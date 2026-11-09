# Roloe coordinator. Runs no model and holds no assistant login.
FROM node:22-slim
ENV NODE_ENV=production PORT=7420 ROLOE_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY bin ./bin
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7420
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7420/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/coordinator.mjs"]
