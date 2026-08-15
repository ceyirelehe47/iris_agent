#!/usr/bin/env node
/**
 * Vendor build provenance manifest（iris_agent#131 A6）。
 *
 * 目标：`npm ci`（preinstall bootstrap）物化的 vendor 检出，其**构建产物**
 * 必须可验证地与精确 pin（commit/tree）+ 依赖锁（package-lock）+ 工具链
 * （node/npm）+ 构建 profile 绑定。旧实现只按 marker 存在复用 dist ——
 * commit/tree 切换后遗留的旧 dist/node_modules 会被静默复用（A6 finding）。
 *
 * 本模块提供：
 *  - `artifactManifest(dir)`：递归 hash 构建产物（相对路径 → sha256）；
 *  - `computeLockHash(dir)`：vendor 根 package-lock.json 的 sha256；
 *  - `buildStampValid(name, dir, pin, stampDir)`：stamp 是否与 pin/lock/
 *    产物全部一致（不一致 → 必须重建或 fail-closed）；
 *  - `verifyBuildStamp(name, dir, pin, stampDir)`：--check 用，返回问题列表；
 *  - `writeBuildStamp(...)`：构建完成后写版本化 build manifest；
 *  - `cleanVendorBuild(dir)`：受管 vendor 检出内的安全、明确范围 clean
 *    （只删 dist/node_modules/build stamp；绝不误删仓库外目录 —— 调用方
 *    负责先验证 dir 是受管 git 检出）。
 *
 * 全部函数纯文件系统，可被单测直接 import（不执行 npm）。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export const BUILD_STAMP_SCHEMA_VERSION = 1;

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** 递归收集目录下所有文件（相对路径）。 */
export function walkFiles(dir, out = [], base = dir) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out, base);
    } else if (entry.isFile()) {
      out.push(relative(base, full));
    }
  }
  return out;
}

/** 构建产物清单（相对路径 → sha256）。 */
export function artifactManifest(dir) {
  const manifest = {};
  for (const rel of walkFiles(dir)) {
    manifest[rel] = sha256File(join(dir, rel));
  }
  return manifest;
}

/** vendor 根 package-lock.json 的 sha256（缺失 → 抛错 fail-closed）。 */
export function computeLockHash(dir) {
  const lockPath = join(dir, "package-lock.json");
  if (!existsSync(lockPath)) {
    throw new Error(`vendor build manifest: missing package-lock.json in ${dir} (fail closed)`);
  }
  return sha256File(lockPath);
}

function stampPath(name, stampDir) {
  return resolve(stampDir, `${name}.build-stamp.json`);
}

export function readBuildStamp(name, stampDir) {
  const path = stampPath(name, stampDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function artifactsMatch(stamp, dir) {
  if (!stamp || typeof stamp.artifacts !== "object" || stamp.artifacts === null) {
    return false;
  }
  const current = artifactManifest(dir);
  const stamped = stamp.artifacts;
  const keys = Object.keys(stamped);
  if (keys.length === 0) return false;
  if (keys.length !== Object.keys(current).length) return false;
  for (const key of keys) {
    if (current[key] !== stamped[key]) return false;
  }
  return true;
}

/**
 * stamp 是否有效：存在 + commit/tree/lockHash 与 pin 一致 + 产物 hash 全匹配。
 * 返回 { valid, reason? }。
 */
export function buildStampValid(name, dir, pin, stampDir) {
  const stamp = readBuildStamp(name, stampDir);
  if (stamp === undefined) {
    return { valid: false, reason: `build stamp missing for ${name}` };
  }
  if (stamp.schemaVersion !== BUILD_STAMP_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `build stamp schema version ${stamp.schemaVersion} != ${BUILD_STAMP_SCHEMA_VERSION}`,
    };
  }
  if (stamp.commit !== pin.commit) {
    return { valid: false, reason: `build stamp commit ${stamp.commit} != pinned ${pin.commit}` };
  }
  if (stamp.tree !== pin.tree) {
    return { valid: false, reason: `build stamp tree ${stamp.tree} != pinned ${pin.tree}` };
  }
  let lockHash;
  try {
    lockHash = computeLockHash(dir);
  } catch (error) {
    return { valid: false, reason: error.message };
  }
  if (stamp.lockHash !== lockHash) {
    return {
      valid: false,
      reason: `build stamp lockHash ${stamp.lockHash} != current ${lockHash}`,
    };
  }
  if (!artifactsMatch(stamp, dir)) {
    return { valid: false, reason: `build artifacts do not match the stamp manifest for ${name}` };
  }
  return { valid: true };
}

/** --check：返回问题列表（空数组 = 通过）。 */
export function verifyBuildStamp(name, dir, pin, stampDir) {
  const problems = [];
  const check = buildStampValid(name, dir, pin, stampDir);
  if (!check.valid) {
    problems.push(check.reason);
  }
  return problems;
}

/**
 * 构建完成后写版本化 build manifest / stamp。覆盖：
 * repo / commit / tree / package-lock hash / Node / npm / build profile /
 * artifact manifest hashes。
 */
export function writeBuildStamp({ name, dir, pin, stampDir, buildProfile }) {
  mkdirSync(stampDir, { recursive: true });
  const lockHash = computeLockHash(dir);
  const stamp = {
    schemaVersion: BUILD_STAMP_SCHEMA_VERSION,
    name,
    repository: pin.repository,
    commit: pin.commit,
    tree: pin.tree,
    lockHash,
    node: process.version,
    npm: process.env.npm_version ?? "unknown",
    buildProfile: buildProfile ?? "npm-ci-build",
    builtAt: new Date().toISOString(),
    artifacts: artifactManifest(dir),
  };
  writeFileSync(stampPath(name, stampDir), JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

/**
 * 受管 vendor 检出内的安全 clean（A6）：
 *  - 只删除 dist / node_modules / build stamp（构建产物与旧 stamp）；
 *  - 调用方负责确认 dir 是**受管 git 检出**（不是任意目录）且不是外部
 *    项目 checkout 的 symlink；绝不触碰仓库内源文件。
 */
export function cleanVendorBuild(dir, name, stampDir) {
  for (const target of ["dist", "node_modules"]) {
    const full = resolve(dir, target);
    if (existsSync(full)) {
      // 只删受管检出内的构建产物目录（防御：路径必须位于 dir 内）。
      const normalized = resolve(full);
      if (normalized.startsWith(resolve(dir) + "/")) {
        rmSync(normalized, { recursive: true, force: true });
      }
    }
  }
  const stamp = stampPath(name, stampDir);
  if (existsSync(stamp)) {
    rmSync(stamp, { force: true });
  }
}
