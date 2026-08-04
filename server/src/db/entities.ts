import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { config } from "../config";

/** MySQL 的 text 只有 64KB，画布项目与提示词需要 longtext；其余方言统一 text。 */
const LONG_TEXT = (config.databaseDriver === "mysql" ? "longtext" : "text") as "text";
const id = { type: "varchar", length: 64 } as const;
const short = { type: "varchar", length: 255, default: "" } as const;

export type UserRole = "guest" | "user" | "admin";
export type UserStatus = "active" | "ban";
export type CreditLogType = "admin_adjust" | "ai_consume" | "ai_refund" | "invite_gift";
export type JobKind = "image" | "video" | "audio" | "text";
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type FileStorage = "local" | "s3";
export type AgentSessionStatus = "idle" | "running" | "awaiting" | "failed";
export type AgentMessageRole = "user" | "assistant" | "tool";
export type ShareRole = "viewer" | "editor";
export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type TeamStatus = "active" | "disabled" | "disbanded";
export type TeamMemberStatus = "active" | "suspended";
export type TeamLimitWindow = "day" | "month" | "total";
export type TeamInviteKind = "link" | "code";
export type TeamCreditLogType = "topup" | "admin_adjust" | "ai_consume" | "ai_refund" | "insufficient";
/** 谁为这次调用买单。存量记录读出来就是 user，因此加列不改变任何既有行为。 */
export type PayerKind = "user" | "team";
export type ShareAccessEvent = "open" | "edit" | "clone";

/**
 * 执行到一半、需要用户点头才能继续的请求。
 * 刻意做成一套通用结构而不是给每种情况各加一个字段：续跑和改标题的交互完全一样，
 * 都是「服务端暂停 → 前端弹确认 → 批准或拒绝」，前端只认 type 就能复用同一套界面与同一个接口。
 */
export type AgentPendingAction = { type: "continue"; roundsUsed: number; credits: number } | { type: "rename_canvas"; title: string; reason: string };

/** 默认云空间配额 100MB，管理员可按用户单独调整。 */
export const DEFAULT_STORAGE_QUOTA = 100 << 20;
/** 团队云空间的默认配额。与个人同一起点，但两者是各自独立的账，改其中一个不影响另一个。 */
export const DEFAULT_TEAM_STORAGE_QUOTA = 100 << 20;
/** 一个用户默认最多能创建几个团队。限制的是「创建」，加入别人的团队不受它约束。 */
export const DEFAULT_TEAM_LIMIT_PER_USER = 5;

