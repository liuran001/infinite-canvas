#!/usr/bin/env bash
# 后端冒烟测试：启动服务并跑通登录、设置、文件、项目、任务幂等等主链路。
# 用法：bash server/smoke-test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
# 随机端口：多个人同时跑这个脚本时，固定端口会让后启动的实例把健康检查打到别人的服务上，
# 而数据库各自独立，断言就会大面积假失败。
PORT="$(shuf -i 20000-45000 -n 1)"
UPSTREAM_PORT=$((PORT + 1))
BASE="http://127.0.0.1:$PORT/api"
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
# 抽成函数是因为「服务重启」那一节要用完全相同的环境变量再起一次，两处配置不能有半点漂移。
start_server() {
    PORT="$PORT" \
        ADMIN_USERNAME=admin ADMIN_PASSWORD=smoke-test \
        JWT_SECRET=smoke-test-secret \
        STORAGE_DRIVER=sqlite DATABASE_DSN="$WORK/test.db" DATA_DIR="$WORK/data" \
        LINUX_DO_TOKEN_URL="http://127.0.0.1:$UPSTREAM_PORT/oauth2/token" \
        LINUX_DO_USERINFO_URL="http://127.0.0.1:$UPSTREAM_PORT/api/user" \
        npx tsx src/index.ts >>"$WORK/server.log" 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 60); do
        curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
        sleep 0.5
    done
    echo "服务启动失败，日志："
    cat "$WORK/server.log"
    exit 1
}
start_server

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

# 只改一个开关不该把其余配置一起清空：直接归一化入参会把没传的字段填成默认值，
# 于是「改个注册开关」会顺手把渠道和密钥洗掉。这条守着 saveSettings 的深合并。
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"public":{"auth":{"allowRegister":false}}}' >/dev/null
check "部分更新不会清掉渠道" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models | length')" "1"
check "部分更新确实改到了目标字段" "$(curl -s "$BASE/settings" | jq -r .data.auth.allowRegister)" "false"
check "部分更新不会清掉渠道密钥" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.private.channels | length')" "1"
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"public":{"auth":{"allowRegister":true}}}' >/dev/null
check "开关能改回去" "$(curl -s "$BASE/settings" | jq -r .data.auth.allowRegister)" "true"
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
# 跨用户去重只在 HTTP 层验收「各自 fileId、各自可读、各自照常计费」；
# refCount、GC、并发这些内部语义由 server/verify-storage.ts 覆盖，放在这里会让 smoke 变得极脆。
DEDUP_TOKEN=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"dedup-user","password":"dedup-pass"}' | jq -r .data.token)
DEDUP_FILE=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $DEDUP_TOKEN" -F "file=@$WORK/tiny.png;type=image/png" | jq -r .data.id)
check "另一个用户上传同内容拿到独立 fileId" "$([ "$DEDUP_FILE" != "null" ] && [ "$DEDUP_FILE" != "$FILE_ID" ] && echo yes || echo no)" "yes"
check "两个用户的直链都能读" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$DEDUP_FILE/content")$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$FILE_ID/content")" "200200"
check "去重不影响第二个用户的逻辑用量" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $DEDUP_TOKEN" | jq -r .data.used)" "$(stat -c %s "$WORK/tiny.png")"
curl -s -X DELETE "$BASE/v1/files/$DEDUP_FILE" -H "Authorization: Bearer $DEDUP_TOKEN" >/dev/null
check "删除一个用户的引用后另一个用户仍可读" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$FILE_ID/content")" "200"
check "删除后第二个用户用量清零" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $DEDUP_TOKEN" | jq -r .data.used)" "0"

echo "画布项目同步"
curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"我的画布","revision":0,"clientId":"smoke-client","data":{"nodes":[1,2,3]}}' >/dev/null
check "首次保存 revision 为 1" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.revision)" "1"
check "项目数据完整回读" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.data.nodes | length')" "3"
check "缺 revision 返回 400" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"clientId":"smoke-client"}')" "400"
curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"我的画布","data":{"nodes":[1]},"revision":1,"clientId":"smoke-client"}' >/dev/null
check "再次保存 revision 递增" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.revision)" "2"
CONFLICT=$(curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":1,"clientId":"smoke-other"}')
check "旧版本写入返回 409" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":1,"clientId":"smoke-other"}')" "409"
check "冲突有稳定错误码" "$(echo "$CONFLICT" | jq -r .code)" "REVISION_CONFLICT"
check "冲突带当前快照" "$(echo "$CONFLICT" | jq -r .data.revision)" "2"
CAS_PIDS=""
for suffix in a b; do
    curl -s -o "$WORK/cas-$suffix.json" -w '%{http_code}' -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"$suffix\",\"data\":{\"winner\":\"$suffix\"},\"revision\":2,\"clientId\":\"smoke-cas-$suffix\"}" >"$WORK/cas-$suffix.status" &
    CAS_PIDS="$CAS_PIDS $!"
done
for pid in $CAS_PIDS; do wait "$pid"; done
check "并发 CAS 恰好一个成功" "$(grep -h '^200$' "$WORK"/cas-*.status | wc -l | tr -d ' ')" "1"
check "并发 CAS 恰好一个冲突" "$(grep -h '^409$' "$WORK"/cas-*.status | wc -l | tr -d ' ')" "1"
timeout 4 curl -sN "$BASE/v1/projects/p1/realtime?clientId=smoke-viewer&sinceRevision=3" -H "Authorization: Bearer $USER_TOKEN" >"$WORK/project-stream.txt" &
PROJECT_STREAM_PID=$!
sleep 1
curl -s -X POST "$BASE/v1/projects/p1/presence" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientId":"smoke-viewer","nodeIds":["n1"],"activity":"editing"}' >/dev/null
curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"实时画布","data":{"nodes":[]},"revision":3,"clientId":"smoke-writer"}' >/dev/null
wait "$PROJECT_STREAM_PID" || true
check "项目流收到 ready" "$(grep -c '"type":"ready"' "$WORK/project-stream.txt")" "1"
check "项目流收到保存广播" "$(grep -c '"type":"project.saved"' "$WORK/project-stream.txt")" "1"
check "保存广播带 writerClientId" "$(grep -c '"writerClientId":"smoke-writer"' "$WORK/project-stream.txt")" "1"
check "项目流收到 Presence" "$([ "$(grep -c '"type":"presence.sync"' "$WORK/project-stream.txt")" -ge 1 ] && echo yes || echo no)" "yes"
check "他人无法订阅项目流" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/p1/realtime?clientId=smoke-other-user&sinceRevision=0" -H "Authorization: Bearer $ADMIN_TOKEN")" "404"
check "他人无法上报 Presence" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/projects/p1/presence" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"clientId":"smoke-other-user","nodeIds":[],"activity":"idle"}')" "404"
check "他人无法读取该项目" "$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "画布项目不存在"
curl -s -X DELETE "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H "X-Client-Id: smoke-client" >/dev/null
check "删除后仍能同步到删除标记" "$(curl -s "$BASE/v1/projects" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.id=="p1")][0].deleted')" "true"

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
# 等任务真的进终态再断言。固定睡几秒是靠不住的：这个上游要多久才失败取决于当前网络能不能解析到它。
for _ in $(seq 1 40); do
    [ "$(curl -s "$BASE/v1/jobs?status=pending,running" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" = "0" ] && break
    sleep 1
done
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
# 同时兼作 agent 的假模型：/chat/completions 与 :generateContent 会真的返回工具调用，
# 这样工具调用循环、落库、SSE、断线续传都能被真正跑到，而不是只测 HTTP 状态码。
cat >"$WORK/upstream.js" <<'EOF'
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// import_image 用的假图床素材。都是真的图片字节，服务端按魔数认格式，写死 base64 才能断言「没有被重新编码过」。
// 两张 png 的内容必须互不相同、也不能和上面那张生成用的 PNG 相同：saveFile 按内容去重，
// 撞上了就会复用同一条文件记录，验不出「导入真的新建了文件」和「配额真的被占用」。
const PNG_IMPORT = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNg+M+AQMRxAJ6jD/HnSNDJAAAAAElFTkSuQmCC";
const PNG_OTHER = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgYPiPAw0pCQCpcD/B+Cvn4QAAAABJRU5ErkJggg==";
const WEBP = "UklGRhwAAABXRUJQVlA4TA8AAAAvBYAAAAcQ0f/+ByKi/wEA";
const AVIF =
    "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACYAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAQAAAAEAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAubWRhdBIACgg4BH2kBDQaQDIYGUJjBMAANAAExbXoBe6cVBGx8nK3xDOA";
// 服务端下载图片时用的对外地址，由脚本按本机主机名拼好传进来。
const IMG_ORIGIN = process.argv[3] || "";
// 假图床：路径决定返回什么，用来覆盖「正常图片 / 伪装成图片的 HTML / 响应头就不是图片 / 不支持的格式」几条路径。
const IMAGES = {
    "/img/ok.png": ["image/png", Buffer.from(PNG_IMPORT, "base64")],
    "/img/other.png": ["image/png", Buffer.from(PNG_OTHER, "base64")],
    "/img/ok.webp": ["image/webp", Buffer.from(WEBP, "base64")],
    "/img/photo.avif": ["image/avif", Buffer.from(AVIF, "base64")],
    // 扩展名和响应头都写着 png，字节却是 HTML：只信其中任何一个，这份内容就会被存进用户的云空间。
    "/img/fake.png": ["image/png", Buffer.from("<!DOCTYPE html><html><body>我不是图片</body></html>")],
    "/img/page.png": ["text/html", Buffer.from("<!DOCTYPE html><html><body>这是网页</body></html>")],
};
// agent 的每轮回复慢一点，冒烟脚本才有机会在循环跑到一半时把 SSE 掐掉。
const AGENT_DELAY_MS = 1200;
// 文本流按片慢慢吐，冒烟脚本才有机会在生成中途读到半截内容、把连接掐掉再续上。
const TEXT_CHUNKS = ["无限画布", "把生成任务", "放在服务端，", "刷新页面", "也不会丢，", "内容会接着写完。"];
const TEXT_DELAY_MS = 800;
// 读网页用的长正文，必须超过服务端 8000 字符的上限，才能验到「截断并告诉模型没读完」。
const LONG_TEXT = "无限画布把超长网页正文截断后再交给模型。".repeat(600);
let lastTools = [];
// 最后一次 agent 请求的原始请求体。冒烟脚本据此断言上下文里到底带了什么，
// 尤其是「引用只带 ID、绝不带图片数据」这条核心约定。
let lastChat = null;
// 最后一次生图请求的原始请求体，用来断言工具参数真的透传到了上游，而不是在半路被丢掉。
let lastImage = null;

function streamText(res, toEvent) {
    res.setHeader("Content-Type", "text/event-stream");
    let index = 0;
    const push = () => {
        // 上游任务被取消时连接已经断了，继续往里写会把 mock 进程搞崩。
        if (res.destroyed || res.writableEnded) return;
        if (index >= TEXT_CHUNKS.length) {
            res.write("data: [DONE]\n\n");
            return res.end();
        }
        res.write(`data: ${JSON.stringify(toEvent(TEXT_CHUNKS[index++]))}\n\n`);
        setTimeout(push, TEXT_DELAY_MS);
    };
    setTimeout(push, TEXT_DELAY_MS);
}

// 附件与引用会把用户消息变成 [{type:"text"},{type:"image_url"}] 这种数组，取文字要摊平一次。
function messageText(item) {
    const content = item && item.content;
    if (typeof content === "string") return content;
    return (content || []).map((part) => part.text || "").join(" ");
}

function lastUserText(messages) {
    return messageText([...messages].reverse().find((item) => item.role === "user"));
}

// 「一直干活」的会话永远返回工具调用，用来把轮数真的耗尽，验证耗尽后是暂停请求授权而不是直接结束。
function keepsGoing(messages) {
    return lastUserText(messages).includes("一直干活");
}

function toolCall(messages) {
    const text = lastUserText(messages);
    if (text.includes("生成图片")) return { name: "generate_image", args: { prompt: "一只猫" } };
    // 生成类工具的全量参数：这一条会被断言「一个不落地透传到了上游请求体」。
    if (text.includes("全参数生图")) {
        return { name: "generate_image", args: { prompt: "一只猫", model: "mock-image-pro", count: 2, size: "1024x1024", quality: "high", background: "transparent" } };
    }
    // 拿文本模型去生图：服务端要按 capability 挡下来并回落到默认生图模型，而不是报错。
    if (text.includes("用文本模型生图")) return { name: "generate_image", args: { prompt: "一只猫", model: "mock-text" } };
    if (text.includes("写一篇长文")) return { name: "generate_text", args: { prompt: "介绍一下无限画布", model: "mock-text", title: "长文" } };
    // 不带 model 的生文调用：用来验证「工具没指定模型时按用户偏好里的生文模型来」。
    if (text.includes("按偏好写长文")) return { name: "generate_text", args: { prompt: "介绍一下无限画布", title: "偏好长文" } };
    if (text.includes("改画布标题")) return { name: "rename_canvas", args: { title: "猫咪画册", reason: "用户整张画布都在做猫咪主题" } };
    if (text.includes("再改一次标题")) return { name: "rename_canvas", args: { title: "猫咪画册二版", reason: "用户又加了新内容" } };
    if (text.includes("一直干活")) return { name: "create_node", args: { type: "text", title: "干活节点", content: "还在干" } };
    // 读网页：内网地址用来验证服务端会直接拒绝，普通地址会被搜索服务的 mock 接住返回长正文。
    if (text.includes("读取内网")) return { name: "read_webpage", args: { url: "http://127.0.0.1:9/admin" } };
    if (text.includes("读取网页")) return { name: "read_webpage", args: { url: "https://example.com/long-article" } };
    if (text.includes("联网搜索")) return { name: "web_search", args: { query: "无限画布" } };
    // 导入图片：服务端会真的按这个地址发起下载，所以除了内网那条，其余都指向上面的假图床。
    if (text.includes("导入内网图片")) return { name: "import_image", args: { url: "http://127.0.0.1:9/secret.png" } };
    if (text.includes("导入超大图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/huge.png` } };
    if (text.includes("导入伪装图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/fake.png` } };
    if (text.includes("导入网页地址")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/page.png` } };
    if (text.includes("导入 avif 图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/photo.avif` } };
    if (text.includes("导入 webp 图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/ok.webp` } };
    if (text.includes("导入另一张图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/other.png` } };
    if (text.includes("导入图片")) return { name: "import_image", args: { url: `${IMG_ORIGIN}/img/ok.png` } };
    // 把消息里出现的 storageKey 原样带进工具参数：用来验证用户上传的附件真的能被工具引用到。
    const storageKey = (text.match(/server:[A-Za-z0-9_-]+/) || [])[0];
    if (text.includes("用这张图建节点") && storageKey) return { name: "create_node", args: { type: "image", title: "附件节点", storageKey } };
    return { name: "create_node", args: { type: "text", title: "冒烟节点", content: "由 agent 创建" } };
}

require("http").createServer((req, res) => {
    // 服务端超上限时会直接掐断下载，这里不接住 error 事件的话，一个 ECONNRESET 就能把 mock 进程带崩。
    res.on("error", () => {});
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/_tools") return res.end(JSON.stringify({ tools: lastTools }));
        if (req.url === "/_last") return res.end(JSON.stringify(lastChat || {}));
        if (req.url === "/_lastimage") return res.end(JSON.stringify(lastImage || {}));
        if (IMAGES[req.url]) {
            const [type, buffer] = IMAGES[req.url];
            res.setHeader("Content-Type", type);
            return res.end(buffer);
        }
        // 超大图片：故意不给 Content-Length，一直往外吐，用来验证服务端是边收边数、超上限当场掐断，
        // 而不是先下完整份再判断大小。
        if (req.url === "/img/huge.png") {
            res.setHeader("Content-Type", "image/png");
            const chunk = Buffer.alloc(1 << 20, 0x61);
            let sent = 0;
            const push = () => {
                if (res.destroyed || res.writableEnded) return;
                if (sent >= 16) return res.end();
                sent += 1;
                res.write(chunk, push);
            };
            return push();
        }
        // 假的 Linux.do：换 token 与拉用户资料，用来验证关闭注册时第三方登录会被挡住。
        // 授权码 invite-code-flow 换出另一个身份：邀请码用例需要一个「站内还不存在」的第三方账号，
        // 否则会直接命中上面那个已经建过号的用户，压根走不到「新用户要邀请码」这条路径。
        if (req.url.startsWith("/oauth2/token")) {
            const invited = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("code") === "invite-code-flow";
            return res.end(JSON.stringify({ access_token: invited ? "linuxdo-invited-token" : "linuxdo-access-token" }));
        }
        if (req.url.startsWith("/api/user")) {
            const invited = String(req.headers.authorization || "").includes("linuxdo-invited-token");
            return res.end(JSON.stringify(invited ? { id: 515151, username: "smoke-invited", name: "邀请码用户" } : { id: 424242, username: "smoke-linuxdo", name: "冒烟测试" }));
        }
        // 文本任务走流式的 /responses 与 Gemini 的 streamGenerateContent，请求体用不上。
        if (req.url.includes("/responses")) return streamText(res, (text) => ({ type: "response.output_text.delta", delta: text }));
        if (req.url.includes("streamGenerateContent")) return streamText(res, (text) => ({ candidates: [{ content: { parts: [{ text }] } }] }));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

        // 假的搜索服务商。两家的请求路径与字段名都按各自官方 spec 来，用来验证 provider 抽象真的各解析各的：
        // Exa 是 /search + /contents、正文在 text 且认 maxCharacters；Tavily 是 /search + /extract、摘要在 content、全文在 raw_content。
        // 挂掉的搜索服务：一律 500，用来验证优先级高的那家失败后会自动换下一家。必须放在两家的分支之前，
        // 否则 /broken/exa/search 会先被 Exa 的分支接住，降级路径根本没被跑到。
        if (req.url.includes("/broken/")) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: "搜索服务挂了" }));
        }
        if (req.url.includes("/exa/contents")) {
            const url = (body.urls || [])[0] || "";
            // 和真实 Exa 一样按 maxCharacters 截断后再返回。
            const max = (body.text || {}).maxCharacters || LONG_TEXT.length;
            return res.end(JSON.stringify({ requestId: "smoke", results: [{ id: url, url, title: "冒烟长文Exa", publishedDate: "2026-01-01T00:00:00.000Z", text: LONG_TEXT.slice(0, max) }], statuses: [{ id: url, status: "success" }] }));
        }
        if (req.url.includes("/exa/search")) {
            // Exa 每条结果自带一张配图，图片能落到具体结果上。
            return res.end(JSON.stringify({ results: [{ title: "冒烟搜索结果", url: "https://example.com/exa", publishedDate: "2026-01-01T00:00:00.000Z", text: "来自 Exa 的正文", image: "https://example.com/exa-cover.jpg" }] }));
        }
        if (req.url.includes("/tavily/extract")) {
            const url = (body.urls || [])[0] || "";
            // Tavily 没有长度参数，整篇原文都回来，用来验证截断是服务端自己做的。
            return res.end(JSON.stringify({ results: [{ url, title: "冒烟长文Tavily", raw_content: LONG_TEXT }], failed_results: [] }));
        }
        if (req.url.includes("/tavily/search")) {
            // Tavily 的图片在顶层 images，落不到具体结果上；每条结果自己的 images 是整页图片的原样堆放
            // （占位图、缩略图都在里面），服务端不该拿它当这条结果的配图。
            return res.end(
                JSON.stringify({
                    images: body.include_images ? ["https://example.com/tavily-1.jpg", "https://example.com/tavily-2.jpg"] : [],
                    results: [{ title: "冒烟搜索结果", url: "https://example.com/tavily", content: "来自 Tavily 的摘要", images: ["https://example.com/tavily-placeholder-1px.png"] }],
                }),
            );
        }

        if (req.url.includes("/chat/completions")) {
            lastTools = (body.tools || []).map((item) => item.function.name);
            const messages = body.messages || [];
            // 起标题是一次独立的短请求，不带工具也不该被当成 agent 的一轮：直接回一个标题字符串。
            // 标题里回带用户原话的前三个字，冒烟脚本据此分得出「标题是第几条消息生成的」，才验得了「只生成一次」。
            if (messageText(messages[0] || {}).includes("起一个标题")) {
                return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `「冒烟-${lastUserText(messages).slice(0, 3)}」` } }] }));
            }
            lastChat = body;
            const done = messages[messages.length - 1].role === "tool" && !keepsGoing(messages);
            const call = toolCall(messages);
            const message = done
                ? { role: "assistant", content: "已经按你的要求改好画布了。" }
                : { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
            return setTimeout(() => res.end(JSON.stringify({ choices: [{ message }] })), AGENT_DELAY_MS);
        }

        if (req.url.includes(":generateContent")) {
            lastTools = ((body.tools || [])[0] || { functionDeclarations: [] }).functionDeclarations.map((item) => item.name);
            const contents = body.contents || [];
            const done = Boolean((contents[contents.length - 1].parts || [])[0].functionResponse);
            const messages = contents.map((item) => ({ role: item.role === "model" ? "assistant" : "user", content: (item.parts[0] || {}).text || "" }));
            const call = toolCall(messages);
            const parts = done ? [{ text: "已经按你的要求改好画布了。" }] : [{ functionCall: { name: call.name, args: call.args } }];
            return setTimeout(() => res.end(JSON.stringify({ candidates: [{ content: { parts } }] })), AGENT_DELAY_MS);
        }

        lastImage = body;
        res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
    });
