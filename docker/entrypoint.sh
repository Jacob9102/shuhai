#!/bin/sh
# 书海 ShuHai 容器入口
#
# 解决的问题：docker compose 把宿主机的 ./data 挂到容器 /data 时，
# 目录属主往往是宿主机用户（甚至 root），而容器内默认以 node(1000) 运行，
# 结果就是「数据库无法写入」——这是自托管应用最常见的坑。
#
# 处理方式：
#   * 以 root 启动时，自动把数据目录调整到 PUID:PGID（默认 1000:1000），
#     然后用 su-exec 降权运行真正的进程；进程本身始终不是 root。
#   * 若 compose 里已经指定了 user:，则直接以该用户运行，不做任何修改。
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${SHUHAI_DB:-/data/shuhai.db}")"

  mkdir -p "$DATA_DIR" 2>/dev/null || true

  # 只有当目标目录对运行用户不可写时才改属主，避免无谓地大范围 chown
  if ! su-exec "$PUID:$PGID" test -w "$DATA_DIR" 2>/dev/null; then
    echo "[entrypoint] 数据目录 $DATA_DIR 对 $PUID:$PGID 不可写，正在修正属主…"
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || \
      echo "[entrypoint] 警告：chown 失败，若出现写入错误请在宿主机执行 chown -R $PUID:$PGID ./data"
  fi

  export HOME="${HOME:-/tmp}"
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
