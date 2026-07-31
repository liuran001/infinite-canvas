import "dotenv/config";
import { randomBytes } from "node:crypto";
import path from "node:path";

function int(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt((value || "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean) {
    const text = (value || "").trim().toLowerCase();
    if (!text) return fallback;
    return text === "1" || text === "true" || text === "yes";
}

function text(value: string | undefined, fallback = "") {
    return (value || "").trim() || fallback;
}

const env = process.env;
const databaseDriver = text(env.STORAGE_DRIVER, "sqlite").toLowerCase();
const databaseDsn = text(env.DATABASE_DSN, "data/infinite-canvas.db");

/** SQLite 场景下数据目录跟随数据库文件，其余场景使用 DATA_DIR。 */
function resolveDataDir() {
    if (env.DATA_DIR) return path.resolve(env.DATA_DIR);
    if (databaseDriver === "sqlite" && databaseDsn && databaseDsn !== ":memory:") return path.resolve(path.dirname(databaseDsn));
    return path.resolve("data");
}

export const config = {
    port: int(env.PORT, 8080),
    adminUsername: text(env.ADMIN_USERNAME, "admin"),
    adminPassword: text(env.ADMIN_PASSWORD, "infinite-canvas"),
    jwtSecret: text(env.JWT_SECRET) && text(env.JWT_SECRET) !== "infinite-canvas" ? text(env.JWT_SECRET) : randomBytes(32).toString("base64url"),
    jwtExpireHours: int(env.JWT_EXPIRE_HOURS, 168),
    databaseDriver,
    databaseDsn,
    dataDir: resolveDataDir(),
    /** 对外可访问地址，供上游厂商回源读取参考素材。 */
    publicBaseUrl: text(env.PUBLIC_BASE_URL).replace(/\/+$/, ""),
    corsOrigin: text(env.CORS_ORIGIN, "*"),
    /** 文件存储驱动：local 落本地磁盘，s3 走 S3 兼容对象存储。 */
    fileDriver: text(env.FILE_DRIVER, "local").toLowerCase(),
    s3: {
        endpoint: text(env.S3_ENDPOINT),
        region: text(env.S3_REGION, "auto"),
        bucket: text(env.S3_BUCKET),
        accessKeyId: text(env.S3_ACCESS_KEY_ID),
        secretAccessKey: text(env.S3_SECRET_ACCESS_KEY),
        forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
        prefix: text(env.S3_PREFIX).replace(/^\/+|\/+$/g, ""),
    },
    jobConcurrency: int(env.JOB_CONCURRENCY, 4),
    linuxDo: {
        authorizeUrl: text(env.LINUX_DO_AUTHORIZE_URL, "https://connect.linux.do/oauth2/authorize"),
        tokenUrl: text(env.LINUX_DO_TOKEN_URL, "https://connect.linux.do/oauth2/token"),
        userInfoUrl: text(env.LINUX_DO_USERINFO_URL, "https://connect.linux.do/api/user"),
    },
};

export function warnDefaultSecurityConfig() {
    if (config.adminUsername === "admin" && config.adminPassword === "infinite-canvas") {
        console.warn("WARNING: 正在使用默认管理员账号，部署前请设置 ADMIN_USERNAME 与 ADMIN_PASSWORD");
    }
    if (!env.JWT_SECRET) {
        console.warn("WARNING: 未设置 JWT_SECRET，本次启动使用随机密钥，重启后已签发的登录态会失效");
    }
}
