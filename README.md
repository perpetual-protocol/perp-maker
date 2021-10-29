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
npm i
npm run build
```

## Configuration

#### Config File: `perp-maker/packages/maker/src/configs/config.json`

-   `PRICE_CHECK_INTERVAL_SEC`: the frequency to check price in second
-   `IS_ENABLED`: set to `true` to enable this market
-   `CURRENT_RANGE_LIQUIDITY_AMOUNT`: how many amount of USD (after leverage) to provide in the current range order
-   `CURRENT_RANGE_LIQUIDITY_RANGE_OFFSET`: the offset to upper price and lower price of current range. ex: if set to 0.05, it will provide a +-5% range order around market price
-   `CURRENT_RANGE_LIQUIDITY_ADJUST_THRESHOLD`: the offset to adjust range order. ex: if set to 0.01, it will adjust current range order when the price is 1% closed to upper price and lower price

## Run

```bash
# remember to update config before running
# provide ENVs:
# L2_WEB3_ENDPOINT: web3 endpoint
# NETWORK: arbitrum-rinkeby or rinkeby
# PRIVATE_KEY: your private key
npm run start
```

## Docker

```bash
docker build -f maker.Dockerfile -t perp-maker .
docker run -e L2_WEB3_ENDPOINT=<ENDPOINT> -e NETWORK=<arbitrum-rinkeby or rinkeby> -e PRIVATE_KEY=<YOUR_PRIVATE_KEY> perp-maker
```
