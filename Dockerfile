FROM node:26-alpine AS dependencies

WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json

FROM dependencies AS web-build
RUN pnpm install --frozen-lockfile
COPY web/ ./web/
RUN pnpm --filter web build

FROM dependencies AS production-dependencies
RUN pnpm install --prod --filter asabot --frozen-lockfile

FROM node:26-alpine AS runtime

ENV NODE_ENV=production
# A directory, not a single file: write-back renames a temp file over the config, which fails on a file bind mount.
ENV ASABOT_CONFIG=/app/config/asabot.config.yaml
WORKDIR /app
RUN apk add --no-cache tini \
    && mkdir -p /app/data /app/plugins /app/config \
    && chown node:node /app /app/data /app/plugins /app/config

COPY --from=production-dependencies /app/node_modules/ ./node_modules/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/ ./src/
COPY --from=web-build /app/web/dist/ ./web/dist/
COPY --chown=node:node plugins/echo.ts plugins/guess.ts ./plugins/

USER node
EXPOSE 5140
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5140/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