// 监听所有网卡而不是只监听 127.0.0.1：import_image 的地址要用本机主机名才能过服务端的内网拦截，
// 而主机名解析出来的未必是 127.0.0.1。
}).listen(Number(process.argv[2]));
EOF
# 服务端下载图片时用的地址：safeWebUrl 只做字面量判断、不解析 DNS（这是它写明的边界），
# 主机名字面量上不是内网地址，正好把 mock 图床装扮成一个「公网图床」，
# 让「下载 → 校验大小与格式 → 落库占配额」整条真链路都能在离线环境里跑一遍。
IMG_ORIGIN="http://${HOSTNAME:-$(uname -n)}:$UPSTREAM_PORT"
# mock 上游流式吐出来的完整文本，文本任务与 agent 的 generate_text 都拿它当预期值。
TEXT_FULL="无限画布把生成任务放在服务端，刷新页面也不会丢，内容会接着写完。"
node "$WORK/upstream.js" "$UPSTREAM_PORT" "$IMG_ORIGIN" &
UPSTREAM_PID=$!
sleep 1

curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-image", "capability": "image" }], "weight": 1, "enabled": true }] },
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

echo "后台内容审查"
ADMIN_ID=$(curl -s "$BASE/admin/users?keyword=admin" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].id')
curl -s -X PUT "$BASE/v1/projects/p2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"审查用画布","revision":0,"clientId":"smoke-client","data":{"nodes":[{"id":"n1","type":"image","metadata":{"storageKey":"server:'"$OUT_ID"'"}},{"id":"n2","type":"text"}]}}' >/dev/null
check "普通用户查生成记录被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/jobs" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "普通用户查画布列表被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/projects" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "普通用户查文件列表被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/files" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "管理员可跨用户查生成任务" "$(curl -s "$BASE/admin/jobs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "3"
check "生成记录带出所属用户名" "$(curl -s "$BASE/admin/jobs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].username')" "tester"
check "生成记录带出产出文件" "$(curl -s "$BASE/admin/jobs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.id=="'"$JOB_OK"'")][0].outputs[0].mimeType')" "image/png"
check "按用户筛选生成记录生效" "$(curl -s "$BASE/admin/jobs?userId=$USER_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "3"
check "换个用户筛不出记录" "$(curl -s "$BASE/admin/jobs?userId=$ADMIN_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "按状态筛选生成记录生效" "$(curl -s "$BASE/admin/jobs?status=succeeded" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "1"
check "按类型筛选生成记录生效" "$(curl -s "$BASE/admin/jobs?kind=video" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "按提示词关键词检索生效" "$(curl -s --get "$BASE/admin/jobs" --data-urlencode 'keyword=一只狗' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "1"
check "任务详情带出完整参数" "$(curl -s "$BASE/admin/jobs/$JOB_OK" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.params.count)" "1"
check "任务详情带出失败原因" "$(curl -s "$BASE/admin/jobs/$JOB1" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.error)" "算力点不足"
check "按用户筛选画布生效" "$(curl -s "$BASE/admin/projects?userId=$USER_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "2"
check "换个用户筛不出画布" "$(curl -s "$BASE/admin/projects?userId=$ADMIN_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "画布列表带出节点数" "$(curl -s --get "$BASE/admin/projects" --data-urlencode 'keyword=审查用画布' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].nodeCount')" "2"
check "画布列表带出软删除标记" "$(curl -s --get "$BASE/admin/projects" --data-urlencode 'keyword=实时画布' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].deleted')" "true"
check "画布详情返回完整数据" "$(curl -s "$BASE/admin/projects/$USER_ID/p2" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.data.nodes | length')" "2"
check "画布详情带出图片节点引用" "$(curl -s "$BASE/admin/projects/$USER_ID/p2" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.data.nodes[0].metadata.storageKey')" "server:$OUT_ID"
check "按用户筛选文件生效" "$(curl -s "$BASE/admin/files?userId=$USER_ID&kind=image" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "2"
check "换个用户筛不出文件" "$(curl -s "$BASE/admin/files?userId=$ADMIN_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "文件列表带出所属用户名" "$(curl -s "$BASE/admin/files?userId=$USER_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].username')" "tester"

echo "画布分享"
# 分享链接就是能力凭证：这一节要跑通「建链接 → 换 guest 令牌 → 访客读写 → 撤销断流 → 克隆」整条链路，
# 并守住两条底线：明文 token 不出现在列表里，guest 身份碰不到账号级能力。
CLONER_TOKEN=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"share-cloner","password":"cloner-pass"}' | jq -r .data.token)
curl -s -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"分享画布","revision":0,"clientId":"smoke-share","data":{"nodes":[{"id":"s1","type":"image","metadata":{"storageKey":"server:'"$FILE_ID"'"}}],"connections":[]}}' >/dev/null
check "未登录不能创建分享" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/projects/share-p1/shares" -H 'Content-Type: application/json' -d '{"role":"viewer"}')" "401"

SHARE=$(curl -s -X POST "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"role":"viewer","allowAnonymous":true,"allowClone":true}')
TOKEN=$(echo "$SHARE" | jq -r .data.token)
SHARE_ID=$(echo "$SHARE" | jq -r .data.id)
check "创建分享返回明文 token" "$(printf '%s' "$TOKEN" | wc -c | tr -d ' ')" "32"
check "创建分享返回完整链接" "$(echo "$SHARE" | jq -r .data.url | grep -c "/s/$TOKEN\$")" "1"
LIST=$(curl -s "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN")
check "列表不返回明文 token" "$(echo "$LIST" | jq -r '.data[0].token // "absent"')" "absent"
check "列表只给出 token 前缀" "$(echo "$LIST" | jq -r '.data[0].tokenPrefix')" "$(printf '%s' "$TOKEN" | cut -c1-8)"
check "他人管理分享按画布不存在处理" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $ADMIN_TOKEN")" "404"

SESSION=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/session")
GUEST=$(echo "$SESSION" | jq -r .data.token)
check "匿名换取 guest 令牌" "$(echo "$SESSION" | jq -r .data.role)" "viewer"
check "换令牌时带出画布元信息" "$(echo "$SESSION" | jq -r '"\(.data.project.title)/\(.data.project.revision)"')" "分享画布/1"
check "匿名访客拿到访客昵称" "$(echo "$SESSION" | jq -r .data.displayName | grep -c '^访客-')" "1"
check "刷新页面沿用同一个匿名 id" "$(curl -s -X POST "$BASE/v1/shares/$TOKEN/session" -H 'Content-Type: application/json' -d "{\"previousToken\":\"$GUEST\"}" | jq -r .data.actorId)" "$(echo "$SESSION" | jq -r .data.actorId)"
FORGED_ACTOR=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/session" -H 'Content-Type: application/json' -d '{"previousToken":"forged-guest-token"}' | jq -r .data.actorId)
check "伪造的旧凭据不会被沿用" "$([ -n "$FORGED_ACTOR" ] && [ "$FORGED_ACTOR" != "$(echo "$SESSION" | jq -r .data.actorId)" ] && echo yes || echo no)" "yes"
check "错误 token 返回 404" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/deadbeefdeadbeefdeadbeef/session")" "404"
check "只读访客可以读画布" "$(curl -s "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $GUEST" | jq -r .data.title)" "分享画布"
check "只读访客可以订阅实时流" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/v1/projects/share-p1/realtime?clientId=share-viewer-1&sinceRevision=99" -H "Authorization: Bearer $GUEST")" "200"

# guest 身份的边界是「编辑这张画布」，不是「以所有者身份用系统」：账号级能力一律 403，
# 而不是 401 —— 访客的凭证本身是合法的，回 401 会让前端把会话清掉，页面直接白掉。
check "访客不能管理分享" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $GUEST")" "403"
check "访客不能列出画布" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects" -H "Authorization: Bearer $GUEST")" "403"
check "访客不能用 Agent" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' -d '{"projectId":"share-p1"}')" "403"
check "访客不能调模型" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/ai/chat/completions" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' -d '{"model":"mock-image"}')" "403"
check "访客不能提交生成任务" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' -d '{"clientJobId":"guest-1","kind":"image","model":"mock-image","prompt":"x","params":{},"inputFileIds":[]}')" "403"
check "访客不能读账号偏好" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/preferences" -H "Authorization: Bearer $GUEST")" "403"
check "访客不能读云空间用量" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/storage" -H "Authorization: Bearer $GUEST")" "403"
check "guest 令牌换不出账号身份" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $GUEST" | jq -r .data.role)" "guest"
check "viewer 访客写入被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":1,"clientId":"share-viewer-1"}')" "403"
check "viewer 写入有稳定错误码" "$(curl -s -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":1,"clientId":"share-viewer-1"}' | jq -r .code)" "SHARE_READ_ONLY"
printf 'share-guest-upload-payload' >"$WORK/share-guest.png"
check "只读访客不能上传" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/files" -H "Authorization: Bearer $GUEST" -F "file=@$WORK/share-guest.png;type=image/png" -F "projectId=share-p1")" "403"

# 可编辑分享：写的是所有者的项目本体，复用现有 CAS 与广播，不另起一条写路径。
ESHARE=$(curl -s -X POST "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"role":"editor","allowAnonymous":true,"allowClone":false}')
ETOKEN=$(echo "$ESHARE" | jq -r .data.token)
ESHARE_ID=$(echo "$ESHARE" | jq -r .data.id)
EGUEST=$(curl -s -X POST "$BASE/v1/shares/$ETOKEN/session" | jq -r .data.token)
REV=$(curl -s "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST" | jq -r .data.revision)
WROTE=$(curl -s -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST" -H 'Content-Type: application/json' -d "{\"title\":\"访客改标题\",\"data\":{\"nodes\":[{\"id\":\"s1\",\"type\":\"image\",\"metadata\":{\"storageKey\":\"server:$FILE_ID\"}}]},\"revision\":$REV,\"clientId\":\"share-editor-1\"}")
check "editor 访客写入成功" "$(echo "$WROTE" | jq -r .data.revision)" "$((REV + 1))"
check "写入落在所有者的画布上" "$(curl -s "$BASE/v1/projects" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.id=="share-p1")][0].title')" "访客改标题"
check "访客写入不会分叉出第二份画布" "$(curl -s --get "$BASE/admin/projects" --data-urlencode 'keyword=访客改标题' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "1"
check "访客用旧版本写入照样 409" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST" -H 'Content-Type: application/json' -d "{\"title\":\"x\",\"data\":{},\"revision\":$REV,\"clientId\":\"share-editor-1\"}")" "409"
check "访客不能删除画布" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST" -H 'X-Client-Id: share-editor-1')" "403"
PRESENCE=$(curl -s -X POST "$BASE/v1/projects/share-p1/presence" -H "Authorization: Bearer $EGUEST" -H 'Content-Type: application/json' -d '{"clientId":"share-editor-1","nodeIds":["s1"],"activity":"editing"}')
check "访客 Presence 用服务端给的访客昵称" "$(echo "$PRESENCE" | jq -r '[.data.members[] | select(.clientId=="share-editor-1")][0].displayName' | grep -c '^访客-')" "1"
check "所有者能看到访客的 Presence" "$(curl -s -X POST "$BASE/v1/projects/share-p1/presence" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientId":"smoke-owner","nodeIds":[],"activity":"idle"}' | jq -r '.data.members | length')" "2"

UP=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $EGUEST" -F "file=@$WORK/share-guest.png;type=image/png" -F "projectId=share-p1")
FID=$(echo "$UP" | jq -r .data.id)
check "editor 访客可上传" "$(echo "$UP" | jq -r .code)" "0"
check "访客上传的文件归所有者" "$(curl -s "$BASE/v1/files/$FID" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.id)" "$FID"
check "访客上传计入所有者名下" "$(curl -s "$BASE/admin/files?userId=$USER_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r "[.data.items[] | select(.id==\"$FID\")] | length")" "1"
check "别的账号读不到这个文件" "$(curl -s "$BASE/v1/files/$FID" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .msg)" "无权访问该文件"

