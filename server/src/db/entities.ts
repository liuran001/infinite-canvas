import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { config } from "../config";

/** MySQL 的 text 只有 64KB，画布项目与提示词需要 longtext；其余方言统一 text。 */
const LONG_TEXT = (config.databaseDriver === "mysql" ? "longtext" : "text") as "text";
const id = { type: "varchar", length: 64 } as const;
const short = { type: "varchar", length: 255, default: "" } as const;

export type UserRole = "guest" | "user" | "admin";
export type UserStatus = "active" | "ban";
export type CreditLogType = "admin_adjust" | "ai_consume" | "ai_refund";
export type JobKind = "image" | "video" | "audio" | "text";
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type FileStorage = "local" | "s3";
export type AgentSessionStatus = "idle" | "running" | "failed";
export type AgentMessageRole = "user" | "assistant" | "tool";

/** 默认云空间配额 100MB，管理员可按用户单独调整。 */
export const DEFAULT_STORAGE_QUOTA = 100 << 20;

@Entity("users")
export class User {
    @PrimaryColumn(id) id!: string;
    @Index({ unique: true }) @Column({ type: "varchar", length: 255 }) username!: string;
    @Column({ type: "varchar", length: 255, default: "" }) password!: string;
    @Column(short) email!: string;
    @Column(short) displayName!: string;
    @Column({ type: "text", nullable: true }) avatarUrl!: string;
    @Column({ type: "varchar", length: 32, default: "user" }) role!: UserRole;
    @Column({ type: "int", default: 0 }) credits!: number;
    @Column({ type: "bigint", default: DEFAULT_STORAGE_QUOTA }) storageQuota!: number;
    @Column(short) affCode!: string;
    @Column({ type: "int", default: 0 }) affCount!: number;
    @Column(short) inviterId!: string;
    @Index() @Column(short) linuxDoId!: string;
    @Column({ type: "varchar", length: 32, default: "active" }) status!: UserStatus;
    @Column(short) lastLoginAt!: string;
    /** 用户偏好 JSON（默认模型、生成参数、系统提示词等），跟着账号走，换设备保留。 */
    @Column({ type: LONG_TEXT, nullable: true }) preferences!: string;
    @Column({ type: "text", nullable: true }) extra!: string;
    @Index() @Column(short) createdAt!: string;
    @Column(short) updatedAt!: string;
}

@Entity("credit_logs")
export class CreditLog {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "varchar", length: 32 }) type!: CreditLogType;
    @Column({ type: "int", default: 0 }) amount!: number;
    @Column({ type: "int", default: 0 }) balance!: number;
    @Column(short) relatedId!: string;
    @Column(short) remark!: string;
    @Column({ type: "text", nullable: true }) extra!: string;
    @Index() @Column(short) createdAt!: string;
}

@Entity("settings")
export class Setting {
    @PrimaryColumn({ type: "varchar", length: 32 }) key!: string;
    @Column({ type: LONG_TEXT, nullable: true }) value!: string;
    @Column(short) updatedAt!: string;
}

@Entity("prompts")
export class Prompt {
    @PrimaryColumn(id) id!: string;
    @Column(short) title!: string;
    @Column({ type: "text", nullable: true }) coverUrl!: string;
    @Column({ type: LONG_TEXT, nullable: true }) prompt!: string;
    @Column({ type: "text", nullable: true }) description!: string;
    @Column({ type: "simple-json", nullable: true }) referenceImageUrls!: string[];
    @Column({ type: "simple-json", nullable: true }) tags!: string[];
    @Index() @Column(short) category!: string;
    @Column({ type: "text", nullable: true }) preview!: string;
    @Column(short) author!: string;
    @Column({ type: "text", nullable: true }) sourceUrl!: string;
    /** registry 里的 imageMode / imageModel / imageSize / imageCount 等可选生成参数。 */
    @Column({ type: "simple-json", nullable: true }) options!: Record<string, unknown>;
    @Index() @Column(short) createdAt!: string;
    @Column(short) updatedAt!: string;
}

@Entity("prompt_categories")
export class PromptCategory {
    @PrimaryColumn({ type: "varchar", length: 128 }) category!: string;
    @Column(short) name!: string;
    @Column({ type: "text", nullable: true }) description!: string;
    @Column({ type: "text", nullable: true }) githubUrl!: string;
    /** 提示词 registry 的 JSON 地址，为空表示纯手工维护的分类。 */
    @Column({ type: "text", nullable: true }) sourceUrl!: string;
    @Column({ type: "boolean", default: false }) remote!: boolean;
    @Column({ type: "boolean", default: true }) enabled!: boolean;
    @Column(short) lastSyncedAt!: string;
    @Column({ type: "text", nullable: true }) lastError!: string;
    @Column(short) updatedAt!: string;
}

