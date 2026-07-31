import { Form, Input, Modal, Select } from "antd";
import { useEffect } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminPrompt } from "@/services/api/admin";

export function PromptEditorModal({ prompt, categories, onClose, onSaved }: { prompt: Partial<AdminPrompt> | null; categories: string[]; onClose: () => void; onSaved: () => void }) {
    const runAction = useAdminAction();
    const [form] = Form.useForm<Partial<AdminPrompt>>();

    useEffect(() => {
        if (!prompt) return;
        form.resetFields();
        form.setFieldsValue({ tags: [], referenceImageUrls: [], ...prompt });
    }, [prompt, form]);

    const submit = async () => {
        const values = await form.validateFields();
        if (await runAction(() => adminApi.savePrompt({ ...prompt, ...values }), "已保存")) {
            onClose();
            onSaved();
        }
    };

    return (
        <Modal open={Boolean(prompt)} width={720} title={prompt?.id ? "编辑提示词" : "新建提示词"} okText="保存" cancelText="取消" onOk={submit} onCancel={onClose}>
            <Form form={form} layout="vertical" className="mt-4">
                <div className="grid grid-cols-2 gap-4">
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                        <Input placeholder="提示词标题" />
                    </Form.Item>
                    <Form.Item name="category" label="分类" rules={[{ required: true, message: "请选择分类" }]}>
                        <Select showSearch placeholder="选择分类" options={categories.map((item) => ({ label: item, value: item }))} />
                    </Form.Item>
                </div>
                <Form.Item name="prompt" label="提示词内容" rules={[{ required: true, message: "请输入提示词内容" }]}>
                    <Input.TextArea rows={8} placeholder="完整提示词" />
                </Form.Item>
                <Form.Item name="description" label="描述">
                    <Input.TextArea rows={2} placeholder="可选" />
                </Form.Item>
                <div className="grid grid-cols-2 gap-4">
                    <Form.Item name="coverUrl" label="封面地址">
                        <Input placeholder="https://..." />
                    </Form.Item>
                    <Form.Item name="tags" label="标签">
                        <Select mode="tags" placeholder="回车添加标签" />
                    </Form.Item>
                </div>
                <Form.Item name="referenceImageUrls" label="参考图地址">
                    <Select mode="tags" placeholder="回车添加图片地址" />
                </Form.Item>
                <div className="grid grid-cols-2 gap-4">
                    <Form.Item name="author" label="作者">
                        <Input placeholder="可选" />
                    </Form.Item>
                    <Form.Item name="sourceUrl" label="来源地址">
                        <Input placeholder="可选" />
                    </Form.Item>
                </div>
            </Form>
        </Modal>
    );
}
