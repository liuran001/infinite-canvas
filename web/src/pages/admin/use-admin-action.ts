import { App } from "antd";

/** 管理后台各页面统一的「执行接口 + 成功/失败提示」动作，返回是否成功便于调用方决定要不要刷新。 */
export function useAdminAction() {
    const { message } = App.useApp();

    return async (action: () => Promise<unknown>, success: string) => {
        try {
            await action();
            message.success(success);
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
            return false;
        }
    };
}
