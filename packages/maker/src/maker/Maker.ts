import { min } from "@perp/common/build/lib/bn"
import { priceToTick, sleep, tickToPrice } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { OpenOrder } from "@perp/common/build/lib/perp/PerpService"
import Big from "big.js"
import { ethers } from "ethers"
import { Service } from "typedi"

import config from "../configs/config.json"

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    tickSpacing: number
    isInHedgingProcess: boolean
    // config
    // maker
    currentRangeLiquidityAmount: Big
    currentRangeLiquidityRangeOffset: Big
    currentRangeLiquidityAdjustThreshold: Big
}

@Service()
export class Maker extends BotService {
    readonly log = Log.getLogger(Maker.name)

    private wallet!: ethers.Wallet
    private marketMap: { [key: string]: Market } = {}
    private marketCurrentOrderMap: { [key: string]: OpenOrder } = {}

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
        this.log.jinfo({
            event: "Maker",
            params: {
                address: this.wallet.address,
                nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
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
                isInHedgingProcess: false,
                // config
                // maker
                currentRangeLiquidityAmount: Big(market.CURRENT_RANGE_LIQUIDITY_AMOUNT),
                currentRangeLiquidityRangeOffset: Big(market.CURRENT_RANGE_LIQUIDITY_RANGE_OFFSET),
                currentRangeLiquidityAdjustThreshold: Big(market.CURRENT_RANGE_LIQUIDITY_ADJUST_THRESHOLD),
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
        this.makerRoutine()
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
                    await this.refreshCurrentRangeOrders(market)
                    await this.adjustCurrentRangeLiquidity(market)
                } catch (err: any) {
                    await this.log.jerror({
                        event: "AdjustCurrentRangeLiquidityError",
                        params: { err: err.toString() },
                    })
                }
            }
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    async refreshCurrentRangeOrders(market: Market) {
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
                // create a new current range order
                this.marketCurrentOrderMap[market.name] = await this.createCurrentRangeOrder(market)
                break
            }
            case 1: {
                // set the current range order
                this.marketCurrentOrderMap[market.name] = openOrders[0]
                break
            }
            default: {
                // abnormal case, remove all current range orders manually
                await this.log.jerror({ event: "RefreshCurrentRangeOrderError", params: { openOrders } })
                //await Promise.all(currentRangeOrders.map(order => this.removeCurrentRangeOrder(market, order)))
                process.exit(0)
            }
        }
    }

    async isValidCurrentRangeOrder(market: Market, openOrder: OpenOrder): Promise<boolean> {
        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const upperPrice = tickToPrice(openOrder.upperTick)
        const lowerPrice = tickToPrice(openOrder.lowerTick)
        const currentRangeLiquidityAdjustThreshold = market.currentRangeLiquidityAdjustThreshold
        return (
            marketPrice.lt(upperPrice.mul(Big(1).minus(currentRangeLiquidityAdjustThreshold))) &&
            marketPrice.gt(lowerPrice.mul(Big(1).add(currentRangeLiquidityAdjustThreshold)))
        )
    }

    async createCurrentRangeOrder(market: Market): Promise<OpenOrder> {
        const buyingPower = await this.perpService.getBuyingPower(this.wallet.address)
        const currentRangeLiquidityAmount = min([market.currentRangeLiquidityAmount, buyingPower])
        if (currentRangeLiquidityAmount.lte(0)) {
            this.log.jwarn({ event: "NoBuyingPowerToCreateCurrentRangeOrder", params: { buyingPower: +buyingPower } })
            throw Error("NoBuyingPowerToCreateCurrentRangeOrder")
        }

        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const currentRangeLiquidityRangeOffset = market.currentRangeLiquidityRangeOffset
        const upperPrice = marketPrice.mul(Big(1).add(currentRangeLiquidityRangeOffset))
        const lowerPrice = marketPrice.mul(Big(1).minus(currentRangeLiquidityRangeOffset))
        const upperTick = priceToTick(upperPrice, market.tickSpacing)
        const lowerTick = priceToTick(lowerPrice, market.tickSpacing)
        this.log.jinfo({
            event: "CreateCurrentRangeOrder",
            params: {
                market: market.name,
                marketPrice: +marketPrice,
                upperPrice: +upperPrice,
                lowerPrice: +lowerPrice,
                upperTick,
                lowerTick,
            },
        })
        const quote = currentRangeLiquidityAmount.div(2)
        const base = currentRangeLiquidityAmount.div(2).div(marketPrice)
        await this.addLiquidity(this.wallet, market.baseToken, lowerTick, upperTick, base, quote)
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
        }
    }

    async removeCurrentRangeOrder(market: Market, openOrder: OpenOrder): Promise<void> {
        this.log.jinfo({
            event: "RemoveCurrentRangeOrder",
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
        )
        await this.closePosition(this.wallet, market.baseToken)
    }

    async adjustCurrentRangeLiquidity(market: Market): Promise<void> {
        const currentOrder = this.marketCurrentOrderMap[market.name]
        this.log.jinfo({
            event: "AdjustCurrentRangeOrder",
            params: {
                market: market.name,
                upperPrice: +tickToPrice(currentOrder.upperTick),
                lowerPrice: +tickToPrice(currentOrder.lowerTick),
            },
        })
        if (!(await this.isValidCurrentRangeOrder(market, currentOrder))) {
            await this.removeCurrentRangeOrder(market, currentOrder)
            const newOpenOrder = await this.createCurrentRangeOrder(market)
            this.marketCurrentOrderMap[market.name] = newOpenOrder
        }
    }
}