# 访客上传单独限流：配额只拦总量，拦不住「拿分享链接当图床」在几分钟内把所有者的空间刷满。
RSHARE=$(curl -s -X POST "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"role":"editor","allowAnonymous":true,"allowClone":false}')
RGUEST=$(curl -s -X POST "$BASE/v1/shares/$(echo "$RSHARE" | jq -r .data.token)/session" | jq -r .data.token)
RATE_LAST=0
for _ in $(seq 1 21); do
    RATE_LAST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/files" -H "Authorization: Bearer $RGUEST" -F "file=@$WORK/share-guest.png;type=image/png" -F "projectId=share-p1")
done
check "访客上传超频返回 429" "$RATE_LAST" "429"

# 克隆：单事务复用底层对象，只给克隆者建新的文件记录，源画布后续修改不影响副本。
CLONED=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/clone" -H "Authorization: Bearer $CLONER_TOKEN")
CLONE_ID=$(echo "$CLONED" | jq -r .data.id)
check "克隆成功" "$(echo "$CLONED" | jq -r .code)" "0"
check "副本 revision 从 1 开始" "$(echo "$CLONED" | jq -r .data.revision)" "1"
check "副本标题带「的副本」" "$(echo "$CLONED" | jq -r .data.title)" "访客改标题的副本"
CLONE_VIEW=$(curl -s "$BASE/v1/projects/$CLONE_ID" -H "Authorization: Bearer $CLONER_TOKEN")
CLONE_FILE=$(echo "$CLONE_VIEW" | jq -r '.data.data.nodes[0].metadata.storageKey' | sed 's/^server://')
check "副本里的 fileId 已被重写" "$([ "$CLONE_FILE" != "$FILE_ID" ] && [ -n "$CLONE_FILE" ] && echo yes || echo no)" "yes"
check "副本的图片归克隆者" "$(curl -s "$BASE/v1/files/$CLONE_FILE" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .data.id)" "$CLONE_FILE"
check "副本的图片可正常显示" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$CLONE_FILE/content")" "200"
check "源画布的图片没有被动过" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/files/$FILE_ID/content")" "200"
check "匿名不能克隆" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/$TOKEN/clone")" "401"
check "不允许克隆的分享被拒" "$(curl -s -X POST "$BASE/v1/shares/$ETOKEN/clone" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .code)" "CLONE_DISABLED"

# 分享页里 Authorization 已经被访客凭据占着，账号 JWT 只能另走 X-User-Authorization，
# 「匿名看了一圈再登录，然后保存到自己账号」这条路全靠它。
DUAL=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/clone" -H "Authorization: Bearer $GUEST" -H "X-Share-Guest: 1" -H "X-User-Authorization: Bearer $CLONER_TOKEN")
check "带访客凭据时用账号头完成克隆" "$(echo "$DUAL" | jq -r .code)" "0"
check "克隆出来的副本归登录账号" "$(curl -s "$BASE/v1/projects/$(echo "$DUAL" | jq -r .data.id)" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .data.revision)" "1"
DUAL_SESSION=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/session" -H "Authorization: Bearer $GUEST" -H "X-Share-Guest: 1" -H "X-User-Authorization: Bearer $CLONER_TOKEN")
check "带账号头换会话时用真实昵称" "$(echo "$DUAL_SESSION" | jq -r .data.displayName)" "share-cloner"
check "带账号头换会话时不再算匿名" "$(echo "$DUAL_SESSION" | jq -r .data.anonymous)" "false"
check "会话同时给出 role 与 permission" "$(echo "$DUAL_SESSION" | jq -r '"\(.data.role)/\(.data.permission)"')" "viewer/viewer"
check "会话给出绝对过期时间" "$(echo "$DUAL_SESSION" | jq -r '.data.expiresAt | test("^[0-9]{4}-")')" "true"
check "账号头不能拿来提权到写" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $GUEST" -H "X-Share-Guest: 1" -H "X-User-Authorization: Bearer $CLONER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":2,"clientId":"share-viewer-1"}')" "403"

# 撤销必须当场断开长连接：SSE 建好之后不重连就不会重新鉴权，只靠令牌过期要等到下一次重连才生效。
timeout 8 curl -sN "$BASE/v1/projects/share-p1/realtime?clientId=share-editor-sse&sinceRevision=0" -H "Authorization: Bearer $EGUEST" >"$WORK/share-stream.txt" &
SHARE_STREAM_PID=$!
sleep 1
REVOKE_AT=$(date +%s)
DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/v1/projects/share-p1/shares/$ESHARE_ID" -H "Authorization: Bearer $USER_TOKEN")
wait "$SHARE_STREAM_PID" 2>/dev/null
check "撤销成功" "$DEL" "200"
check "访客流曾经建立成功" "$(grep -c '"type":"ready"' "$WORK/share-stream.txt")" "1"
check "撤销后长连接被主动断开" "$([ "$(($(date +%s) - REVOKE_AT))" -le 3 ] && echo yes || echo no)" "yes"
check "撤销后旧 guest 令牌读画布返回 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST")" "404"
check "撤销后旧 guest 令牌写入返回 404" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/share-p1" -H "Authorization: Bearer $EGUEST" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":9,"clientId":"share-editor-1"}')" "404"
check "撤销后原始 token 也换不到令牌" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/$ETOKEN/session")" "404"
check "撤销后分享仍能查到（软删除）" "$(curl -s "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" | jq -r "[.data[] | select(.id==\"$ESHARE_ID\")][0].enabled")" "false"

# 停用与过期都按「链接不存在」处理，不给 token 探测留任何信号。
check "改开关会同步给所有者" "$(curl -s -X PATCH "$BASE/v1/projects/share-p1/shares/$SHARE_ID" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"allowClone":false}' | jq -r .data.allowClone)" "false"
check "改成不允许克隆后立刻生效" "$(curl -s -X POST "$BASE/v1/shares/$TOKEN/clone" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .code)" "CLONE_DISABLED"
curl -s -X PATCH "$BASE/v1/projects/share-p1/shares/$SHARE_ID" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
check "停用后换不到令牌" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/$TOKEN/session")" "404"
EXPIRED=$(curl -s -X POST "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"role":"viewer","allowAnonymous":true,"allowClone":true,"expiresAt":"2020-01-01T00:00:00.000Z"}' | jq -r .data.token)
check "已过期的链接换不到令牌" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/$EXPIRED/session")" "404"
NOANON=$(curl -s -X POST "$BASE/v1/projects/share-p1/shares" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"role":"viewer","allowAnonymous":false,"allowClone":true}' | jq -r .data.token)
check "不允许匿名时未登录换不到令牌" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/$NOANON/session")" "404"
check "不允许匿名时登录后可以换到令牌" "$(curl -s -X POST "$BASE/v1/shares/$NOANON/session" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .data.role)" "viewer"
check "已登录访客用账号昵称而不是访客昵称" "$(curl -s -X POST "$BASE/v1/shares/$NOANON/session" -H "Authorization: Bearer $CLONER_TOKEN" | jq -r .data.displayName | grep -c '^访客-')" "0"

# 访问日志按分享维度落库，IP 只存哈希。
SHARE_LOGS=$(curl -s "$BASE/v1/projects/share-p1/shares/$SHARE_ID/logs" -H "Authorization: Bearer $USER_TOKEN")
check "所有者能查到访问日志" "$([ "$(echo "$SHARE_LOGS" | jq -r .data.total)" -ge 1 ] && echo yes || echo no)" "yes"
check "日志区分匿名访问" "$(echo "$SHARE_LOGS" | jq -r '[.data.items[] | select(.event=="open" and .isAnonymous==true)] | length >= 1')" "true"
check "日志不落原始 IP" "$(echo "$SHARE_LOGS" | jq -r '[.data.items[] | select(.ipHash | test("[.:]"))] | length')" "0"
check "他人查不到访问日志" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/share-p1/shares/$SHARE_ID/logs" -H "Authorization: Bearer $CLONER_TOKEN")" "404"
check "分享页响应头带 noindex" "$(curl -sI "http://127.0.0.1:$PORT/s/$TOKEN" | grep -ci 'x-robots-tag: noindex')" "1"

echo "账号自助管理"
check "改密码要校验原密码" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"wrong","newPassword":"new-pass-123"}' | jq -r .msg)" "原密码不正确"
check "新密码长度不足被拒" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"tester-pass","newPassword":"123"}' | jq -r .msg)" "新密码至少 6 位"
check "改密码成功" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"tester-pass","newPassword":"tester-pass-2"}' | jq -r .code)" "0"
check "旧密码已失效" "$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"tester","password":"tester-pass"}' | jq -r .msg)" "用户名或密码错误"
check "新密码可登录" "$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"tester","password":"tester-pass-2"}' | jq -r .code)" "0"
check "未绑定时解绑被拒" "$(curl -s -X POST "$BASE/auth/linux-do/unbind" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "当前账号未绑定 Linux.do"
check "未开启时拿不到绑定地址" "$(curl -s "$BASE/auth/linux-do/bind" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "Linux.do 登录未开启"
check "伪造的授权 state 被拒绝" "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/linux-do/callback?code=x&state=forged" | grep -c 'error=')" "1"

# 关闭注册后，第三方登录同样不能凭空建号，否则等于给注册开关开了个后门。
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "public": { "auth": { "allowRegister": false, "linuxDo": { "enabled": true } } },
  "private": { "auth": { "linuxDo": { "clientId": "smoke-id", "clientSecret": "smoke-secret" } } }
}' >/dev/null
oauth_state() { curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/linux-do/authorize?redirect=/" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p'; }
oauth_callback() { curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/linux-do/callback?code=smoke-code&state=$1"; }
decode() { python3 -c "import sys,urllib.parse as u; print(u.unquote(sys.argv[1]))" "$1"; }

CLOSED_CB="$(oauth_callback "$(oauth_state)")"
check "关闭注册时第三方登录不发令牌" "$(echo "$CLOSED_CB" | grep -c 'token=')" "0"
check "关闭注册时第三方登录被拒" "$(decode "$(echo "$CLOSED_CB" | sed -n 's/.*[?&]error=\([^&]*\).*/\1/p')")" "当前未开放注册"
check "被拒后没有凭空建出账号" "$(curl -s "$BASE/admin/users?keyword=smoke-linuxdo" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items | length')" "0"

# 开回注册后同一个 Linux.do 账号应当能正常建号登录，确认上面拦的是注册开关而不是链路本身坏了。
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"public":{"auth":{"allowRegister":true,"linuxDo":{"enabled":true}}},"private":{"auth":{"linuxDo":{"clientId":"smoke-id","clientSecret":"smoke-secret"}}}}' >/dev/null
OPEN_CB="$(oauth_callback "$(oauth_state)")"
check "开放注册后第三方登录换到令牌" "$(echo "$OPEN_CB" | grep -c 'token=')" "1"
check "开放注册后账号已建出来" "$(curl -s "$BASE/admin/users?keyword=smoke-linuxdo" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items | length')" "1"

# 已经绑定过的账号，即使再关掉注册也必须还能登录，否则老用户会被误伤。
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"public":{"auth":{"allowRegister":false,"linuxDo":{"enabled":true}}},"private":{"auth":{"linuxDo":{"clientId":"smoke-id","clientSecret":"smoke-secret"}}}}' >/dev/null
check "关闭注册不影响已绑定用户登录" "$(echo "$(oauth_callback "$(oauth_state)")" | grep -c 'token=')" "1"
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"public":{"auth":{"allowRegister":true,"linuxDo":{"enabled":false}}}}' >/dev/null

echo "节点插件云端同步"
curl -s -X PUT "$BASE/v1/user-plugins/demo-plugin" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"data":{"id":"demo-plugin","name":"演示插件","version":"1.0.0","enabled":true,"source":"export default {}"}}' >/dev/null
check "插件可保存" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].data.name')" "演示插件"
check "插件源码完整回读" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].data.source')" "export default {}"
# 插件 id 由插件作者定义，不同用户装同一个插件必然重名，靠复合主键隔离。
curl -s -X PUT "$BASE/v1/user-plugins/demo-plugin" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"data":{"id":"demo-plugin","name":"管理员的同名插件"}}' >/dev/null
check "同名插件在不同用户间互不覆盖" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].data.name')" "演示插件"
check "另一用户看到自己的那份" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].data.name')" "管理员的同名插件"
curl -s -X DELETE "$BASE/v1/user-plugins/demo-plugin" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "删除后同步到软删除标记" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].deleted')" "true"
check "删除不影响另一用户" "$(curl -s "$BASE/v1/user-plugins" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].deleted')" "false"

echo "功能入口开关"
check "默认全部开启" "$(curl -s "$BASE/settings" | jq -r '.data.capabilities.video')" "true"
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-image", "capability": "image" }], "weight": 1, "enabled": true }] },
  "public": { "capabilities": { "video": false, "audio": false } }
}' >/dev/null
check "管理员可关闭视频入口" "$(curl -s "$BASE/settings" | jq -r '.data.capabilities.video')" "false"
check "未提及的能力保持开启" "$(curl -s "$BASE/settings" | jq -r '.data.capabilities.image')" "true"

echo "模型展示名与档位计费"
curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "private": { "channels": [{ "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "gemini-3.1-flash-image", "label": "Nano Banana 2", "capability": "image" }, { "name": "mock-image", "capability": "image" }], "weight": 1, "enabled": true }] },
  "public": { "modelChannel": { "modelCosts": [{ "model": "mock-image", "credits": 1, "qualityCredits": { "medium": 2, "high": 5 } }] } }
}' >/dev/null
check "模型展示名下发给前端" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models[] | select(.name=="gemini-3.1-flash-image") | .label')" "Nano Banana 2"
check "没配展示名时回落到模型名" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.models[] | select(.name=="mock-image") | .label')" "mock-image"
check "档位加价已保存" "$(curl -s "$BASE/settings" | jq -r '.data.modelChannel.modelCosts[0].qualityCredits.high')" "5"

curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
# 基础价 1 + high 档加价 5 = 6，两张就是 12。
curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"key-quality","kind":"image","model":"mock-image","prompt":"4k 图","params":{"count":2,"quality":"high"},"inputFileIds":[]}' >/dev/null
for _ in $(seq 1 20); do
    [ "$(curl -s "$BASE/v1/jobs?status=pending,running" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" = "0" ] && break
    sleep 1
done
check "按档位叠加后扣费正确" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_consume")][0].amount')" "-12"

echo "云空间配额"
USED=$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)
check "用量按已存文件实时聚合" "$([ "$USED" -gt 0 ] && echo yes || echo no)" "yes"
check "默认配额为 100MB" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.quota)" "104857600"
check "后台用户列表带出云空间用量" "$(curl -s "$BASE/admin/users?keyword=tester" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].storageUsed')" "$USED"
# 把配额压到刚好用满，验证「新内容被拒、命中去重的重复上传照样放行」。
curl -s -X POST "$BASE/admin/users/$USER_ID/quota" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "{\"quota\":$USED}" >/dev/null
check "管理员调整配额立即生效" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.quota)" "$USED"
printf 'quota-smoke-test-payload' >"$WORK/other.png"
check "超出配额的上传被拒绝" "$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/other.png;type=image/png" | jq -r .msg | grep -c '云空间不足')" "1"
check "去重命中的重复上传不受配额影响" "$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/tiny.png;type=image/png" | jq -r .data.id)" "$FILE_ID"
check "去重命中后用量不变" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)" "$USED"

# 放开配额后把新文件挂到素材上，删除素材应连带回收文件并释放用量。
curl -s -X POST "$BASE/admin/users/$USER_ID/quota" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"quota":104857600}' >/dev/null
ASSET_FILE=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/other.png;type=image/png" | jq -r .data.id)
curl -s -X PUT "$BASE/v1/user-assets/a1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"kind\":\"image\",\"title\":\"配额素材\",\"data\":{\"storageKey\":\"server:$ASSET_FILE\"}}" >/dev/null
check "放开配额后可以继续上传" "$([ "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)" -gt "$USED" ] && echo yes || echo no)" "yes"
curl -s -X DELETE "$BASE/v1/user-assets/a1" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "删除素材后用量下降" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)" "$USED"
check "被回收的文件不再可读" "$(curl -s "$BASE/v1/files/$ASSET_FILE" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "文件不存在"
# 同一个文件被另一个素材引用时不能回收，否则会误删还在用的图。
KEPT_FILE=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/other.png;type=image/png" | jq -r .data.id)
curl -s -X PUT "$BASE/v1/user-assets/a2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"kind\":\"image\",\"title\":\"引用一\",\"data\":{\"storageKey\":\"server:$KEPT_FILE\"}}" >/dev/null
curl -s -X PUT "$BASE/v1/user-assets/a3" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"kind\":\"image\",\"title\":\"引用二\",\"data\":{\"storageKey\":\"server:$KEPT_FILE\"}}" >/dev/null
curl -s -X DELETE "$BASE/v1/user-assets/a2" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "仍被其它素材引用的文件不回收" "$(curl -s "$BASE/v1/files/$KEPT_FILE" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.id)" "$KEPT_FILE"
# 画布数据里的 server:<fileId> 同样要被扫出来，删画布时连带回收。
PROJECT_FILE=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/upstream.js;type=image/png" | jq -r .data.id)
curl -s -X PUT "$BASE/v1/projects/quota-p2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"配额画布\",\"revision\":0,\"clientId\":\"smoke-client\",\"data\":{\"nodes\":[{\"metadata\":{\"storageKey\":\"server:$PROJECT_FILE\"}},{\"metadata\":{\"storageKey\":\"server:$KEPT_FILE\"}}]}}" >/dev/null
curl -s -X DELETE "$BASE/v1/projects/quota-p2" -H "Authorization: Bearer $USER_TOKEN" -H "X-Client-Id: smoke-client" >/dev/null
check "删除画布回收只有它引用的文件" "$(curl -s "$BASE/v1/files/$PROJECT_FILE" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "文件不存在"
check "删除画布不影响素材还在用的文件" "$(curl -s "$BASE/v1/files/$KEPT_FILE" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.id)" "$KEPT_FILE"


echo "用户偏好云同步"
check "未登录读取偏好被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/preferences")" "401"
check "未登录保存偏好被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/preferences" -H 'Content-Type: application/json' -d '{}')" "401"
check "新账号偏好为空对象" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data | length')" "0"
curl -s -X PUT "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"imageModel":"mock-image","size":"16:9","systemPrompt":"你是助手"}' >/dev/null
check "偏好保存后能回读" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.imageModel)" "mock-image"
check "偏好里的中文完整回读" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.systemPrompt)" "你是助手"
check "另一账号读不到他人偏好" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data | length')" "0"
curl -s -X PUT "$BASE/v1/preferences" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"imageModel":"admin-model"}' >/dev/null
check "两个账号的偏好互不覆盖" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.imageModel)" "mock-image"
# 前端每次推的是整份偏好，服务端整体覆盖，旧字段不残留。
curl -s -X PUT "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"size":"1:1"}' >/dev/null
check "整份覆盖会清掉旧字段" "$(curl -s "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.imageModel // "none"')" "none"

echo "Passkey"
check "未登录列出 Passkey 被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/auth/passkeys")" "401"
check "未登录申请注册 options 被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/passkey/register/options")" "401"
check "未登录删除 Passkey 被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/auth/passkeys/whatever")" "401"
check "新账号没有 Passkey" "$(curl -s "$BASE/auth/passkeys" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data | length')" "0"
check "注册 options 带 challenge" "$(curl -s -X POST "$BASE/auth/passkey/register/options" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.challenge | length > 0')" "true"
# rpID 从请求域名推导，换域名部署不用改配置。
check "注册 options 的 rpID 取自请求域名" "$(curl -s -X POST "$BASE/auth/passkey/register/options" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.rp.id)" "127.0.0.1"
check "登录 options 支持不传用户名" "$(curl -s -X POST "$BASE/auth/passkey/login/options" -H 'Content-Type: application/json' -d '{}' | jq -r '.data.options.challenge | length > 0')" "true"
check "不存在的用户名被拒绝" "$(curl -s -X POST "$BASE/auth/passkey/login/options" -H 'Content-Type: application/json' -d '{"username":"nobody"}' | jq -r .msg)" "该账号不存在或未添加 Passkey"
check "没有 Passkey 的账号被拒绝" "$(curl -s -X POST "$BASE/auth/passkey/login/options" -H 'Content-Type: application/json' -d '{"username":"tester"}' | jq -r .msg)" "该账号不存在或未添加 Passkey"
check "伪造的 flowId 被拒绝" "$(curl -s -X POST "$BASE/auth/passkey/login/verify" -H 'Content-Type: application/json' -d '{"flowId":"forged","response":{"id":"x"}}' | jq -r .msg)" "操作已超时，请重试"
check "删除不存在的 Passkey 被拒绝" "$(curl -s -X DELETE "$BASE/auth/passkeys/nope" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "Passkey 不存在"

