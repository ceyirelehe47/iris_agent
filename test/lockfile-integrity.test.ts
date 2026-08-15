/**
 * A7：lockfile integrity gate（iris_agent#132 A7）。
 *
 * 覆盖：
 *  - 当前 package-lock.json：所有非 file:/link/workspace 的 registry package
 *    都必须带 `integrity`（+ `resolved`）—— npm ci 的 tarball 校验基础；
 *  - 不得「只为新增 DSH 包保留 integrity，而删除既有普通依赖的 integrity」；
 *  - sensitivity：篡改任一 registry entry 的 integrity（或删掉它）→ gate 失败
 *    （有牙齿）；恢复后通过。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LOCK = join(REPO_ROOT, "package-lock.json");
const GATE = join(REPO_ROOT, "scripts", "check-lockfile-integrity.mjs");

interface LockEntry {
  link?: boolean;
  resolved?: string;
  integrity?: string;
}

interface LockfileShape {
  packages?: Record<string, LockEntry>;
}

function readLock(path: string): LockfileShape {
  return JSON.parse(readFileSync(path, "utf8")) as LockfileShape;
}

function analyzeLock(lock: { packages?: Record<string, LockEntry> }) {
  let registry = 0;
  let missingIntegrity = 0;
  let missingResolved = 0;
  const sample: string[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.link === true || key === "") continue;
    if (
      (typeof entry.resolved === "string" && entry.resolved.startsWith("file:")) ||
      /^\.\.?\//.test(key)
    ) {
      continue;
    }
    registry += 1;
    if (typeof entry.integrity !== "string" || entry.integrity.length === 0) {
      missingIntegrity += 1;
      sample.push(key);
    }
    if (typeof entry.resolved !== "string" || entry.resolved.length === 0) {
      missingResolved += 1;
    }
  }
  return { registry, missingIntegrity, missingResolved, sample };
}

test("A7: every non-file registry package in the lockfile carries integrity + resolved", () => {
  const lock = readLock(LOCK);
  const { registry, missingIntegrity, missingResolved, sample } = analyzeLock(lock);
  assert.ok(registry > 0, "lockfile must contain registry packages");
  assert.deepEqual(
    { missingIntegrity, missingResolved },
    { missingIntegrity: 0, missingResolved: 0 },
    `registry packages must all carry integrity+resolved; missing: ${sample.join(", ")}`,
  );
});

test("A7: new DSH packages must not be the only entries with integrity (all entries covered)", () => {
  // 回归门：如果未来 lockfile 只给新增的 @deepseek-ai/dsh-* 保留 integrity、
  // 却把既有普通依赖（ajv/typescript/eslint 等）的 integrity 删掉 → 本门失败。
  const lock = readLock(LOCK);
  const { registry, missingIntegrity } = analyzeLock(lock);
  assert.equal(missingIntegrity, 0, "no registry entry may lose integrity");
  // 代表性既有普通依赖必须仍带 integrity。
  const ordinary = ["node_modules/ajv", "node_modules/typescript", "node_modules/eslint"];
  const packages: Record<string, LockEntry> = lock.packages ?? {};
  for (const key of ordinary) {
    const entry = packages[key];
    assert.ok(entry !== undefined, `lockfile must contain ${key}`);
    assert.equal(
      typeof entry.integrity,
      "string",
      `${key} must carry integrity (existing ordinary deps keep it)`,
    );
    assert.ok(String(entry.resolved ?? "").length > 0, `${key} must carry resolved`);
  }
  assert.ok(registry > 0);
});

test("A7 sensitivity: stripping an entry's integrity fails the gate (has teeth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-lock-integrity-"));
  try {
    const lock = readLock(LOCK);
    const packages: Record<string, LockEntry> = lock.packages ?? {};
    const pair = Object.entries(packages).find(
      ([k, entry]) =>
        k.startsWith("node_modules/") &&
        entry.integrity !== undefined &&
        entry.resolved !== undefined,
    );
    assert.ok(pair !== undefined, "a registry entry must exist to tamper");
    const targetEntry = pair[1];
    // 删除 integrity（lockfile 退化为"离线/缓存生成、无完整性"状态 —— A7 的
    // 回归对象）→ gate 必须失败。
    delete targetEntry.integrity;
    const stripped = join(dir, "package-lock-stripped.json");
    writeFileSync(stripped, JSON.stringify(lock, null, 2));
    assert.throws(
      () =>
        execFileSync(process.execPath, [GATE, "--lockfile", stripped], {
          encoding: "utf8",
        }),
      /lockfile-integrity FAILED/,
      "stripped integrity must fail the gate",
    );
    // 删除 resolved 同样失败。
    delete targetEntry.resolved;
    const noResolved = join(dir, "package-lock-noresolved.json");
    writeFileSync(noResolved, JSON.stringify(lock, null, 2));
    assert.throws(
      () =>
        execFileSync(process.execPath, [GATE, "--lockfile", noResolved], {
          encoding: "utf8",
        }),
      /lockfile-integrity FAILED/,
      "missing resolved must fail the gate",
    );
    // 恢复后通过（sensitivity 双向证明）。
    const restored = join(dir, "package-lock-restored.json");
    writeFileSync(restored, JSON.stringify(readLock(LOCK), null, 2));
    const out = execFileSync(process.execPath, [GATE, "--lockfile", restored], {
      encoding: "utf8",
    });
    assert.match(out, /lockfile-integrity OK/);
  } finally {
    // OS tmpdir 管理。
  }
});

test("A7: lockfile regeneration used the deterministic official registry (resolved URLs)", () => {
  // A7 要求使用确定的官方或项目明确批准的 registry 重新生成 lockfile。
  // 当前 lockfile 的 resolved URL 必须来自官方 registry（registry.npmjs.org）
  // 或项目批准镜像 —— 任何条目不得退化为无 resolved 的离线形式。
  const lock = readLock(LOCK) as LockfileShape & {
    packages: Record<string, { link?: boolean; resolved?: string }>;
  };
  let official = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.link === true || key === "" || /^\.\.?\//.test(key)) continue;
    if (typeof entry.resolved !== "string") continue;
    assert.ok(
      entry.resolved.startsWith("https://registry.npmjs.org/") ||
        entry.resolved.startsWith("https://registry.npmmirror.com/"),
      `${key} resolved must come from an approved registry, got ${entry.resolved}`,
    );
    official += 1;
  }
  assert.ok(official > 0, "registry entries must resolve to an approved registry");
});
