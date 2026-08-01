import { useQuery } from "@tanstack/react-query";
import { Select } from "antd";
import { useEffect, useState } from "react";

import { adminApi } from "@/services/api/admin";

/** 管理后台按用户筛选的下拉框，输入关键词走服务端搜索，多个审查页面共用。 */
export function AdminUserSelect({ value, onChange, className, placeholder = "全部用户" }: { value?: string; onChange: (userId: string) => void; className?: string; placeholder?: string }) {
    const [input, setInput] = useState("");
    const [keyword, setKeyword] = useState("");
    const { data, isFetching } = useQuery({ queryKey: ["admin-user-options", keyword], queryFn: () => adminApi.users({ keyword, page: 1, pageSize: 50 }) });

    // 下拉搜索按键防抖，避免每敲一个字就打一次后台接口。
    useEffect(() => {
        const timer = setTimeout(() => setKeyword(input.trim()), 300);
        return () => clearTimeout(timer);
    }, [input]);

    return (
        <Select
            className={className}
            showSearch
            allowClear
            filterOption={false}
            loading={isFetching}
            placeholder={placeholder}
            value={value || undefined}
            searchValue={input}
            onSearch={setInput}
            onChange={(next) => onChange(next || "")}
            options={(data?.items || []).map((user) => ({ label: user.displayName ? `${user.username}（${user.displayName}）` : user.username, value: user.id }))}
        />
    );
}
