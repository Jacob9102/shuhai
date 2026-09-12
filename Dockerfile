# syntax=docker/dockerfile:1
#
# 书海 ShuHai —— 全网小说搜索与阅读服务
#
# 零运行时依赖：镜像里只有 Node 标准库 + 本项目源码，没有 node_modules。
# 好处是构建只需几秒、可完全离线构建、也不存在第三方供应链风险。

FROM node:24-alpine

# tini     : 作为 PID 1 正确处理信号，容器可优雅退出
# su-exec  : 入口脚本用它把 root 降权到 PUID:PGID 后再启动服务
# 若基础镜像缺少 full-icu（中文编码依赖），改成 node:24-slim 即可
RUN apk add --no-cache tini su-exec

WORKDIR /app

ENV NODE_ENV=production \
    SHUHAI_HOST=0.0.0.0 \
    SHUHAI_PORT=8080 \
    SHUHAI_DB=/data/shuhai.db \
    TZ=Asia/Shanghai

# 只拷贝运行所需内容
COPY package.json ./
COPY src ./src
COPY web ./web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/verify-runtime.mjs /usr/local/bin/verify-runtime.mjs

# 关于最后的 chmod -R a+rX /app：
# COPY 会原样保留构建上下文里的文件权限。若项目文件是在 umask 077 的环境下
# 创建的（权限 600），镜像里 /app 下的源码就是 600 root:root；而 entrypoint
# 会降权到 PUID:PGID 运行，届时连 src/server.mjs 都读不出来，报
# EACCES: permission denied, open '/app/src/server.mjs'。
# 这里统一放开读权限，让镜像不受宿主机 umask 影响。
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/verify-runtime.mjs \
 && mkdir -p /data \
 && chmod -R a+rX /app

# 构建期能力自检：缺 GBK 解码或 node:sqlite 就让构建失败，
# 而不是等用户导入书源后才发现满屏乱码。
RUN node /usr/local/bin/verify-runtime.mjs

VOLUME ["/data"]
EXPOSE 8080

# 健康检查：不依赖 curl/wget，直接用 Node 打自己的 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SHUHAI_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 故意以 root 启动：由 entrypoint 修正数据卷属主后降权到 PUID:PGID。
# 若希望容器内完全不出现 root 进程，可在 compose 中设置 user: "1000:1000"。
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.mjs"]
