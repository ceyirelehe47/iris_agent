#!/usr/bin/env node
/**
 * A7 lockfile integrity gate（iris_agent#132 A7）。
 *
 * 扫描 package-lock.json 的全部 packages 条目：
 *  - `link: true`（file:/link 依赖）与 root 条目不需要 integrity（npm 语义）；
 *  - 其它（registry package）**必须**同时有 `resolved` 与 `integrity`。
 *
 * 用途：防止 lockfile 退化为离线/缓存生成的"无 integrity"状态（tarball
 * 校验失效 = 供应链完整性缺口）。任何 registry 条目缺 integrity/resolved →
 * fail-closed。
 *
 * 用法：`node scripts/check-lockfile-integrity.mjs [path/to/package-lock.json]`
 * 缺省扫描本仓库 package-lock.json。也支持 `--lockfile <path>`。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const lockArg = args.find((a, i) => a === "--lockfile" && args[i + 1] !== undefined);
const lockPath = lockArg
  ? resolve(process.cwd(), args[args.indexOf("--lockfile") + 1])
  : resolve(import.meta.dirname, "..", "package-lock.json");

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (error) {
  console.error(`lockfile-integrity: cannot read ${lockPath}: ${error.message}`);
  process.exit(1);
}

const offenders = [];
let registryEntries = 0;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  // link: true → file:/link 依赖（npm 不为其生成 integrity）；root 条目（key 为
  // 空串）同样无 integrity —— 两者豁免。
  if (entry.link === true || key === "") {
    continue;
  }
  // file: 协议（resolved 以 file: 开头）或相对路径 key（../.iris-vendor/...，
  // npm 对 file: 依赖的外部 link 形式）→ 本地/受管依赖，豁免。
  if (
    (typeof entry.resolved === "string" && entry.resolved.startsWith("file:")) ||
    /^\.\.?\//.test(key)
  ) {
    continue;
  }
  registryEntries += 1;
  if (typeof entry.integrity !== "string" || entry.integrity.length === 0) {
    offenders.push(`${key}: missing integrity`);
  }
  if (typeof entry.resolved !== "string" || entry.resolved.length === 0) {
    offenders.push(`${key}: missing resolved`);
  }
}

if (offenders.length > 0) {
  console.error(
    `lockfile-integrity FAILED: ${offenders.length} registry package(s) in ${lockPath} ` +
      `lack resolved/integrity (${registryEntries} registry entries scanned):`,
  );
  for (const offender of offenders.slice(0, 40)) {
    console.error(`  - ${offender}`);
  }
  if (offenders.length > 40) {
    console.error(`  … and ${offenders.length - 40} more`);
  }
  console.error(
    "\nRegenerate with `npm install --package-lock-only --registry=https://registry.npmjs.org/` " +
      "(deterministic official registry) and commit the lockfile.",
  );
  process.exit(1);
}

console.log(
  `lockfile-integrity OK: ${registryEntries} registry package(s) all carry resolved+integrity`,
);
process.exit(0);
