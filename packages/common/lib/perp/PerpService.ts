import { Log as EthersLog } from "@ethersproject/abstract-provider"
import { BlockTag } from "@ethersproject/providers"
import { formatUnits, parseUnits } from "@ethersproject/units"
import { UniswapV3Pool } from "@perp/common/types/ethers-uniswap"
import AccountBalanceArtifact from "@perp/lushan/artifacts/contracts/AccountBalance.sol/AccountBalance.json"
import BaseTokenArtifact from "@perp/lushan/artifacts/contracts/BaseToken.sol/BaseToken.json"
import ClearingHouseArtifact from "@perp/lushan/artifacts/contracts/ClearingHouse.sol/ClearingHouse.json"
import ClearingHouseConfigArtifact from "@perp/lushan/artifacts/contracts/ClearingHouseConfig.sol/ClearingHouseConfig.json"
import ExchangeArtifact from "@perp/lushan/artifacts/contracts/Exchange.sol/Exchange.json"
import QuoterArtifact from "@perp/lushan/artifacts/contracts/lens/Quoter.sol/Quoter.json"
import MarketRegistryArtifact from "@perp/lushan/artifacts/contracts/MarketRegistry.sol/MarketRegistry.json"
import OrderBookArtifact from "@perp/lushan/artifacts/contracts/OrderBook.sol/OrderBook.json"
import VaultArtifact from "@perp/lushan/artifacts/contracts/Vault.sol/Vault.json"
import VirtualTokenArtifact from "@perp/lushan/artifacts/contracts/VirtualToken.sol/VirtualToken.json"
import arbitrumRinkebyMetadata from "@perp/lushan/metadata/arbitrumRinkeby.json"
import UniswapV3PoolArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"
import Big from "big.js"
import { BigNumber, Signer, ethers } from "ethers"
import { get } from "lodash"
import { Service } from "typedi"

import TestERC20Artifact from "../../abis/TestERC20.json"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    Quoter,
    Vault,
    VirtualToken,
} from "../../types/ethers"
import { TestERC20 } from "../../types/ethers-extra"
import { sum } from "../bn"
import { L2EthService } from "../eth/L2EthService"
import { BNToBig, BigToBN, sqrtPriceX96ToPrice } from "../helper"
import { Log } from "../loggers"
import { Metadata } from "../types"

export enum EventType {
    POSITION_CHANGED = "positionChanged",
    POSITION_LIQUIDATED = "positionLiquidated",
    LIQUIDITY_CHANGED = "liquidityChanged",
    FUNDING_PAYMENT_SETTLED = "fundingPaymentSettled",
    DEPOSITED = "deposited",
    WITHDRAWN = "withdrawn",
}
export enum Side {
    SHORT = "short",
    LONG = "long",
}
export enum AmountType {
    BASE = "base",
    QUOTE = "quote",
}

export interface EventLog {
    blockNumber: number
    logIndex: number
    txHash: string
    eventType: EventType
    eventSource: string
}

export interface PositionChangedLog extends EventLog {
    trader: string
    baseToken: string
    exchangedPositionSize: Big
    exchangedPositionNotional: Big
    fee: Big
    openNotional: Big
    realizedPnl: Big
    priceAfter: Big
}

export interface PositionLiquidatedLog extends EventLog {
    trader: string
    baseToken: string
    positionNotional: Big
    positionSize: Big
    liquidationFee: Big
    liquidator: string
}

export interface LiquidityChangedLog extends EventLog {
    maker: string
    baseToken: string
    quoteToken: string
    lowerTick: number
    upperTick: number
    base: Big
    quote: Big
    liquidity: Big
    quoteFee: Big
}

export interface FundingPaymentSettledLog extends EventLog {
    trader: string
    baseToken: string
    fundingPayment: Big
}

export interface DepositedLog extends EventLog {
    collateralToken: string
    trader: string
    amount: Big
}

export interface WithdrawnLog extends EventLog {
    token: string
    to: string
    amount: Big
}

export interface PnlRealizedLog extends EventLog {
    trader: string
    amount: Big
}

interface SwapResponse {
    deltaAvailableBase: Big
    deltaAvailableQuote: Big
    exchangedPositionSize: Big
    exchangedPositionNotional: Big
    afterSwapPrice: Big
}
export interface OpenOrder {
    liquidity: Big
    lowerTick: number
    upperTick: number
    lastFeeGrowthInsideX128?: Big
    lastTwPremiumGrowthInsideX96?: Big
    lastTwPremiumGrowthBelowX96?: Big
    lastTwPremiumDivBySqrtPriceGrowthInsideX96?: Big
}
@Service()
export class PerpService {
    readonly log = Log.getLogger(PerpService.name)
    readonly metadata: Metadata
    private _testUSDCDecimals: number | undefined
    private _vaultDecimals: number | undefined

