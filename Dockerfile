# syntax=docker/dockerfile:1.7
# OMH Agape: one Node.js process (web + notification worker + maintenance) and SQLite.
FROM node:22.14.0-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22.14.0-bookworm-slim
ENV NODE_ENV=production PORT=8080 AGAPE_DATABASE_PATH=/data/agape.db
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY data ./data
COPY package.json LICENSE ./
COPY deploy/fly/entrypoint.sh /usr/local/bin/agape-entrypoint
RUN chmod 0755 /usr/local/bin/agape-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/agape-entrypoint"]
CMD ["node", "dist/server.js"]
