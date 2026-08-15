#!/usr/bin/env node
/**
 * Vendor dependency bootstrap（iris_agent#131 clean-checkout CI）。
 *
 * 目标：一个 fresh checkout（无 sibling 项目仓库）执行 `npm ci` + `npm run check`
 * 即可成功。跨仓库依赖（@iris/context、@iris/pi-*）不再依赖「开发者/CI 预先放好
 * 的 sibling 项目 checkout」，而是由本脚本在 `preinstall` 阶段把 production lock
 * 的**精确 commit/tree pin** 物化到仓库外的受管缓存 `<repo>/../.iris-vendor`，
 * package.json 以 `file:../.iris-vendor/...` 引用（npm 按外部 link 处理：不解析
 * 目标包 devDeps/peerDeps，与既有 `file:../pi` 语义一致、安装面精简）。
 *
 * 单一事实来源：src/contracts/pins/production-lock.json
 *   - pi.fork.seamCommit / seamTree + pi.fork.repository（可访问的真实 fork）；
 *   - irisContext.commit / tree + irisContext.repository（@iris/context 的
 *     精确 pin，指向已接受/已审的 iris-context 状态）。
 *
 * 布局：
 *   - 缓存根：`<repo>/../.iris-vendor`（仓库外 sibling；可再生的精确 pin 检出）；
 *   - `<repo>/../.iris-vendor/pi`、`<repo>/../.iris-vendor/iris-context`。
 *
 * 行为（幂等）：
 *   - ensureRepo(dir, repository, commit, tree)：
 *       已存在且 HEAD==commit 且 tree==pin → 跳过；
 *       否则 fetch 精确 commit 的完整历史（ancestry 校验需要）并 detached
 *       checkout，校验 commit+tree；
 *   - ensureBuilds()：构建产物 marker 存在 → 跳过；否则执行 vendor 内构建
 *       （iris-context: npm ci + npm run build；pi: npm ci + 三包 build）。
 *   - `--check`：只校验（不物化、不构建、不联网）；任何不匹配 → 退出非 0
 *     （fail-closed）。供 production-lock.test.ts / clean-layout gate 使用。
 *
 * 失败一律 fail-closed：不静默 fallback 到旧 sibling 项目 checkout、不猜测 pin。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PIN_PATH = resolve(REPO_ROOT, "src", "contracts", "pins", "production-lock.json");
const CACHE_ROOT = resolve(dirname(REPO_ROOT), ".iris-vendor");
const CACHE_PI = resolve(CACHE_ROOT, "pi");
const CACHE_IRIS_CONTEXT = resolve(CACHE_ROOT, "iris-context");

function run(cmd, args, opts = {}) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 600_000,
      ...opts,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      };
    }
    return { ok: true, out: `${result.stdout ?? ""}`.trim() };
  } catch (error) {
    return { ok: false, out: String(error?.message ?? error) };
  }
}

function readPin() {
  return JSON.parse(readFileSync(PIN_PATH, "utf8"));
}

function isGitRepo(dir) {
  return run("git", ["-C", dir, "rev-parse", "--git-dir"]).ok;
}

/** 校验 vendor 检出的 git identity（commit + tree）与 pin 一致。 */
function verifyRepo(dir, repository, commit, tree) {
  const problems = [];
  if (!existsSync(dir)) {
    problems.push(`missing vendor checkout: ${dir} (run \`npm ci\` / bootstrap-vendor-deps.mjs)`);
    return problems;
  }
  if (!isGitRepo(dir)) {
    problems.push(`not a git repository: ${dir}`);
    return problems;
  }
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (!head.ok || head.out !== commit) {
    problems.push(
      `HEAD ${head.ok ? head.out : "?"} != pinned commit ${commit} (${repository}) in ${dir}`,
    );
    return problems;
  }
  const headTree = run("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]);
  if (!headTree.ok || headTree.out !== tree) {
    problems.push(`HEAD tree ${headTree.ok ? headTree.out : "?"} != pinned tree ${tree} in ${dir}`);
  }
  return problems;
}

/** 物化 vendor 检出到精确 commit（fetch exact SHA 完整历史 + detached checkout）。 */
function provisionRepo(dir, repository, commit, tree) {
  if (existsSync(dir) && isGitRepo(dir)) {
    const problems = verifyRepo(dir, repository, commit, tree);
    if (problems.length === 0) {
      return;
    }
    const fetch = run("git", ["-C", dir, "fetch", `https://github.com/${repository}.git`, commit]);
    if (!fetch.ok) {
      throw new Error(`cannot fetch pinned commit ${commit} from ${repository}: ${fetch.out}`);
    }
    const checkout = run("git", ["-C", dir, "checkout", "--detach", "--force", commit]);
    if (!checkout.ok) {
      throw new Error(`cannot checkout ${commit}: ${checkout.out}`);
    }
    const after = verifyRepo(dir, repository, commit, tree);
    if (after.length > 0) {
      throw new Error(`${after.join("; ")} (fail closed)`);
    }
    return;
  }
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  run("mkdir", ["-p", dirname(dir)]);
  const init = run("git", ["init", "-q", dir]);
  if (!init.ok) {
    throw new Error(`git init failed for ${dir}: ${init.out}`);
  }
  const fetch = run("git", ["-C", dir, "fetch", `https://github.com/${repository}.git`, commit]);
  if (!fetch.ok) {
    throw new Error(`cannot fetch pinned commit ${commit} from ${repository}: ${fetch.out}`);
  }
  const checkout = run("git", ["-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD"]);
  if (!checkout.ok) {
    throw new Error(`cannot checkout pinned commit: ${checkout.out}`);
  }
  const problems = verifyRepo(dir, repository, commit, tree);
  if (problems.length > 0) {
    throw new Error(`${problems.join("; ")} (fail closed)`);
  }
  console.log(`bootstrap: provisioned ${dir} at ${commit}`);
}

function runNpm(dir, args) {
  const result = run("npm", args, { cwd: dir, timeout: 900_000 });
  if (!result.ok) {
    throw new Error(`npm ${args[0]} in ${dir} failed: ${result.out.slice(0, 2000)}`);
  }
  return result;
}

/** 构建产物 markers。 */
const IRIS_CONTEXT_BUILD_MARKER = resolve(CACHE_IRIS_CONTEXT, "dist", "src", "cordis", "index.js");
const PI_BUILD_MARKERS = [
  "packages/ai/dist/index.js",
  "packages/agent/dist/index.js",
  "packages/storage/sqlite-node/dist/index.js",
].map((rel) => resolve(CACHE_PI, rel));

function ensureVendorBuilds() {
  if (!existsSync(IRIS_CONTEXT_BUILD_MARKER)) {
    console.log("bootstrap: building @iris/context (../.iris-vendor/iris-context)…");
    runNpm(CACHE_IRIS_CONTEXT, ["ci", "--no-audit", "--no-fund"]);
    runNpm(CACHE_IRIS_CONTEXT, ["run", "build"]);
  }
  if (!PI_BUILD_MARKERS.every(existsSync)) {
    console.log("bootstrap: building @iris/pi-* (../.iris-vendor/pi)…");
    runNpm(CACHE_PI, ["ci", "--no-audit", "--no-fund"]);
    for (const pkg of ["packages/ai", "packages/agent", "packages/storage/sqlite-node"]) {
      runNpm(resolve(CACHE_PI, pkg), ["run", "build"]);
    }
  }
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

const pin = readPin();
const piFork = pin.pi.fork;
const irisContextPin = pin.irisContext;

const problems = [
  ...verifyRepo(CACHE_PI, piFork.repository, piFork.seamCommit, piFork.seamTree),
  ...verifyRepo(
    CACHE_IRIS_CONTEXT,
    irisContextPin.repository,
    irisContextPin.commit,
    irisContextPin.tree,
  ),
];

if (problems.length > 0) {
  if (checkOnly) {
    console.error("bootstrap-vendor-deps: vendor checkouts do not match the production lock:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.error("bootstrap-vendor-deps: provisioning exact-pinned checkouts…");
  try {
    provisionRepo(CACHE_PI, piFork.repository, piFork.seamCommit, piFork.seamTree);
    provisionRepo(
      CACHE_IRIS_CONTEXT,
      irisContextPin.repository,
      irisContextPin.commit,
      irisContextPin.tree,
    );
    ensureVendorBuilds();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
} else if (!checkOnly) {
  ensureVendorBuilds();
}

console.log(
  `bootstrap: vendor deps OK (pi ${piFork.seamCommit} / iris-context ${irisContextPin.commit})`,
);
process.exit(0);