/** 管理后台维护的公共素材，所有用户可见。 */
@Entity("assets")
export class Asset {
    @PrimaryColumn(id) id!: string;
    @Column(short) title!: string;
    @Column({ type: "varchar", length: 32, default: "image" }) type!: string;
    @Column({ type: "text", nullable: true }) coverUrl!: string;
    @Column({ type: "simple-json", nullable: true }) tags!: string[];
    @Index() @Column(short) category!: string;
    @Column({ type: "text", nullable: true }) description!: string;
    @Column({ type: LONG_TEXT, nullable: true }) content!: string;
    @Column({ type: "text", nullable: true }) url!: string;
    @Index() @Column(short) createdAt!: string;
    @Column(short) updatedAt!: string;
}

/** 服务端文件对象，图片、视频、音频与参考素材统一走这里。 */
@Entity("files")
export class StoredFile {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "varchar", length: 32, default: "image" }) kind!: string;
    @Column({ type: "varchar", length: 128, default: "application/octet-stream" }) mimeType!: string;
    @Column({ type: "bigint", default: 0 }) bytes!: number;
    @Column({ type: "int", default: 0 }) width!: number;
    @Column({ type: "int", default: 0 }) height!: number;
    @Column({ type: "int", default: 0 }) durationMs!: number;
    @Column({ type: "varchar", length: 16, default: "local" }) storage!: FileStorage;
    @Column({ type: "varchar", length: 512, default: "" }) path!: string;
    @Index() @Column({ type: "varchar", length: 128, default: "" }) checksum!: string;
    @Index() @Column(short) createdAt!: string;
}

/**
 * 用户画布项目，revision 单调递增用于多设备增量同步。
 * 主键带上 userId：projectId 由客户端生成，不同用户之间不保证唯一。
 */
@Entity("projects")
export class Project {
    @PrimaryColumn(short) userId!: string;
    @PrimaryColumn(id) projectId!: string;
    @Column(short) title!: string;
    @Column({ type: LONG_TEXT, nullable: true }) data!: string;
    @Column({ type: "int", default: 1 }) revision!: number;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
}

/** 用户自己的素材库，与管理后台的公共素材分开。 */
@Entity("user_assets")
export class UserAsset {
    @PrimaryColumn(short) userId!: string;
    @PrimaryColumn(id) assetId!: string;
    @Column({ type: "varchar", length: 32, default: "image" }) kind!: string;
    @Column(short) title!: string;
    @Column({ type: LONG_TEXT, nullable: true }) data!: string;
    @Column({ type: "int", default: 1 }) revision!: number;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
}

/**
 * 用户安装的画布节点插件，换设备后可以带着走。
 * pluginId 由插件作者定义，不同用户装同一个插件必然重名，所以必须复合主键。
 */
@Entity("user_plugins")
export class UserPlugin {
    @PrimaryColumn(short) userId!: string;
    @PrimaryColumn({ type: "varchar", length: 191 }) pluginId!: string;
    @Column({ type: LONG_TEXT, nullable: true }) data!: string;
    @Column({ type: "int", default: 1 }) revision!: number;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
}

/** 用户注册的 Passkey 凭证。公钥按 base64 存，校验时还原成字节。 */
@Entity("passkeys")
export class Passkey {
    @PrimaryColumn(id) id!: string;
    @Index({ unique: true }) @Column({ type: "varchar", length: 255 }) credentialId!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "text", nullable: true }) publicKey!: string;
    @Column({ type: "int", default: 0 }) counter!: number;
    @Column({ type: "simple-json", nullable: true }) transports!: string[];
    /** 用户可编辑的名称，方便区分多个设备上的 Passkey。 */
    @Column(short) name!: string;
    @Column(short) createdAt!: string;
}

/**
 * 服务端生成任务。clientJobId 是前端下发的幂等键：
 * 同一用户重复提交同一个 clientJobId 只会命中已有任务，
 * 因此客户端断网重试不会造成重复生成或重复扣费。
 */
