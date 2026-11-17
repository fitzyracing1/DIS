FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
COPY package.json package-lock.json LICENSE README.md status.config.json ./
COPY bin/ ./bin/
COPY lib/ ./lib/
# Optional x402 deps for paid /check/report (free /check still works without them loaded at runtime).
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "bin/dis.mjs", "serve"]
