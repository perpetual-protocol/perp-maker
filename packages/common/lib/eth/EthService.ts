/* eslint-disable @typescript-eslint/no-explicit-any */
import { Signer } from "@ethersproject/abstract-signer"
import { Block, JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers"
import { formatUnits, parseUnits } from "@ethersproject/units"
import Big from "big.js"
import { BigNumber, ContractInterface, Wallet, ethers } from "ethers"
import { Service } from "typedi"

import { Log } from "../loggers"
import { Layer } from "../types"

const SUBSCRIPTION_HEALTH_CHECK_INTERVAL_MSEC = 5 * 1_000
const SUBSCRIPTION_NO_RESPONSE_INTERVAL_MSEC = 3 * 60 * 1_000

@Service()
export class EthService {
    readonly log = Log.getLogger(EthService.name)
    protected web3EndpointsIndex: number = 0
    protected lastResponseTime: number = 0

    // TODO: currently only Alchemy provides ws endpoint for Arbitrum
    // Offchain Labs and Infura only provide RPC endpoint
    // provider!: WebSocketProvider
    provider!: JsonRpcProvider | WebSocketProvider

    constructor(readonly layer: Layer, readonly web3Endpoints: string[]) {
        const web3Endpoint = web3Endpoints[this.web3EndpointsIndex]
        if (!web3Endpoint) {
            throw Error("web3 endpoint not found")
        }

        this.log.info(
            JSON.stringify({
                event: "InitEthServiceProvider",
                params: {
                    layer,
                    web3Endpoints,
                },
            }),
        )

        this.provider = EthService.providerFactory(web3Endpoint)
    }

    protected static providerFactory(endpoint: string): JsonRpcProvider | WebSocketProvider {
        return EthService.isWebSocketEndpoint(endpoint)
            ? new WebSocketProvider(endpoint)
            : new JsonRpcProvider(endpoint)
    }

    static isWebSocketEndpoint(endpoint: string): boolean {
        return endpoint.startsWith("wss://")
    }

    privateKeyToWallet(privateKey: string): Wallet {
        return new ethers.Wallet(privateKey, this.provider)
    }

    createContract<T>(address: string, abi: ContractInterface, signer?: Signer): T {
        return new ethers.Contract(address, abi, signer ? signer : this.provider) as unknown as T
    }

    static fromWei(value: BigNumber, decimals = 18): Big {
        return Big(formatUnits(value, decimals).toString())
    }

    static toWei(value: Big, decimals = 18): BigNumber {
        return parseUnits(value.toFixed(decimals), decimals)
    }

    subscribeToNewBlocks(callback: NewBlockCallback): void {
        this.provider.on("block", (blockNumber: number) => {
            this.lastResponseTime = Date.now()
            callback(blockNumber)
        })

        this.provider.on("error", tx => {
            this.log.jinfo({
                event: "NewBlockSubscriptionError",
                params: { tx },
            })
        })

        // prevent endpoint rotation being triggered immediately
        this.lastResponseTime = Date.now()
        setTimeout(this.subscriptionHealthCheck.bind(this), SUBSCRIPTION_HEALTH_CHECK_INTERVAL_MSEC, callback)
    }

    private subscriptionHealthCheck(callback: NewBlockCallback) {
        const noResponseInterval = Date.now() - this.lastResponseTime
        if (noResponseInterval > SUBSCRIPTION_NO_RESPONSE_INTERVAL_MSEC) {
            this.log.jinfo({
                event: "NewBlockSubscriptionNoResponse",
                params: { noResponseInterval },
            })

            this.rotateToNextEndpoint()
            this.subscribeToNewBlocks(callback)
        } else {
            setTimeout(this.subscriptionHealthCheck.bind(this), SUBSCRIPTION_HEALTH_CHECK_INTERVAL_MSEC, callback)
        }
    }

    rotateToNextEndpoint() {
        this.provider.removeAllListeners()

        if (this.provider instanceof WebSocketProvider) {
            this.provider.destroy()
        }

        const fromEndpoint = this.provider.connection.url
        this.web3EndpointsIndex = (this.web3EndpointsIndex + 1) % this.web3Endpoints.length
        const toEndpoint = this.web3Endpoints[this.web3EndpointsIndex]
        this.provider = EthService.providerFactory(toEndpoint)

        this.log.jinfo({
            event: "RotatedEndpoint",
            params: { fromEndpoint, toEndpoint },
        })
    }

    async getBlock(blockNumber: number): Promise<Block> {
        return await this.provider.getBlock(blockNumber)
    }

    async getBlocks(blockNumbers: number[]): Promise<Record<number, Block>> {
        const blocksMap: Record<number, Block> = {}
        await Promise.all(
            blockNumbers.map(async blockNumber => {
                blocksMap[blockNumber] = await this.getBlock(blockNumber)
            }),
        )
        return blocksMap
    }

    async getLatestBlockNumber(): Promise<number> {
        return await this.provider.getBlockNumber()
    }

    async checkBlockNumberWithLatency(): Promise<{ blockNumber: number; latency: number }> {
        const startTime = Date.now()
        const blockNumber = await this.getLatestBlockNumber()
        const latency = Date.now() - startTime
        return { blockNumber, latency }
    }
}

export type NewBlockCallback = (blockNumber: number) => void
