import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { config } from "../config";

/** MySQL 的 text 只有 64KB，画布项目与提示词需要 longtext；其余方言统一 text。 */
const LONG_TEXT = (config.databaseDriver === "mysql" ? "longtext" : "text") as "text";
const id = { type: "varchar", length: 64 } as const;
const short = { type: "varchar", length: 255, default: "" } as const;

export type UserRole = "guest" | "user" | "admin";
export type UserStatus = "active" | "ban";
export type CreditLogType = "admin_adjust" | "ai_consume" | "ai_refund";
export type JobKind = "image" | "video" | "audio";
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type FileStorage = "local" | "s3";

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
    @Column(short) affCode!: string;
    @Column({ type: "int", default: 0 }) affCount!: number;
    @Column(short) inviterId!: string;
    @Index() @Column(short) linuxDoId!: string;
    @Column({ type: "varchar", length: 32, default: "active" }) status!: UserStatus;
    @Column(short) lastLoginAt!: string;
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

/** 用户画布项目，revision 单调递增用于多设备增量同步。 */
@Entity("projects")
export class Project {
    @PrimaryColumn(id) projectId!: string;
    @Index() @Column(short) userId!: string;
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
    @PrimaryColumn(id) assetId!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "varchar", length: 32, default: "image" }) kind!: string;
    @Column(short) title!: string;
    @Column({ type: LONG_TEXT, nullable: true }) data!: string;
    @Column({ type: "int", default: 1 }) revision!: number;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
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
    /** 客户端自定义的任务归属信息（发起页面、画布与节点 ID），换设备后据此把任务定位回界面。 */
    @Column({ type: "simple-json", nullable: true }) context!: Record<string, unknown>;
    @Column({ type: "text", nullable: true }) error!: string;
    @Column({ type: "int", default: 0 }) credits!: number;
    @Column({ type: "int", default: 0 }) progress!: number;
    @Column({ type: "varchar", length: 512, default: "" }) upstreamTaskId!: string;
    @Column(short) createdAt!: string;
    @Index() @Column(short) updatedAt!: string;
    @Column(short) finishedAt!: string;
}

export const entities = [User, CreditLog, Setting, Prompt, PromptCategory, Asset, StoredFile, Project, UserAsset, Job];
