export type Stage = "production" | "staging" | "test"

export type Network = "arbitrumRinkeby"
export type Layer = "layer1" | "layer2"

export interface Metadata {
    network: Network
    contracts: Map<string, ContractMetadata>
    pools: PoolMetadata[]
    externalContracts: Map<string, string>
}

export interface ContractMetadata {
    name: string
    address: string
}

export interface PoolMetadata {
    address: string
    baseSymbol: string
    baseAddress: string
    quoteSymbol: string
    quoteAddress: string
}
