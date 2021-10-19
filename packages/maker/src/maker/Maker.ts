import { min, random } from "@perp/common/build/lib/bn"
import { Side as FTXSide, FtxService, OrderType } from "@perp/common/build/lib/external/FtxService"
import { getMaxTick, getMinTick, getRandomNumber, priceToTick, sleep, tickToPrice } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, OpenOrder, Side } from "@perp/common/build/lib/perp/PerpService"
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
    ftxMinProvideSize: Big
    // config
    ftxMarketName: string
    // maker
    fullRangeLiquidityAmount: Big
    currentRangeLiquidityAmount: Big
    currentRangeLiquidityRangeOffset: Big
    currentRangeLiquidityAdjustThreshold: Big
    // taker
    maxSlippageRatio: Big
    minSlippageRatio: Big
    shortTrigger: Big
    longTrigger: Big
    maxPerOrderOpenAmount: Big
    // reduce mode
    isEmergencyReduceModeEnabled: boolean
    normalReduceModeShortTrigger: Big
    normalReduceModeLongTrigger: Big
}
interface Slippage {
    ratio: Big
    openAmount: Big
}

const OPEN_AMOUNT_DENOMINATOR = Big(100)

@Service()
export class Maker extends BotService {
    readonly log = Log.getLogger(Maker.name)

