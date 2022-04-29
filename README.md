# Perp Maker

A simple maker strategy for perpetual protocol v2.

## Requirement

-   `npm >= 7`
-   `nodejs >= 16`

Since maker strategy will adjust your order, please make sure there's only 0 or 1 order in the account.

## Installation

```bash
git clone https://github.com/perpetual-protocol/perp-maker.git
cd perp-maker
npm i --legacy-peer-deps
npm run build
```

## Configuration

#### Config File: `perp-maker/src/configs/config.json`

-   `PRICE_CHECK_INTERVAL_SEC`: the frequency to check price in second
-   `ADJUST_MAX_GAS_PRICE_GWEI`: the maximum gas fee in Gwei to adjust order. If gas price exceeds this number, the order won't be adjusted
-   `IS_ENABLED`: set to `true` to enable this market
-   `LIQUIDITY_AMOUNT`: how many amount of USD (after leverage) to provide in the order
-   `LIQUIDITY_RANGE_OFFSET`: the offset to upper price and lower price of the range. ex: if set to 0.05, it will provide a +-5% range order around market price
-   `LIQUIDITY_ADJUST_THRESHOLD`: the offset to adjust range order. ex: if set to 0.01, it will adjust order when the price is 1% closed to upper price and lower price

## Run

```bash
# remember to update config before running
# provide ENVs:
# L2_WEB3_ENDPOINT: web3 endpoint
# NETWORK: optimism or optimism-kovan
# PRIVATE_KEY: your private key
npm start
```

## Docker

```bash
docker build -f maker.Dockerfile -t perp-maker .
docker run -e L2_WEB3_ENDPOINT=<ENDPOINT> -e NETWORK=<optimism or optimism-kovan> -e PRIVATE_KEY=<YOUR_PRIVATE_KEY> perp-maker
```
