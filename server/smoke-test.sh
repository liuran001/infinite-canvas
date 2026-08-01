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
PORT="$PORT" \
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
}).listen(Number(process.argv[2]), "127.0.0.1");
EOF
node "$WORK/upstream.js" "$UPSTREAM_PORT" &
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
curl -s -X PUT "$BASE/v1/projects/p2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"审查用画布","data":{"nodes":[{"id":"n1","type":"image","metadata":{"storageKey":"server:'"$OUT_ID"'"}},{"id":"n2","type":"text"}]}}' >/dev/null
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
check "画布列表带出软删除标记" "$(curl -s --get "$BASE/admin/projects" --data-urlencode 'keyword=我的画布' -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].deleted')" "true"
check "画布详情返回完整数据" "$(curl -s "$BASE/admin/projects/$USER_ID/p2" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.data.nodes | length')" "2"
check "画布详情带出图片节点引用" "$(curl -s "$BASE/admin/projects/$USER_ID/p2" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.data.nodes[0].metadata.storageKey')" "server:$OUT_ID"
check "按用户筛选文件生效" "$(curl -s "$BASE/admin/files?userId=$USER_ID&kind=image" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "2"
check "换个用户筛不出文件" "$(curl -s "$BASE/admin/files?userId=$ADMIN_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .data.total)" "0"
check "文件列表带出所属用户名" "$(curl -s "$BASE/admin/files?userId=$USER_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.data.items[0].username')" "tester"

echo "账号自助管理"
check "改密码要校验原密码" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"wrong","newPassword":"new-pass-123"}' | jq -r .msg)" "原密码不正确"
check "新密码长度不足被拒" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"tester-pass","newPassword":"123"}' | jq -r .msg)" "新密码至少 6 位"
check "改密码成功" "$(curl -s -X POST "$BASE/auth/password" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"oldPassword":"tester-pass","newPassword":"tester-pass-2"}' | jq -r .code)" "0"
check "旧密码已失效" "$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"tester","password":"tester-pass"}' | jq -r .msg)" "用户名或密码错误"
check "新密码可登录" "$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"tester","password":"tester-pass-2"}' | jq -r .code)" "0"
check "未绑定时解绑被拒" "$(curl -s -X POST "$BASE/auth/linux-do/unbind" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "当前账号未绑定 Linux.do"
check "未开启时拿不到绑定地址" "$(curl -s "$BASE/auth/linux-do/bind" -H "Authorization: Bearer $USER_TOKEN" | jq -r .msg)" "Linux.do 登录未开启"
check "伪造的授权 state 被拒绝" "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/linux-do/callback?code=x&state=forged" | grep -c 'error=')" "1"

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
curl -s -X PUT "$BASE/v1/projects/p2" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"配额画布\",\"data\":{\"nodes\":[{\"metadata\":{\"storageKey\":\"server:$PROJECT_FILE\"}},{\"metadata\":{\"storageKey\":\"server:$KEPT_FILE\"}}]}}" >/dev/null
curl -s -X DELETE "$BASE/v1/projects/p2" -H "Authorization: Bearer $USER_TOKEN" >/dev/null
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

echo
printf '通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
