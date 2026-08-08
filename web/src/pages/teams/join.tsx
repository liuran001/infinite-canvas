import { useQuery } from "@tanstack/react-query";
import { App, Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { teamApi } from "@/services/api/teams";
import { useServerStore } from "@/stores/use-server-store";

/**
 * 邀请落地页。预览接口本身要求登录（团队数据一律不对匿名开放），
 * 未登录时 serverRequest 会清掉会话并弹出登录框，这里只负责把「登录后再来一次」讲清楚。
 */
export default function TeamJoinPage() {
    const { token = "" } = useParams();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [joining, setJoining] = useState(false);
    const loggedIn = useServerStore((state) => Boolean(state.token));
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const { data, isPending, error } = useQuery({ queryKey: ["team-invite", token], queryFn: () => teamApi.previewInvite(token), enabled: Boolean(token) && loggedIn, retry: false });

    const accept = async () => {
        setJoining(true);
        try {
            const member = await teamApi.acceptInvite(token);
            message.success(t("teams.join.joined"));
            navigate(`/teams/${member.teamId}`);
        } catch (acceptError) {
            message.error(acceptError instanceof Error ? acceptError.message : t("teams.join.joinFailed"));
        } finally {
            setJoining(false);
        }
    };

    return (
        <main className="flex h-dvh items-center justify-center bg-background px-6 text-stone-950 dark:text-stone-100">
            <div className="w-full max-w-md rounded-2xl border border-stone-200 p-8 text-center dark:border-stone-800">
                {!loggedIn ? (
                    <>
                        <h1 className="text-lg font-semibold">{t("teams.join.loginTitle")}</h1>
                        <p className="mt-2 text-sm text-stone-500">{t("teams.join.loginDescription")}</p>
                        <Button className="mt-5" type="primary" onClick={() => setLoginOpen(true)}>
                            {t("teams.join.login")}
                        </Button>
                    </>
                ) : isPending ? (
                    <div className="text-sm text-stone-500">{t("teams.join.validating")}</div>
                ) : error || !data ? (
                    <>
                        <h1 className="text-lg font-semibold">{t("teams.join.invalidTitle")}</h1>
                        <p className="mt-2 text-sm text-stone-500">{t("teams.join.invalidDescription")}</p>
                        <Button className="mt-5" onClick={() => navigate("/teams")}>
                            {t("teams.join.myTeams")}
                        </Button>
                    </>
                ) : (
                    <>
                        <p className="text-xs text-stone-500">{t("teams.join.invitedTo")}</p>
                        <h1 className="mt-2 text-xl font-semibold">{data.teamName}</h1>
                        <p className="mt-2 text-sm text-stone-500">{t("teams.join.summary", { count: data.memberCount, role: t(`teams.roles.${data.role}`, { defaultValue: data.role }) })}</p>
                        <Button className="mt-5" type="primary" loading={joining} onClick={() => void accept()}>
                            {t("teams.join.join")}
                        </Button>
                    </>
                )}
            </div>
        </main>
    );
}