    // Webpack doesn't support load json files dynamically in runtime,
    // so we must import both metadataStaging and metadataProduction
    constructor(readonly ethService: L2EthService) {
        this.metadata = arbitrumRinkebyMetadata as unknown as Metadata
    }

    static fromWei(value: BigNumber, decimals = 18): Big {
        return Big(formatUnits(value, decimals).toString())
    }

    static toWei(value: Big, decimals = 18): BigNumber {
        return parseUnits(value.toFixed(decimals), decimals)
    }

    createTestUSDC(signer?: Signer): TestERC20 {
        const address = get(this.metadata, "externalContracts.USDC") as string
        return this.ethService.createContract<TestERC20>(address, TestERC20Artifact.abi, signer)
    }

    createVault(signer?: Signer): Vault {
        const address = get(this.metadata, "contracts.Vault.address") as string
        return this.ethService.createContract<Vault>(address, VaultArtifact.abi, signer)
    }

    createMarketRegistry(signer?: Signer): MarketRegistry {
        const address = get(this.metadata, "contracts.MarketRegistry.address") as string
        return this.ethService.createContract<MarketRegistry>(address, MarketRegistryArtifact.abi, signer)
    }

    createClearingHouse(signer?: Signer): ClearingHouse {
        const address = get(this.metadata, "contracts.ClearingHouse.address") as string
        return this.ethService.createContract<ClearingHouse>(address, ClearingHouseArtifact.abi, signer)
    }

    createClearingHouseConfig(signer?: Signer): ClearingHouseConfig {
        const address = get(this.metadata, "contracts.ClearingHouseConfig.address") as string
        return this.ethService.createContract<ClearingHouseConfig>(address, ClearingHouseConfigArtifact.abi, signer)
    }

    createAccountBalance(signer?: Signer): AccountBalance {
        const address = get(this.metadata, "contracts.AccountBalance.address") as string
        return this.ethService.createContract<AccountBalance>(address, AccountBalanceArtifact.abi, signer)
    }

    createExchange(signer?: Signer): Exchange {
        const address = get(this.metadata, "contracts.Exchange.address") as string
        return this.ethService.createContract<Exchange>(address, ExchangeArtifact.abi, signer)
    }

    createOrderBook(signer?: Signer): OrderBook {
        const address = get(this.metadata, "contracts.OrderBook.address") as string
        return this.ethService.createContract<OrderBook>(address, OrderBookArtifact.abi, signer)
    }

    createQuoter(signer?: Signer): Quoter {
        const address = get(this.metadata, "contracts.Quoter.address") as string
        return this.ethService.createContract<Quoter>(address, QuoterArtifact.abi, signer)
    }

    createVirtualToken(tokenAddr: string, signer?: Signer): VirtualToken {
        return this.ethService.createContract<VirtualToken>(tokenAddr, VirtualTokenArtifact.abi, signer)
    }

    createBaseToken(tokenAddr: string, signer?: Signer): BaseToken {
        return this.ethService.createContract<BaseToken>(tokenAddr, BaseTokenArtifact.abi, signer)
    }

    createPool(poolAddr: string, signer?: Signer): UniswapV3Pool {
        return this.ethService.createContract<UniswapV3Pool>(poolAddr, UniswapV3PoolArtifact.abi, signer)
    }

    getAllBaseTokens(): string[] {
        return this.metadata.pools.map(pool => pool.baseAddress)
    }

    async getTestUSDCDecimals() {
        if (this._testUSDCDecimals === undefined) {
            const testUSDC = this.createTestUSDC()
            this._testUSDCDecimals = await testUSDC.decimals()
        }
        return this._testUSDCDecimals
    }

    async getVaultDecimals() {
        if (this._vaultDecimals === undefined) {
            const vault = this.createVault()
            this._vaultDecimals = await vault.decimals()
        }
        return this._vaultDecimals
    }

    async getBaseTokens(trader: string): Promise<string[]> {
        const accountBalance = this.createAccountBalance()
        return await accountBalance.getBaseTokens(trader)
    }

    async getUSDCBalance(trader: string): Promise<Big> {
        const testUSDC = this.createTestUSDC()
        return PerpService.fromWei(await testUSDC.balanceOf(trader), await this.getTestUSDCDecimals())
    }

