import { parseUnits } from "@ethersproject/units"
import { min } from "@perp/common/build/lib/bn"
import { priceToTick, sleep, tickToPrice } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { OpenOrder } from "@perp/common/build/lib/perp/PerpService"
import Big from "big.js"
import { ethers } from "ethers"
import { CallOverrides } from "ethers"
import { Service } from "typedi"

import config from "../configs/config.json"

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    tickSpacing: number
    // config
    // maker
    liquidityAmount: Big
    liquidityRangeMultiplier: Big
    liquidityAdjustMultiplier: Big
}

@Service()
export class Maker extends BotService {
    readonly log = Log.getLogger(Maker.name)

    private wallet!: ethers.Wallet
    private marketMap: { [key: string]: Market } = {}
    private marketOrderMap: { [key: string]: OpenOrder } = {}
    private referralCode: string | null = null

    private readonly defaultOverrides: CallOverrides = {
        maxFeePerGas: parseUnits("10", "gwei"),
        maxPriorityFeePerGas: parseUnits("0.001", "gwei"),
    }

    async setup(): Promise<void> {
        this.log.jinfo({
            event: "SetupMaker",
        })
        const privateKey = process.env.PRIVATE_KEY
        if (!privateKey) {
            throw Error("no env PRIVATE_KEY is provided")
        }
        this.wallet = this.ethService.privateKeyToWallet(privateKey)
        await this.createNonceMutex([this.wallet])
        await this.createMarketMap()

        try {
            this.referralCode = await this.perpService.getReferralCode(this.wallet.address)
        } catch (err: any) {
            if (err.message && err.message.includes("You do not have a referral code")) {
                this.log.jinfo({ event: "NoReferralCode" })
            } else {
                await this.log.jerror({ event: "GetReferralCodeError", params: { err } })
            }
            this.referralCode = "perpmaker"
        }

        this.log.jinfo({
            event: "Maker",
            params: {
                address: this.wallet.address,
                nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
                referralCode: this.referralCode,
            },
        })
    }

