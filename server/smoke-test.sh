#!/usr/bin/env bash
# 后端冒烟测试：启动服务并跑通登录、设置、文件、项目、任务幂等等主链路。
# 用法：bash server/smoke-test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
BASE="http://127.0.0.1:18080/api"
PASS=0
FAIL=0

cleanup() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "${UPSTREAM_PID:-}" ] && kill "$UPSTREAM_PID" 2>/dev/null
    wait "$SERVER_PID" "$UPSTREAM_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

check() {
    if [ "$2" = "$3" ]; then
        printf '  \033[32mOK\033[0m   %s\n' "$1"
        PASS=$((PASS + 1))
    else
        printf '  \033[31mFAIL\033[0m %s\n       期望 %s，实际 %s\n' "$1" "$3" "$2"
        FAIL=$((FAIL + 1))
    fi
}

cd "$ROOT"
PORT=18080 \
    ADMIN_USERNAME=admin ADMIN_PASSWORD=smoke-test \
    JWT_SECRET=smoke-test-secret \
    STORAGE_DRIVER=sqlite DATABASE_DSN="$WORK/test.db" DATA_DIR="$WORK/data" \
    npx tsx src/index.ts >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && break
    sleep 0.5
done

if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
    echo "服务启动失败，日志："
    cat "$WORK/server.log"
    exit 1
fi

echo "健康检查与公开接口"
check "GET /health" "$(curl -s "$BASE/health" | jq -r .data)" "ok"
check "GET /settings 默认开放注册" "$(curl -s "$BASE/settings" | jq -r .data.auth.allowRegister)" "true"
check "GET /auth/me 未登录返回访客" "$(curl -s "$BASE/auth/me" | jq -r .data.role)" "guest"
check "未登录访问受限接口返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/jobs")" "401"

echo "认证"
ADMIN_TOKEN=$(curl -s -X POST "$BASE/admin/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"smoke-test"}' | jq -r .data.token)
check "管理员登录拿到令牌" "$([ -n "$ADMIN_TOKEN" ] && [ "$ADMIN_TOKEN" != "null" ] && echo yes || echo no)" "yes"
check "错误密码被拒绝" "$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}' | jq -r .msg)" "用户名或密码错误"
USER_TOKEN=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"tester","password":"tester-pass"}' | jq -r .data.token)
check "普通用户注册拿到令牌" "$([ -n "$USER_TOKEN" ] && [ "$USER_TOKEN" != "null" ] && echo yes || echo no)" "yes"
check "重复用户名被拒绝" "$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"tester","password":"x"}' | jq -r .msg)" "用户名已存在"
check "普通用户访问后台被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/users" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "管理员可读用户列表" "$(curl -s "$BASE/admin/users" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "2"

echo "系统设置"
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "测试渠道", "baseUrl": "https://api.example.com", "apiKey": "sk-secret", "models": [{ "name": "gpt-image-2", "capability": "image" }], "weight": 1, "enabled": true }] },
  "public": { "modelChannel": { "modelCosts": [{ "model": "gpt-image-2", "credits": 2 }] } }
}' >/dev/null
check "渠道模型汇总到公开配置" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models[0].name')" "gpt-image-2"
check "公开配置带出模型能力" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models[0].capability')" "image"
check "默认生图模型自动修复" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.defaultImageModel')" "gpt-image-2"
check "后台读取时密钥被脱敏" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.private.channels[0].apiKey')" ""
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "测试渠道", "baseUrl": "https://api.example.com", "apiKey": "", "models": [{ "name": "gpt-image-2", "capability": "image" }], "weight": 1, "enabled": true }] },
  "public": { "modelChannel": { "modelCosts": [{ "model": "gpt-image-2", "credits": 2 }] } }
}' >/dev/null
check "留空保存不会清掉已有密钥" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models | length')" "1"
check "模型算力点成本已保存" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.modelCosts[0].credits')" "2"

echo "文件存储"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x10\x00\x00\x00\x20\x08\x06\x00\x00\x00' >"$WORK/tiny.png"
FILE_JSON=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/tiny.png;type=image/png")
FILE_ID=$(echo "$FILE_JSON" | jq -r .data.id)
check "上传图片成功" "$([ "$FILE_ID" != "null" ] && echo yes || echo no)" "yes"
check "服务端解析出图片宽度" "$(echo "$FILE_JSON" | jq -r .data.width)" "16"
check "服务端解析出图片高度" "$(echo "$FILE_JSON" | jq -r .data.height)" "32"
check "文件直链可匿名读取" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$FILE_ID/content")" "200"
check "文件直链返回正确类型" "$(curl -s -o /dev/null -w '%{content_type}' "$BASE/files/$FILE_ID/content")" "image/png"
check "文件直链支持 Range" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-3' "$BASE/files/$FILE_ID/content")" "206"
SAME_ID=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/tiny.png;type=image/png" | jq -r .data.id)
check "相同内容重复上传复用记录" "$SAME_ID" "$FILE_ID"

echo "画布项目同步"
curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"我的画布","data":{"nodes":[1,2,3]}}' >/dev/null
check "首次保存 revision 为 1" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.revision)" "1"
check "项目数据完整回读" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.data.nodes | length')" "3"
curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"我的画布","data":{"nodes":[1]},"revision":1}' >/dev/null
check "再次保存 revision 递增" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.revision)" "2"
check "旧版本写入被乐观锁拦截" "$(curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":1}' | jq -r .msg)" "画布项目在其他设备上已更新，请先同步"
check "他人无法读取该项目" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "画布项目不存在"
curl -s -X DELETE "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "删除后仍能同步到删除标记" "$(curl -s "$BASE/v1/projects" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].deleted')" "true"

