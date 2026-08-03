/**
 * SSE 分帧。刻意不依赖任何模块：分帧是纯字符串处理，独立出来就能被 node 直接跑测试，
 * 不必为了验证「反代把 \n 改写成 \r\n 之后还切不切得出帧」去起一个浏览器。
 *
 * services/api/server.ts 里另有一份服务着画布、Agent、生成任务三条既有流的实现，
 * 本次不动它——那三条流的回归风险与团队余额无关，不该被顺手卷进来。
 */

/**
 * 从缓冲区里切出所有完整帧的 data 内容，并返回还没收完的余量。
 *
 * 换行按 SSE 规范同时接受 \n、\r\n、\r。只认 \n\n 的话，遇到会改写换行的反代
 * （nginx 与不少企业网关都会）整条流一帧都切不出来，界面表现为「连上了但余额永远不动」，
 * 比直接断开还难查。
 *
 * 注释帧（保活的 ": keep-alive"）没有 data 行，自然不会产出内容。
 */
export function decodeSseFrames(buffer: string): { data: string[]; rest: string } {
    // 末尾单独一个 \r 可能是 \r\n 被切在两个分片中间，留到下一片再判定；
    // 立刻归一化的话这一帧会被当成 \r 结尾提前切开，后半截再也拼不回去。
    const pending = buffer.endsWith("\r") ? "\r" : "";
    let rest = (pending ? buffer.slice(0, -1) : buffer).replace(/\r\n|\r/g, "\n");
    const data: string[] = [];
    for (let index = rest.indexOf("\n\n"); index >= 0; index = rest.indexOf("\n\n")) {
        const frame = rest
            .slice(0, index)
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
        rest = rest.slice(index + 2);
        if (frame) data.push(frame);
    }
    return { data, rest: rest + pending };
}

/**
 * 解析一帧 data。坏帧返回 null 而不是抛错：抛出去会被读流的外层当成「连接断了」，
 * 白白触发一次重连与退避，而实际上后面的帧都是好的。
 */
export function parseSseJson<T>(data: string): T | null {
    try {
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}
