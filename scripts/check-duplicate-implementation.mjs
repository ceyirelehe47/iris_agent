#!/usr/bin/env node
/**
 * Duplicate-Implementation Fence（consume-iris-context）。
 *
 * iris_agent 不再实现自己的 Context/Historian/RuntimeEvent 引擎 —— 权威
 * 语义完全由 @iris/context（ContextService + ContextGenerationV2 +
 * RuntimeEventInput）持有，本仓库只消费其版本化契约并在 Pi seam 适配。
 *
 * 本 fence 断言：
 *   1. src/context、src/historian 目录不存在（没有第二套引擎实现）；
 *   2. src/ 下没有任何 `../context/`、`../historian/` 的相对导入（连本地
 *      history-read-port / context-store 等内部文件都不存在）；
 *   3. src/db/migrations 下没有 context / historian / runtime-events 目录
 *      （durable schema 由 @iris/context 管理）；
 *   4. package.json 依赖包含 @iris/context（单一 Context 权威）。
 *
 * 退出码非 0 即违规（fail-closed；CI 前置/末尾 gate）。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const violations = [];

// --- 1. 目录 fence ---
for (const dir of ["src/context", "src/historian"]) {
  if (existsSync(resolve(REPO_ROOT, dir))) {
    violations.push(`duplicate implementation directory exists: ${dir}/`);
  }
}

// --- 2. 相对导入 fence（src/ 全部源文件）---
const srcFiles = execSync("git ls-files src/", {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
})
  .trim()
  .split("\n")
  .filter((file) => file.endsWith(".ts"));
for (const file of srcFiles) {
  const fullPath = resolve(REPO_ROOT, file);
  let content;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    continue; // 已删除/未检出
  }
  const lineHits = [];
  content.split("\n").forEach((line, index) => {
    if (/from "\.\.\/context\//.test(line) || /from "\.\.\/historian\//.test(line)) {
      lineHits.push(index + 1);
    }
  });
  if (lineHits.length > 0) {
    violations.push(
      `${file} imports local duplicate context/historian module at line(s): ${lineHits.join(", ")}`,
    );
  }
}

// --- 3. migration 目录 fence ---
for (const dir of [
  "src/db/migrations/context",
  "src/db/migrations/historian",
  "src/db/migrations/runtime-events",
]) {
  if (existsSync(resolve(REPO_ROOT, dir))) {
    violations.push(`duplicate migration directory exists: ${dir}/`);
  }
}

// --- 4. 依赖 fence ---
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
if (!("@" + "iris/context" in deps)) {
  violations.push("package.json does not depend on @iris/context");
}

if (violations.length > 0) {
  console.error("Duplicate-implementation fence FAILED:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error(
    "\nThe canonical Context/Historian engine lives in @iris/context; iris_agent must only consume it.",
  );
  process.exit(1);
}

console.log(
  "Duplicate-implementation fence passed — no local Context/Historian engine, only @iris/context.",
);
