# Build once, run the same image as API, worker or a one-off CLI.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 MEDIA_DIR=/data/media
WORKDIR /app
RUN groupadd --gid 10001 veshi && useradd --uid 10001 --gid veshi --no-create-home veshi \
    && mkdir -p /data/media && chown veshi:veshi /data/media
COPY --from=build --chown=veshi:veshi /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=veshi:veshi /app/dist ./dist
COPY --from=build --chown=veshi:veshi /app/dist-server ./dist-server
COPY --from=build --chown=veshi:veshi /app/server/migrations ./dist-server/server/migrations
USER veshi
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server/main.js"]
