#!/usr/bin/env node
/**
 * Clean-layout gate（iris_agent#131）：禁止 unmanaged required sibling file 依赖。
 *
 * 一个 fresh checkout（无 sibling 项目仓库）必须能执行 `npm ci` + `npm run check`。
 * `file:../...` 依赖若指向「另一个项目 checkout」（如 `file:../iris-context`、
 * `file:../pi/...`），fresh checkout 无法提供，且无法确定性获得 —— 不得再引入。
 *
 * 唯一允许的 `file:../` 前缀是 `file:../.iris-vendor/`：这是
 * scripts/bootstrap-vendor-deps.mjs 在 `preinstall` 阶段按 production-lock
 * 精确 commit/tree pin 物化的受管缓存（仓库外 sibling）。它可复现、自包含，
 * 且被 production-lock.test.ts 逐 commit/tree 校验（fail-closed）。
 *
 * 本门断言：
 *   1. package.json 的 dependencies / devDependencies 没有任何 `file:../` spec，
 *      除 `file:../.iris-vendor/` 前缀之外；
 *   2. package-lock.json 中没有任何 `file:../` 的 resolved 路径，除
 *      `.iris-vendor/` 之外。
 *
 * 退出码非 0 即违规（fail-closed；CI 前置 gate）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ALLOWED_SIBLING_PREFIX = "file:../.iris-vendor/";

// Test override: point the gate at a specific package.json / lockfile (used by
// the sensitivity test to prove a regressed layout fails).
const args = process.argv.slice(2);
const pkgFlag = args.indexOf("--package");
const lockFlag = args.indexOf("--lockfile");
const pkgPath = pkgFlag >= 0 ? resolve(args[pkgFlag + 1]) : resolve(REPO_ROOT, "package.json");
const lockPath =
  lockFlag >= 0 ? resolve(args[lockFlag + 1]) : resolve(REPO_ROOT, "package-lock.json");

const violations = [];

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const allSpecs = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};
for (const [name, spec] of Object.entries(allSpecs)) {
  if (
    typeof spec === "string" &&
    spec.startsWith("file:../") &&
    !spec.startsWith(ALLOWED_SIBLING_PREFIX)
  ) {
    violations.push(
      `package.json dependency ${name} uses unmanaged required sibling file spec ${spec} — ` +
        "a fresh checkout cannot resolve it; only the bootstrap-managed " +
        `\`${ALLOWED_SIBLING_PREFIX}\` cache (exact-pinned by production-lock.json) is allowed`,
    );
  }
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const walk = (value) => {
  if (typeof value === "string") {
    if (value.startsWith("file:../") && !value.startsWith(ALLOWED_SIBLING_PREFIX)) {
      violations.push(`package-lock.json carries unmanaged sibling file spec ${value}`);
    }
    if (value.startsWith("../") && !value.startsWith("../.iris-vendor/")) {
      violations.push(`package-lock.json resolved path escapes the managed cache: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(walk);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) {
      walk(member);
    }
  }
};
walk(lock);

if (violations.length > 0) {
  console.error("Clean-layout gate FAILED:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error(
    `\nAll cross-repo dependencies must be exact-pinned and self-contained ` +
      `(${ALLOWED_SIBLING_PREFIX}, materialized by scripts/bootstrap-vendor-deps.mjs from production-lock.json).`,
  );
  process.exit(1);
}

console.log("Clean-layout gate passed — no unmanaged sibling file dependencies.");