    async getPositionChangedLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<PositionChangedLog[]> {
        const exchange = this.createExchange()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...exchange.filters.PositionChanged(trader, null, null, null, null, null, null, null),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const {
                trader,
                baseToken,
                exchangedPositionSize,
                exchangedPositionNotional,
                fee,
                openNotional,
                realizedPnl,
                sqrtPriceAfter,
            } = exchange.interface.parseLog(log).args
            return {
                trader,
                baseToken,
                exchangedPositionSize: PerpService.fromWei(exchangedPositionSize),
                exchangedPositionNotional: PerpService.fromWei(exchangedPositionNotional),
                fee: PerpService.fromWei(fee),
                openNotional: PerpService.fromWei(openNotional),
                realizedPnl: PerpService.fromWei(realizedPnl),
                priceAfter: sqrtPriceX96ToPrice(BNToBig(sqrtPriceAfter)),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.POSITION_CHANGED,
                eventSource: exchange.address,
            }
        })
    }

    async getPositionLiquidatedLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<PositionLiquidatedLog[]> {
        const clearingHouse = this.createClearingHouse()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...clearingHouse.filters.PositionLiquidated(trader),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { trader, baseToken, positionNotional, positionSize, liquidationFee, liquidator } =
                clearingHouse.interface.parseLog(log).args
            return {
                trader,
                baseToken,
                positionNotional: PerpService.fromWei(positionNotional),
                positionSize: PerpService.fromWei(positionSize),
                liquidationFee: PerpService.fromWei(liquidationFee),
                liquidator,
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.POSITION_LIQUIDATED,
                eventSource: clearingHouse.address,
            }
        })
    }

    async getLiquidityChangedLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        maker: string | null = null,
    ): Promise<LiquidityChangedLog[]> {
        const orderBook = this.createOrderBook()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...orderBook.filters.LiquidityChanged(maker),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { maker, baseToken, quoteToken, lowerTick, upperTick, base, quote, liquidity, quoteFee } =
                orderBook.interface.parseLog(log).args
            return {
                maker,
                baseToken,
                quoteToken,
                lowerTick: +lowerTick,
                upperTick: +upperTick,
                base: PerpService.fromWei(base),
                quote: PerpService.fromWei(quote),
                liquidity: PerpService.fromWei(liquidity),
                quoteFee: PerpService.fromWei(quoteFee),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.LIQUIDITY_CHANGED,
                eventSource: orderBook.address,
            }
        })
    }

    async getFundingPaymentSettledLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<FundingPaymentSettledLog[]> {
        const exchange = this.createExchange()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...exchange.filters.FundingPaymentSettled(trader),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { trader, baseToken, fundingPayment } = exchange.interface.parseLog(log).args
            return {
                trader,
                baseToken,
                fundingPayment: PerpService.fromWei(fundingPayment),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.FUNDING_PAYMENT_SETTLED,
                eventSource: exchange.address,
            }
        })
    }

    async getDepositedLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<DepositedLog[]> {
        const vault = this.createVault()
        const decimals = await vault.decimals()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...vault.filters.Deposited(null, trader),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { collateralToken, trader, amount } = vault.interface.parseLog(log).args
            return {
                collateralToken,
                trader,
                amount: PerpService.fromWei(amount, decimals),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.DEPOSITED,
                eventSource: vault.address,
            }
        })
    }

    async getWithdrawnLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<WithdrawnLog[]> {
        const vault = this.createVault()
        const decimals = await vault.decimals()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...vault.filters.Withdrawn(null, trader),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { token, to, amount } = vault.interface.parseLog(log).args
            return {
                token,
                to,
                amount: PerpService.fromWei(amount, decimals),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.WITHDRAWN,
                eventSource: vault.address,
            }
        })
    }

    async getPnlRealizedLogs(
        fromBlock: BlockTag,
        toBlock: BlockTag,
        trader: string | null = null,
    ): Promise<PnlRealizedLog[]> {
        const accountBalance = this.createAccountBalance()
        const filter = {
            fromBlock: fromBlock,
            toBlock: toBlock,
            ...accountBalance.filters.PnlRealized(trader),
        }
        return (await this.ethService.provider.getLogs(filter)).map((log: EthersLog) => {
            const { trader, amount } = accountBalance.interface.parseLog(log).args
            return {
                trader,
                amount: PerpService.fromWei(amount),
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                txHash: log.transactionHash,
                eventType: EventType.WITHDRAWN,
                eventSource: accountBalance.address,
            }
        })
    }

    async getTickSpacing(poolAddr: string): Promise<number> {
        const pool = this.createPool(poolAddr)
        return await pool.tickSpacing()
    }

    async getMarketPrice(poolAddr: string): Promise<Big> {
        const pool = this.createPool(poolAddr)
        const { sqrtPriceX96 } = await pool.slot0()
        return sqrtPriceX96ToPrice(Big(sqrtPriceX96.toString()))
    }

    async getIndexPrice(baseTokenAddr: string): Promise<Big> {
        const baseToken = this.createBaseToken(baseTokenAddr)
        // use interval 0 to get current index price
        const interval = BigNumber.from(0)
        return PerpService.fromWei(await baseToken.getIndexPrice(interval))
    }

    async getBalance(trader: string): Promise<Big> {
        const vault = this.createVault()
        return PerpService.fromWei(await vault.balanceOf(trader), await this.getVaultDecimals())
    }

    async getFreeCollateral(trader: string): Promise<Big> {
        const vault = this.createVault()
        return PerpService.fromWei(await vault.getFreeCollateral(trader), await this.getVaultDecimals())
    }

    async getAccountValue(trader: string): Promise<Big> {
        const clearingHouse = this.createClearingHouse()
        return PerpService.fromWei(await clearingHouse.getAccountValue(trader))
    }

    async getNetQuoteBalance(trader: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getNetQuoteBalance(trader))
    }

    async getOwedAndUnrealizedPnl(trader: string): Promise<{ owedRealizedPnl: Big; unrealizedPnl: Big }> {
        const accountBalance = this.createAccountBalance()
        const [owedRealizedPnl, unrealizedPnl] = await accountBalance.getOwedAndUnrealizedPnl(trader)
        return {
            owedRealizedPnl: PerpService.fromWei(owedRealizedPnl),
            unrealizedPnl: PerpService.fromWei(unrealizedPnl),
        }
    }

    async getUnrealizedPnl(trader: string): Promise<Big> {
        return (await this.getOwedAndUnrealizedPnl(trader)).unrealizedPnl
    }

    async getOwedRealizedPnl(trader: string): Promise<Big> {
        return (await this.getOwedAndUnrealizedPnl(trader)).owedRealizedPnl
    }

    async getAllPendingFundingPayment(trader: string): Promise<Big> {
        const exchange = this.createExchange()
        return PerpService.fromWei(await exchange.getAllPendingFundingPayment(trader))
    }

    async getPositionSize(trader: string, baseToken: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getPositionSize(trader, baseToken))
    }

    async getPositionValue(trader: string, baseToken: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getPositionValue(trader, baseToken))
    }

    async getOpenNotional(trader: string, baseToken: string): Promise<Big> {
        const exchange = this.createExchange()
        return PerpService.fromWei(await exchange.getOpenNotional(trader, baseToken))
    }

    async getQuote(trader: string, baseToken: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getQuote(trader, baseToken))
    }

    async getBase(trader: string, baseToken: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getBase(trader, baseToken))
    }

    async getBuyingPower(trader: string): Promise<Big> {
        return (await this.getFreeCollateral(trader)).mul(10)
    }

    async getTotalAbsPositionValue(trader: string): Promise<Big> {
        const accountBalance = this.createAccountBalance()
        return PerpService.fromWei(await accountBalance.getTotalAbsPositionValue(trader))
    }

    async getMarginRatio(trader: string): Promise<Big | null> {
        const totalAbsPositionValue = await this.getTotalAbsPositionValue(trader)
        if (totalAbsPositionValue.eq(0)) {
            return null
        }
        const accountValue = await this.getAccountValue(trader)
        return accountValue.div(totalAbsPositionValue)
    }

    async quote(
        baseToken: string,
        side: Side,
        amountType: AmountType,
        amount: Big,
        sqrtPriceLimitX96: Big,
    ): Promise<SwapResponse> {
        const quoter = this.createQuoter()
        let isBaseToQuote: boolean
        let isExactInput: boolean
        if (side === Side.SHORT) {
            isBaseToQuote = true
            // for short, the input is base
            isExactInput = amountType === AmountType.BASE
        } else {
            isBaseToQuote = false
            // for long, the input is quote
            isExactInput = amountType === AmountType.QUOTE
        }
        const resp = await quoter.callStatic.swap({
            baseToken,
            isBaseToQuote,
            isExactInput,
            amount: PerpService.toWei(amount),
            sqrtPriceLimitX96: BigToBN(sqrtPriceLimitX96),
        })
        return {
            deltaAvailableBase: PerpService.fromWei(resp.deltaAvailableBase),
            deltaAvailableQuote: PerpService.fromWei(resp.deltaAvailableQuote),
            exchangedPositionSize: PerpService.fromWei(resp.exchangedPositionSize),
            exchangedPositionNotional: PerpService.fromWei(resp.exchangedPositionNotional),
            afterSwapPrice: sqrtPriceX96ToPrice(Big(resp.sqrtPriceX96.toString())),
        }
    }

    async getOpenOrder(trader: string, baseToken: string, lowerTick: number, upperTick: number): Promise<OpenOrder> {
        const orderBook = this.createOrderBook()
        const openOrder = await orderBook.getOpenOrder(
            trader,
            baseToken,
            BigNumber.from(lowerTick.toString()),
            BigNumber.from(upperTick.toString()),
        )
        return {
            liquidity: Big(openOrder.liquidity.toString()),
            lowerTick: openOrder.lowerTick,
            upperTick: openOrder.upperTick,
            lastFeeGrowthInsideX128: Big(openOrder.lastFeeGrowthInsideX128.toString()),
            lastTwPremiumGrowthInsideX96: Big(openOrder.lastTwPremiumGrowthInsideX96.toString()),
            lastTwPremiumGrowthBelowX96: Big(openOrder.lastTwPremiumGrowthBelowX96.toString()),
            lastTwPremiumDivBySqrtPriceGrowthInsideX96: Big(
                openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96.toString(),
            ),
        }
    }

    async getOpenOrderIds(trader: string, baseToken: string): Promise<string[]> {
        const orderBook = this.createOrderBook()
        return await orderBook.getOpenOrderIds(trader, baseToken)
    }

    async getOpenOrderById(orderId: string): Promise<OpenOrder> {
        const orderBook = this.createOrderBook()
        const openOrder = await orderBook.getOpenOrderById(orderId)
        return {
            liquidity: Big(openOrder.liquidity.toString()),
            lowerTick: openOrder.lowerTick,
            upperTick: openOrder.upperTick,
            lastFeeGrowthInsideX128: Big(openOrder.lastFeeGrowthInsideX128.toString()),
            lastTwPremiumGrowthInsideX96: Big(openOrder.lastTwPremiumGrowthInsideX96.toString()),
            lastTwPremiumGrowthBelowX96: Big(openOrder.lastTwPremiumGrowthBelowX96.toString()),
            lastTwPremiumDivBySqrtPriceGrowthInsideX96: Big(
                openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96.toString(),
            ),
        }
    }

    async getOpenOrders(trader: string, baseToken: string): Promise<OpenOrder[]> {
        const openOrderIds = await this.getOpenOrderIds(trader, baseToken)
        return await Promise.all(openOrderIds.map(async openOrderId => this.getOpenOrderById(openOrderId)))
    }

    async getUncollectedFeeInOrder(
        maker: string,
        baseToken: string,
        lowerTick: number,
        upperTick: number,
    ): Promise<Big> {
        const clearingHouse = this.createClearingHouse()
        const response = await clearingHouse.connect(maker).callStatic.removeLiquidity({
            baseToken,
            lowerTick,
            upperTick,
            liquidity: 0,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        return PerpService.fromWei(response.fee)
    }

    async getUncollectedFeeInMarket(maker: string, baseToken: string): Promise<Big> {
        const openOrders = await this.getOpenOrders(maker, baseToken)
        const uncollectedFees = await Promise.all(
            openOrders.map(openOrder =>
                this.getUncollectedFeeInOrder(maker, baseToken, openOrder.lowerTick, openOrder.upperTick),
            ),
        )
        return sum(uncollectedFees)
    }

    async getTotalUncollectedFee(maker: string): Promise<Big> {
        const baseTokens = this.getAllBaseTokens()
        const uncollectedFees = await Promise.all(
            baseTokens.map(baseToken => this.getUncollectedFeeInMarket(maker, baseToken)),
        )
        return sum(uncollectedFees)
    }

    async getMarketInfo(baseToken: string): Promise<{
        pool: string
        exchangeFeeRatio: number
        uniswapFeeRatio: number
        insuranceFundFeeRatio: number
    }> {
        const marketRegistry = await this.createMarketRegistry()
        const ret = await marketRegistry.getMarketInfo(baseToken)
        return {
            pool: ret.pool,
            exchangeFeeRatio: +ret.exchangeFeeRatio,
            uniswapFeeRatio: +ret.uniswapFeeRatio,
            insuranceFundFeeRatio: +ret.insuranceFundFeeRatio,
        }
    }

    async getPendingFundingPayment(trader: string, baseToken: string): Promise<Big> {
        const exchange = this.createExchange()
        return PerpService.fromWei(await exchange.getPendingFundingPayment(trader, baseToken))
    }
}