    async createMarketMap() {
        const poolMap: { [keys: string]: any } = {}
        for (const pool of this.perpService.metadata.pools) {
            poolMap[pool.baseSymbol] = pool
        }
        for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
            if (!market.IS_ENABLED) {
                continue
            }
            const pool = poolMap[marketName]
            this.marketMap[marketName] = {
                name: marketName,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                tickSpacing: await this.perpService.getTickSpacing(pool.address),
                // config
                // maker
                liquidityAmount: Big(market.LIQUIDITY_AMOUNT),
                liquidityRangeMultiplier: Big(market.LIQUIDITY_RANGE_OFFSET).add(1),
                liquidityAdjustMultiplier: Big(market.LIQUIDITY_ADJUST_THRESHOLD).add(1),
            }
        }
    }

    async start(): Promise<void> {
        const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
        if (balance.gt(0)) {
            await this.approve(this.wallet, balance)
            await this.deposit(this.wallet, balance)
        }
        await this.makerRoutine()
    }

    async makerRoutine() {
        while (true) {
            // TODO: use Promise.all()
            for (const market of Object.values(this.marketMap)) {
                try {
                    const gasPrice = await this.ethService.getGasPrice()
                    const adjustMaxGasPrice = Big(config.ADJUST_MAX_GAS_PRICE_GWEI)
                    if (gasPrice.gt(adjustMaxGasPrice)) {
                        this.log.jwarn({
                            event: "GasPriceExceed",
                            params: { gasPrice: +gasPrice, maxGasPrice: +adjustMaxGasPrice },
                        })
                        continue
                    }
                    await this.refreshOrders(market)
                    await this.adjustLiquidity(market)
                } catch (err: any) {
                    await this.log.jerror({
                        event: "AdjustLiquidityError",
                        params: { err: err.toString() },
                    })
                }
            }
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    async refreshOrders(market: Market) {
        const openOrders = await this.perpService.getOpenOrders(this.wallet.address, market.baseToken)
        if (openOrders.length > 1) {
            throw Error("account has more than 1 orders")
        }
        for (const openOrder of openOrders) {
            this.log.jinfo({
                event: "GetOpenOrders",
                params: {
                    market: market.name,
                    lowerPrice: tickToPrice(openOrder.lowerTick),
                    upperPrice: tickToPrice(openOrder.upperTick),
                },
            })
        }
        switch (openOrders.length) {
            case 0: {
                // create a new order
                this.marketOrderMap[market.name] = await this.createOrder(market)
                break
            }
            case 1: {
                // set the order
                this.marketOrderMap[market.name] = openOrders[0]
                break
            }
            default: {
                // abnormal case, remove all orders manually
                await this.log.jerror({
                    event: "RefreshOrderError",
                    params: { err: new Error("RefreshOrderError"), openOrders },
                })
                //await Promise.all(orders.map(order => this.removeOrder(market, order)))
                process.exit(0)
            }
        }
    }

    async isValidOrder(market: Market, openOrder: OpenOrder): Promise<boolean> {
        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const upperPrice = tickToPrice(openOrder.upperTick)
        const lowerPrice = tickToPrice(openOrder.lowerTick)
        // since upper price = central price * range multiplier, lower price = central price / range multiplier
        // central price = sqrt(upper price * lower price)
        const centralPrice = upperPrice.mul(lowerPrice).sqrt()
        const upperAdjustPrice = centralPrice.mul(market.liquidityAdjustMultiplier)
        const lowerAdjustPrice = centralPrice.div(market.liquidityAdjustMultiplier)
        return marketPrice.gt(lowerAdjustPrice) && marketPrice.lt(upperAdjustPrice)
    }

    async createOrder(market: Market): Promise<OpenOrder> {
        const buyingPower = await this.perpService.getBuyingPower(this.wallet.address)
        const liquidityAmount = min([market.liquidityAmount, buyingPower])
        if (liquidityAmount.lte(0)) {
            this.log.jwarn({
                event: "NoBuyingPowerToCreateOrder",
                params: {
                    market: market.name,
                    buyingPower: +buyingPower,
                },
            })
            throw Error("NoBuyingPowerToCreateOrder")
        }

        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const upperPrice = marketPrice.mul(market.liquidityRangeMultiplier)
        const lowerPrice = marketPrice.div(market.liquidityRangeMultiplier)
        const upperTick = priceToTick(upperPrice, market.tickSpacing)
        const lowerTick = priceToTick(lowerPrice, market.tickSpacing)
        this.log.jinfo({
            event: "CreateOrder",
            params: {
                market: market.name,
                marketPrice: +marketPrice,
                upperPrice: +upperPrice,
                lowerPrice: +lowerPrice,
                upperTick,
                lowerTick,
            },
        })
        const quote = liquidityAmount.div(2)
        const base = liquidityAmount.div(2).div(marketPrice)
        await this.addLiquidity(
            this.wallet,
            market.baseToken,
            lowerTick,
            upperTick,
            base,
            quote,
            false,
            this.defaultOverrides,
        )
        const newOpenOrder = await this.perpService.getOpenOrder(
            this.wallet.address,
            market.baseToken,
            lowerTick,
            upperTick,
        )
        return {
            upperTick: upperTick,
            lowerTick: lowerTick,
            liquidity: newOpenOrder.liquidity,
            baseDebt: newOpenOrder.baseDebt,
            quoteDebt: newOpenOrder.quoteDebt,
        }
    }

    async removeOrder(market: Market, openOrder: OpenOrder): Promise<void> {
        this.log.jinfo({
            event: "RemoveOrder",
            params: {
                market: market.name,
                upperPrice: +tickToPrice(openOrder.upperTick),
                lowerPrice: +tickToPrice(openOrder.lowerTick),
            },
        })
        await this.removeLiquidity(
            this.wallet,
            market.baseToken,
            openOrder.lowerTick,
            openOrder.upperTick,
            openOrder.liquidity,
            this.defaultOverrides,
        )
        await this.closePosition(this.wallet, market.baseToken, this.defaultOverrides, undefined, this.referralCode)
    }

    async adjustLiquidity(market: Market): Promise<void> {
        const order = this.marketOrderMap[market.name]
        this.log.jinfo({
            event: "AdjustOrder",
            params: {
                market: market.name,
                upperPrice: +tickToPrice(order.upperTick),
                lowerPrice: +tickToPrice(order.lowerTick),
            },
        })
        if (!(await this.isValidOrder(market, order))) {
            await this.removeOrder(market, order)
            const newOpenOrder = await this.createOrder(market)
            this.marketOrderMap[market.name] = newOpenOrder
        }
    }
}