    private wallet!: ethers.Wallet
    private marketMap: { [key: string]: Market } = {}
    private marketCurrentOrderMap: { [key: string]: OpenOrder } = {}
    private ftxClient: any
    private isInEmergencyMode: boolean = false

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
                ftxMinProvideSize: (await this.ftxService.getMarket(market.FTX_MARKET_NAME)).minProvideSize,
                // config
                ftxMarketName: market.FTX_MARKET_NAME,
                // maker
                fullRangeLiquidityAmount: Big(market.FULL_RANGE_LIQUIDITY_AMOUNT),
                currentRangeLiquidityAmount: Big(market.CURRENT_RANGE_LIQUIDITY_AMOUNT),
                currentRangeLiquidityRangeOffset: Big(market.CURRENT_RANGE_LIQUIDITY_RANGE_OFFSET),
                currentRangeLiquidityAdjustThreshold: Big(market.CURRENT_RANGE_LIQUIDITY_ADJUST_THRESHOLD),
                // taker
                maxSlippageRatio: Big(market.MAX_SLIPPAGE_RATIO),
                minSlippageRatio: Big(market.MIN_SLIPPAGE_RATIO),
                shortTrigger: Big(market.SHORT_TRIGGER),
                longTrigger: Big(market.LONG_TRIGGER),
                maxPerOrderOpenAmount: Big(market.MAX_PER_ORDER_OPEN_AMOUNT),
                // sell mode
                isEmergencyReduceModeEnabled: market.IS_EMERGENCY_REDUCE_MODE_ENABLED,
                normalReduceModeShortTrigger: Big(market.NORMAL_REDUCE_MODE_SHORT_TRIGGER),
                normalReduceModeLongTrigger: Big(market.NORMAL_REDUCE_MODE_LONG_TRIGGER),
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
        for (const market of Object.values(this.marketMap)) {
            const openOrders = await this.perpService.getOpenOrders(this.wallet.address, market.baseToken)
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
            const fullRangeOpenOrder = openOrders.find(
                openOrder => !openOrder.liquidity.eq(0) && this.isFullRangeOrder(market, openOrder),
            )
            if (!fullRangeOpenOrder) {
                await this.addFullRangeLiquidity(market)
            }
            const currentRangeOrders = openOrders.filter(
                openOrder => !openOrder.liquidity.eq(0) && !this.isFullRangeOrder(market, openOrder),
            )
            await this.refreshCurrentRangeOrders(market, currentRangeOrders)
        }
        this.emergencyReduceRoutine()
        this.normalReduceRoutine()
        if (config.IS_HEDGE_ENABLED) {
            await Promise.all(Object.values(this.marketMap).map(market => this.hedge(market, true)))
            this.hedgeRoutine()
        }
        this.keepPriceRoutine()
    }

    async keepPriceRoutine() {
        while (true) {
            // TODO: use Promise.all()
            for (const market of Object.values(this.marketMap)) {
                try {
                    await this.keepPrice(market)
                } catch (err: any) {
                    await this.log.jerror({ event: "KeepPriceError", params: { err: err.toString() } })
                }
                try {
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

    async openFTXPositionPeriodically(market: Market, side: FTXSide, size: Big) {
        let remainSize = size
        while (remainSize.gt(market.ftxMinProvideSize)) {
            const price = await this.getFTXPrice(market.ftxMarketName)
            const maxOpenSize = Big(config.FTX_MAX_PER_ORDER_OPEN_AMOUNT).div(price)
            const openSize = remainSize.lte(maxOpenSize) ? remainSize : maxOpenSize
            if (openSize.lt(market.ftxMinProvideSize)) {
                break
            }
            // should not increase position if we are below min margin ratio
            if (await this.isBelowFTXMarginRatio(config.FTX_MIN_MARGIN_RATIO)) {
                const positionSize = await this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName)
                if ((side === FTXSide.BUY && positionSize.gte(0)) || (side === FTXSide.SELL && positionSize.lte(0))) {
                    await this.log.jwarn({
                        event: "ShouldNotIncreaseFTXPosition",
                        params: { market: market.ftxMarketName, ftxMinMarginRatio: config.FTX_MIN_MARGIN_RATIO },
                    })
                    break
                }
            }
            this.log.jinfo({
                event: "OpenFTXPositionPeriodically",
                params: { market: market.ftxMarketName, openSize: +openSize, remainSize: +remainSize },
            })
            try {
                await this.ftxService.placeOrder(this.ftxClient, {
                    market: market.ftxMarketName,
                    side,
                    price: null,
                    size: +size,
                    type: OrderType.MARKET,
                })
                remainSize = remainSize.minus(openSize)
            } catch (err: any) {
                await this.log.jerror({
                    event: "FTXPlaceOrderError",
                    params: { market: market.ftxMarketName, side, size: +size, error: err.toString() },
                })
                throw err
            }
            await sleep(config.FTX_OPEN_INTERVAL_SEC * 1000)
        }
    }

    async hedge(market: Market, force: boolean) {
        if (!config.IS_HEDGE_ENABLED || market.isInHedgingProcess || this.isInEmergencyMode) {
            return
        }
        const perpPositionSize = await this.perpService.getPositionSize(this.wallet.address, market.baseToken)
        const ftxPositionSize = await this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName)
        this.log.jinfo({
            event: "Hedge",
            params: { market: market.name, perpPositionSize: +perpPositionSize, ftxPositionSize: +ftxPositionSize },
        })
        const positionSizeDiff = ftxPositionSize.add(perpPositionSize).abs()
        const hasLargePositionSizeDiff = positionSizeDiff
            .div(perpPositionSize.abs())
            .gt(Big(config.HEDGE_TRIGGER_RATIO))
        if (force || hasLargePositionSizeDiff) {
            // adjust ftx position
            const { sizeAbs, side } = FtxService.mitigatePositionSizeDiff(perpPositionSize, ftxPositionSize)
            try {
                market.isInHedgingProcess = true
                await this.openFTXPositionPeriodically(market, side, sizeAbs)
            } finally {
                market.isInHedgingProcess = false
            }
        }
    }

    async hedgeRoutine() {
        while (true) {
            try {
                await Promise.all(Object.values(this.marketMap).map(market => this.hedge(market, false)))
                await sleep(config.HEDGE_CHECK_INTERVAL_SEC * 1000)
            } catch (err: any) {
                await this.log.jerror({ event: "HedgeRoutineError", params: { err: err.toString() } })
            }
        }
    }

    async normalReducePosition(market: Market) {
        const targetPrice = await this.getTargetPrice(market)
        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const spread = marketPrice.minus(targetPrice).div(targetPrice)
        this.log.jinfo({
            event: "NormalReducePositionSpread",
            params: { market: market.name, marketPrice: +marketPrice, targetPrice: +targetPrice, spread: +spread },
        })
        if (spread.lt(market.normalReduceModeShortTrigger) && spread.gt(market.normalReduceModeLongTrigger)) {
            const positionSize = await this.perpService.getPositionSize(this.wallet.address, market.baseToken)
            if (positionSize.eq(0)) {
                return
            }
            const positionValueAbs = (
                await this.perpService.getPositionValue(this.wallet.address, market.baseToken)
            ).abs()
            const maxReduceAmount = config.NORMAL_REDUCE_AMOUNT * (1 + config.NORMAL_REDUCE_AMOUNT_OFFSET)
            const minReduceAmount = config.NORMAL_REDUCE_AMOUNT * (1 - config.NORMAL_REDUCE_AMOUNT_OFFSET)
            const reduceAmount = getRandomNumber(minReduceAmount, maxReduceAmount)
            if (positionValueAbs.lte(reduceAmount)) {
                this.log.jinfo({
                    event: "NormalReduceClosePosition",
                    params: { market: market.name, positionValueAbs: +positionValueAbs },
                })
                await this.closePosition(this.wallet, market.baseToken)
                return
            }
            this.log.jinfo({
                event: "NormalReducePosition",
                params: { market: market.name, reduceAmount: reduceAmount, positionValue: +positionValueAbs },
            })
            const side = positionSize.gt(0) ? Side.SHORT : Side.LONG
            await this.openPosition(this.wallet, market.baseToken, side, AmountType.QUOTE, Big(reduceAmount))
        }
    }

    async normalReduceRoutine() {
        while (true) {
            try {
                await Promise.all(Object.values(this.marketMap).map(market => this.normalReducePosition(market)))
                await sleep(config.NORMAL_REDUCE_CHECK_INTERVAL_SEC * 1000)
            } catch (err: any) {
                await this.log.jerror({ event: "NormalReduceRoutineError", params: { err: err.toString() } })
            }
        }
    }

    async emergencyReducePerpPosition(market: Market) {
        const emergencyReduceAmount = Big(config.EMERGENCY_REDUCE_AMOUNT)
        const positionValue = await this.perpService.getPositionValue(this.wallet.address, market.baseToken)
        if (positionValue.eq(0)) {
            return
        }
        if (positionValue.abs().lte(emergencyReduceAmount)) {
            await this.log.jwarn({
                event: "EmergencyReduceClosePerpPosition",
                params: { market: market.name, positionValue: +positionValue },
            })
            await this.closePosition(this.wallet, market.baseToken)
            return
        }
        const side = positionValue.gt(0) ? Side.SHORT : Side.LONG
        await this.log.jwarn({
            event: "EmergencyReducePerpPosition",
            params: { market: market.name, reduceAmount: +emergencyReduceAmount, positionValue: +positionValue },
        })
        await this.openPosition(this.wallet, market.baseToken, side, AmountType.QUOTE, emergencyReduceAmount)
    }

    async emergencyReduceFTXPosition(market: Market) {
        if (!config.IS_HEDGE_ENABLED) {
            return
        }
        const emergencyReduceAmount = Big(config.EMERGENCY_REDUCE_AMOUNT)
        const positionSize = await this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName)
        if (positionSize.eq(0)) {
            return
        }
        const price = await this.getFTXPrice(market.ftxMarketName)
        const reduceSize = min([positionSize.abs(), emergencyReduceAmount.div(price)])
        if (reduceSize.lt(market.ftxMinProvideSize)) {
            return
        }
        const side = positionSize.gt(0) ? FTXSide.SELL : FTXSide.BUY
        try {
            await this.log.jwarn({
                event: "EmergencyReduceFTXPosition",
                params: { market: market.name, reduceSize: +reduceSize, positionSize: +positionSize },
            })
            await this.ftxService.placeOrder(this.ftxClient, {
                market: market.ftxMarketName,
                side,
                price: null,
                size: +reduceSize,
                type: OrderType.MARKET,
            })
        } catch (err: any) {
            await this.log.jerror({
                event: "FTXPlaceOrderError",
                params: { market: market.ftxMarketName, side, size: +reduceSize, error: err.toString() },
            })
            throw err
        }
    }

    async emergencyReducePosition(market: Market) {
        if (!market.isEmergencyReduceModeEnabled) {
            return
        }
        await Promise.all([this.emergencyReducePerpPosition(market), this.emergencyReduceFTXPosition(market)])
    }

    private async isBelowFTXMarginRatio(criterion: number) {
        const accountInfo = await this.ftxService.getAccountInfo(this.ftxClient)
        const marginRatio = accountInfo.marginFraction
        this.log.jinfo({ event: "FTXMarginRatio", params: { marginRatio: marginRatio === null ? null : +marginRatio } })
        return marginRatio !== null && marginRatio.lt(criterion)
    }

    private async isBelowPerpMarginRatio(criterion: number) {
        const marginRatio = await this.perpService.getMarginRatio(this.wallet.address)
        this.log.jinfo({
            event: "PerpMarginRatio",
            params: { marginRatio: marginRatio === null ? null : +marginRatio },
        })
        return marginRatio !== null && marginRatio.lt(criterion)
    }

    async emergencyReduceRoutine() {
        while (true) {
            try {
                const isBelowFTXMarginRatio =
                    config.IS_HEDGE_ENABLED && (await this.isBelowFTXMarginRatio(config.FTX_EMERGENCY_MARGIN_RATIO))
                const isBelowPerpMarginRatio = await this.isBelowPerpMarginRatio(config.PERP_EMERGENCY_MARGIN_RATIO)
                if (isBelowFTXMarginRatio || isBelowPerpMarginRatio) {
                    try {
                        await this.log.jwarn({
                            event: "EnterEmergencyReduceMode",
                            params: {
                                perpEmergencyMarginRatio: config.PERP_EMERGENCY_MARGIN_RATIO,
                                ftxEmergencyMarginRatio: config.FTX_EMERGENCY_MARGIN_RATIO,
                            },
                        })
                        this.isInEmergencyMode = true
                        await Promise.all(
                            Object.values(this.marketMap).map(market => this.emergencyReducePosition(market)),
                        )
                        await sleep(config.EMERGENCY_REDUCE_SLEEP_SEC * 1000)
                    } finally {
                        this.isInEmergencyMode = false
                    }
                }
                await sleep(config.EMERGENCY_REDUCE_CHECK_INTERVAL_SEC * 1000)
            } catch (err: any) {
                await this.log.jerror({ event: "EmergencyReduceRoutineError", params: { err: err.toString() } })
            }
        }
    }

    async refreshCurrentRangeOrders(market: Market, currentRangeOrders: OpenOrder[]) {
        switch (currentRangeOrders.length) {
            case 0: {
                // create a new current range order
                this.marketCurrentOrderMap[market.name] = await this.createCurrentRangeOrder(market)
                break
            }
            case 1: {
                // set the current range order
                this.marketCurrentOrderMap[market.name] = currentRangeOrders[0]
                break
            }
            case 2: {
                // remove one invalid current range order
                if (await this.isValidCurrentRangeOrder(market, currentRangeOrders[0])) {
                    // keep the first one and remove the second one
                    this.marketCurrentOrderMap[market.name] = currentRangeOrders[0]
                    await this.removeCurrentRangeOrder(market, currentRangeOrders[1])
                } else {
                    // keep the second one and remove the first one
                    this.marketCurrentOrderMap[market.name] = currentRangeOrders[1]
                    await this.removeCurrentRangeOrder(market, currentRangeOrders[0])
                }
                break
            }
            default: {
                // abnormal case, remove all current range orders manually
                await this.log.jerror({ event: "InitializeError", params: { currentRangeOrders } })
                //await Promise.all(currentRangeOrders.map(order => this.removeCurrentRangeOrder(market, order)))
                process.exit(0)
            }
        }
    }

    isFullRangeOrder(market: Market, openOrder: OpenOrder): boolean {
        return (
            openOrder.lowerTick === getMinTick(market.tickSpacing) &&
            openOrder.upperTick === getMaxTick(market.tickSpacing)
        )
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

    async calcSlippageAmount(
        market: Market,
        marketPrice: Big,
        targetSlippageRatio: Big,
        side: Side,
    ): Promise<Slippage> {
        const deltaAmount = market.maxPerOrderOpenAmount.div(OPEN_AMOUNT_DENOMINATOR)
        const openAmounts = []
        let amount = Big(0)
        const denominator = +OPEN_AMOUNT_DENOMINATOR
        for (let i = 0; i < denominator; i++) {
            amount = amount.add(deltaAmount)
            openAmounts.push(amount)
        }
        const slippages = await Promise.all(
            openAmounts.map(async openAmount => {
                const swapResp = await this.perpService.quote(
                    market.baseToken,
                    side,
                    AmountType.QUOTE,
                    openAmount,
                    Big(0),
                )
                const afterSwapPrice = swapResp.afterSwapPrice
                const ratio = marketPrice.minus(afterSwapPrice).div(marketPrice).abs()
                this.log.jinfo({
                    event: "CalculateSlippage",
                    params: {
                        side,
                        marketPrice: +marketPrice,
                        afterSwapPrice: +afterSwapPrice,
                        slippageRatio: +ratio,
                        openAmount: +openAmount,
                        exchangedPositionNotional: swapResp.exchangedPositionNotional,
                        exchangedPositionSize: +swapResp.exchangedPositionSize,
                    },
                })
                return { ratio, openAmount }
            }),
        )
        let closestSlippage = slippages[0]
        for (const slippage of slippages) {
            const closestDiff = closestSlippage.ratio.minus(targetSlippageRatio).abs()
            if (slippage.ratio.minus(targetSlippageRatio).abs().lt(closestDiff)) {
                closestSlippage = slippage
            }
        }
        this.log.jinfo({
            event: "ClosestSlippage",
            params: {
                targetSlippageRatio: +targetSlippageRatio,
                slippageRatio: +closestSlippage.ratio,
                openAmount: +closestSlippage.openAmount,
            },
        })
        return closestSlippage
    }

    async getFTXPrice(ftxMarketName: string): Promise<Big> {
        return (await this.ftxService.getMarket(ftxMarketName)).last
    }

    async getTargetPrice(market: Market): Promise<Big> {
        return await this.getFTXPrice(market.ftxMarketName)
    }

    async keepPrice(market: Market) {
        const targetPrice = await this.getTargetPrice(market)
        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const spread = marketPrice.minus(targetPrice).div(targetPrice)
        this.log.jinfo({
            event: "Spread",
            params: { market: market.name, marketPrice: +marketPrice, targetPrice: +targetPrice, spread: +spread },
        })
        const targetSlippageRatio = random(market.minSlippageRatio, market.maxSlippageRatio)
        const buyingPower = await this.perpService.getBuyingPower(this.wallet.address)
        let positionSize = await this.perpService.getPositionSize(this.wallet.address, market.baseToken)
        this.log.jinfo({ event: "PositionSizeBefore", params: { market: market.name, positionSize: +positionSize } })
        const isBelowPerpMarginRatio = await this.isBelowPerpMarginRatio(config.PERP_MIN_MARGIN_RATIO)
        const isBelowFTXMarginRatio =
            config.IS_HEDGE_ENABLED && (await this.isBelowFTXMarginRatio(config.FTX_MIN_MARGIN_RATIO))
        const isBelowMarginRatio = isBelowPerpMarginRatio || isBelowFTXMarginRatio
        if (spread.gt(market.shortTrigger)) {
            // short
            const side = Side.SHORT
            // should not increase position if we are below min margin ratio
            if (positionSize.lte(0) && isBelowMarginRatio) {
                await this.log.jwarn({
                    event: "ShouldNotIncreasePerpPosition",
                    params: {
                        perpMinMarginRatio: config.PERP_MIN_MARGIN_RATIO,
                        ftxMinMarginRatio: config.FTX_MIN_MARGIN_RATIO,
                    },
                })
                return
            }
            const { ratio, openAmount: slippageAmount } = await this.calcSlippageAmount(
                market,
                marketPrice,
                targetSlippageRatio,
                side,
            )
            if (ratio.gt(market.maxSlippageRatio)) {
                this.log.jinfo({
                    event: "ClosestSlippageExceedsMaxSlippageRatio",
                    params: { closestSlippage: +ratio, maxSlippageRatio: +market.maxSlippageRatio },
                })
                return
            }
            const amount = min([slippageAmount, buyingPower])
            await this.openPosition(this.wallet, market.baseToken, side, AmountType.QUOTE, amount)
        } else if (spread.lt(market.longTrigger)) {
            // long
            const side = Side.LONG
            // should not increase position if we are below min margin ratio
            if (positionSize.gte(0) && isBelowMarginRatio) {
                await this.log.jwarn({
                    event: "ShouldNotIncreasePerpPosition",
                    params: {
                        perpMinMarginRatio: config.PERP_MIN_MARGIN_RATIO,
                        ftxMinMarginRatio: config.FTX_MIN_MARGIN_RATIO,
                    },
                })
                return
            }
            const { ratio, openAmount: slippageAmount } = await this.calcSlippageAmount(
                market,
                marketPrice,
                targetSlippageRatio,
                side,
            )
            if (ratio.gt(market.maxSlippageRatio)) {
                this.log.jinfo({
                    event: "ClosestSlippageExceedsMaxSlippageRatio",
                    params: { closestSlippage: +ratio, maxSlippageRatio: +market.maxSlippageRatio },
                })
                return
            }
            const amount = min([slippageAmount, buyingPower])
            await this.openPosition(this.wallet, market.baseToken, side, AmountType.QUOTE, amount)
        } else {
            this.log.jinfo({ event: "NotTriggered", params: { market: market.name } })
        }
        positionSize = await this.perpService.getPositionSize(this.wallet.address, market.baseToken)
        this.log.jinfo({ event: "PositionSizeAfter", params: { market: market.name, positionSize: +positionSize } })
    }

    async addFullRangeLiquidity(market: Market): Promise<void> {
        const lowerTick = getMinTick(market.tickSpacing)
        const upperTick = getMaxTick(market.tickSpacing)
        this.log.jinfo({
            event: "AddFullRangeLiquidity",
            params: { marketName: market.name },
        })
        const marketPrice = await this.perpService.getMarketPrice(market.poolAddr)
        const quote = market.fullRangeLiquidityAmount.div(2)
        const base = market.fullRangeLiquidityAmount.div(2).div(marketPrice)
        await this.addLiquidity(this.wallet, market.baseToken, lowerTick, upperTick, base, quote)
    }

    async createCurrentRangeOrder(market: Market): Promise<OpenOrder> {
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
        const quote = market.currentRangeLiquidityAmount.div(2)
        const base = market.currentRangeLiquidityAmount.div(2).div(marketPrice)
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
            const newOpenOrder = await this.createCurrentRangeOrder(market)
            await this.removeCurrentRangeOrder(market, currentOrder)
            this.marketCurrentOrderMap[market.name] = newOpenOrder
            await this.hedge(market, true)
        }
    }
}