@Entity("users")
export class User {
    @PrimaryColumn(id) id!: string;
    @Index({ unique: true }) @Column({ type: "varchar", length: 255 }) username!: string;
    @Column({ type: "varchar", length: 255, default: "" }) password!: string;
    @Column(short) email!: string;
    @Column(short) displayName!: string;
    /**
     * 昵称是否被用户自己改过。没有这一列的话，Linux.do 每次登录都会用第三方昵称覆盖本地昵称
     * （见 loginWithLinuxDo），用户改完昵称、下次登录就被打回去，而且没有任何提示。
     * 存量行默认 false，行为与改动前完全一致：没自定义过的账号仍然跟随第三方同步。
     */
    @Column({ type: "boolean", default: false }) displayNameCustomized!: boolean;
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
    /**
     * 这条退款针对的原始扣费流水 ID，只有退款行才有值，其余一律为 null。
     * 唯一索引就是防重复退款的最后一道闸：进程崩在「退款已提交、任务行还没清干净」之间，
     * 重启后再退一次会直接撞这条约束而整笔事务回滚，钱不会被退第二遍。
     * 三种驱动都允许多行 NULL，所以非退款流水不受影响。
     * 约束显式命名：撞上时要能认出「撞的就是这条」，而不是把主键冲突也当成「已经退过了」。
     */
    @Index("uq_credit_logs_refund_of", { unique: true }) @Column({ type: "varchar", length: 64, nullable: true }) refundOf!: string | null;
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

/**
 * 注册邀请码。码值本身就是主键：它是随机生成、不可枚举的，再多一个自增 ID 只会让每次校验都多一次查询。
 * 码值统一按大写存，校验时也先转大写，用户手输不用纠结大小写。
 * usedCount 靠「usedCount < maxUses」的原子条件更新推进，两个人抢最后一个名额时不会一起成功。
 */
@Entity("invite_codes")
export class InviteCode {
    @PrimaryColumn({ type: "varchar", length: 64 }) code!: string;
    @Column({ type: "int", default: 1 }) maxUses!: number;
    @Column({ type: "int", default: 0 }) usedCount!: number;
    /** 用这个码注册时赠送的算力点，0 表示不送。赠送时照常走算力点流水，不直接改余额。 */
    @Column({ type: "int", default: 0 }) credits!: number;
    @Column({ type: "boolean", default: true }) enabled!: boolean;
    @Column(short) note!: string;
    @Index() @Column(short) createdAt!: string;
}

/** 邀请码使用记录，注册成功一次落一条，后台据此查「这个码被谁、在什么时候用了」。 */
@Entity("invite_uses")
export class InviteUse {
    @PrimaryColumn(id) id!: string;
    @Index() @Column({ type: "varchar", length: 64 }) code!: string;
    @Index() @Column(short) userId!: string;
    /** 当时实际赠送的算力点。码上的 credits 后来可能被改，留档才知道这个人到底拿了多少。 */
    @Column({ type: "int", default: 0 }) credits!: number;
    @Index() @Column(short) createdAt!: string;
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

export type BlobState = "active" | "pending_delete";

/** 全局物理对象。用户归属和配额仍由 StoredFile 表表达。 */
@Entity("file_blobs")
export class PhysicalBlob {
    @PrimaryColumn({ type: "varchar", length: 64 }) checksum!: string;
    @Column({ type: "bigint", default: 0 }) bytes!: number;
    @Column({ type: "varchar", length: 32, default: "other" }) kind!: string;
    @Column({ type: "varchar", length: 128, default: "application/octet-stream" }) mimeType!: string;
    @Column({ type: "int", default: 0 }) width!: number;
    @Column({ type: "int", default: 0 }) height!: number;
    @Column({ type: "int", default: 0 }) durationMs!: number;
    @Column({ type: "varchar", length: 16, default: "local" }) storage!: FileStorage;
    @Column({ type: "varchar", length: 512, default: "" }) path!: string;
    @Column({ type: "int", default: 0 }) refCount!: number;
    @Index() @Column({ type: "varchar", length: 16, default: "active" }) state!: BlobState;
    @Column(short) pendingSince!: string;
    @Index() @Column(short) createdAt!: string;
}

/** 服务端文件对象，图片、视频、音频与参考素材统一走这里。 */
@Entity("files")
export class StoredFile {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) userId!: string;
    /**
     * 云空间的计费归属，空串表示记在 userId 的个人配额上。存量行读出来就是空串，所以加这一列不改变任何既有行为。
     * 只由上传时画布的 Project.teamId 决定，与上传者是谁无关：团队画布里传的图记团队的账，
     * 否则一个成员往团队画布里传素材，吃掉的是画布所有者的个人空间。
     * userId 仍然保留：它决定的是「谁能查到、删掉这一行」，与计费归属是两件事。
     */
    @Index() @Column(short) teamId!: string;
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
    /**
     * 画布的持久团队归属，空串表示个人画布。存量行读出来就是空串，所以加这一列不改变任何既有行为。
     * 只能通过受控的归属接口修改：普通保存/同步一律不读也不写它，否则一次夹带 teamId 的保存就能把账挪到别人的池子上。
     */
    @Index() @Column(short) teamId!: string;
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
@Index(["userId", "shareId", "clientJobId"], { unique: true })
@Entity("jobs")
export class Job {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) userId!: string;
    @Column(short) storageUserId!: string;
    @Column(short) payerUserId!: string;
    @Column(short) shareId!: string;
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
     * 账号任务按用户、分享任务按分享链接单调递增的变更序号，每次状态变化都会重新分配一个。
     * 订阅方断线重连时带上最后收到的序号，服务端据此把断线期间变化过的任务补回来。
     * 用序号而不是 updatedAt：同一毫秒内落多次变更时，时间戳游标会漏掉其中几条。
     */
    @Index() @Column({ type: "int", default: 0 }) seq!: number;
    @Column({ type: "varchar", length: 512, default: "" }) upstreamTaskId!: string;
    /**
     * 创建时固化的付费方。任务可能跑几分钟，期间用户可能被移出团队，
     * 退款必须回到当初扣钱的那个池子，所以不能在退款时重新解析。
     */
    @Column({ type: "varchar", length: 16, default: "user" }) payerKind!: PayerKind;
    @Column(short) payerTeamId!: string;
    /**
     * 这次扣费落下的流水 ID。任务可能跨进程重启后才走到退款，那时回执早已不在内存里，
     * 只有把它落在任务行上，退款流水才能通过 relatedId 指回原始那笔扣费，对账时「扣」与「退」能一一对上。
     */
    @Column(short) payerLogId!: string;
    /**
     * 产出文件记谁的云空间，空串表示记发起人个人名下。与 payerTeamId 刻意分成两列：
     * 付费方在团队池不足时可能回落到个人，而文件归属只跟画布走——合成一列的话，一次回落就会让
     * 团队画布里生成的图挂到某个成员名下，他一退出团队那张图就该被清掉，可团队的空间从没为它付过账。
     */
    @Column(short) storageTeamId!: string;
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
    /**
     * 待用户确认的请求，空表示没有。必须落库而不是只放内存：
     * 手机上点了同意、电脑上还显示等待，就是因为这份状态只活在某一个连接里。
     */
    @Column({ type: "simple-json", nullable: true }) pendingAction!: AgentPendingAction | null;
    /** 本次执行已经用掉的轮数。落库才能在「等待用户确认」这段时间里保住轮数预算，批准续跑时再清零重来。 */
    @Column({ type: "int", default: 0 }) rounds!: number;
    /**
     * 画布还是默认标题时，允许模型主动改一次标题不用确认；用掉之后记在这里。
     * 只靠提示词说「只能改一次」是拦不住的：模型每一轮都可能重新起念再改一次，必须落到数据上。
     */
    @Column({ type: "boolean", default: false }) autoRenamed!: boolean;
    @Column({ type: "boolean", default: false }) deleted!: boolean;
    /** 同 Job：会话创建时固化付费方，同一会话所有轮次沿用它。 */
    @Column({ type: "varchar", length: 16, default: "user" }) payerKind!: PayerKind;
    @Column(short) payerTeamId!: string;
    /**
     * 当前这段执行「已经扣掉、还没结清」的那一笔回执。执行成功或退款之后必须清零，
     * 否则进程崩在中间时重启就找不回它，用户白花一次钱；而落库之前崩掉同样白花，
     * 所以扣费一成功就立刻写这两列，退款一律以它们为准并靠 refundOf 幂等。
     */
    @Column(short) payerLogId!: string;
    @Column({ type: "int", default: 0 }) payerCredits!: number;
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

/**
 * 画布分享链接。一条链接就是一份能力凭证，没有成员表也没有邀请流程。
 * 只存 token 的哈希：明文一旦落库，拿到数据库备份或日志的人就等于拿到了所有画布的访问权。
 * 哈希用 SHA-256 而不是慢哈希——token 是 192 bit 随机值，没有字典攻击面，而查询必须能走等值索引。
 */
@Entity("project_shares")
export class ProjectShare {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(id) projectId!: string;
    /** 创建分享时的项目所有者，冗余存储，配额归属与审计都以它为准。 */
    @Index() @Column(short) ownerId!: string;
    @Index({ unique: true }) @Column({ type: "varchar", length: 128 }) tokenHash!: string;
    /**
     * 明文 token，空串表示这条记录建于「只存哈希」的年代、再也取不回完整链接。
     *
     * 存明文是一个被明确权衡过的决定：分享链接需要随时可复制，而哈希不可逆，
     * 只显示一次的链接用户一旦没存下来就只能重建一条、把已经发出去的旧链接作废。
     * 代价是数据库被拖库或备份泄露时，所有分享链接（含可编辑链接）可以直接使用——
     * 这一点已经知情并接受。因此这一列绝不能出现在任何非所有者可达的响应里。
     *
     * 校验路径一个字都不走这一列：定位仍靠 tokenHash 上的唯一索引做等值查询。
     * 改成按明文查的话要再建一条索引，而且等于把「能不能登录进来」这件事挂到了一列
     * 随时可能为空的历史数据上。这一列只负责回显。
     */
    @Column(short) token!: string;
    /** 明文前若干字符，只够管理界面区分「这是哪一条链接」，不足以还原 token。 */
    @Column({ type: "varchar", length: 16, default: "" }) tokenPrefix!: string;
    @Column({ type: "varchar", length: 16, default: "viewer" }) role!: ShareRole;
    @Column({ type: "boolean", default: true }) allowAnonymous!: boolean;
    @Column({ type: "boolean", default: false }) ownerPays!: boolean;
    @Column({ type: "boolean", default: false }) allowAnonymousEdit!: boolean;
    @Column({ type: "boolean", default: true }) allowClone!: boolean;
    /** 撤销开关。撤销是软删除语义：访问日志还要能查回「这条链接当初被谁看过」。 */
    @Column({ type: "boolean", default: true }) enabled!: boolean;
    /** 过期时间，空串表示不过期。 */
    @Column(short) expiresAt!: string;
    @Column(short) createdAt!: string;
    @Column(short) updatedAt!: string;
}

/** 分享维度的访问事件。写入必须节流，否则一次访客打开画布就会被 SSE 与 Presence 刷出几十条。 */
@Entity("project_access_logs")
export class ProjectAccessLog {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(id) shareId!: string;
    @Index() @Column(id) projectId!: string;
    /** 账号 id，或匿名访客的稳定 id。 */
    @Column(short) actorId!: string;
    @Column({ type: "boolean", default: false }) isAnonymous!: boolean;
    @Column({ type: "varchar", length: 16, default: "open" }) event!: ShareAccessEvent;
    /** IP 只存哈希：所有者需要的是「是不是同一个人」，不是对方的真实地址。 */
    @Column({ type: "varchar", length: 64, default: "" }) ipHash!: string;
    @Column(short) userAgent!: string;
    @Index() @Column(short) createdAt!: string;
}

/**
 * 团队。积分池与 User.credits 是两个完全独立的余额，各自有独立流水，
 * 谁付钱由服务端在调用发起时解析一次并固化，之后不再重算。
 */
@Entity("teams")
export class Team {
    @PrimaryColumn(id) id!: string;
    @Column(short) name!: string;
    @Column({ type: "text", nullable: true }) description!: string;
    @Column({ type: "text", nullable: true }) avatarUrl!: string;
    /** 冗余当前 owner，列出「我拥有的团队」时不必再连 team_members。 */
    @Index() @Column(short) ownerId!: string;
    @Column({ type: "int", default: 0 }) credits!: number;
    /**
     * 团队云空间上限（字节）。建团队时取当时的系统默认值并落库，之后只由平台管理员单独调整——
     * 与 User.storageQuota 之于 storage.defaultQuota 是同一个语义：改默认值只影响新建的团队，
     * 已有团队的额度是管理员看得见、算得清的一个数，不会因为改了一处设置就集体变动。
     */
    @Column({ type: "bigint", default: DEFAULT_TEAM_STORAGE_QUOTA }) storageQuota!: number;
    /** 成员数上限，0 表示不限。 */
    @Column({ type: "int", default: 0 }) memberLimit!: number;
    @Column({ type: "varchar", length: 32, default: "active" }) status!: TeamStatus;
    @Column(short) createdAt!: string;
    @Column(short) updatedAt!: string;
}

/**
 * 团队成员。复合主键 (teamId, userId) 与 Project 同一风格：
 * 一个人在一个团队里只可能有一条记录，复合主键比额外加唯一索引更直接地表达这件事。
 * 已用额度不落冗余计数列，按 TeamCreditLog 实时聚合——冗余列漏改一条路径就会永久漂移。
 */
@Entity("team_members")
export class TeamMember {
    @PrimaryColumn(short) teamId!: string;
    @PrimaryColumn(short) userId!: string;
    @Column({ type: "varchar", length: 32, default: "member" }) role!: TeamRole;
    /** 成员周期额度上限，0 表示不限。 */
    @Column({ type: "int", default: 0 }) creditLimit!: number;
    @Column({ type: "varchar", length: 32, default: "month" }) limitWindow!: TeamLimitWindow;
    @Column({ type: "varchar", length: 32, default: "active" }) status!: TeamMemberStatus;
    @Column(short) invitedBy!: string;
    @Column(short) joinedAt!: string;
    @Column(short) updatedAt!: string;
}

/**
 * 邀请链接与手输码共用一张表，靠 kind 区分：两者的生命周期字段完全相同，
 * 拆两张表只会让「这个人是怎么进来的」变成两次查询。
 * 链接只存哈希（高熵、无需回显），手输码存明文（管理员必须能反复看到它才能分发）。
 */
@Entity("team_invites")
export class TeamInvite {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) teamId!: string;
    @Column({ type: "varchar", length: 16, default: "link" }) kind!: TeamInviteKind;
    @Index() @Column({ type: "varchar", length: 128, default: "" }) tokenHash!: string;
    @Column({ type: "varchar", length: 32, default: "" }) tokenPrefix!: string;
    /**
     * 手输码唯一。没有这条约束的话，两次生成撞上同一个码时，
     * 按 code 查只会命中其中一张，另一张邀请的领取路径就被静默劫走了。
     * 链接类邀请没有码，这里存 NULL 而不是空串：三种数据库的唯一索引都允许多行 NULL，
     * 而空串会互相冲突——用 NULL 才能让「唯一」和「链接不占码」同时成立，
     * 也不必依赖 MySQL 不支持的部分索引。
     */
    @Index("uq_team_invites_code", { unique: true }) @Column({ type: "varchar", length: 64, nullable: true, default: null }) code!: string | null;
    @Column({ type: "varchar", length: 32, default: "member" }) role!: TeamRole;
    /** 0 表示不限次，语义与 InviteCode.maxUses 一致。 */
    @Column({ type: "int", default: 0 }) maxUses!: number;
    @Column({ type: "int", default: 0 }) usedCount!: number;
    @Column({ type: "boolean", default: true }) enabled!: boolean;
    /** 空串表示不过期。 */
    @Column(short) expiresAt!: string;
    @Column(short) createdBy!: string;
    @Column(short) note!: string;
    @Index() @Column(short) createdAt!: string;
}

/** 邀请领取记录。role 是领取当时授予的角色，邀请后来改角色不影响历史。 */
@Entity("team_invite_uses")
export class TeamInviteUse {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) inviteId!: string;
    @Index() @Column(short) teamId!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "varchar", length: 32, default: "member" }) role!: TeamRole;
    @Index() @Column(short) createdAt!: string;
}