# 真正注册 Passkey 需要浏览器里的认证器，shell 跑不了，这里直接往库里种一条凭证，
# 用来覆盖列表、重命名、越权与「最后一个 Passkey」这些不依赖认证器的分支。
cat >"$WORK/seed-passkey.js" <<'EOF'
const [dbPath, userId] = process.argv.slice(2);
const db = require("better-sqlite3")(dbPath);
db.prepare("UPDATE users SET password = '' WHERE id = ?").run(userId);
db.prepare("INSERT INTO passkeys (id, credentialId, userId, publicKey, counter, transports, name, createdAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)").run(
    "passkey-smoke",
    "cred-smoke",
    userId,
    "AAAA",
    "[]",
    "冒烟测试",
    new Date().toISOString(),
);
db.close();
EOF
# 脚本落在临时目录里，要指到 server 的 node_modules 才找得到 better-sqlite3。
NODE_PATH="$ROOT/node_modules" node "$WORK/seed-passkey.js" "$WORK/test.db" "$USER_ID"

check "种下的 Passkey 能被列出" "$(curl -s "$BASE/auth/passkeys" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data[0].name')" "冒烟测试"
check "Passkey 列表不下发公钥" "$(curl -s "$BASE/auth/passkeys" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data[0].publicKey // "none"')" "none"
check "有 Passkey 后可拿到登录 options" "$(curl -s -X POST "$BASE/auth/passkey/login/options" -H 'Content-Type: application/json' -d '{"username":"tester"}' | jq -r '.data.options.allowCredentials | length')" "1"
check "可以重命名 Passkey" "$(curl -s -X PUT "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"我的钥匙"}' | jq -r .data.name)" "我的钥匙"
check "重命名不能传空名称" "$(curl -s -X PUT "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"  "}' | jq -r .msg)" "名称不能为空"
check "他人无法重命名该 Passkey" "$(curl -s -X PUT "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"name":"抢过来"}' | jq -r .msg)" "Passkey 不存在"
check "他人无法删除该 Passkey" "$(curl -s -X DELETE "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "Passkey 不存在"
# 没有密码的账号删掉最后一个 Passkey 就再也登不进来，必须拦住。
check "无密码账号删最后一个 Passkey 被拒绝" "$(curl -s -X DELETE "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "请先设置登录密码，否则删除后将无法登录"
check "被拒绝后 Passkey 仍在" "$(curl -s "$BASE/auth/passkeys" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data | length')" "1"
curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"","newPassword":"tester-pass-3"}' >/dev/null
check "设好密码后可以删除最后一个 Passkey" "$(curl -s -X DELETE "$BASE/auth/passkeys/passkey-smoke" -H "Authorization: Bearer $USER_TOKEN" | jq -r .code)" "0"
check "删除后列表为空" "$(curl -s "$BASE/auth/passkeys" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data | length')" "0"

echo "画布 Agent"
# mock-image-pro 专门用来验「工具指定的生成模型真的被用上」，mock-title-broken 挂在一个必定连不上的渠道上，
# 用来验「标题模型挂了就回落到截断，绝不能连累发消息」。
AGENT_CHANNELS='[
  { "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-image", "capability": "image" }, { "name": "mock-image-pro", "capability": "image" }, { "name": "mock-text", "capability": "text" }, { "name": "mock-text-vision", "capability": "text", "vision": true }], "weight": 1, "enabled": true },
  { "apiFormat": "openai", "name": "断掉的渠道", "baseUrl": "http://127.0.0.1:1", "apiKey": "sk-test", "models": [{ "name": "mock-title-broken", "capability": "text" }], "weight": 1, "enabled": true },
  { "apiFormat": "gemini", "name": "本地假 Gemini", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-gemini-text", "capability": "text" }], "weight": 1, "enabled": true }
]'
# 把 Gemini 渠道停用，用来验证「用户选的模型被管理员下线」这条路径。
AGENT_CHANNELS_NO_GEMINI='[
  { "apiFormat": "openai", "name": "本地假上游", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-image", "capability": "image" }, { "name": "mock-image-pro", "capability": "image" }, { "name": "mock-text", "capability": "text" }, { "name": "mock-text-vision", "capability": "text", "vision": true }], "weight": 1, "enabled": true },
  { "apiFormat": "openai", "name": "断掉的渠道", "baseUrl": "http://127.0.0.1:1", "apiKey": "sk-test", "models": [{ "name": "mock-title-broken", "capability": "text" }], "weight": 1, "enabled": true },
  { "apiFormat": "gemini", "name": "本地假 Gemini", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'", "apiKey": "sk-test", "models": [{ "name": "mock-gemini-text", "capability": "text" }], "weight": 1, "enabled": false }
]'
# 三个文本模型故意定不同单价：agent 按消息计费，换模型必须换单价，只有价差才验得出「计费真的按所选模型走」。
AGENT_COSTS='[{ "model": "mock-text", "credits": 1 }, { "model": "mock-gemini-text", "credits": 3 }, { "model": "mock-text-vision", "credits": 2 }, { "model": "mock-image", "credits": 1 }, { "model": "mock-image-pro", "credits": 1 }]'
# 搜索服务全部指向本地 mock 上游：baseUrl 留空才走官方地址，填了就能在冒烟里把搜索与读网页整条链路真跑一遍。
SEARCH_EMPTY='{ "enabled": true, "maxResults": 5, "services": [] }'
search_service() { echo '{ "provider": "'"$1"'", "name": "冒烟'"$1"'", "baseUrl": "http://127.0.0.1:'"$UPSTREAM_PORT"'/'"${3:-$1}"'", "apiKey": "'"$2"'", "weight": '"${4:-10}"', "enabled": true }'; }
SEARCH_EXA='{ "enabled": true, "maxResults": 3, "services": ['"$(search_service exa exa-test-key)"'] }'
# 同一条服务但密钥留空，用来验证「留空表示保持不变」按条目对应补回，不会把已配好的 key 洗掉。
SEARCH_EXA_KEEP='{ "enabled": true, "maxResults": 3, "services": ['"$(search_service exa "")"'] }'
SEARCH_DISABLED='{ "enabled": false, "maxResults": 3, "services": ['"$(search_service exa "")"'] }'
SEARCH_TAVILY='{ "enabled": true, "maxResults": 3, "services": ['"$(search_service tavily tavily-test-key)"'] }'
# 权重高的那条指向必定 500 的路径，验证会自动降级到后面那条。
SEARCH_FAILOVER='{ "enabled": true, "maxResults": 3, "services": ['"$(search_service exa exa-test-key broken/exa 20)"', '"$(search_service tavily tavily-test-key tavily 5)"'] }'
# 参数依次是：搜索配置、agent 主模型、渠道配置（默认两条渠道都开着）、标题模型、最大轮数。
agent_settings() {
    curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
      "private": { "channels": '"${3:-$AGENT_CHANNELS}"', "search": '"$1"' },
      "public": {
        "modelChannel": { "defaultTextModel": "mock-text", "defaultImageModel": "mock-image", "modelCosts": '"$AGENT_COSTS"' },
        "agent": { "enabled": true, "model": '"$2"', "titleModel": '"${4:-\"\"}"', "maxRounds": '"${5:-5}"' }
      }
    }' >/dev/null
}
credits_now() { curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits; }
agent_session() { curl -s "$BASE/v1/agent/sessions/$1" -H "Authorization: Bearer $USER_TOKEN"; }
agent_title() { agent_session "$1" | jq -r .data.title; }
agent_model() { curl -s "$BASE/v1/agent/sessions/$1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.model; }
agent_status() { curl -s "$BASE/v1/agent/sessions/$1" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status; }
wait_agent_idle() {
    for _ in $(seq 1 40); do
        [ "$(agent_status "$1")" != "running" ] && break
        sleep 1
    done
}
agent_resolve() { curl -s -X POST "$BASE/v1/agent/sessions/$1/resolve" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"approved":'"$2"'}'; }
new_agent_session() { curl -s -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "$1" | jq -r .data.id; }
agent_settings "$SEARCH_EMPTY" '""'
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null

check "Agent 开关下发给前端" "$(curl -s "$BASE/settings" | jq -r .data.agent.enabled)" "true"
check "最大轮数下发给前端" "$(curl -s "$BASE/settings" | jq -r .data.agent.maxRounds)" "5"
check "没配搜索密钥时联网搜索关闭" "$(curl -s "$BASE/settings" | jq -r .data.agent.searchEnabled)" "false"
check "搜索密钥不会下发给前端" "$(curl -s "$BASE/settings" | jq -r '.data.agent.apiKey // "none"')" "none"
check "后台读取时没配服务就是空列表" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.private.search.services | length')" "0"
check "未登录访问会话列表返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/agent/sessions")" "401"

curl -s -X PUT "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Agent 画布","revision":0,"clientId":"smoke-client","data":{"nodes":[],"connections":[]}}' >/dev/null
check "会话必须绑定存在的画布" "$(curl -s -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"projectId":"不存在的画布"}' | jq -r .msg)" "画布项目不存在"
SESSION=$(curl -s -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"projectId":"agent-p1","title":"冒烟会话"}' | jq -r .data.id)
check "创建会话成功" "$([ -n "$SESSION" ] && [ "$SESSION" != "null" ] && echo yes || echo no)" "yes"
check "会话用的是系统配置的文本模型" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.model)" "mock-text"
check "按画布筛选会话生效" "$(curl -s "$BASE/v1/agent/sessions?projectId=agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" "1"
check "换个画布筛不出会话" "$(curl -s "$BASE/v1/agent/sessions?projectId=agent-p9" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" "0"
check "他人无法读取该会话" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "会话不存在"

# 发消息只负责入库并触发后台执行，接口立刻返回，循环在服务端继续跑。
check "发消息要带幂等键" "$(curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"content":"x"}' | jq -r .msg)" "缺少消息幂等键"
FIRST_SEQ=$(curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m1","content":"在画布上加一个文本节点"}' | jq -r .data.seq)
check "用户消息落库并拿到序号" "$FIRST_SEQ" "1"
check "同一幂等键不会重复建消息" "$(curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m1","content":"在画布上加一个文本节点"}' | jq -r .data.seq)" "1"
check "执行期间会话状态为 running" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "running"

for _ in $(seq 1 40); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "idle" ] && break
    sleep 1
done
AGENT_MSGS=$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN")
check "循环跑完后回到 idle" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "idle"
check "工具调用被真正执行" "$(echo "$AGENT_MSGS" | jq -r '[.data.items[] | select(.role=="tool")][0].toolName')" "create_node"
check "工具结果落库" "$(echo "$AGENT_MSGS" | jq -r '[.data.items[] | select(.role=="tool")][0].toolResult | fromjson | .ok')" "true"
check "模型最终回复落库" "$(echo "$AGENT_MSGS" | jq -r '[.data.items[] | select(.role=="assistant")][-1].content')" "已经按你的要求改好画布了。"
check "工具列表里没有 web_search" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="web_search")] | length')" "0"
check "工具列表里没有 read_webpage" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="read_webpage")] | length')" "0"
check "工具列表里没有 import_image" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="import_image")] | length')" "0"
check "工具列表里有画布读写工具" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="read_canvas" or .=="create_node" or .=="connect_nodes")] | length')" "3"

# 工具直接改的是服务端画布，revision 递增后前端现有的增量同步就能拉到。
AGENT_PROJECT=$(curl -s "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN")
check "工具真的改到了服务端画布" "$(echo "$AGENT_PROJECT" | jq -r '.data.data.nodes | length')" "1"
check "画布 revision 递增可被前端拉到" "$([ "$(echo "$AGENT_PROJECT" | jq -r .data.revision)" -gt 1 ] && echo yes || echo no)" "yes"
check "节点结构与前端约定一致" "$(echo "$AGENT_PROJECT" | jq -r '.data.data.nodes[0] | "\(.type)/\(.title)/\(.position.x)/\(.width)/\(.metadata.content)"')" "text/冒烟节点/80/340/由 agent 创建"
check "一条消息只扣一次算力点" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.remark=="调用模型 mock-text")] | length')" "1"

# 断线增量拉取：带上最后看到的 seq 只返回后续消息。
LAST_SEQ=$(echo "$AGENT_MSGS" | jq -r '.data.items[-1].seq')
check "sinceSeq 只返回增量" "$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages?sinceSeq=1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].seq')" "2"
check "sinceSeq 追平后没有增量" "$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages?sinceSeq=$LAST_SEQ" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" "0"
check "重连拉全量能拿回完整会话" "$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages?sinceSeq=0" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items | length')" "$LAST_SEQ"

# SSE 断开不能中断服务端循环：订阅上以后立刻掐断连接，循环仍要跑完并把结果落库。
curl -s -N --max-time 2 "$BASE/v1/agent/sessions/$SESSION/stream?sinceSeq=$LAST_SEQ" -H "Authorization: Bearer $USER_TOKEN" >"$WORK/sse.txt" &
SSE_PID=$!
sleep 0.5
curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m2","content":"再加一个文本节点"}' >/dev/null
wait "$SSE_PID" 2>/dev/null
check "SSE 推送了会话状态" "$(grep -c '"type":"status"' "$WORK/sse.txt")" "2"
check "SSE 推送了新消息" "$([ "$(grep -c '"type":"message"' "$WORK/sse.txt")" -gt 0 ] && echo yes || echo no)" "yes"
check "SSE 断开时循环还没跑完" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "running"
for _ in $(seq 1 40); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "idle" ] && break
    sleep 1
done
RESUMED=$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages?sinceSeq=$LAST_SEQ" -H "Authorization: Bearer $USER_TOKEN")
check "SSE 断开后循环仍跑完" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "idle"
check "断线期间的进度可用 sinceSeq 补齐" "$(echo "$RESUMED" | jq -r '[.data.items[] | select(.role=="tool")] | length')" "1"
check "断线期间的画布改动也已落库" "$(curl -s "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.data.nodes | length')" "2"

# 生图工具复用现有任务队列，照常扣算力点、占云空间、落到用户文件里。
curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m3","content":"帮我生成图片"}' >/dev/null
for _ in $(seq 1 60); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "idle" ] && break
    sleep 1
done
IMAGE_NODE=$(curl -s "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.data.nodes[] | select(.type=="image")][0]')
check "生图工具在画布上建了图片节点" "$(echo "$IMAGE_NODE" | jq -r .type)" "image"
check "图片节点引用服务端文件" "$(echo "$IMAGE_NODE" | jq -r '.metadata.storageKey | startswith("server:")')" "true"
check "生图走的是现有任务队列" "$(curl -s "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.context.source=="agent" and .status=="succeeded")] | length')" "1"
check "生图照常计费" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.remark=="调用模型 mock-image")] | length')" "3"

# 换 Gemini 格式的渠道，同一套工具循环要照样跑通。
agent_settings "$SEARCH_EMPTY" '"mock-gemini-text"'
GEMINI_SESSION=$(curl -s -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"projectId":"agent-p1","title":"Gemini 会话"}' | jq -r .data.id)
curl -s -X POST "$BASE/v1/agent/sessions/$GEMINI_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"gemini-m1","content":"在画布上加一个文本节点"}' >/dev/null
for _ in $(seq 1 40); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$GEMINI_SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "idle" ] && break
    sleep 1
done
GEMINI_MSGS=$(curl -s "$BASE/v1/agent/sessions/$GEMINI_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN")
check "管理员指定的 Agent 专用模型生效" "$(curl -s "$BASE/v1/agent/sessions/$GEMINI_SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.model)" "mock-gemini-text"
check "Gemini 格式的工具调用也能跑通" "$(echo "$GEMINI_MSGS" | jq -r '[.data.items[] | select(.role=="tool")][0].toolName')" "create_node"
check "Gemini 格式能拿到最终回复" "$(echo "$GEMINI_MSGS" | jq -r '[.data.items[] | select(.role=="assistant")][-1].content')" "已经按你的要求改好画布了。"

# 用户自选模型：选了就按选的跑、按选的单价计费；生图模型和没配过的模型一律挡下来回落到管理员默认。
agent_settings "$SEARCH_EMPTY" '""'
PICK_SESSION=$(new_agent_session '{"projectId":"agent-p1","title":"选模型会话","model":"mock-gemini-text"}')
check "用户指定的文本模型能生效" "$(agent_model "$PICK_SESSION")" "mock-gemini-text"
check "不指定模型时用管理员配置的默认" "$(agent_model "$(new_agent_session '{"projectId":"agent-p1","title":"默认模型会话"}')")" "mock-text"
check "生图模型不能拿来跑 agent" "$(agent_model "$(new_agent_session '{"projectId":"agent-p1","title":"生图模型会话","model":"mock-image"}')")" "mock-text"
check "没配过的模型不能拿来跑 agent" "$(agent_model "$(new_agent_session '{"projectId":"agent-p1","title":"野模型会话","model":"不存在的模型"}')")" "mock-text"

# 计费按会话实际用的模型算，且一条消息只扣一次：mock-gemini-text 每条消息 3 点，换成 mock-text 只会扣 1 点。
PICK_BEFORE=$(credits_now)
curl -s -X POST "$BASE/v1/agent/sessions/$PICK_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"pick-m1","content":"在画布上加一个文本节点","model":"mock-gemini-text"}' >/dev/null
wait_agent_idle "$PICK_SESSION"
check "用户选的模型真的跑起来了" "$(agent_status "$PICK_SESSION")" "idle"
check "按用户选的模型计费" "$((PICK_BEFORE - $(credits_now)))" "3"

