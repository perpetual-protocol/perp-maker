# Perp Maker

A simple maker strategy for perpetual protocol v2.

## Requirement

npm >= 7
nodejs >= 16

Since maker strategy will adjust your order, please make sure there's only 0 or 1 order in the account.

## Installation

```bash
git clone https://github.com/perpetual-protocol/perp-maker.git
cd perp-maker
npm i
npm run build
```

## Run

```bash
# provide ENVs:
# L2_WEB3_ENDPOINT: web3 endpoint
# NETWORK: arbitrum-rinkeby or rinkeby
# PRIVATE_KEY: your private key
npm run start
```
