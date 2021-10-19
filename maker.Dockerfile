#
# Builder stage
#
FROM node:16 AS builder

# Use non-root user to avoid unexpected npm behaviors.
RUN groupadd -r perp && useradd --no-log-init --create-home -r -g perp perp
USER perp

# Copy npm install dependencies so we can cache the results independently.
WORKDIR /home/perp
COPY --chown=perp:perp ./packages/maker/package*.json ./packages/maker/
COPY --chown=perp:perp ./packages/common/package*.json ./packages/common/
COPY --chown=perp:perp ./package*.json ./
RUN npm ci --quiet

# Copy source codes for building.
COPY --chown=perp:perp ./packages/maker ./packages/maker
COPY --chown=perp:perp ./packages/common ./packages/common
WORKDIR /home/perp/packages/common
RUN npm run build
WORKDIR /home/perp/packages/maker
RUN npm run build

#
# Production stage
#
FROM node:16-alpine

# Use non-root user to avoid unexpected npm behaviors.
RUN addgroup perp && adduser -G perp -S -s /bin/sh -D perp perp
USER perp

ENV NODE_ENV=production

WORKDIR /home/perp
COPY --chown=perp:perp --from=builder /home/perp/packages/common ./packages/common
COPY --chown=perp:perp --from=builder /home/perp/node_modules ./node_modules
COPY --chown=perp:perp --from=builder /home/perp/packages/maker/build ./packages/maker/build
ENTRYPOINT ["node", "packages/maker/build/index.js"]