echo "生成任务幂等"
JOB1=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-1","kind":"image","model":"gpt-image-2","prompt":"一只猫","params":{"count":1},"inputFileIds":[],"context":{"source":"canvas","projectId":"p1","nodeId":"n1"}}' | jq -r .data.id)
check "提交任务成功" "$([ "$JOB1" != "null" ] && echo yes || echo no)" "yes"
JOB2=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-1","kind":"image","model":"gpt-image-2","prompt":"一只猫","params":{"count":1},"inputFileIds":[]}' | jq -r .data.id)
check "同一幂等键不会重复建任务" "$JOB2" "$JOB1"
check "任务上下文可跨设备回读" "$(curl -s "$BASE/v1/jobs/$JOB1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.context.nodeId)" "n1"
check "未配置的模型被拒绝" "$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-2","kind":"image","model":"不存在的模型","prompt":"x","params":{},"inputFileIds":[]}' | jq -r .msg)" "模型不可用：不存在的模型"
check "他人无法查询该任务" "$(curl -s "$BASE/v1/jobs/$JOB1" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "任务不存在"
sleep 3
check "算力点不足时任务失败" "$(curl -s "$BASE/v1/jobs/$JOB1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "failed"
check "失败原因是算力点不足" "$(curl -s "$BASE/v1/jobs/$JOB1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.error)" "算力点不足"

echo "算力点"
USER_ID=$(curl -s "$BASE/admin/users?keyword=tester" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].id')
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":10}' >/dev/null
check "管理员可调整算力点" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "10"
check "调整算力点写入流水" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].type')" "admin_adjust"

# 上游地址是假的必定失败，正好验证「先扣点、失败后原路返还」这条路径。
curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-3","kind":"image","model":"gpt-image-2","prompt":"一只狗","params":{"count":2},"inputFileIds":[]}' >/dev/null
sleep 4
check "生成失败后算力点原路返还" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "10"
check "流水记录了扣除" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_consume")] | length')" "1"
check "扣除金额按张数计算" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_consume")][0].amount')" "-4"
check "流水记录了返还" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_refund")][0].amount')" "4"

echo "提示词"
check "内置提示词分类已初始化" "$(curl -s "$BASE/admin/prompt-categories" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data | length')" "6"
curl -s -X POST "$BASE/admin/prompts" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"title":"测试提示词","prompt":"一只猫","tags":["动物","可爱"],"category":"awesome-gpt-image"}' >/dev/null
check "提示词可写入并检索" "$(curl -s --get "$BASE/prompts" --data-urlencode 'keyword=测试' | jq -r .data.total)" "1"
check "提示词标签可聚合" "$(curl -s "$BASE/prompts" | jq -r '.data.tags | length')" "2"
check "按标签筛选生效" "$(curl -s --get "$BASE/prompts" --data-urlencode 'tag=动物' | jq -r .data.total)" "1"
check "不存在的标签筛不出结果" "$(curl -s --get "$BASE/prompts" --data-urlencode 'tag=不存在' | jq -r .data.total)" "0"
check "按分类筛选生效" "$(curl -s --get "$BASE/prompts" --data-urlencode 'category=awesome-gpt-image' | jq -r .data.total)" "1"
check "其他分类筛不出结果" "$(curl -s --get "$BASE/prompts" --data-urlencode 'category=youmind-gpt-image-2' | jq -r .data.total)" "0"

echo "生成任务成功路径"
# 起一个假的 OpenAI 兼容上游，返回一张 1x1 PNG，端到端验证「提交 → 执行 → 落文件 → 回读」。
cat >"$WORK/upstream.js" <<'EOF'
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
require("http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
    });
}).listen(19090, "127.0.0.1");
EOF
node "$WORK/upstream.js" &
UPSTREAM_PID=$!
sleep 1

curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:19090", "apiKey": "sk-test", "models": [{ "name": "mock-image", "capability": "image" }], "weight": 1, "enabled": true }] },
  "public": { "modelChannel": { "modelCosts": [{ "model": "mock-image", "credits": 1 }] } }
}' >/dev/null
JOB_OK=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-ok","kind":"image","model":"mock-image","prompt":"一只猫","params":{"count":1},"inputFileIds":[],"context":{"source":"image"}}' | jq -r .data.id)
for _ in $(seq 1 30); do
    [ "$(curl -s "$BASE/v1/jobs/$JOB_OK" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "succeeded" ] && break
    sleep 1
done
JOB_VIEW=$(curl -s "$BASE/v1/jobs/$JOB_OK" -H "Authorization: Bearer $USER_TOKEN")
check "任务执行成功" "$(echo "$JOB_VIEW" | jq -r .data.status)" "succeeded"
check "进度到达 100" "$(echo "$JOB_VIEW" | jq -r .data.progress)" "100"
check "产出了一个文件" "$(echo "$JOB_VIEW" | jq -r '.data.outputs | length')" "1"
check "产出被识别为图片" "$(echo "$JOB_VIEW" | jq -r '.data.outputs[0].kind')" "image"
OUT_ID=$(echo "$JOB_VIEW" | jq -r '.data.outputs[0].id')
check "产出文件可下载" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$OUT_ID/content")" "200"
check "成功后扣掉算力点" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "9"
check "成功不产生返还流水" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_refund")] | length')" "1"
check "重发同一幂等键拿回已完成任务" "$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-ok","kind":"image","model":"mock-image","prompt":"一只猫","params":{"count":1},"inputFileIds":[]}' | jq -r .data.id)" "$JOB_OK"
check "未完成任务列表里没有已完成的任务" "$(curl -s "$BASE/v1/jobs?status=pending,running" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.id=="'"$JOB_OK"'")] | length')" "0"

echo
printf '通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]