FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY openapi.yaml ./openapi.yaml

RUN npm prune --omit=dev

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
