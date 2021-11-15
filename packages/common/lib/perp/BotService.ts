import { Mutex } from "async-mutex"
import Big from "big.js"
import { ContractTransaction, Overrides, Wallet, constants } from "ethers"
import { Service } from "typedi"

import { L2EthService } from "../eth/L2EthService"
import { BigToBN } from "../helper"
import { Log } from "../loggers"
import { AmountType, PerpService, Side } from "./PerpService"

interface NonceMutex {
    nextNonce: number
    mutex: Mutex
}

const MAX_RETRY_COUNT = 5
@Service()
export abstract class BotService {
    readonly log = Log.getLogger(BotService.name)
    protected readonly addrNonceMutexMap: { [key: string]: NonceMutex } = {}

    constructor(readonly perpService: PerpService, readonly ethService: L2EthService) {}

    abstract setup(): Promise<void>
    abstract start(): Promise<void>

    async createNonceMutex(wallets: Wallet[]) {
        for (const wallet of wallets) {
            this.addrNonceMutexMap[wallet.address] = {
                nextNonce: await wallet.getTransactionCount(),
                mutex: new Mutex(),
            }
        }
    }

    private async retrySendTx(
        wallet: Wallet,
        sendTx: () => Promise<ContractTransaction>,
    ): Promise<ContractTransaction> {
        const nonceMutex = this.addrNonceMutexMap[wallet.address]
        for (let retryCount = 0; retryCount <= MAX_RETRY_COUNT; retryCount++) {
            if (retryCount > 0) {
                this.log.jinfo({ event: "RetrySendTx", params: { retryCount } })
            }
            const release = await nonceMutex.mutex.acquire()
            try {
                const tx = await sendTx()
                nonceMutex.nextNonce++
                this.log.jinfo({
                    event: "TxSent",
                    params: {
                        txHash: tx.hash,
                        gasPrice: tx.gasPrice?.toString(),
                        maxFeePerGas: tx.maxFeePerGas ? tx.maxFeePerGas.toString() : null,
                        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? tx.maxPriorityFeePerGas.toString() : null,
                        gasLimit: tx.gasLimit.toString(),
                        nonce: tx.nonce,
                        rawData: tx.raw,
                    },
                })
                return tx
            } catch (err: any) {
                if (err.code === "NONCE_EXPIRED" || err.message.includes("invalid transaction nonce")) {
                    const expiredNonce = nonceMutex.nextNonce
                    nonceMutex.nextNonce = await wallet.getTransactionCount()
                    this.log.jinfo({
                        event: "NonceReset",
                        params: { expiredNonce: expiredNonce, newNonce: nonceMutex.nextNonce },
                    })
                    continue
                }
                throw err
            } finally {
                release()
            }
        }
        throw Error("max retry count reached")
    }

    async approve(trader: Wallet, amount: Big, overrides?: Overrides): Promise<void> {
        const vault = this.perpService.createVault(trader)
        const testUSDC = this.perpService.createTestUSDC(trader)
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            testUSDC.approve(vault.address, PerpService.toWei(amount), {
                gasLimit: 5_000_000,
                nonce: nonceMutex.nextNonce,
                ...overrides,
            })
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({ event: "ApproveTxSent" })
        await tx.wait()
        this.log.jinfo({ event: "ApproveTxMined" })
    }

    async deposit(trader: Wallet, amount: Big, overrides?: Overrides): Promise<void> {
        const vault = this.perpService.createVault(trader)
        const testUSDC = this.perpService.createTestUSDC(trader)
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            vault.deposit(testUSDC.address, PerpService.toWei(amount), {
                gasLimit: 5_000_000,
                nonce: nonceMutex.nextNonce,
                ...overrides,
            })
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({
            event: "DepositTxSent",
            params: {
                trader: trader.address,
                token: testUSDC.address,
                amount: +amount,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "DepositTxMinded",
            params: {
                trader: trader.address,
                token: testUSDC.address,
                amount: +amount,
                txHash: tx.hash,
            },
        })
    }

    async removeLiquidity(
        trader: Wallet,
        baseToken: string,
        lowerTick: number,
        upperTick: number,
        liquidity: Big,
        overrides?: Overrides,
    ): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(trader)
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.removeLiquidity(
                {
                    baseToken: baseToken,
                    liquidity: BigToBN(liquidity),
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    deadline: constants.MaxUint256,
                },
                {
                    gasLimit: 5_000_000,
                    nonce: nonceMutex.nextNonce,
                    ...overrides,
                },
            )
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({
            event: "RemoveLiquidityTxSent",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                liquidity: +liquidity,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "RemoveLiquidityTxMined",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                liquidity: +liquidity,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        })
    }

