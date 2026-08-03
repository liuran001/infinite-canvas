#!/usr/bin/env node
/**
 * 真实 WebSocket 收发探针，供 smoke-test.sh 使用。
 *
 * 单独一个脚本而不是在 bash 里用 curl：curl 完不成 WebSocket 握手之后的帧收发，
 * 只用 HTTP 断言就等于只验证了「101 有没有回」，而真正会坏的是订阅、ready 与 presence 这一段。
 *
 * 用法：node ws-probe.mjs <wsUrl> <projectId> <clientId> [timeoutMs]
 * 输出：一行一个 JSON 帧，收到 ready 并发完 presence 后退出。
 */
import { WebSocket } from "ws";

const [url, projectId, clientId, timeoutMs = "5000"] = process.argv.slice(2);
if (!url || !projectId || !clientId) {
    console.error("用法：node ws-probe.mjs <wsUrl> <projectId> <clientId> [timeoutMs]");
    process.exit(2);
}

const socket = new WebSocket(url);
// 兜底超时：探针挂住会让整个 smoke test 停在这里，而卡住比失败更难查。
const timer = setTimeout(() => {
    socket.terminate();
    process.exit(1);
}, Number(timeoutMs));

let done = false;
socket.on("open", () => socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "probe", channel: `project:${projectId}`, payload: { clientId, sinceRevision: 0 } })));
socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    console.log(JSON.stringify(frame));
    // presence 写入会通过同一条频道广播回来，收到它就说明上行真的落到了服务端状态里，
    // 而不是只被 socket 收下了。等这一帧再退出，断言才有对象可看。
    if (frame.type === "event" && frame.payload?.type === "presence.sync") {
        clearTimeout(timer);
        socket.close();
        process.exit(0);
    }
    if (frame.type !== "ready" || done) return;
    done = true;
    socket.send(JSON.stringify({ v: 1, type: "presence.update", id: "probe", payload: { clientId, nodeIds: ["probe-node"], activity: "editing" } }));
});
socket.on("error", (error) => {
    console.error(String(error));
    process.exit(1);
});
