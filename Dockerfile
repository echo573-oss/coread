FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Windows 上传的源文件是 mode 600，Docker 的 COPY 会原样保留权限。
# 容器以非 root 运行（compose: COREAD_UID/COREAD_GID，NAS 上为 1001:10），
# 于是 node 读不到 /app/server.mjs 与 /app/lib/*.mjs：
#   Error: EACCES: permission denied, open '/app/server.mjs'
# 只对需要的路径置为「所有人可读、目录可进入」（a+rX，即 644/755，不是 777）。
# 注意：不要用 chmod -R /app —— 会递归 node_modules 的数万个文件，
# 在这台 N100 + Btrfs 上会长时间卡住（实测 >5 分钟无进展）。
# node_modules 是容器内 npm ci 生成的，权限本来就正确，无需处理。
RUN chmod a+rX /app/server.mjs /app/package.json \
 && find /app/lib /app/public -exec chmod a+rX {} +
RUN npm run check && npm test && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production COREAD_HOST=0.0.0.0 COREAD_PORT=3000 COREAD_DB=/data/coread.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]
