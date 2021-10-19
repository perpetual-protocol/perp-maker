import Big from "big.js"
import { BigNumber } from "ethers"

export function sleep(ms: number): Promise<unknown> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function BNToBig(n: BigNumber): Big {
    return Big(n.toString())
}

export function BigToBN(n: Big): BigNumber {
    // BigNumber.from does not accept string exponential notation
    // We use toFixed() instead of toString() to prevent exponential notation string
    // ref: https://mikemcl.github.io/big.js/#toF
    return BigNumber.from(n.toFixed())
}

export function getMinTick(tickSpacing: number): number {
    return Math.ceil(-887272 / tickSpacing) * tickSpacing
}

export function getMaxTick(tickSpacing: number): number {
    return Math.floor(887272 / tickSpacing) * tickSpacing
}

export function tickToPrice(tick: number): Big {
    return Big(Math.pow(1.0001, tick))
}

function getBaseLog(x: number, y: number) {
    return Math.log(y) / Math.log(x)
}

export function priceToTick(price: Big, tickSpacing: number): number {
    const tick = getBaseLog(1.0001, +price)
    return Math.round(tick / tickSpacing) * tickSpacing
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: Big): Big {
    const Q96 = new Big(2).pow(96)
    return sqrtPriceX96.div(Q96).pow(2)
}

// [min, max)
export function getRandomNumber(min: number, max: number): number {
    return Math.random() * (max - min) + min
}