# 关键回归：管理员改了全站默认，也不能把用户已经选好的模型冲掉。
agent_settings "$SEARCH_EMPTY" '"mock-text"'
KEEP_BEFORE=$(credits_now)
curl -s -X POST "$BASE/v1/agent/sessions/$PICK_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"pick-m2","content":"再加一个文本节点"}' >/dev/null
wait_agent_idle "$PICK_SESSION"
check "用户选的模型不会被管理员配置冲掉" "$(agent_model "$PICK_SESSION")" "mock-gemini-text"
check "沿用会话模型时也按该模型计费" "$((KEEP_BEFORE - $(credits_now)))" "3"

# 管理员把用户选的模型下线：不该报错卡死，要静默回落到默认模型继续跑完。
agent_settings "$SEARCH_EMPTY" '""' "$AGENT_CHANNELS_NO_GEMINI"
check "下线的模型不再下发给前端" "$(curl -s "$BASE/settings" | jq -r '[.data.modelChannel.models[] | select(.name=="mock-gemini-text")] | length')" "0"
FALLBACK_BEFORE=$(credits_now)
curl -s -X POST "$BASE/v1/agent/sessions/$PICK_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"pick-m3","content":"再加一个文本节点","model":"mock-gemini-text"}' >/dev/null
wait_agent_idle "$PICK_SESSION"
check "选的模型被下线后回落到默认模型" "$(agent_model "$PICK_SESSION")" "mock-text"
check "回落之后照样跑完，不会卡死" "$(agent_status "$PICK_SESSION")" "idle"
check "回落之后按默认模型计费" "$((FALLBACK_BEFORE - $(credits_now)))" "1"

# 配上搜索密钥后才把 web_search 交给模型，没配时既不报错也不下发。
agent_settings "$SEARCH_EXA" '""'
check "配了密钥后联网搜索开启" "$(curl -s "$BASE/settings" | jq -r .data.agent.searchEnabled)" "true"
check "后台读取时搜索密钥被脱敏" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.private.search.services[0].apiKey')" ""
check "脱敏不会连服务商配置一起抹掉" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.private.search.services[0].provider')" "exa"
SEARCH_SESSION=$(curl -s -X POST "$BASE/v1/agent/sessions" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"projectId":"agent-p1","title":"搜索会话"}' | jq -r .data.id)
curl -s -X POST "$BASE/v1/agent/sessions/$SEARCH_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"search-m1","content":"在画布上加一个文本节点"}' >/dev/null
for _ in $(seq 1 40); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$SEARCH_SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" = "idle" ] && break
    sleep 1
done
check "配了密钥后才把 web_search 下发给模型" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="web_search")] | length')" "1"
check "配了密钥后才把 read_webpage 下发给模型" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="read_webpage")] | length')" "1"
check "配了密钥后才把 import_image 下发给模型" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="import_image")] | length')" "1"

# 读网页真的把上游正文取回来，并按服务端上限截断后告诉模型「没读完」。
agent_message() {
    curl -s -X POST "$BASE/v1/agent/sessions/$1/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"'"$2"'","content":"'"$3"'"}' >/dev/null
    wait_agent_idle "$1"
}
last_tool_result() { curl -s "$BASE/v1/agent/sessions/$1/messages" -H "Authorization: Bearer $USER_TOKEN" | jq -r "[.data.items[] | select(.toolName==\"$2\")][-1].toolResult"; }

agent_message "$SEARCH_SESSION" "read-m1" "帮我读取网页"
EXA_PAGE=$(last_tool_result "$SEARCH_SESSION" "read_webpage" | jq -r '.data')
check "读网页拿到 Exa 的正文" "$(echo "$EXA_PAGE" | jq -r '.title')" "冒烟长文Exa"
check "读网页回填原始网址" "$(echo "$EXA_PAGE" | jq -r '.url')" "https://example.com/long-article"
check "超长正文按 8000 字符截断" "$(echo "$EXA_PAGE" | jq -r '.text | length')" "8000"
check "截断时明确告诉模型没读完" "$(echo "$EXA_PAGE" | jq -r '.truncated')" "true"
check "截断时附带中文说明" "$(echo "$EXA_PAGE" | jq -r '.note | contains("只有开头部分")')" "true"

# 换一家服务商：Tavily 的字段名完全不同（raw_content 且没有长度参数），provider 抽象要能各解析各的。
agent_settings "$SEARCH_TAVILY" '""'
agent_message "$SEARCH_SESSION" "read-m2" "帮我读取网页"
TAVILY_PAGE=$(last_tool_result "$SEARCH_SESSION" "read_webpage" | jq -r '.data')
check "换成 Tavily 也能读到正文" "$(echo "$TAVILY_PAGE" | jq -r '.title')" "冒烟长文Tavily"
check "Tavily 的整篇原文同样被截断" "$(echo "$TAVILY_PAGE" | jq -r '.text | length')" "8000"
agent_message "$SEARCH_SESSION" "search-m2" "帮我联网搜索"
TAVILY_FOUND=$(last_tool_result "$SEARCH_SESSION" "web_search" | jq -r '.data')
check "换成 Tavily 也能搜到结果" "$(echo "$TAVILY_FOUND" | jq -r '.results[0].url')" "https://example.com/tavily"
check "Tavily 的图片进本次搜索的图片列表" "$(echo "$TAVILY_FOUND" | jq -r '.images[0]')" "https://example.com/tavily-1.jpg"
check "Tavily 不把整页图片堆当成结果配图" "$(echo "$TAVILY_FOUND" | jq -r '.results[0].imageUrl')" ""

# 多服务自动切换：权重高的那家必定 500，整条链路仍要成功。
agent_settings "$SEARCH_FAILOVER" '""'
agent_message "$SEARCH_SESSION" "read-m3" "帮我读取网页"
FAILOVER_PAGE=$(last_tool_result "$SEARCH_SESSION" "read_webpage" | jq -r '.data')
check "优先级高的搜索服务挂了会自动换下一家" "$(echo "$FAILOVER_PAGE" | jq -r '.title')" "冒烟长文Tavily"
check "自动换服务商后正文照样截断" "$(echo "$FAILOVER_PAGE" | jq -r '.text | length')" "8000"
agent_message "$SEARCH_SESSION" "search-m3" "帮我联网搜索"
check "搜索同样会自动换到可用的服务商" "$(last_tool_result "$SEARCH_SESSION" "web_search" | jq -r '.data.results[0].url')" "https://example.com/tavily"

# 内网地址必须挡住：模型可能被网页内容诱导去探测部署环境。
agent_settings "$SEARCH_EXA" '""'
agent_message "$SEARCH_SESSION" "read-m4" "帮我读取内网地址"
INTERNAL=$(last_tool_result "$SEARCH_SESSION" "read_webpage")
check "读网页拒绝内网地址" "$(echo "$INTERNAL" | jq -r '.ok')" "false"
check "拒绝内网地址给出中文原因" "$(echo "$INTERNAL" | jq -r '.error')" "不能读取本机或内网地址"

# 搜到的图片要能真的变成画布用得上的服务端文件。整条链路是「搜索拿到图片地址 → import_image 落库 → storageKey 建节点」。
agent_message "$SEARCH_SESSION" "search-m4" "帮我联网搜索"
EXA_FOUND=$(last_tool_result "$SEARCH_SESSION" "web_search" | jq -r '.data')
check "Exa 的配图跟着对应结果一起回来" "$(echo "$EXA_FOUND" | jq -r '.results[0].imageUrl')" "https://example.com/exa-cover.jpg"
check "Exa 的图片都能归属到结果上" "$(echo "$EXA_FOUND" | jq -r '.images | length')" "0"

check "mock 图床可按主机名访问" "$(curl -s -o /dev/null -w '%{http_code}' "$IMG_ORIGIN/img/ok.png")" "200"
agent_message "$SEARCH_SESSION" "img-m1" "帮我导入图片"
IMPORT_OK=$(last_tool_result "$SEARCH_SESSION" "import_image")
check "导入网上的图片成功" "$(echo "$IMPORT_OK" | jq -r '.ok')" "true"
IMPORT_KEY=$(echo "$IMPORT_OK" | jq -r '.data.storageKey')
IMPORT_ID="${IMPORT_KEY#server:}"
check "导入后拿到 server: 形式的 storageKey" "$(echo "$IMPORT_KEY" | grep -c '^server:')" "1"
check "落库类型按字节判断" "$(echo "$IMPORT_OK" | jq -r '.data.mimeType')" "image/png"
check "导入的文件进了这个用户的云空间" "$(curl -s "$BASE/v1/files/$IMPORT_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.id)" "$IMPORT_ID"
check "导入的图片可按直链读回" "$(curl -s -o /dev/null -w '%{content_type}' "$BASE/files/$IMPORT_ID/content")" "image/png"
# 拿到的 storageKey 要能直接喂给 create_node，否则「搜到图 → 插进画布」还是断的。
agent_message "$SEARCH_SESSION" "img-m2" "用这张图建节点 $IMPORT_KEY"
check "导入的 storageKey 能直接建成画布图片节点" "$(curl -s "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.data.nodes[] | select(.metadata.storageKey=="'"$IMPORT_KEY"'")] | length')" "1"

# 本来就支持的格式原样落库，不做任何转码：字节数和源文件一模一样才算没被重新编码。
agent_message "$SEARCH_SESSION" "img-m3" "帮我导入 webp 图片"
IMPORT_WEBP=$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.data')
check "webp 原样导入不被转码" "$(echo "$IMPORT_WEBP" | jq -r '.mimeType')" "image/webp"
check "webp 字节数与源文件一致" "$(echo "$IMPORT_WEBP" | jq -r '.bytes')" "36"
check "webp 的宽高也解析出来了" "$(echo "$IMPORT_WEBP" | jq -r '"\(.width)x\(.height)"')" "6x3"

# 下面四条都是必须挡住的输入。挡住之后云空间用量不能有任何变化，否则等于被写进去了。
BAD_USED=$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)
agent_message "$SEARCH_SESSION" "img-m4" "帮我导入内网图片"
check "导入图片同样拒绝内网地址" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error')" "不能读取本机或内网地址"
agent_message "$SEARCH_SESSION" "img-m5" "帮我导入超大图片"
check "超过上限的图片被中断下载" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error')" "图片超过 10MB，已中止下载，请换一张小一点的图"
agent_message "$SEARCH_SESSION" "img-m6" "帮我导入伪装图片"
check "伪装成 png 的 HTML 被字节校验挡住" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error')" "这个地址的内容不是图片"
agent_message "$SEARCH_SESSION" "img-m7" "帮我导入网页地址"
check "响应头就不是图片时直接拒绝" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error')" "这个地址返回的不是图片：text/html"
agent_message "$SEARCH_SESSION" "img-m8" "帮我导入 avif 图片"
check "画布与上游都吃不下的格式被拒绝" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error')" "暂不支持 avif 格式的图片，请换一张 png、jpeg 或 webp 的图片地址"
check "被拒绝的内容一个字节都没落库" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)" "$BAD_USED"

# 导入占的是用户自己的云空间，配额压满后必须明确报错，不能悄悄存进去。
curl -s -X POST "$BASE/admin/users/$USER_ID/quota" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "{\"quota\":$BAD_USED}" >/dev/null
agent_message "$SEARCH_SESSION" "img-m9" "帮我导入另一张图片"
check "云空间不足时导入明确报错" "$(last_tool_result "$SEARCH_SESSION" "import_image" | jq -r '.error' | grep -c '云空间不足')" "1"
check "配额不足时也没写进云空间" "$(curl -s "$BASE/v1/storage" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.used)" "$BAD_USED"
curl -s -X POST "$BASE/admin/users/$USER_ID/quota" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"quota":104857600}' >/dev/null

# 留空表示保持不变，别把已配好的密钥洗掉。
agent_settings "$SEARCH_EXA_KEEP" '""'
check "留空保存不会清掉搜索密钥" "$(curl -s "$BASE/settings" | jq -r .data.agent.searchEnabled)" "true"
agent_settings "$SEARCH_DISABLED" '""'
check "关掉开关后联网搜索不可用" "$(curl -s "$BASE/settings" | jq -r .data.agent.searchEnabled)" "false"

# 画布节点引用与图片附件：引用只把 ID / 类型 / 标题交给模型，附件才真的进上下文。
# 这两条路径故意都用支持视觉的模型跑，才能证明「不带图」是设计如此，不是因为模型不认图。
agent_settings "$SEARCH_EMPTY" '""'
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
REF_FILE=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $USER_TOKEN" -F "file=@$WORK/tiny.png;type=image/png" | jq -r .data.id)
curl -s -X PUT "$BASE/v1/projects/agent-ref" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"引用画布","revision":0,"clientId":"smoke-client","data":{"nodes":[
  {"id":"ref-a","type":"image","title":"图A","position":{"x":0,"y":0},"width":200,"height":200,"metadata":{"storageKey":"server:'"$REF_FILE"'"}},
  {"id":"ref-b","type":"image","title":"图B","position":{"x":300,"y":0},"width":200,"height":200,"metadata":{"storageKey":"server:'"$REF_FILE"'"}},
  {"id":"ref-c","type":"text","title":"说明","position":{"x":600,"y":0},"width":200,"height":120,"metadata":{"content":"一段文字"}}
],"connections":[]}}' >/dev/null
REF_SESSION=$(new_agent_session '{"projectId":"agent-ref","title":"引用会话","model":"mock-text-vision"}')

check "引用不存在的节点直接报错" "$(curl -s -X POST "$BASE/v1/agent/sessions/$REF_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"ref-bad","content":"看看 @[没了](canvas-node:ref-x#image)","model":"mock-text-vision"}' | jq -r .msg)" "引用的画布节点已不存在：ref-x"

# 标记插在句子中间，位置本身有语义；客户端给的标题与类型一律不信，按当前画布重写。
REF_BEFORE=$(credits_now)
REF_MSG=$(curl -s -X POST "$BASE/v1/agent/sessions/$REF_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"ref-m1","content":"我需要对 @[假标题](canvas-node:ref-a#text) 和 @[图B](canvas-node:ref-b#image) 的图片作为参考，再改一下 @[说明](canvas-node:ref-c#text)","model":"mock-text-vision"}')
check "引用按出现顺序落库" "$(echo "$REF_MSG" | jq -r '[.data.references[].nodeId] | join(",")')" "ref-a,ref-b,ref-c"
check "引用只带 ID、类型、标题和缩略图键" "$(echo "$REF_MSG" | jq -r '.data.references[0] | keys | join(",")')" "nodeId,storageKey,title,type"
check "客户端传的类型不作数" "$(echo "$REF_MSG" | jq -r '.data.references[0].type')" "image"
check "客户端传的标题不作数" "$(echo "$REF_MSG" | jq -r '.data.references[0].title')" "图A"
check "文本节点也能被引用" "$(echo "$REF_MSG" | jq -r '.data.references[2].type')" "text"
check "标记留在正文原来的位置上" "$(echo "$REF_MSG" | jq -r '.data.content')" "我需要对 @[图A](canvas-node:ref-a#image) 和 @[图B](canvas-node:ref-b#image) 的图片作为参考，再改一下 @[说明](canvas-node:ref-c#text)"
wait_agent_idle "$REF_SESSION"
REF_CONTEXT=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last")
check "引用标记原样进了模型上下文" "$(echo "$REF_CONTEXT" | jq -r '[.messages[] | select(.role=="user") | tostring | select(test("canvas-node:ref-a"))] | length')" "1"
check "系统提示里说明了引用格式" "$(echo "$REF_CONTEXT" | jq -r '[.messages[] | select(.role=="system") | select(.content | test("canvas-node:节点ID#节点类型"))] | length')" "1"
check "引用不会把图片数据塞进上下文" "$(echo "$REF_CONTEXT" | jq -r 'tostring | test("data:image")')" "false"
check "引用不会带上任何图片部件" "$(echo "$REF_CONTEXT" | jq -r '[.. | objects | select(.type=="image_url")] | length')" "0"
check "一条消息只按所选模型扣一次" "$((REF_BEFORE - $(credits_now)))" "2"

# 只给 references 不在正文里插标记：这类引用在句子里没有位置，统一补到正文末尾。
TAIL_MSG=$(curl -s -X POST "$BASE/v1/agent/sessions/$REF_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"ref-m2","content":"帮我看看这个","references":[{"nodeId":"ref-b"}],"model":"mock-text-vision"}')
check "单独给的引用也会落库" "$(echo "$TAIL_MSG" | jq -r '[.data.references[].nodeId] | join(",")')" "ref-b"
check "单独给的引用补到正文末尾" "$(echo "$TAIL_MSG" | jq -r '.data.content')" "帮我看看这个

@[图B](canvas-node:ref-b#image)"
wait_agent_idle "$REF_SESSION"

# 附件走的是另一条路：图片要真的进上下文，还要能被工具按 storageKey 引用到。
ATT_SESSION=$(new_agent_session '{"projectId":"agent-ref","title":"附件会话","model":"mock-text"}')
check "不支持视觉的模型不能收图" "$(curl -s -X POST "$BASE/v1/agent/sessions/$ATT_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"att-bad","content":"看这张图","attachmentIds":["'"$REF_FILE"'"],"model":"mock-text"}' | jq -r .msg)" "当前模型不支持识别图片，请换一个标注了「支持视觉」的模型再发图"
check "别人的文件不能当附件" "$(curl -s -X POST "$BASE/v1/agent/sessions/$ATT_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"att-bad2","content":"看这张图","attachmentIds":["不存在的文件"],"model":"mock-text-vision"}' | jq -r .msg)" "图片附件不存在或已被删除"
ATT_MSG=$(curl -s -X POST "$BASE/v1/agent/sessions/$ATT_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"att-m1","content":"用这张图建节点","attachmentIds":["'"$REF_FILE"'"],"model":"mock-text-vision"}')
check "附件落库" "$(echo "$ATT_MSG" | jq -r '.data.attachments | join(",")')" "$REF_FILE"
wait_agent_idle "$ATT_SESSION"
ATT_CONTEXT=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last")
check "附件真的进了模型上下文" "$(echo "$ATT_CONTEXT" | jq -r '[.. | objects | select(.type=="image_url")] | length >= 1')" "true"
check "附件是按 data url 传的" "$(echo "$ATT_CONTEXT" | jq -r 'tostring | test("data:image/png;base64,")')" "true"
check "附件的 storageKey 也给了模型" "$(echo "$ATT_CONTEXT" | jq -r 'tostring | test("server:'"$REF_FILE"'")')" "true"
check "工具能按 storageKey 引用到附件" "$(curl -s "$BASE/v1/projects/agent-ref" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.data.nodes[] | select(.metadata.storageKey=="server:'"$REF_FILE"'" and .title=="附件节点")] | length')" "1"


# 生成工具的全量参数：模型给什么就透传什么，服务端不再自己写一套归一化，也不能在半路把参数吃掉。
agent_settings "$SEARCH_EMPTY" '""'
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
GEN_SESSION=$(new_agent_session '{"projectId":"agent-p1","title":"生成参数会话"}')
agent_message "$GEN_SESSION" "gen-m1" "帮我全参数生图"
GEN_IMAGE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "工具指定的生图模型真的用上了" "$(echo "$GEN_IMAGE" | jq -r .model)" "mock-image-pro"
check "画质档位透传到上游请求" "$(echo "$GEN_IMAGE" | jq -r .quality)" "high"
check "背景参数透传到上游请求" "$(echo "$GEN_IMAGE" | jq -r .background)" "transparent"
check "尺寸参数透传到上游请求" "$(echo "$GEN_IMAGE" | jq -r .size)" "1024x1024"
check "张数透传到上游请求" "$(echo "$GEN_IMAGE" | jq -r .n)" "2"
check "工具结果里回报了实际用的模型" "$(last_tool_result "$GEN_SESSION" "generate_image" | jq -r .data.model)" "mock-image-pro"

# 拿文本模型去生图：按 capability 挡下来并静默回落到默认生图模型，而不是报错让这一轮白跑。
agent_message "$GEN_SESSION" "gen-m2" "帮我用文本模型生图"
check "能力不匹配的模型回落到默认生图模型" "$(last_tool_result "$GEN_SESSION" "generate_image" | jq -r .data.model)" "mock-image"
check "回落之后照样生成成功" "$(last_tool_result "$GEN_SESSION" "generate_image" | jq -r .ok)" "true"

# generate_text 复用 jobs 里已有的 text 任务：计费、落库、幂等都跟着那一套走，不另起一份。
check "文本生成工具下发给了模型" "$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_tools" | jq -r '[.tools[] | select(.=="generate_text")] | length')" "1"
GEN_TEXT_BEFORE=$(credits_now)
agent_message "$GEN_SESSION" "gen-m3" "帮我写一篇长文"
check "文本生成工具执行成功" "$(last_tool_result "$GEN_SESSION" "generate_text" | jq -r .ok)" "true"
check "文本生成走的是现有任务队列" "$(curl -s "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.context.source=="agent" and .kind=="text" and .status=="succeeded")] | length')" "1"
check "生成的正文落到了文本节点上" "$(curl -s "$BASE/v1/projects/agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.data.nodes[] | select(.title=="长文")][0].metadata.content')" "$TEXT_FULL"
# 发消息 1 点 + 文本任务 1 点：两笔都要真的扣到，少一笔就说明有一条路径没走计费。
check "文本生成照常按模型单价计费" "$((GEN_TEXT_BEFORE - $(credits_now)))" "2"

