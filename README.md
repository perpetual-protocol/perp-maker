<img width="1012" alt="maker" src="https://user-images.githubusercontent.com/105896/168986674-3b7169c1-c8ad-45dc-9d40-3653ff2766f4.png">

# Perp Maker

A simple maker strategy for perpetual protocol v2. Please note that it uses a basic strategy and serves as a template for developers to create their own maker strategy. Use it at your own risk!

## Requirement

-   `npm >=7 <=7.24.1`
-   `nodejs >= 16`
-   Since maker strategy will adjust your order, please make sure there's only 0 or 1 order in the account.

> **Warning**
> Check your npm version by using `npm -v`. It must be within the range of `v7.0.0` ~ `v7.24.1`. `v7.24.1` is recommended. Using the versions > `7.24.1` to install packages will get stuck. To install or reinstall npm, run `npm install -g npm@7.x.x`

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

            // the offset to upper price and lower price of the liquidity range.
            // e.g. if set to 0.5, it will provide liquidity with range [current price / 1.5, current price * 1.5]
            "LIQUIDITY_RANGE_OFFSET": 0.5,

            // the offset to adjust range liquidity.
            // e.g. if set to 0.1, it will adjust liquidity when the current price goes out of the range [market price / 1.1, market price * 1.1]
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

# stage
STAGE=["production"|"staging"]

# network
NETWORK=["optimism"|"optimism-goerli"]
```

## Market Metadata
We have different markets between optimism and optimism-goerli.

Please check the market metadata in the following links:
- [optimism metadata](https://metadata.perp.exchange/v2/core/optimism.json)
- [optimism-goerli metadata](https://metadata.perp.exchange/v2/core/optimism-goerli.json)

## Run

```bash
$ env $(cat .env | grep -v '#' | xargs) npm run start
```

## Docker

```bash
$ docker build -f maker.Dockerfile -t perp-maker .
$ docker run --env-file ./.env perp-maker
```

## Deployment

### AWS Lambda

Prerequisite

-   `~/.aws/credentials` should have default profile with `aws_access_key_id` and `aws_secret_access_key`
-   copy `.env.example` to `.env`
-   Fill in envs in `.env`

Deploy

```bash
npm run build
npm run sls:deploy
```

---

> If any features/functionalities described in the Perpetual Protocol documentation, code comments, marketing, community discussion or announcements, pre-production or testing code, or other non-production-code sources, vary or differ from the code used in production, in case of any dispute, the code used in production shall prevail.

