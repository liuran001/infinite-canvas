import { App } from "antd";
import { useEffect } from "react";
import { registerShareBillingPrompt } from "@/services/share-billing-consent";

export function useShareBillingConsentPrompt() {
    const { modal } = App.useApp();
    useEffect(() => registerShareBillingPrompt(() => new Promise((resolve) => {
        modal.confirm({ title: "确认使用个人算力点？", content: "本次及之后该分享的生成会扣除你当前账号的个人算力点。", okText: "同意并不再提示", cancelText: "取消本次操作", onOk: () => resolve(true), onCancel: () => resolve(false) });
    })), [modal]);
}
