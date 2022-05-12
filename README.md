# Perp Maker

A simple maker strategy for perpetual protocol v2. Please note that it uses a basic strategy and serves as a template for developers to create their own maker strategy. Use it at your own risk!

## Requirement

-   `npm >= 7`
-   `nodejs >= 16`

Since maker strategy will adjust your order, please make sure there's only 0 or 1 order in the account.

## Installation

```bash
$ git clone https://github.com/perpetual-protocol/perp-maker.git
$ cd perp-maker
$ npm install
$ npm run build
```


## Configuration
Edit the trading parameters in `src/configs/config.json`:

```javascript
{
    // the frequency to check price in second
    "PRICE_CHECK_INTERVAL_SEC": 10,
    // the maximum gas fee in Gwei to adjust liquidity. If gas price exceeds this number, the liquidity won't be adjusted
    "ADJUST_MAX_GAS_PRICE_GWEI": 100,

    // Maximum 5 markets
    "MARKET_MAP": {
        "vBTC": {
            // set to `true` to enable this market
            "IS_ENABLED": true,
            // how many amount of USD (after leverage) to provide in the liquidity
            "LIQUIDITY_AMOUNT": 0,

            // the offset to upper price and lower price of the liquidity range. ex: if set to 0.05, it will provide liquidity with range [current price / 1.05, current price * 1.05]
            "LIQUIDITY_RANGE_OFFSET": 0.5,

            // the offset to adjust range liquidity. ex: if set to 0.01, it will adjust liquidity when the current price goes out of the range [market price / 1.01, market price * 1.01]
            "LIQUIDITY_ADJUST_THRESHOLD": 0.1
        },
    }
}
```

## Environment Variables
Provide your endpoint(s) and wallet private key in `.env`:

```bash
# endpoint(s)
L2_WEB3_ENDPOINTS={ENDPOINT1,ENDPOINT2,...}

# secrets
PRIVATE_KEY={WALLET_PRIVATE_KEY}
```

## Run

```bash
$ env $(cat .env | grep -v '#' | xargs) npm run start
```

## Docker

```bash
$ docker build -f maker.Dockerfile -t perp-maker .
$ docker run --env-file ./.env perp-maker
```
