import { useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { teamApi } from "@/services/api/teams";
import { useServerStore } from "@/stores/use-server-store";

const roleLabels: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };

/**
 * 邀请落地页。预览接口本身要求登录（团队数据一律不对匿名开放），
 * 未登录时 serverRequest 会清掉会话并弹出登录框，这里只负责把「登录后再来一次」讲清楚。
 */
export default function TeamJoinPage() {
    const { token = "" } = useParams();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [joining, setJoining] = useState(false);
    const loggedIn = useServerStore((state) => Boolean(state.token));
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const { data, isPending, error } = useQuery({ queryKey: ["team-invite", token], queryFn: () => teamApi.previewInvite(token), enabled: Boolean(token) && loggedIn, retry: false });

    const accept = async () => {
        setJoining(true);
        try {
            const member = await teamApi.acceptInvite(token);
            message.success("已加入团队");
            navigate(`/teams/${member.teamId}`);
        } catch (acceptError) {
            message.error(acceptError instanceof Error ? acceptError.message : "加入团队失败");
        } finally {
            setJoining(false);
        }
    };

    return (
        <main className="flex h-dvh items-center justify-center bg-background px-6 text-stone-950 dark:text-stone-100">
            <div className="w-full max-w-md rounded-2xl border border-stone-200 p-8 text-center dark:border-stone-800">
                {!loggedIn ? (
                    <>
                        <h1 className="text-lg font-semibold">先登录再加入团队</h1>
                        <p className="mt-2 text-sm text-stone-500">团队数据不对未登录访客开放，登录后这条邀请仍然有效。</p>
                        <Button className="mt-5" type="primary" onClick={() => setLoginOpen(true)}>
                            去登录
                        </Button>
                    </>
                ) : isPending ? (
                    <div className="text-sm text-stone-500">正在校验邀请…</div>
                ) : error || !data ? (
                    <>
                        <h1 className="text-lg font-semibold">邀请链接无效或已失效</h1>
                        <p className="mt-2 text-sm text-stone-500">这条链接可能已被停用、用完或过期，请向团队管理员要一条新的。</p>
                        <Button className="mt-5" onClick={() => navigate("/teams")}>
                            去我的团队
                        </Button>
                    </>
                ) : (
                    <>
                        <p className="text-xs text-stone-500">你被邀请加入</p>
                        <h1 className="mt-2 text-xl font-semibold">{data.teamName}</h1>
                        <p className="mt-2 text-sm text-stone-500">
                            当前 {data.memberCount} 名成员 · 加入后的角色：{roleLabels[data.role] || data.role}
                        </p>
                        <Button className="mt-5" type="primary" loading={joining} onClick={() => void accept()}>
                            加入团队
                        </Button>
                    </>
                )}
            </div>
        </main>
    );
}
