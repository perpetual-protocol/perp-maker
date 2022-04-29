# Perp Maker

A simple maker strategy for perpetual protocol v2. Please note that it uses a basic strategy and serves as a template for developers to create their own maker strategy. Use it at your own risk!

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

Remember to update config before running.

#### Config File: `perp-maker/src/configs/config.json`

-   `PRICE_CHECK_INTERVAL_SEC`: the frequency to check price in second
-   `ADJUST_MAX_GAS_PRICE_GWEI`: the maximum gas fee in Gwei to adjust liquidity. If gas price exceeds this number, the liquidity won't be adjusted
-   `IS_ENABLED`: set to `true` to enable this market
-   `LIQUIDITY_AMOUNT`: how many amount of USD (after leverage) to provide in the liquidity
-   `LIQUIDITY_RANGE_OFFSET`: the offset to upper price and lower price of the liquidity range. ex: if set to 0.05, it will provide liquidity with range [current price / 1.05, current price * 1.05]
-   `LIQUIDITY_ADJUST_THRESHOLD`: the offset to adjust range liquidity. ex: if set to 0.01, it will adjust liquidity when the current price goes out of the range [market price / 1.01, market price * 1.01]

## Environment Variables

```bash
L2_WEB3_ENDPOINTS={endpoint1},{endpoint2},...
NETWORK=optimism or optimism-kovan
PRIVATE_KEY={your private key}
```

## Run

```bash
npm start
```

## Docker

```bash
docker build -f maker.Dockerfile -t perp-maker .
docker run -e L2_WEB3_ENDPOINT=<ENDPOINT> -e NETWORK=<optimism or optimism-kovan> -e PRIVATE_KEY=<YOUR_PRIVATE_KEY> perp-maker
```
