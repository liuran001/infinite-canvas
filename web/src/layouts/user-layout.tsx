import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { LoginGuard } from "@/components/layout/login-guard";
import { LoginModal } from "@/components/layout/login-modal";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const canvasProject = /^\/canvas\/[^/]+/.test(pathname);
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {canvasProject ? <AgentPanel /> : null}
            <LoginGuard />
            <LoginModal />
        </div>
    );
}
