/**
 * SSE 的「先缓冲、ready 之后再按序放行」写法。
 *
 * 长连接必须先订阅再去读库：反过来的话，鉴权与读快照这段 await 窗口里发生的事件谁也收不到。
 * 但先订阅就意味着事件可能早于 ready 到达，而 ready 里带的是读库那一刻的快照——
 * 直接写出去的顺序会变成「新事件、旧快照」，客户端最后落在旧值上，且没有任何理由怀疑它。
 * 所以订阅后先入队，ready 写完再按到达顺序 flush，此后转为直写。
 *
 * 单独成一个函数是为了能被脚本确定性地验证：写在路由闭包里的话，这段顺序逻辑只能靠起真服务、
 * 掐时序去撞，而撞不出来不等于没有。
 */
export function createBufferedWriter(sink: (event: unknown) => void) {
    const buffered: unknown[] = [];
    let open = false;
    return {
        /** 总线事件入口：flush 之前一律入队。 */
        push(event: unknown) {
            if (open) return sink(event);
            buffered.push(event);
        },
        /** 写 ready 这类必须排在最前的事件，然后放行队列。重复调用是空操作。 */
        flush(ready: unknown) {
            if (open) return;
            sink(ready);
            open = true;
            for (const event of buffered.splice(0)) sink(event);
        },
        get pending() {
            return buffered.length;
        },
    };
}

/**
 * 往一条 SSE 连接上写事件，连接已经结束就静默丢弃。
 *
 * 守卫不是可选的加固：被挂起或移除的成员由 closeTeamConnectionsOf 直接 `res.end()`，
 * 而这可能正好发生在 flush 补发缓冲事件的中途、或 keepalive 定时器即将触发的那一刻。
 * 结束后再写会抛 ERR_STREAM_WRITE_AFTER_END——补发那条抛在 flush 的循环里会截断剩余事件，
 * 定时器那条则没有任何调用栈接得住，会直接掀翻整个进程。
 * 收到 end 之后本来就没有对端可言，丢弃是唯一正确的处置。
 */
export function sseWriter(res: { writableEnded: boolean; write: (chunk: string) => unknown }) {
    return (event: unknown) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
}