@Index(["userId", "clientJobId"], { unique: true })
@Entity("jobs")
export class Job {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) userId!: string;
    @Column(short) clientJobId!: string;
    @Column({ type: "varchar", length: 32, default: "image" }) kind!: JobKind;
    @Index() @Column({ type: "varchar", length: 32, default: "pending" }) status!: JobStatus;
    @Column(short) model!: string;
    @Column({ type: LONG_TEXT, nullable: true }) prompt!: string;
    @Column({ type: LONG_TEXT, nullable: true }) params!: string;
    @Column({ type: "simple-json", nullable: true }) inputFileIds!: string[];
    @Column({ type: "simple-json", nullable: true }) outputFileIds!: string[];
    /**
     * 文本任务的产出。上游是流式返回的，收的过程中就要按节奏落库：
     * 只在结束时写一次的话，中途断开或进程被杀就什么都留不下，用户既拿不到内容又已经扣了算力点。
     */
    @Column({ type: LONG_TEXT, nullable: true }) text!: string;
    /** 客户端自定义的任务归属信息（发起页面、画布与节点 ID），换设备后据此把任务定位回界面。 */
    @Column({ type: "simple-json", nullable: true }) context!: Record<string, unknown>;
    @Column({ type: "text", nullable: true }) error!: string;
    @Column({ type: "int", default: 0 }) credits!: number;
    @Column({ type: "int", default: 0 }) progress!: number;
    /**
     * 用户内单调递增的变更序号，每次任务状态变化都会重新分配一个。
     * 订阅方断线重连时带上最后收到的序号，服务端据此把断线期间变化过的任务补回来。
     * 用序号而不是 updatedAt：同一毫秒内落多次变更时，时间戳游标会漏掉其中几条。
     */
    @Index() @Column({ type: "int", default: 0 }) seq!: number;
    @Column({ type: "varchar", length: 512, default: "" }) upstreamTaskId!: string;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
    @Column(short) finishedAt!: string;
}

/**
 * 画布 Agent 会话，绑定到某个画布项目。sessionId 由客户端生成，
 * 不同用户之间不保证唯一，所以和画布一样用 (userId, sessionId) 复合主键。
 * lastSeq 是会话内已分配的最大消息序号，前端靠它做 sinceSeq 增量拉取。
 */
@Entity("agent_sessions")
export class AgentSession {
    @PrimaryColumn(short) userId!: string;
    @PrimaryColumn(id) sessionId!: string;
    @Index() @Column(id) projectId!: string;
    @Column(short) title!: string;
    @Column({ type: "varchar", length: 32, default: "idle" }) status!: AgentSessionStatus;
    @Column(short) model!: string;
    @Column({ type: "text", nullable: true }) error!: string;
    @Column({ type: "int", default: 0 }) lastSeq!: number;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
}

/**
 * 会话消息。seq 在会话内单调递增，断线重连时带 sinceSeq 拉增量即可续上，
 * 所以推理循环每走一步就要落一条，不能攒到最后一次性写。
 * clientMessageId 是发消息的幂等键，重复提交同一个键不会重复触发执行、不重复计费。
 */
@Entity("agent_messages")
export class AgentMessage {
    @PrimaryColumn(short) userId!: string;
    @PrimaryColumn(id) sessionId!: string;
    @PrimaryColumn({ type: "int" }) seq!: number;
    @Column({ type: "varchar", length: 32, default: "user" }) role!: AgentMessageRole;
    @Column({ type: LONG_TEXT, nullable: true }) content!: string;
    @Column(short) toolName!: string;
    @Column({ type: LONG_TEXT, nullable: true }) toolArgs!: string;
    @Column({ type: LONG_TEXT, nullable: true }) toolResult!: string;
    /**
     * 用户消息带的图片附件（服务端文件 ID）。图片走的是和素材同一套文件对象，占用户云空间配额。
     * 落库而不是只放进内存：重连、重启后重建上下文时要按各家格式把这些图重新还原给模型。
     */
    @Column({ type: "simple-json", nullable: true }) attachments!: string[];
    /**
     * 用户从画布拖进面板的节点引用。只存 ID、类型与标题，绝不把节点内容（尤其是图片）带进上下文：
     * 拖拽表达的是「我指的是这个」，不是「现在就看这张图」；真要看图、要改内容，模型自己去调 view_image / read_canvas。
     * storageKey 只给前端画缩略图用，不进模型上下文。
     */
    @Column({ type: "simple-json", nullable: true }) references!: Array<{ nodeId: string; type: string; title: string; storageKey?: string }>;
    @Index() @Column(short) clientMessageId!: string;
    @Column(short) createdAt!: string;
}

export const entities = [User, CreditLog, Setting, Prompt, PromptCategory, Asset, StoredFile, Project, UserAsset, UserPlugin, Passkey, Job, AgentSession, AgentMessage];
