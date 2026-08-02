import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 存储专项验证脚本的公共骨架。
 * 单独一个文件而不是各脚本复制一遍，是为了让两个验证脚本的环境准备完全一致：
 * 环境变量必须在 import 业务模块之前写好，config 是模块级只读一次的。
 */
export function prepareEnv(name: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    process.env.STORAGE_DRIVER = "sqlite";
    process.env.DATABASE_DSN = path.join(root, "test.db");
    process.env.DATA_DIR = path.join(root, "data");
    process.env.FILE_DRIVER = "local";
    process.env.JWT_SECRET = "verify-secret";
    fs.mkdirSync(path.join(root, "data", "files"), { recursive: true });
    return { root, dbFile: path.join(root, "test.db"), dataDir: path.join(root, "data"), filesDir: path.join(root, "data", "files") };
}

export function writeObject(filesDir: string, key: string, body: Buffer) {
    const target = path.join(filesDir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
}

export function objectExists(filesDir: string, key: string) {
    return fs.existsSync(path.join(filesDir, key));
}

export function removeObject(filesDir: string, key: string) {
    fs.rmSync(path.join(filesDir, key), { force: true });
}

export function createChecker() {
    let pass = 0;
    let fail = 0;
    const check = (name: string, actual: unknown, expected: unknown) => {
        const same = JSON.stringify(actual) === JSON.stringify(expected);
        if (same) {
            pass += 1;
            console.log(`  [32mOK[0m   ${name}`);
        } else {
            fail += 1;
            console.log(`  [31mFAIL[0m ${name}\n       期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
        }
    };
    const rejects = async (name: string, work: () => Promise<unknown>) => {
        try {
            await work();
            check(name, "没有抛错", "抛错");
        } catch {
            check(name, "抛错", "抛错");
        }
    };
    const finish = (root: string) => {
        fs.rmSync(root, { recursive: true, force: true });
        console.log(`\n通过 ${pass}，失败 ${fail}`);
        process.exit(fail ? 1 : 0);
    };
    return { check, rejects, finish };
}
