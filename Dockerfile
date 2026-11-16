# wbsbx daemon 镜像
#
#   docker build -t wbsbx-daemon:slim .                    # 纯 HTTP 刷 token，~150MB
#   docker build -t wbsbx-daemon:full --build-arg WITH_BROWSER=1 .   # 带 chromium，能续登录态
#
# full 版多出来的东西只有一个用途：cookie 快满 7 天时，用真浏览器走一次 SSO 换新 session。
# 不需要它就把 renew.enabled 留 false，用 slim 就行。
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json ./
# playwright-core 是 optionalDependency，装它但不装浏览器二进制，slim 版靠它也只是个空驱动
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force 2>/dev/null || true

FROM ${NODE_IMAGE} AS base
# 容器里必须听 0.0.0.0，否则宿主端口映射打不进去（映射转到容器 IP，不是容器回环）。
# 安全性由 compose 里的 "127.0.0.1:8787:8787" 和强制令牌保证。
ENV NODE_ENV=production \
    WB_CLOUD_HOME=/data \
    WBSBX_DAEMON_HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY commands ./commands
COPY docs ./docs
COPY README.md LICENSE ./
RUN mkdir -p /data && chown -R node:node /data /app
# 用非 root 跑：挂载出来的 state.json / 日志在 Linux 宿主上是 UID 1000，宿主用户一般能直接读
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/wbsbx-daemon.js"]

# ---------- slim（默认） ----------
FROM base AS slim

# ---------- full：带 chromium，能自动续登录态 ----------
FROM base AS full
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# browser.js 会按这个顺序找：/usr/bin/chromium*
ENV WBSBX_BROWSER=/usr/bin/chromium
USER node
