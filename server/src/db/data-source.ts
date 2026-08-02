import fs from "node:fs";
import path from "node:path";
import { DataSource, type EntityManager } from "typeorm";

import { config } from "../config";
import { entities } from "./entities";

function driverType() {
    const driver = config.databaseDriver;
    if (driver === "mysql" || driver === "mariadb") return "mysql" as const;
    if (driver === "postgres" || driver === "postgresql") return "postgres" as const;
    return "sqlite" as const;
}

/** 库不存在时先建库，行为对齐旧后端的 ensureMySQLDatabase / ensurePostgresDatabase。 */
async function ensureDatabase(type: "mysql" | "postgres") {
    const url = new URL(config.databaseDsn);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!database) return;
    url.pathname = type === "mysql" ? "/" : "/postgres";
    if (type === "mysql") {
        const { createConnection } = await import("mysql2/promise");
        const connection = await createConnection(url.toString());
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.end();
        return;
    }
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    await client.end();
}

function buildDataSource() {
    const type = driverType();
    const common = { entities, synchronize: true, logging: false } as const;
    if (type === "sqlite") {
        if (config.databaseDsn !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(config.databaseDsn)), { recursive: true });
        return new DataSource({ type: "better-sqlite3", database: config.databaseDsn, ...common });
    }
    return new DataSource({ type, url: config.databaseDsn, ...common });
}

export const dataSource = buildDataSource();

export async function initDatabase() {
    const type = driverType();
    if (type !== "sqlite") await ensureDatabase(type);
    await dataSource.initialize();
    fs.mkdirSync(config.dataDir, { recursive: true });
}

export function repo<T extends object>(entity: new () => T) {
    return dataSource.getRepository<T>(entity);
}

/**
 * 进程内串行事务队列。SQLite 驱动全程只有一条连接，两个并发的 `BEGIN` 会直接报
 * 「cannot start a transaction within a transaction」，所以事务必须排队进出，
 * 而且必须是全进程唯一的一条队列——各服务各排各的等于没排，扣费和领邀请照样会撞在一起。
 * MySQL/Postgres 走连接池不需要它，但排队本身无害：这些事务都以毫秒计。
 * 跨进程的正确性不依赖这把锁——那由事务内的条件更新与行锁保证。
 */
let transactionQueue: Promise<unknown> = Promise.resolve();

export function serialTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const run = () => dataSource.transaction(work);
    const next = transactionQueue.then(run, run);
    transactionQueue = next.catch(() => undefined);
    return next;
}
