# Build context: repository root.  docker build -f docker/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST_DIR=/app/web PORT=4000
COPY docker/runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./web
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "dist/main.js"]
