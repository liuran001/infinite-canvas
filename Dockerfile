# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建 Node 后端产物。用 Debian 而不是 alpine：better-sqlite3 是原生模块，
# glibc 平台有官方预编译包，缺失时也能用这里装好的工具链回退源码编译。
FROM node:22-bookworm-slim AS server-build

WORKDIR /app/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server ./
RUN npm run build && npm prune --omit=dev

# 运行镜像：nginx 托管前端静态资源，并把 /api 反代到同容器内的 Node 后端。
FROM nginx:1.27-bookworm

COPY --from=server-build /usr/local/bin/node /usr/local/bin/node
COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY --from=server-build /app/server/dist /app/server/dist
COPY --from=server-build /app/server/node_modules /app/server/node_modules
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
COPY docker-entrypoint.sh /docker-entrypoint.d/50-server.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/50-server.sh \
    && mkdir -p /app/data

# 数据库文件与本地上传文件都落在 /app/data，挂卷即可持久化。
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    DATABASE_DSN=/app/data/infinite-canvas.db

EXPOSE 3000