# Agent 生成默认设置：优先级是「模型显式传的 > 用户偏好 > 全站默认」。
# 断言一律看 mock 上游真正收到的请求体，只看接口返回成功的话，参数在半路被吃掉也验不出来。
set_agent_prefs() { curl -s -X PUT "$BASE/v1/preferences" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "$1" >/dev/null; }

# 先钉住「没配过偏好」时的老行为：模型是全站默认，尺寸画质背景一个都不该凭空冒出来。
set_agent_prefs '{}'
agent_message "$GEN_SESSION" "pref-m0" "帮我生成图片"
PREF_NONE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "没配偏好时用全站默认生图模型" "$(echo "$PREF_NONE" | jq -r .model)" "mock-image"
check "没配偏好时不给上游塞尺寸" "$(echo "$PREF_NONE" | jq -r '.size // "none"')" "none"
check "没配偏好时不给上游塞画质" "$(echo "$PREF_NONE" | jq -r '.quality // "none"')" "none"
check "没配偏好时不给上游塞背景" "$(echo "$PREF_NONE" | jq -r '.background // "none"')" "none"
check "没配偏好时张数仍是 1" "$(echo "$PREF_NONE" | jq -r .n)" "1"

# 配上偏好后，同一句「帮我生成图片」（工具只传了提示词）发给上游的请求体必须是偏好里的规格。
set_agent_prefs '{"agentImageModel":"mock-image-pro","agentImageSize":"1024x1024","agentImageQuality":"high","agentImageCount":"2","agentImageBackground":"transparent"}'
agent_message "$GEN_SESSION" "pref-m1" "帮我生成图片"
PREF_IMAGE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "偏好里的生图模型进了上游请求" "$(echo "$PREF_IMAGE" | jq -r .model)" "mock-image-pro"
check "偏好里的尺寸进了上游请求" "$(echo "$PREF_IMAGE" | jq -r .size)" "1024x1024"
check "偏好里的画质进了上游请求" "$(echo "$PREF_IMAGE" | jq -r .quality)" "high"
check "偏好里的背景进了上游请求" "$(echo "$PREF_IMAGE" | jq -r .background)" "transparent"
check "偏好里的张数进了上游请求" "$(echo "$PREF_IMAGE" | jq -r .n)" "2"
check "工具结果里回报的是偏好模型" "$(last_tool_result "$GEN_SESSION" "generate_image" | jq -r .data.model)" "mock-image-pro"

# 模型自己传了参数就以它为准，偏好只补它没传的那部分。这里偏好与显式参数每一项都不同，才验得出到底谁赢。
set_agent_prefs '{"agentImageModel":"mock-image","agentImageSize":"512x512","agentImageQuality":"low","agentImageCount":"3","agentImageBackground":"opaque"}'
agent_message "$GEN_SESSION" "pref-m2" "帮我全参数生图"
PREF_OVERRIDE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "显式模型覆盖偏好模型" "$(echo "$PREF_OVERRIDE" | jq -r .model)" "mock-image-pro"
check "显式尺寸覆盖偏好尺寸" "$(echo "$PREF_OVERRIDE" | jq -r .size)" "1024x1024"
check "显式画质覆盖偏好画质" "$(echo "$PREF_OVERRIDE" | jq -r .quality)" "high"
check "显式背景覆盖偏好背景" "$(echo "$PREF_OVERRIDE" | jq -r .background)" "transparent"
check "显式张数覆盖偏好张数" "$(echo "$PREF_OVERRIDE" | jq -r .n)" "2"

# 偏好里的模型被管理员下线之后要静默回落到全站默认：不能报错，也不能连带把其他偏好参数丢掉。
set_agent_prefs '{"agentImageModel":"已经下线的模型","agentImageSize":"1024x1024"}'
agent_message "$GEN_SESSION" "pref-m3" "帮我生成图片"
PREF_GONE=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "偏好模型被下线后回落到全站默认" "$(echo "$PREF_GONE" | jq -r .model)" "mock-image"
check "回落之后偏好里的其他参数照样生效" "$(echo "$PREF_GONE" | jq -r .size)" "1024x1024"
check "偏好模型被下线也不报错" "$(last_tool_result "$GEN_SESSION" "generate_image" | jq -r .ok)" "true"

# 偏好里存的模型还在、但能力被管理员改成了文本：同样只能回落，绝不能拿文本模型去生图。
set_agent_prefs '{"agentImageModel":"mock-text"}'
agent_message "$GEN_SESSION" "pref-m4" "帮我生成图片"
PREF_WRONG_KIND=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_lastimage")
check "偏好里配成文本模型时回落到全站默认" "$(echo "$PREF_WRONG_KIND" | jq -r .model)" "mock-image"
# 这条同时钉住「拿到的是这次的请求体」：上一次偏好里带着尺寸，这次没带，尺寸就不该还在。
check "上一次偏好的尺寸不会残留到这次请求" "$(echo "$PREF_WRONG_KIND" | jq -r '.size // "none"')" "none"

# 生文默认模型同理：工具没指定模型时用偏好里的那个，计费也跟着按它的单价走。
set_agent_prefs '{"agentTextModel":"mock-text-vision"}'
PREF_TEXT_BEFORE=$(credits_now)
agent_message "$GEN_SESSION" "pref-m5" "帮我按偏好写长文"
check "偏好里的生文模型被用上" "$(last_tool_result "$GEN_SESSION" "generate_text" | jq -r .data.model)" "mock-text-vision"
# 发消息按会话模型 mock-text 扣 1 点 + 文本任务按偏好模型 mock-text-vision 扣 2 点。
check "文本生成按偏好模型的单价计费" "$((PREF_TEXT_BEFORE - $(credits_now)))" "3"
# 后面几节都按「没有偏好」的口径断言，这里清干净，免得偏好串到别的用例里。
set_agent_prefs '{}'

# 会话标题：配了标题模型就用模型起名，且只在第一条用户消息时起一次。
agent_settings "$SEARCH_EMPTY" '""' "$AGENT_CHANNELS" '"mock-text"'
TITLE_SESSION=$(new_agent_session '{"projectId":"agent-p1","title":"新会话"}')
curl -s -X POST "$BASE/v1/agent/sessions/$TITLE_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"title-m1","content":"在画布上加一个文本节点"}' >/dev/null
for _ in $(seq 1 20); do
    [ "$(agent_title "$TITLE_SESSION")" = "冒烟-在画布" ] && break
    sleep 1
done
check "配了标题模型时用模型生成会话标题" "$(agent_title "$TITLE_SESSION")" "冒烟-在画布"
wait_agent_idle "$TITLE_SESSION"
# 标题里带着第一条消息的原话，所以第二条消息如果又生成一次，标题会变成「冒烟-再加一」。
agent_message "$TITLE_SESSION" "title-m2" "再加一个文本节点"
check "标题只在第一条消息时生成一次" "$(agent_title "$TITLE_SESSION")" "冒烟-在画布"

# 标题模型挂掉：发消息必须照常成功，标题回落到截断，绝不能让起标题拖垮主链路。
agent_settings "$SEARCH_EMPTY" '""' "$AGENT_CHANNELS" '"mock-title-broken"'
BROKEN_SESSION=$(new_agent_session '{"projectId":"agent-p1","title":"新会话"}')
check "标题模型挂掉不影响发消息" "$(curl -s -X POST "$BASE/v1/agent/sessions/$BROKEN_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"title-m3","content":"标题模型挂了也要能发消息"}' | jq -r .data.seq)" "1"
sleep 3
check "标题生成失败时回落到截断" "$(agent_title "$BROKEN_SESSION")" "标题模型挂了也要能发消息"
wait_agent_idle "$BROKEN_SESSION"
check "没配标题模型时也用截断" "$(agent_settings "$SEARCH_EMPTY" '""' && NOTITLE=$(new_agent_session '{"projectId":"agent-p1","title":"新会话"}') && agent_message "$NOTITLE" "title-m4" "没配标题模型时用截断" && agent_title "$NOTITLE")" "没配标题模型时用截断"

# 轮数耗尽不再直接收工，而是暂停下来向用户申请继续。maxRounds 压到 2，冒烟里才跑得快。
agent_settings "$SEARCH_EMPTY" '""' "$AGENT_CHANNELS" '""' 2
curl -s -X PUT "$BASE/v1/projects/agent-rounds" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"轮数画布","revision":0,"clientId":"smoke-client","data":{"nodes":[],"connections":[]}}' >/dev/null
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
ROUND_SESSION=$(new_agent_session '{"projectId":"agent-rounds","title":"轮数会话"}')
ROUND_BEFORE=$(credits_now)
agent_message "$ROUND_SESSION" "round-m1" "你就一直干活别停"
ROUND_VIEW=$(agent_session "$ROUND_SESSION")
check "轮数耗尽后进入等待确认而不是直接结束" "$(echo "$ROUND_VIEW" | jq -r .data.status)" "awaiting"
check "待确认请求的类型是续跑" "$(echo "$ROUND_VIEW" | jq -r .data.pendingAction.type)" "continue"
check "待确认请求带上已用轮数" "$(echo "$ROUND_VIEW" | jq -r .data.pendingAction.roundsUsed)" "2"
check "待确认请求带上继续要花的算力点" "$(echo "$ROUND_VIEW" | jq -r .data.pendingAction.credits)" "1"
check "轮数真的按上限跑满" "$(curl -s "$BASE/v1/projects/agent-rounds" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.data.nodes | length')" "2"
check "等待确认期间只扣了发消息那一次" "$((ROUND_BEFORE - $(credits_now)))" "1"
check "等待确认时不能再发新消息" "$(curl -s -X POST "$BASE/v1/agent/sessions/$ROUND_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"round-m2","content":"插队"}' | jq -r .msg)" "当前会话正在等待你确认，请先处理确认请求或中止"

# 批准续跑：轮数重置成上限，并且按当前模型单价再扣一次点。
APPROVE_BEFORE=$(credits_now)
check "批准续跑后回到执行中" "$(agent_resolve "$ROUND_SESSION" true | jq -r .data.status)" "running"
check "批准续跑确实又扣了一次点" "$((APPROVE_BEFORE - $(credits_now)))" "1"
wait_agent_idle "$ROUND_SESSION"
check "续跑后轮数是重置过的" "$(agent_session "$ROUND_SESSION" | jq -r .data.pendingAction.roundsUsed)" "2"
check "续跑真的多干了两轮活" "$(curl -s "$BASE/v1/projects/agent-rounds" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.data.nodes | length')" "4"

# 拒绝：正常收尾，不再扣点，也不留下待确认状态。
REJECT_BEFORE=$(credits_now)
check "拒绝后本次执行正常结束" "$(agent_resolve "$ROUND_SESSION" false | jq -r .data.status)" "idle"
check "拒绝不扣算力点" "$((REJECT_BEFORE - $(credits_now)))" "0"
check "拒绝后清掉待确认请求" "$(agent_session "$ROUND_SESSION" | jq -r '.data.pendingAction // "none"')" "none"
check "拒绝后留下可见的收尾消息" "$(curl -s "$BASE/v1/agent/sessions/$ROUND_SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[-1].content')" "好的，本次执行到此为止。"
check "没有待确认请求时答复被拒绝" "$(agent_resolve "$ROUND_SESSION" true | jq -r .msg)" "当前没有待确认的请求"

# 余额不足时批准续跑要明确拒绝，不能悄悄放行跑一段免费的。
agent_message "$ROUND_SESSION" "round-m3" "你就一直干活别停"
check "再次跑满仍然进入等待确认" "$(agent_status "$ROUND_SESSION")" "awaiting"
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":0}' >/dev/null
check "余额不足时批准续跑被明确拒绝" "$(agent_resolve "$ROUND_SESSION" true | jq -r .msg)" "算力点不足"
check "被拒绝后仍停在等待确认" "$(agent_status "$ROUND_SESSION")" "awaiting"
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
curl -s -X POST "$BASE/v1/agent/sessions/$ROUND_SESSION/abort" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "等待确认时中止可用" "$(agent_status "$ROUND_SESSION")" "idle"
check "中止后待确认请求被清掉" "$(agent_session "$ROUND_SESSION" | jq -r '.data.pendingAction // "none"')" "none"

# 画布标题：还是系统默认标题时允许主动改一次，之后一律要确认。
agent_settings "$SEARCH_EMPTY" '""'
curl -s -X PUT "$BASE/v1/projects/agent-title" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"无限画布 3","revision":0,"clientId":"smoke-client","data":{"nodes":[],"connections":[]}}' >/dev/null
TITLE_CANVAS=$(new_agent_session '{"projectId":"agent-title","title":"标题会话"}')
agent_message "$TITLE_CANVAS" "ct-m1" "帮我改画布标题"
check "默认标题下主动改名立刻生效" "$(curl -s "$BASE/v1/projects/agent-title" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.title)" "猫咪画册"
check "主动改名不需要用户确认" "$(agent_status "$TITLE_CANVAS")" "idle"
agent_message "$TITLE_CANVAS" "ct-m2" "帮我再改一次标题"
CT_VIEW=$(agent_session "$TITLE_CANVAS")
check "第二次改名必须用户确认" "$(echo "$CT_VIEW" | jq -r .data.status)" "awaiting"
check "待确认请求的类型是改标题" "$(echo "$CT_VIEW" | jq -r .data.pendingAction.type)" "rename_canvas"
check "待确认请求带上新标题" "$(echo "$CT_VIEW" | jq -r .data.pendingAction.title)" "猫咪画册二版"
check "待确认请求带上改名理由" "$(echo "$CT_VIEW" | jq -r .data.pendingAction.reason)" "用户又加了新内容"
check "等待确认期间画布标题没有被改掉" "$(curl -s "$BASE/v1/projects/agent-title" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.title)" "猫咪画册"
# 刷新或换设备后靠 SSE 首帧就能把待确认请求原样恢复出来。
curl -s -N --max-time 2 "$BASE/v1/agent/sessions/$TITLE_CANVAS/stream?sinceSeq=0" -H "Authorization: Bearer $USER_TOKEN" >"$WORK/pending-sse.txt"
check "SSE 重连能拿回待确认请求" "$(grep '^data: ' "$WORK/pending-sse.txt" | sed 's/^data: //' | jq -rs '[.[] | select(.type=="status") | .pendingAction.type] | last // ""')" "rename_canvas"
check "批准改名后回到执行中" "$(agent_resolve "$TITLE_CANVAS" true | jq -r .data.status)" "running"
wait_agent_idle "$TITLE_CANVAS"
check "批准后画布标题才真的改掉" "$(curl -s "$BASE/v1/projects/agent-title" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.title)" "猫咪画册二版"

