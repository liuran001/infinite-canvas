import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Checkbox, Modal } from "antd";

const DISMISS_KEY = "canvas-mobile-hint-dismissed";

/** 画布没有针对移动端优化，窄屏进入画布时提示一次，勾选后本地记住不再提醒。 */
export function CanvasMobileHintDialog() {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [dismiss, setDismiss] = useState(false);

    useEffect(() => {
        // 768 对应 Tailwind md 断点，与顶部导航的移动端判断保持一致。
        if (window.innerWidth < 768 && localStorage.getItem(DISMISS_KEY) !== "1") setOpen(true);
    }, []);

    const close = () => {
        if (dismiss) localStorage.setItem(DISMISS_KEY, "1");
        setOpen(false);
    };

    return (
        <Modal
            title="画布未针对移动端优化"
            open={open}
            centered
            onCancel={close}
            footer={
                <>
                    <Button onClick={close}>继续</Button>
                    <Button
                        type="primary"
                        onClick={() => {
                            close();
                            navigate("/image");
                        }}
                    >
                        去生图工作台
                    </Button>
                </>
            }
        >
            <p className="text-sm opacity-60">画布的拖拽、缩放和节点编辑在小屏幕上不太好用，建议改用生图工作台生成图片。</p>
            <Checkbox className="mt-4" checked={dismiss} onChange={(event) => setDismiss(event.target.checked)}>
                下次不再提醒
            </Checkbox>
        </Modal>
    );
}
