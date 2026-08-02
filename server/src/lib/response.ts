import type { NextFunction, Request, RequestHandler, Response } from "express";

import { SafeError } from "./errors";

export const MAX_PAGE_SIZE = 500;

export type Query = {
    keyword: string;
    tags: string[];
    category: string;
    type: string;
    page: number;
    pageSize: number;
    offset: number;
};

export function ok(res: Response, data: unknown) {
    res.json({ code: 0, data, msg: "ok" });
}

export function failResponse(res: Response, msg: string) {
    res.json({ code: 1, data: null, msg });
}

export function errorResponse(res: Response, error: unknown) {
    if (error instanceof SafeError) return res.status(error.status).json({ code: error.code, data: error.data, msg: error.message });
    console.error("request failed:", error);
    return res.status(500).json({ code: 1, data: null, msg: "操作失败" });
}

/** 包装异步处理器，把抛出的异常统一转成带 HTTP 状态与稳定错误码的响应。 */
export function handle(handler: (req: Request, res: Response) => unknown): RequestHandler {
    return (req, res, next) => {
        Promise.resolve(handler(req, res)).catch((error) => {
            if (res.headersSent) return next(error);
            errorResponse(res, error);
        });
    };
}

export function parseQuery(req: Request): Query {
    const query = req.query;
    const page = Math.max(1, Number.parseInt(String(query.page || ""), 10) || 1);
    const size = Number.parseInt(String(query.pageSize || ""), 10) || 20;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));
    const rawTags = query.tag;
    return {
        keyword: String(query.keyword || "").trim(),
        tags: (Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : []).map(String),
        category: String(query.category || "").trim(),
        type: String(query.type || "").trim(),
        page,
        pageSize,
        offset: (page - 1) * pageSize,
    };
}

export function notFoundJson(_req: Request, res: Response) {
    res.status(404).json({ code: 1, data: null, msg: "接口不存在" });
}

export function errorJson(error: unknown, _req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) return next(error);
    errorResponse(res, error);
}