# 「无限画布精选」只是前缀像默认标题，用户自己起的名字一样不能被擅自改掉。
curl -s -X PUT "$BASE/v1/projects/agent-title2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"无限画布精选","revision":0,"clientId":"smoke-client","data":{"nodes":[],"connections":[]}}' >/dev/null
TITLE_CANVAS2=$(new_agent_session '{"projectId":"agent-title2","title":"标题会话2"}')
agent_message "$TITLE_CANVAS2" "ct-m3" "帮我改画布标题"
check "非默认标题第一次改名就要确认" "$(agent_status "$TITLE_CANVAS2")" "awaiting"
check "拒绝改名后正常收尾" "$(agent_resolve "$TITLE_CANVAS2" false | jq -r .data.status)" "idle"
check "拒绝后画布标题原样保留" "$(curl -s "$BASE/v1/projects/agent-title2" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.title)" "无限画布精选"

curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m4","content":"再加一个文本节点"}' >/dev/null
check "执行中不允许并发发消息" "$(curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientMessageId":"agent-m5","content":"插队"}' | jq -r .msg)" "当前会话正在执行中，请等待完成或先中止"
curl -s -X POST "$BASE/v1/agent/sessions/$SESSION/abort" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
for _ in $(seq 1 20); do
    [ "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" != "running" ] && break
    sleep 1
done
check "中止后会话不再是 running" "$(curl -s "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.status)" "idle"
check "中止会留下可见的提示消息" "$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[-1].content')" "已中止本次执行。"

curl -s -X DELETE "$BASE/v1/agent/sessions/$SESSION" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
check "删除后会话不再列出" "$(curl -s "$BASE/v1/agent/sessions?projectId=agent-p1" -H "Authorization: Bearer $USER_TOKEN" | jq -r '[.data.items[] | select(.id=="'"$SESSION"'")] | length')" "0"
check "删除后拉消息被拒绝" "$(curl -s "$BASE/v1/agent/sessions/$SESSION/messages" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "会话不存在"

echo "文本任务"
# 文本生成和生图走同一套任务队列：服务端边收上游流边落库，前端断开也不影响任务继续跑完。
# 任务事件流是一条连接推当前用户所有任务的状态与文本增量，下面三个函数从抓下来的流里取某个任务的内容、终态和游标。
stream_text() { grep '^data: ' "$1" | sed 's/^data: //' | jq -rs --arg id "$2" '[.[] | select(.type=="text" and .id==$id) | .text] | add // ""'; }
stream_status() { grep '^data: ' "$1" | sed 's/^data: //' | jq -rs --arg id "$2" '[.[] | select(.type=="job" and .job.id==$id) | .job.status] | last // ""'; }
stream_seq() { grep '^data: ' "$1" | sed 's/^data: //' | jq -rs '[.[] | select(.seq != null) | .seq] | max // 0'; }
job_stream() { curl -s -N --max-time "$2" "$BASE/v1/jobs/stream?sinceSeq=$3" -H "Authorization: Bearer ${4:-$USER_TOKEN}" >"$1"; }
text_job() { curl -s "$BASE/v1/jobs/$1" -H "Authorization: Bearer $USER_TOKEN"; }

curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":50}' >/dev/null
TEXT_JOB=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"text-1","kind":"text","model":"mock-text","prompt":"介绍一下无限画布","params":{"reasoningEffort":"auto"},"inputFileIds":[],"context":{"source":"canvas","projectId":"agent-p1","nodeId":"text-node-1"}}' | jq -r .data.id)
check "提交文本任务成功" "$([ -n "$TEXT_JOB" ] && [ "$TEXT_JOB" != "null" ] && echo yes || echo no)" "yes"
check "文本任务被识别为 text 类型" "$(text_job "$TEXT_JOB" | jq -r .data.kind)" "text"

# 上游每 0.8 秒吐一片，落库节奏是「攒够 1 秒或 400 字」，这时库里应该已经有半截内容。
sleep 2
PARTIAL=$(text_job "$TEXT_JOB" | jq -r .data.text)
check "生成中途已经把部分内容落库" "$([ -n "$PARTIAL" ] && [ "$PARTIAL" != "$TEXT_FULL" ] && echo yes || echo "no（实际「$PARTIAL」）")" "yes"
check "落库的半截内容是完整文本的前缀" "$(case "$TEXT_FULL" in "$PARTIAL"*) echo yes ;; *) echo no ;; esac)" "yes"
check "中途任务仍在进行中" "$(text_job "$TEXT_JOB" | jq -r .data.status)" "running"

for _ in $(seq 1 30); do
    [ "$(text_job "$TEXT_JOB" | jq -r .data.status)" = "succeeded" ] && break
    sleep 1
done
check "文本任务执行成功" "$(text_job "$TEXT_JOB" | jq -r .data.status)" "succeeded"
check "完成后拿到完整内容" "$(text_job "$TEXT_JOB" | jq -r .data.text)" "$TEXT_FULL"
check "文本任务不产出文件" "$(text_job "$TEXT_JOB" | jq -r '.data.outputs | length')" "0"
check "文本任务照常扣算力点" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "49"

# 已结束的任务照样能补齐：带一个更早的游标重连，快照会把完整文本和终态一起推回来，换设备打开画布靠的就是这条路径。
job_stream "$WORK/text-done.txt" 3 1
check "补齐已结束的任务能拿回完整内容" "$(stream_text "$WORK/text-done.txt" "$TEXT_JOB")" "$TEXT_FULL"
check "补齐已结束的任务会推终态" "$(stream_status "$WORK/text-done.txt" "$TEXT_JOB")" "succeeded"
# 游标追平之后，已经结束的任务不会再被补一遍，只剩还在跑的任务需要推。
job_stream "$WORK/text-caught-up.txt" 3 "$(stream_seq "$WORK/text-done.txt")"
check "游标追平后不再补已结束的任务" "$(stream_status "$WORK/text-caught-up.txt" "$TEXT_JOB")" ""
check "游标追平后也不会重发内容" "$(stream_text "$WORK/text-caught-up.txt" "$TEXT_JOB")" ""

# 幂等：同一个键既不重复建任务，也不重复扣费。
check "同一幂等键不会重复建文本任务" "$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"text-1","kind":"text","model":"mock-text","prompt":"介绍一下无限画布","params":{},"inputFileIds":[]}' | jq -r .data.id)" "$TEXT_JOB"
sleep 2
check "重发幂等键不会重复扣费" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "49"

# 断线续传：订阅一会儿就掐断，任务继续在服务端跑；带上断开时的游标重连，剩下的内容与终态都能补齐。
TEXT_JOB2=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"text-2","kind":"text","model":"mock-text","prompt":"再写一段","params":{},"inputFileIds":[],"context":{"source":"canvas","projectId":"agent-p1","nodeId":"text-node-2"}}' | jq -r .data.id)
job_stream "$WORK/text-sse1.txt" 2.5 0
PART1=$(stream_text "$WORK/text-sse1.txt" "$TEXT_JOB2")
check "断开前已经收到增量" "$([ -n "$PART1" ] && [ "$PART1" != "$TEXT_FULL" ] && echo yes || echo "no（实际「$PART1」）")" "yes"
check "断开时还没推终态" "$(stream_status "$WORK/text-sse1.txt" "$TEXT_JOB2")" "running"
check "订阅断开不会中断任务" "$(text_job "$TEXT_JOB2" | jq -r .data.status)" "running"
job_stream "$WORK/text-sse2.txt" 10 "$(stream_seq "$WORK/text-sse1.txt")"
check "按游标重连补齐后能拿回完整文本" "$(stream_text "$WORK/text-sse2.txt" "$TEXT_JOB2")" "$TEXT_FULL"
check "重连后能收到终态" "$(stream_status "$WORK/text-sse2.txt" "$TEXT_JOB2")" "succeeded"
check "断线期间的内容也已落库" "$(text_job "$TEXT_JOB2" | jq -r .data.text)" "$TEXT_FULL"

# 取消正在跑的文本任务：已经流出来的半截留在任务里，算力点原路返还。
TEXT_JOB3=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"text-3","kind":"text","model":"mock-text","prompt":"这段会被取消","params":{},"inputFileIds":[]}' | jq -r .data.id)
sleep 2.5
curl -s -X POST "$BASE/v1/jobs/$TEXT_JOB3/cancel" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
sleep 1
CANCELED=$(text_job "$TEXT_JOB3")
check "取消后任务状态为 canceled" "$(echo "$CANCELED" | jq -r .data.status)" "canceled"
check "取消保留已经生成的半截内容" "$([ -n "$(echo "$CANCELED" | jq -r .data.text)" ] && echo yes || echo no)" "yes"
# 50 起步，三个文本任务各扣 1 点，被取消的那次原路返还，净消耗 2 点。
check "取消后算力点原路返还" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "48"
check "取消也写了返还流水" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.type=="ai_refund" and (.extra | fromjson | .path) == "/jobs/text")] | length')" "1"

# Gemini 格式的渠道同样走流式，解析的是另一套事件结构。
GEMINI_TEXT_JOB=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"text-gemini","kind":"text","model":"mock-gemini-text","prompt":"用 Gemini 格式写","params":{},"inputFileIds":[]}' | jq -r .data.id)
for _ in $(seq 1 30); do
    [ "$(text_job "$GEMINI_TEXT_JOB" | jq -r .data.status)" = "succeeded" ] && break
    sleep 1
done
check "Gemini 格式的文本流也能跑通" "$(text_job "$GEMINI_TEXT_JOB" | jq -r .data.text)" "$TEXT_FULL"
# 这里数的是全库文本任务：本节建的 4 条，加上 agent 那一节的两条（工具指定模型的那条、按用户偏好模型的那条）。
check "文本任务也能被后台按类型筛出来" "$(curl -s "$BASE/admin/jobs?kind=text" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "6"

echo "任务事件流"
# 生成任务的进度不再靠轮询：一条 SSE 连接订阅当前用户的所有任务。
# 之所以必须是一条，是因为浏览器对同源只允许 6 个并发连接，每任务一条会把连接池占满。
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":50}' >/dev/null
check "未登录无法订阅任务事件流" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/jobs/stream")" "401"

# 一条连接同时跟两个任务：一个慢的文本任务和一个秒回的生图任务，两边的事件都要从同一条流里出来。
job_stream "$WORK/stream-base.txt" 2 0
STREAM_SEQ=$(stream_seq "$WORK/stream-base.txt")
job_stream "$WORK/stream-multi.txt" 14 "$STREAM_SEQ" &
STREAM_PID=$!
sleep 0.5
MULTI_TEXT=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"stream-text","kind":"text","model":"mock-text","prompt":"一条流里的文本","params":{},"inputFileIds":[]}' | jq -r .data.id)
MULTI_IMAGE=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"stream-image","kind":"image","model":"mock-image","prompt":"一条流里的图","params":{"count":1},"inputFileIds":[]}' | jq -r .data.id)
wait "$STREAM_PID" 2>/dev/null
check "同一条连接推到了文本任务的终态" "$(stream_status "$WORK/stream-multi.txt" "$MULTI_TEXT")" "succeeded"
check "同一条连接推到了生图任务的终态" "$(stream_status "$WORK/stream-multi.txt" "$MULTI_IMAGE")" "succeeded"
check "同一条连接里的文本增量拼得回完整文本" "$(stream_text "$WORK/stream-multi.txt" "$MULTI_TEXT")" "$TEXT_FULL"
check "同一条连接里带回了生图产物" "$(grep '^data: ' "$WORK/stream-multi.txt" | sed 's/^data: //' | jq -rs --arg id "$MULTI_IMAGE" '[.[] | select(.type=="job" and .job.id==$id) | .job.outputs[0].mimeType] | last // ""')" "image/png"
check "同一条连接里两个任务的进度互不干扰" "$(grep '^data: ' "$WORK/stream-multi.txt" | sed 's/^data: //' | jq -rs --arg a "$MULTI_TEXT" --arg b "$MULTI_IMAGE" '[.[] | select(.type=="job") | .job.id] | (index($a) != null) and (index($b) != null)')" "true"

# 断线期间跑完的任务：重连带上断开时的游标就能补回终态，不用重新拉一次全量。
# 游标用的是自增序号而不是时间戳，同一毫秒内落多次变更也不会被漏掉。
CATCH_JOB=$(curl -s -X POST "$BASE/v1/jobs" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"clientJobId":"stream-catchup","kind":"text","model":"mock-text","prompt":"断线期间跑完","params":{},"inputFileIds":[]}' | jq -r .data.id)
job_stream "$WORK/stream-before.txt" 2 "$(stream_seq "$WORK/stream-multi.txt")"
CATCH_SEQ=$(stream_seq "$WORK/stream-before.txt")
check "断开时任务还没结束" "$(stream_status "$WORK/stream-before.txt" "$CATCH_JOB")" "running"
sleep 8
check "断线期间任务照常跑完" "$(text_job "$CATCH_JOB" | jq -r .data.status)" "succeeded"
job_stream "$WORK/stream-after.txt" 3 "$CATCH_SEQ"
check "断线期间的终态在重连补齐里能拿回" "$(stream_status "$WORK/stream-after.txt" "$CATCH_JOB")" "succeeded"
check "断线期间的文本在重连补齐里能拿回" "$(stream_text "$WORK/stream-after.txt" "$CATCH_JOB")" "$TEXT_FULL"

# 安全：事件流按用户分发，拿别人的令牌订阅不到这个账号的任务。
job_stream "$WORK/stream-other.txt" 3 1 "$ADMIN_TOKEN"
check "换个账号订阅不到别人的任务" "$(grep -c "$CATCH_JOB" "$WORK/stream-other.txt")" "0"
check "换个账号的流也拿不到别人的文本" "$(stream_text "$WORK/stream-other.txt" "$CATCH_JOB")" ""
check "换个账号的流里没有任何别人的任务快照" "$(grep '^data: ' "$WORK/stream-other.txt" | sed 's/^data: //' | jq -rs '[.[] | select(.type=="job")] | length')" "0"

echo "邀请码"
invite_settings() {
    curl -s -X POST "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
      "public": { "auth": { "allowRegister": true, "requireInvite": '"$1"', "linuxDo": { "enabled": true } } },
      "private": { "auth": { "linuxDo": { "clientId": "smoke-id", "clientSecret": "smoke-secret" } } }
    }' >/dev/null
}
new_invites() { curl -s -X POST "$BASE/admin/invites" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$1"; }
invite_row() { curl -s --get "$BASE/admin/invites" --data-urlencode "keyword=$1" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r ".data.items[] | select(.code==\"$1\")"; }
register_invited() { curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"invite-pass\",\"inviteCode\":\"$2\"}"; }
oauth_callback_code() { curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/linux-do/callback?code=$2&state=$1"; }
complete_linuxdo() { curl -s -X POST "$BASE/auth/linux-do/complete" -H 'Content-Type: application/json' -d "{\"pendingToken\":\"$1\",\"inviteCode\":\"$2\"}"; }

invite_settings false
check "开关默认关闭" "$(curl -s "$BASE/settings" | jq -r .data.auth.requireInvite)" "false"
check "普通用户读不到邀请码列表" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/invites" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "未登录也读不到邀请码列表" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/invites")" "401"
check "普通用户不能批量生成" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/invites" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"count":1}')" "401"

# 批量生成：一次要出 N 个互不相同、且看不出规律的码。
BATCH=$(new_invites '{"count":8,"maxUses":2,"credits":7,"note":"冒烟批量"}')
check "批量生成返回指定数量" "$(echo "$BATCH" | jq -r '.data | length')" "8"
check "批量生成的码互不相同" "$(echo "$BATCH" | jq -r '[.data[].code] | unique | length')" "8"
# 不可枚举：10 位随机大写码，去掉了 0/O/1/I/L 这些形近字，既猜不出也没有连号规律。
check "码值长度固定" "$(echo "$BATCH" | jq -r '[.data[].code | length] | unique | join(",")')" "10"
check "码值只含约定字母表" "$(echo "$BATCH" | jq -r '[.data[].code | test("^[A-HJ-KM-NP-Z2-9]+$")] | all')" "true"
check "码值没有公共前缀（不可预测）" "$(echo "$BATCH" | jq -r '[.data[].code[0:4]] | unique | length > 1')" "true"
check "生成时写入了配置" "$(echo "$BATCH" | jq -r '.data[0] | "\(.maxUses)/\(.credits)/\(.note)/\(.enabled)/\(.usedCount)"')" "2/7/冒烟批量/true/0"
check "批量生成的码都能在列表里查到" "$(curl -s --get "$BASE/admin/invites" --data-urlencode 'keyword=冒烟批量' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "8"
check "列表带出使用情况" "$(invite_row "$(echo "$BATCH" | jq -r '.data[0].code')" | jq -r '"\(.usedCount)/\(.maxUses)"')" "0/2"

GIFT_CODE=$(echo "$BATCH" | jq -r '.data[0].code')
LIMIT_CODE=$(echo "$BATCH" | jq -r '.data[1].code')
CASE_CODE=$(echo "$BATCH" | jq -r '.data[2].code')
OFF_CODE=$(echo "$BATCH" | jq -r '.data[3].code')
RACE_CODE=$(echo "$BATCH" | jq -r '.data[4].code')
PATCH_CODE=$(echo "$BATCH" | jq -r '.data[5].code')
DROP_CODE=$(echo "$BATCH" | jq -r '.data[6].code')
LINUXDO_CODE=$(echo "$BATCH" | jq -r '.data[7].code')

# 开关关着的时候，不填邀请码必须照常能注册，不能因为后台建了码就把大门堵上。
check "关闭强制邀请码时不填也能注册" "$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"invite-off","password":"invite-pass"}' | jq -r .code)" "0"

invite_settings true
check "开关打开后公开配置能读到" "$(curl -s "$BASE/settings" | jq -r .data.auth.requireInvite)" "true"
check "开启后不填邀请码被拒" "$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"invite-none","password":"invite-pass"}' | jq -r .msg)" "请输入邀请码"
check "开启后填错邀请码被拒" "$(register_invited invite-bad NOTEXISTCODE | jq -r .msg)" "邀请码无效"
check "被拒时没有凭空建出账号" "$(curl -s "$BASE/admin/users?keyword=invite-none" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"

# 用码注册：算力点要真的到账，而且能在流水里查到是哪个码送的。
GIFT_TOKEN=$(register_invited invite-gift "$GIFT_CODE" | jq -r .data.token)
check "用有效邀请码能注册" "$([ -n "$GIFT_TOKEN" ] && [ "$GIFT_TOKEN" != "null" ] && echo yes || echo no)" "yes"
check "赠送的算力点已到账" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $GIFT_TOKEN" | jq -r .data.credits)" "7"
check "赠送算力点写了流水" "$(curl -s "$BASE/admin/credit-logs?keyword=$GIFT_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].type')" "invite_gift"
check "流水里能看出是哪个邀请码送的" "$(curl -s "$BASE/admin/credit-logs?keyword=$GIFT_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].remark')" "邀请码 $GIFT_CODE 注册赠送"
check "流水金额与配置一致" "$(curl -s "$BASE/admin/credit-logs?keyword=$GIFT_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].amount')" "7"
check "已用次数递增" "$(invite_row "$GIFT_CODE" | jq -r .usedCount)" "1"

