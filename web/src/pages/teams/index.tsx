import { useQuery } from "@tanstack/react-query";
import { App, Button, Empty, Form, Input, Modal, Tag, Tooltip } from "antd";
import { Plus, RefreshCw, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { teamCreateBlockedReason } from "@/lib/team-limits";
import { teamApi, type Team } from "@/services/api/teams";
import { useServerStore } from "@/stores/use-server-store";
import { useTeamStore } from "@/stores/use-team-store";

const roleLabels: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };

export default function TeamsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [createForm] = Form.useForm<{ name: string; description?: string }>();
    const [creating, setCreating] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [code, setCode] = useState("");
    const [joining, setJoining] = useState(false);
    const setTeams = useTeamStore((state) => state.setTeams);
    const userId = useServerStore((state) => state.user?.id) || "";
    const maxTeamsPerUser = useServerStore((state) => state.settings?.teams.maxTeamsPerUser);
    const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ["teams"], queryFn: () => teamApi.teams() });

    // 列表进 store，顶部导航等地方不必各自再拉一次。
    useEffect(() => {
        if (data) setTeams(data);
    }, [data, setTeams]);

    const create = async () => {
        setSubmitting(true);
        try {
            // 校验失败会 reject，放在 try 外面就是一条没人接的 promise rejection：
            // 名称留空时按钮不动、控制台报错，用户只当页面卡住了。
            const values = await createForm.validateFields();
            const team = await teamApi.createTeam(values);
            setCreating(false);
            createForm.resetFields();
            message.success("团队已创建");
            await refetch();
            navigate(`/teams/${team.id}`);
        } catch (createError) {
            // 校验失败表单已经在字段下面标红了，再弹一句「创建失败」只会误导成服务端出错。
            if (createError && typeof createError === "object" && "errorFields" in createError) return;
            message.error(createError instanceof Error ? createError.message : "创建团队失败");
        } finally {
            setSubmitting(false);
        }
    };

    const join = async () => {
        const value = code.trim();
        if (!value) return message.warning("请先填写邀请码");
        setJoining(true);
        try {
            const member = await teamApi.joinByCode(value);
            setCode("");
            message.success("已加入团队");
            await refetch();
            navigate(`/teams/${member.teamId}`);
        } catch (joinError) {
            message.error(joinError instanceof Error ? joinError.message : "加入团队失败");
        } finally {
            setJoining(false);
        }
    };

    const teams = data || [];
    /*
     * 上限在点「创建团队」之前就要讲清楚。服务端当然也会拒，但那时用户已经填完了名称和简介，
     * 拿到的还是一句原始的接口错误——他既不知道自己撞的是哪条线，也不知道该怎么办。
     * settings 还没拉回来时 maxTeamsPerUser 是 undefined，此时一律放行：
     * 宁可让服务端拒一次，也不能因为配置慢一拍就把所有人的创建入口锁死。
     */
    const blockedReason = maxTeamsPerUser === undefined ? "" : teamCreateBlockedReason(teams, userId, maxTeamsPerUser);

    return (
        <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto w-full max-w-5xl px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">团队协作</p>
                        <h1 className="mt-3 text-2xl font-semibold">我的团队</h1>
                        <p className="mt-1 text-sm text-stone-500">团队积分由平台管理员充值，成员在团队内的生成消耗记在团队账上。</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()}>
                            刷新
                        </Button>
                        <Tooltip title={blockedReason || undefined}>
                            <Button type="primary" icon={<Plus className="size-4" />} disabled={Boolean(blockedReason)} onClick={() => setCreating(true)}>
                                创建团队
                            </Button>
                        </Tooltip>
                    </div>
                </header>
                {/* 禁用的按钮点不动也没法悬停出提示（触屏尤其如此），原因必须在页面上直接写一遍。 */}
                {blockedReason ? (
                    <p className="mt-3 text-xs text-amber-600 dark:text-amber-500" data-testid="team-create-blocked">
                        {blockedReason}
                    </p>
                ) : null}

                <section className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                    <div className="mr-2 text-sm">有邀请码？直接加入</div>
                    <Input className="w-56" value={code} placeholder="输入邀请码" aria-label="邀请码" onChange={(event) => setCode(event.target.value)} onPressEnter={() => void join()} />
                    <Button loading={joining} onClick={() => void join()}>
                        加入团队
                    </Button>
                </section>

                {isPending ? <div className="py-16 text-center text-sm text-stone-500">加载中…</div> : null}
                {error ? <div className="py-16 text-center text-sm text-red-500">{error instanceof Error ? error.message : "读取团队列表失败"}</div> : null}
                {!isPending && !error && !teams.length ? (
                    <div className="py-16">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="你还没有加入任何团队">
                            <Tooltip title={blockedReason || undefined}>
                                <Button type="primary" icon={<Plus className="size-4" />} disabled={Boolean(blockedReason)} onClick={() => setCreating(true)}>
                                    创建团队
                                </Button>
                            </Tooltip>
                        </Empty>
                    </div>
                ) : null}

                <div className="mt-6 grid gap-3 md:grid-cols-2">
                    {teams.map((team: Team) => (
                        <button key={team.id} type="button" className="rounded-xl border border-stone-200 p-4 text-left transition hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600" onClick={() => navigate(`/teams/${team.id}`)}>
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <Users className="size-4 shrink-0 text-stone-400" />
                                    <span className="truncate text-base font-medium">{team.name}</span>
                                </div>
                                <Tag className="m-0">{roleLabels[team.myRole] || team.myRole}</Tag>
                            </div>
                            <div className="mt-2 text-xs text-stone-500">{team.description || "暂无简介"}</div>
                            <div className="mt-3 text-sm tabular-nums">团队积分 {team.credits}</div>
                            {team.status !== "active" ? <div className="mt-2 text-xs text-amber-600">该团队已被平台停用，只能查看历史记录。</div> : null}
                        </button>
                    ))}
                </div>
            </div>

            <Modal open={creating} title="创建团队" okText="确定" cancelText="取消" confirmLoading={submitting} onOk={() => void create()} onCancel={() => setCreating(false)} destroyOnHidden>
                <Form form={createForm} layout="vertical" className="mt-4">
                    <Form.Item name="name" label="团队名称" rules={[{ required: true, message: "请填写团队名称" }]}>
                        <Input maxLength={64} placeholder="例如：设计部" />
                    </Form.Item>
                    <Form.Item name="description" label="团队简介">
                        <Input.TextArea rows={2} placeholder="可选" />
                    </Form.Item>
                </Form>
            </Modal>
        </main>
    );
}
