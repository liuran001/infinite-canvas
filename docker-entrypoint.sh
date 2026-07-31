#!/bin/sh
set -e

# 由 nginx 官方镜像的入口在启动前自动执行（/docker-entrypoint.d/*.sh），随后 nginx 在前台拉起。
# 后端固定监听 8080，和 nginx.conf 里的反代地址对应，避免外部传入的 PORT 与 nginx 的 3000 端口冲突。
export PORT=8080

mkdir -p "${DATA_DIR:-/app/data}"

cd /app/server
# 后端退出说明服务已经不可用，直接终止 PID 1 让容器整体退出并由 restart 策略拉起；
# 否则只剩 nginx 在跑，页面能打开但所有 /api 请求都会失败且没有任何告警。
# 生成任务的状态都已落库，重启后会自动重新入队，不会丢任务。
(node dist/index.js; echo "后端进程已退出，终止容器" >&2; kill 1) &