# 大小写策略：码只存大写，输入一律 trim + 转大写，用户抄成小写照样能用。
check "小写输入的邀请码同样有效" "$(register_invited invite-lower "$(echo "$CASE_CODE" | tr 'A-Z' 'a-z')" | jq -r .code)" "0"
check "前后空格不影响使用" "$(register_invited invite-space "  $CASE_CODE  " | jq -r .code)" "0"
check "两次都记在同一个码上" "$(invite_row "$CASE_CODE" | jq -r .usedCount)" "2"

# 次数用完：第 3 个人再用同一个码必须被拒。
check "用完前两次名额" "$(register_invited invite-limit-1 "$LIMIT_CODE" | jq -r .code)$(register_invited invite-limit-2 "$LIMIT_CODE" | jq -r .code)" "00"
check "次数用完后同一个码被拒" "$(register_invited invite-limit-3 "$LIMIT_CODE" | jq -r .msg)" "邀请码已用完"
check "被拒后已用次数没有超上限" "$(invite_row "$LIMIT_CODE" | jq -r '"\(.usedCount)/\(.maxUses)"')" "2/2"

# 停用的码立刻失效，不用等次数用完。
curl -s -X PATCH "$BASE/admin/invites/$OFF_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
check "停用后的码被拒" "$(register_invited invite-disabled "$OFF_CODE" | jq -r .msg)" "邀请码已停用"

# 并发抢最后一个名额：两个注册请求同时打进来，只能成功一个，usedCount 不能超过 maxUses。
curl -s -X PATCH "$BASE/admin/invites/$RACE_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"maxUses":1}' >/dev/null
register_invited invite-race-a "$RACE_CODE" >"$WORK/race-a.json" &
RACE_A=$!
register_invited invite-race-b "$RACE_CODE" >"$WORK/race-b.json" &
RACE_B=$!
wait "$RACE_A" "$RACE_B"
RACE_CODES="$(jq -r .code "$WORK/race-a.json") $(jq -r .code "$WORK/race-b.json")"
check "并发抢最后一个名额只成功一个" "$(echo "$RACE_CODES" | tr ' ' '\n' | grep -c '^0$')" "1"
check "另一个并发请求被明确拒绝" "$(jq -r .msg "$WORK/race-a.json" "$WORK/race-b.json" | grep -c '邀请码已用完')" "1"
check "并发后已用次数没有超上限" "$(invite_row "$RACE_CODE" | jq -r '"\(.usedCount)/\(.maxUses)"')" "1/1"
check "并发后只建出了一个账号" "$(curl -s "$BASE/admin/users?keyword=invite-race" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "1"

# 使用记录：后台要能查到这个码被谁、在什么时候用了。
USES=$(curl -s "$BASE/admin/invites/$CASE_CODE/uses" -H "Authorization: Bearer $ADMIN_TOKEN")
check "使用记录条数与已用次数一致" "$(echo "$USES" | jq -r .data.total)" "2"
check "使用记录带出用户名" "$(echo "$USES" | jq -r '[.data.items[].username] | sort | join(",")')" "invite-lower,invite-space"
check "使用记录带出使用时间" "$(echo "$USES" | jq -r '[.data.items[] | select(.usedAt | test("^[0-9]{4}-"))] | length')" "2"
check "使用记录带出当时赠送的点数" "$(echo "$USES" | jq -r '.data.items[0].credits')" "7"
check "没人用过的码查不到使用记录" "$(curl -s "$BASE/admin/invites/$DROP_CODE/uses" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "普通用户查不到使用记录" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/invites/$CASE_CODE/uses" -H "Authorization: Bearer $USER_TOKEN")" "401"

# 编辑与删除。
PATCHED=$(curl -s -X PATCH "$BASE/admin/invites/$PATCH_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"maxUses":5,"credits":13,"note":"改过的备注","enabled":false}')
check "可以改次数上限与赠送点数" "$(echo "$PATCHED" | jq -r '.data | "\(.maxUses)/\(.credits)/\(.note)/\(.enabled)"')" "5/13/改过的备注/false"
check "改不存在的码有明确文案" "$(curl -s -X PATCH "$BASE/admin/invites/NOTEXISTCODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"enabled":true}' | jq -r .msg)" "邀请码不存在"
# 上限不允许改到已用次数以下，否则后台会显示出 1/0 这种看着像坏了的数据。
curl -s -X PATCH "$BASE/admin/invites/$CASE_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"maxUses":1}' >/dev/null
check "上限不会被改到已用次数以下" "$(invite_row "$CASE_CODE" | jq -r '"\(.usedCount)/\(.maxUses)"')" "2/2"
# maxUses 为 0 是「不限次」：前端后台就是这么标的，改成 0 之后不能被当成 0 个名额直接作废。
curl -s -X PATCH "$BASE/admin/invites/$GIFT_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"maxUses":0}' >/dev/null
check "上限可以改成不限次" "$(invite_row "$GIFT_CODE" | jq -r .maxUses)" "0"
check "不限次的码还能继续用" "$(register_invited invite-unlimited-1 "$GIFT_CODE" | jq -r .code)$(register_invited invite-unlimited-2 "$GIFT_CODE" | jq -r .code)" "00"
check "不限次的码照常累计已用次数" "$(invite_row "$GIFT_CODE" | jq -r .usedCount)" "3"
check "没人用过的码可以删除" "$(curl -s -X DELETE "$BASE/admin/invites/$DROP_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .code)" "0"
check "删除后列表里查不到" "$(invite_row "$DROP_CODE" | jq -r .code)" ""
# 用过的码不物理删除：删了使用记录就成了孤儿，后台再也查不出这个人是拿哪个码进来的。
check "用过的码不允许删除" "$(curl -s -X DELETE "$BASE/admin/invites/$GIFT_CODE" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .msg)" "该邀请码已被使用，不能删除，请改为停用"
check "用过的码删除后仍在" "$(invite_row "$GIFT_CODE" | jq -r .code)" "$GIFT_CODE"
check "使用记录没有被带走" "$(curl -s "$BASE/admin/invites/$GIFT_CODE/uses" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "3"

# 第三方登录：新用户在开启强制邀请码时只能拿到待注册凭据，绝不能直接换到登录令牌。
PENDING_CB="$(oauth_callback_code "$(oauth_state)" invite-code-flow)"
PENDING_TOKEN="$(echo "$PENDING_CB" | sed -n 's/.*[?&]pendingToken=\([^&]*\).*/\1/p')"
check "第三方新用户拿不到登录令牌" "$(echo "$PENDING_CB" | grep -c '[?&]token=')" "0"
check "拿到的是待注册凭据而不是登录令牌" "$(echo "$PENDING_CB" | grep -c 'pendingToken=')" "1"
check "待注册阶段没有凭空建号" "$(curl -s "$BASE/admin/users?keyword=smoke-invited" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "伪造的待注册凭据被拒" "$(complete_linuxdo forged-pending-token "$LINUXDO_CODE" | jq -r .msg)" "注册凭据已过期，请重新发起 Linux.do 登录"
# 拿 OAuth 的 state 令牌来顶待注册凭据：签名是对的，但用途不同，必须靠 kind 挡住。
check "拿 state 令牌冒充待注册凭据被拒" "$(complete_linuxdo "$(oauth_state)" "$LINUXDO_CODE" | jq -r .msg)" "注册凭据无效，请重新发起 Linux.do 登录"
check "凭据有效但邀请码错误被拒" "$(complete_linuxdo "$PENDING_TOKEN" NOTEXISTCODE | jq -r .msg)" "邀请码无效"
check "邀请码错误时仍然没有建号" "$(curl -s "$BASE/admin/users?keyword=smoke-invited" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"

LINUXDO_SESSION=$(complete_linuxdo "$PENDING_TOKEN" "$LINUXDO_CODE")
LINUXDO_TOKEN=$(echo "$LINUXDO_SESSION" | jq -r .data.token)
check "补交邀请码后拿到登录会话" "$([ -n "$LINUXDO_TOKEN" ] && [ "$LINUXDO_TOKEN" != "null" ] && echo yes || echo no)" "yes"
check "补交后账号才被建出来" "$(curl -s "$BASE/admin/users?keyword=smoke-invited" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "1"
check "新账号确实绑着第三方身份" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $LINUXDO_TOKEN" | jq -r .data.linuxDoBound)" "true"
check "第三方注册也拿到赠送的算力点" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $LINUXDO_TOKEN" | jq -r .data.credits)" "7"
check "第三方注册的使用记录能查到人" "$(curl -s "$BASE/admin/invites/$LINUXDO_CODE/uses" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].username')" "smoke-invited"
check "同一张凭据不会重复建号" "$(complete_linuxdo "$PENDING_TOKEN" "$LINUXDO_CODE" | jq -r .code)$(curl -s "$BASE/admin/users?keyword=smoke-invited" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "01"

# 已经存在的第三方用户不该被要求邀请码，否则老用户全被挡在门外。
EXISTING_CB="$(oauth_callback_code "$(oauth_state)" smoke-code)"
check "已存在的第三方用户直接换到登录令牌" "$(echo "$EXISTING_CB" | grep -c '[?&]token=')" "1"
check "已存在的第三方用户不被要求邀请码" "$(echo "$EXISTING_CB" | grep -c 'pendingToken=')" "0"
invite_settings false
check "关掉开关后第三方登录不再签待注册凭据" "$(oauth_callback_code "$(oauth_state)" invite-code-flow | grep -c 'pendingToken=')" "0"

echo "团队与团队计费"
MEMBER_TOKEN=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"team-member","password":"member-pass"}' | jq -r .data.token)
OUTSIDER_TOKEN=$(curl -s -X POST "$BASE/auth/register" -H 'Content-Type: application/json' -d '{"username":"team-outsider","password":"outsider-pass"}' | jq -r .data.token)
OUTSIDER_CREDITS_BEFORE=$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $OUTSIDER_TOKEN" | jq -r .data.credits)
check "团队冒烟用的两个账号都拿到令牌" "$([ -n "$MEMBER_TOKEN" ] && [ "$MEMBER_TOKEN" != "null" ] && [ -n "$OUTSIDER_TOKEN" ] && [ "$OUTSIDER_TOKEN" != "null" ] && echo yes || echo no)" "yes"

TEAM=$(curl -s -X POST "$BASE/v1/teams" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"name":"冒烟团队","description":"smoke"}')
TEAM_ID=$(echo "$TEAM" | jq -r .data.id)
check "创建团队成功" "$(echo "$TEAM" | jq -r .data.name)" "冒烟团队"
check "创建者角色为 owner" "$(curl -s "$BASE/v1/teams" -H "Authorization: Bearer $USER_TOKEN" | jq -r --arg id "$TEAM_ID" '.data[] | select(.id==$id) | .myRole')" "owner"
check "新团队积分池为 0" "$(curl -s "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "0"

INVITE=$(curl -s -X POST "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"kind":"link","role":"member","maxUses":0}')
INVITE_TOKEN=$(echo "$INVITE" | jq -r .data.token)
check "邀请链接 token 长度 >= 32" "$([ "$(printf '%s' "$INVITE_TOKEN" | wc -c | tr -d ' ')" -ge 32 ] && echo yes || echo no)" "yes"
check "邀请列表不返回明文 token" "$(curl -s "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data[0].token // "absent"')" "absent"

CODE_INVITE=$(curl -s -X POST "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"kind":"code","role":"viewer","maxUses":1}')
JOIN_CODE=$(echo "$CODE_INVITE" | jq -r .data.code)
check "手输码长度为 10" "$(printf '%s' "$JOIN_CODE" | wc -c | tr -d ' ')" "10"

check "第二个用户用链接加入" "$(curl -s -X POST "$BASE/v1/team-invites/$INVITE_TOKEN/accept" -H "Authorization: Bearer $MEMBER_TOKEN" | jq -r .data.role)" "member"
check "成员列表有两个人" "$(curl -s "$BASE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $USER_TOKEN" | jq '.data | length')" "2"
check "member 无权看全员流水" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID/credit-logs" -H "Authorization: Bearer $MEMBER_TOKEN")" "403"
check "member 可以看自己的流水" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID/credit-logs/mine" -H "Authorization: Bearer $MEMBER_TOKEN")" "200"
check "member 无权改团队信息" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $MEMBER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"改名"}')" "403"
check "非成员看团队返回 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $OUTSIDER_TOKEN")" "404"
check "不存在的团队也返回 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/team-does-not-exist" -H "Authorization: Bearer $USER_TOKEN")" "404"
check "owner 不能退出团队" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/teams/$TEAM_ID/leave" -H "Authorization: Bearer $USER_TOKEN")" "400"
check "未登录访问团队接口返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams")" "401"

echo "平台团队后台"
check "管理员可列出全平台团队" "$(curl -s "$BASE/admin/teams" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r --arg id "$TEAM_ID" '.data.items[] | select(.id==$id) | .name')" "冒烟团队"
check "普通用户访问平台团队后台返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/teams" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "团队 owner 也访问不了平台后台" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN")" "401"

TOPUP=$(curl -s -X POST "$BASE/admin/teams/$TEAM_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' -d '{"credits":500,"remark":"冒烟充值"}')
check "管理员调整团队积分" "$(echo "$TOPUP" | jq -r .data.credits)" "500"
check "调整写入团队流水" "$(curl -s "$BASE/v1/teams/$TEAM_ID/credit-logs" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].type')" "admin_adjust"
check "团队流水不污染个人流水页" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.remark=="冒烟充值")] | length')" "0"
check "全平台团队流水查得到这一笔" "$(curl -s "$BASE/admin/team-credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.remark=="冒烟充值")] | length')" "1"

check "管理员可停用团队" "$(curl -s -X PATCH "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"status":"disabled"}' | jq -r .data.status)" "disabled"
check "停用后成员仍可只读" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN")" "200"
check "停用后禁止写入" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"改名"}')" "403"
curl -s -X PATCH "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"status":"active"}' >/dev/null

echo "团队实时同步"
STREAM_LOG="$WORK/team-stream.log"
curl -sN --max-time 3 "$BASE/v1/teams/$TEAM_ID/realtime" -H "Authorization: Bearer $USER_TOKEN" >"$STREAM_LOG" &
STREAM_PID=$!
sleep 1
curl -s -X POST "$BASE/admin/teams/$TEAM_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":600,"remark":"实时验证"}' >/dev/null
wait $STREAM_PID 2>/dev/null
check "SSE 推送团队余额变化" "$(grep -c 'team.credits' "$STREAM_LOG")" "1"
check "非成员无法订阅团队 SSE" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/v1/teams/$TEAM_ID/realtime" -H "Authorization: Bearer $OUTSIDER_TOKEN")" "404"

echo "存量个人账户兼容"
check "无团队用户生成仍按个人扣费" "$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $OUTSIDER_TOKEN" | jq -r .data.credits)" "$OUTSIDER_CREDITS_BEFORE"
check "无团队用户团队列表为空" "$(curl -s "$BASE/v1/teams" -H "Authorization: Bearer $OUTSIDER_TOKEN" | jq '.data | length')" "0"

echo "服务重启"
# 重启会把内存里的推理循环全丢掉。running 会话早就有兜底，awaiting 也必须一起收尾：
# 那条待确认请求属于上一次执行，留着只会变成一个点了也没人接的确认框。
agent_settings "$SEARCH_EMPTY" '""' "$AGENT_CHANNELS" '""' 2
curl -s -X POST "$BASE/admin/users/$USER_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":100}' >/dev/null
RESTART_SESSION=$(new_agent_session '{"projectId":"agent-rounds","title":"重启会话"}')
agent_message "$RESTART_SESSION" "restart-m1" "你就一直干活别停"
check "重启前会话停在等待确认" "$(agent_status "$RESTART_SESSION")" "awaiting"

kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
start_server
check "服务重启后恢复可用" "$(curl -s "$BASE/health" | jq -r .data)" "ok"
RESTARTED=$(agent_session "$RESTART_SESSION")
check "重启后 awaiting 会话不再挂着" "$(echo "$RESTARTED" | jq -r .data.status)" "failed"
check "重启后待确认请求已被清掉" "$(echo "$RESTARTED" | jq -r '.data.pendingAction // "none"')" "none"
check "重启后给出可读的中文原因" "$(echo "$RESTARTED" | jq -r .data.error)" "服务已重启，待确认的请求已失效，请重新发送消息"
check "重启后不能再答复这个请求" "$(agent_resolve "$RESTART_SESSION" true | jq -r .msg)" "当前没有待确认的请求"

echo
printf '通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
