import { OauthCallbackHandler } from "@/components/layout/login-modal";

/**
 * 第三方登录的回调落地页。后端固定回跳到这里，处理完令牌就回原页面，
 * 真正的登录界面是全站共用的登录弹窗。
 */
export default function LoginPage() {
    return <OauthCallbackHandler />;
}