    async addLiquidity(
        trader: Wallet,
        baseToken: string,
        lowerTick: number,
        upperTick: number,
        base: Big,
        quote: Big,
        overrides?: Overrides,
    ): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(trader)
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.addLiquidity(
                {
                    baseToken: baseToken,
                    base: PerpService.toWei(base),
                    quote: PerpService.toWei(quote),
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    deadline: constants.MaxUint256,
                },
                {
                    gasLimit: 5_000_000,
                    nonce: nonceMutex.nextNonce,
                    ...overrides,
                },
            )
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({
            event: "AddLiquidityTxSent",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                base: +base,
                quote: +quote,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "AddLiquidityTxMined",
            params: {
                trader: trader.address,
                baseToken,
                lowerTick,
                upperTick,
                base: +base,
                quote: +quote,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        })
    }

    async openPosition(
        trader: Wallet,
        baseToken: string,
        side: Side,
        amountType: AmountType,
        amount: Big,
        overrides?: Overrides,
    ): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(trader)
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
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.openPosition(
                {
                    baseToken,
                    isBaseToQuote,
                    isExactInput,
                    amount: PerpService.toWei(amount),
                    oppositeAmountBound: 0,
                    deadline: constants.MaxUint256,
                    sqrtPriceLimitX96: 0,
                    referralCode: constants.HashZero,
                },
                {
                    gasLimit: 5_000_000,
                    nonce: nonceMutex.nextNonce,
                    ...overrides,
                },
            )
        const startTime = Date.now()
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({
            event: "OpenPositionTxSent",
            params: {
                trader: trader.address,
                baseToken,
                isBaseToQuote,
                isExactInput,
                amount: +amount,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "OpenPositionTxMinded",
            params: {
                trader: trader.address,
                baseToken,
                isBaseToQuote,
                isExactInput,
                amount: +amount,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
                timeSpent: Date.now() - startTime,
            },
        })
    }

    async closePosition(trader: Wallet, baseToken: string, overrides?: Overrides): Promise<void> {
        const currentPositionSize = await this.perpService.getPositionSize(trader.address, baseToken)
        if (currentPositionSize.eq(0)) {
            return
        }

        const clearingHouse = this.perpService.createClearingHouse(trader)
        const nonceMutex = this.addrNonceMutexMap[trader.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.closePosition(
                {
                    baseToken,
                    sqrtPriceLimitX96: PerpService.toWei(Big(0)),
                    oppositeAmountBound: PerpService.toWei(Big(0)),
                    deadline: constants.MaxUint256,
                    referralCode: constants.HashZero,
                },
                {
                    gasLimit: 5_000_000,
                    nonce: nonceMutex.nextNonce,
                    ...overrides,
                },
            )
        const tx = await this.retrySendTx(trader, sendTx)
        this.log.jinfo({
            event: "ClosePositionTxSent",
            params: {
                trader: trader.address,
                baseToken,
            },
        })
        await tx.wait()
        this.log.jinfo({
            event: "ClosePositionTxMinded",
            params: {
                trader: trader.address,
                baseToken,
                txHash: tx.hash,
                currentPositionSize: +(await this.perpService.getPositionSize(trader.address, baseToken)),
            },
        })
    }

    async cancelAllExcessOrders(
        signer: Wallet,
        maker: string,
        baseToken: string,
        overrides?: Overrides,
    ): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(signer)
        const nonceMutex = this.addrNonceMutexMap[signer.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.cancelAllExcessOrders(maker, baseToken, {
                gasLimit: 5_000_000,
                nonce: nonceMutex.nextNonce,
                ...overrides,
            })
        const tx = await this.retrySendTx(signer, sendTx)
        this.log.jinfo({
            event: "CancelAllExcessOrdersTxSent",
            params: {
                signer: signer.address,
                maker,
                baseToken,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "CancelAllExcessOrdersTxMined",
            params: {
                signer: signer.address,
                maker,
                baseToken,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        })
    }

    async liquidate(signer: Wallet, trader: string, baseToken: string, overrides?: Overrides): Promise<void> {
        const clearingHouse = this.perpService.createClearingHouse(signer)
        const nonceMutex = this.addrNonceMutexMap[signer.address]
        const sendTx = (): Promise<ContractTransaction> =>
            clearingHouse.liquidate(trader, baseToken, {
                gasLimit: 5_000_000,
                nonce: nonceMutex.nextNonce,
                ...overrides,
            })
        const tx = await this.retrySendTx(signer, sendTx)
        this.log.jinfo({
            event: "LiquidateTxSent",
            params: {
                signer: signer.address,
                trader,
                baseToken,
            },
        })

        await tx.wait()
        this.log.jinfo({
            event: "LiquidateTxMined",
            params: {
                signer: signer.address,
                trader,
                baseToken,
                txHash: tx.hash,
                gasPrice: tx.gasPrice?.toString(),
                maxFeePerGas: tx.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                gasLimit: tx.gasLimit.toString(),
                nonce: tx.nonce,
                rawData: tx.raw,
            },
        })
    }
}
