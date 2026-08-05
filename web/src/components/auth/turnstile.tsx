import { useEffect, useRef } from "react";

type TurnstileApi = {
    render: (container: HTMLElement, options: Record<string, unknown>) => string;
    remove: (widgetId: string) => void;
};

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-cloudflare-turnstile="true"]');
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("验证码脚本加载失败")), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.cloudflareTurnstile = "true";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("验证码脚本加载失败"));
        document.head.appendChild(script);
    }).catch((error) => {
        scriptPromise = null;
        throw error;
    });
    return scriptPromise;
}

export function Turnstile({ siteKey, action, onToken, onError }: { siteKey: string; action: "login" | "register" | "oauth_complete"; onToken: (token: string) => void; onError?: (message: string) => void }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const tokenRef = useRef(onToken);
    const errorRef = useRef(onError);
    tokenRef.current = onToken;
    errorRef.current = onError;

    useEffect(() => {
        let disposed = false;
        let widgetId = "";
        tokenRef.current("");
        void loadTurnstile()
            .then(() => {
                if (disposed || !containerRef.current || !window.turnstile) return;
                widgetId = window.turnstile.render(containerRef.current, {
                    sitekey: siteKey,
                    action,
                    theme: "auto",
                    language: "zh-cn",
                    "response-field": false,
                    callback: (token: string) => tokenRef.current(token),
                    "expired-callback": () => tokenRef.current(""),
                    "timeout-callback": () => tokenRef.current(""),
                    "error-callback": () => {
                        tokenRef.current("");
                        errorRef.current?.("验证码加载失败，请刷新后重试");
                    },
                });
            })
            .catch((error) => errorRef.current?.(error instanceof Error ? error.message : "验证码脚本加载失败"));
        return () => {
            disposed = true;
            if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
        };
    }, [action, siteKey]);

    return <div ref={containerRef} className="flex min-h-[65px] justify-center overflow-hidden" />;
}