/**
 * 团队积分流水，独立于 CreditLog。
 * 共表会让 balance 这一列的含义变成「要靠 type 猜是团队池还是个人余额」，
 * 而且平台后台的个人流水页会混进不影响个人余额的行。
 */
@Index(["teamId", "userId", "createdAt"])
@Entity("team_credit_logs")
export class TeamCreditLog {
    @PrimaryColumn(id) id!: string;
    @Index() @Column(short) teamId!: string;
    @Index() @Column(short) userId!: string;
    @Column({ type: "varchar", length: 32 }) type!: TeamCreditLogType;
    @Column({ type: "int", default: 0 }) amount!: number;
    /** 本次变动后的团队池余额。 */
    @Column({ type: "int", default: 0 }) balance!: number;
    @Column(short) model!: string;
    @Column(short) relatedId!: string;
    /** 同 CreditLog.refundOf：唯一索引保证同一笔团队扣费只可能被退一次。 */
    @Index("uq_team_credit_logs_refund_of", { unique: true }) @Column({ type: "varchar", length: 64, nullable: true }) refundOf!: string | null;
    @Column(short) remark!: string;
    @Column({ type: "text", nullable: true }) extra!: string;
    @Index() @Column(short) createdAt!: string;
}

export const entities = [User, CreditLog, Setting, InviteCode, InviteUse, Prompt, PromptCategory, Asset, PhysicalBlob, StoredFile, Project, ProjectShare, ProjectAccessLog, UserAsset, UserPlugin, Passkey, Job, AgentSession, AgentMessage, Team, TeamMember, TeamInvite, TeamInviteUse, TeamCreditLog];
