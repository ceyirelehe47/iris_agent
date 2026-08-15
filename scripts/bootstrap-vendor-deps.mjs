#!/usr/bin/env node
/**
 * Vendor dependency bootstrap（iris_agent#131 clean-checkout CI + A6 build
 * provenance）。
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
 *   - `<repo>/../.iris-vendor/pi`、`<repo>/../.iris-vendor/iris-context`；
 *   - build stamp：`<repo>/../.iris-vendor/.build-stamps/<name>.json`（A6）。
 *
 * A6 build provenance：
 *   - commit/tree 变化 → 清除 dist / node_modules / 旧 build stamp（受管
 *     vendor 检出内的安全、明确范围 clean；绝不误删仓库外目录）；
 *   - 构建完成后写版本化 build manifest/stamp，覆盖 repo / commit / tree /
 *     package-lock hash / Node / npm / build profile / artifact manifest
 *     hashes（scripts/vendor-build-manifest.mjs）；
 *   - 构建产物 marker 存在但 stamp 缺失/与 pin 不符/产物 hash 不匹配 → 重建
 *     （绝不复用旧 artifact —— poisoned cache fail-closed）；
 *   - `--check` 验证 source pin **和** build stamp/artifact（不只 Git HEAD）。
 *
 * 失败一律 fail-closed：不静默 fallback 到旧 sibling 项目 checkout、不猜测 pin。
 *
 * 测试注入（test/vendor-build-provenance.test.ts）：
 *   - IRIS_VENDOR_ROOT   覆盖缓存根（默认 <repo>/../.iris-vendor）；
 *   - IRIS_VENDOR_PIN_PATH 覆盖 production-lock 路径；
 *   - IRIS_VENDOR_STAMP_DIR 覆盖 build stamp 目录。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  cleanVendorBuild,
  readBuildStamp,
  verifyBuildStamp,
  writeBuildStamp,
} from "./vendor-build-manifest.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PIN_PATH = process.env.IRIS_VENDOR_PIN_PATH
  ? resolve(process.env.IRIS_VENDOR_PIN_PATH)
  : resolve(REPO_ROOT, "src", "contracts", "pins", "production-lock.json");
const CACHE_ROOT = process.env.IRIS_VENDOR_ROOT
  ? resolve(process.env.IRIS_VENDOR_ROOT)
  : resolve(dirname(REPO_ROOT), ".iris-vendor");
const STAMP_DIR = process.env.IRIS_VENDOR_STAMP_DIR
  ? resolve(process.env.IRIS_VENDOR_STAMP_DIR)
  : resolve(CACHE_ROOT, ".build-stamps");
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

/** 是否 symlink（开发环境快速通道；symlink 指向真实项目 checkout，禁止 clean）。 */
function isSymlink(dir) {
  try {
    return lstatSync(dir).isSymbolicLink();
  } catch {
    return false;
  }
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

/**
 * 物化 vendor 检出到精确 commit（fetch exact SHA 完整历史 + detached checkout）。
 *
 * A6：commit/tree 变化时（旧 HEAD != 目标 commit），先清除旧构建产物
 * （dist/node_modules/build stamp）—— 绝不复用旧 commit 的 artifact。
 *
 * symlink 快速通道（开发环境：vendor 目录 symlink 到真实项目 checkout）：
 * **绝不** checkout / clean / fetch —— 开发者工作树与未提交改动不可被
 * preinstall 触碰；pin 漂移由 `--check` / production-lock gate 报错（fail
 * closed），由开发者手动对齐。
 */
function provisionRepo(dir, name, repository, commit, tree) {
  if (isSymlink(dir)) {
    const problems = verifyRepo(dir, repository, commit, tree);
    if (problems.length > 0) {
      throw new Error(
        `vendor symlink ${dir} does not match the pin: ${problems.join("; ")} ` +
          "(dev symlink fast path: align the checkout manually; preinstall will not mutate it)",
      );
    }
    return;
  }
  if (existsSync(dir) && isGitRepo(dir)) {
    const problems = verifyRepo(dir, repository, commit, tree);
    if (problems.length === 0) {
      return;
    }
    const previousHead = run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const fetch = run("git", ["-C", dir, "fetch", `https://github.com/${repository}.git`, commit]);
    if (!fetch.ok) {
      throw new Error(`cannot fetch pinned commit ${commit} from ${repository}: ${fetch.out}`);
    }
    if (previousHead.ok && previousHead.out !== commit) {
      // commit 切换：遗留 dist/node_modules 来自旧 commit —— 清除（A6）。
      cleanVendorBuild(dir, name, STAMP_DIR);
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
  // 非 git 目录（陈旧/损坏/被误放的目录）：**fail-closed**，绝不递归删除 ——
  // 受管 vendor 检出中只允许安全、明确范围的 clean（dist/node_modules/
  // stamp，见 cleanVendorBuild）；任何无法确认是受管 git 检出的路径都要
  // 人工清理（review minor-3 加固：不得误删仓库外其它目录）。
  if (existsSync(dir) && !isGitRepo(dir)) {
    throw new Error(
      `bootstrap: ${dir} exists but is not a git repository (stale/foreign dir). ` +
        "Refusing to recursively delete it (fail closed); remove it manually and re-run.",
    );
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

/** 构建产物目录（相对 vendor 根）—— artifact manifest 只 hash 这些 build output。 */
const IRIS_CONTEXT_ARTIFACT_DIRS = ["dist"];
const PI_ARTIFACT_DIRS = [
  "packages/ai/dist",
  "packages/agent/dist",
  "packages/storage/sqlite-node/dist",
];

/**
 * 确保 vendor 检出有**与 pin + lock + 产物一致**的构建（A6）：
 *   - build stamp 有效（commit/tree/lockHash/artifacts 全匹配）→ 跳过；
 *   - 否则（stamp 缺失 / pin 变化 / lock 变化 / 产物被篡改）→ 受管 clean
 *     （dist/node_modules/stamp；symlink 快速通道不 clean，直接重建覆盖）+
 *     重建 + 写版本化 build stamp。
 */
function ensureVendorBuild(name, dir, pin, buildSteps, artifactDirs) {
  const check = verifyBuildStamp(name, dir, pin, STAMP_DIR, artifactDirs);
  if (check.length === 0) {
    console.log(`bootstrap: ${name} build stamp valid (${pin.commit})`);
    return;
  }
  console.log(`bootstrap: ${name} build stamp invalid (${check[0]}) — rebuilding…`);
  if (!isSymlink(dir)) {
    cleanVendorBuild(dir, name, STAMP_DIR);
  }
  buildSteps();
  writeBuildStamp({
    name,
    dir,
    pin,
    stampDir: STAMP_DIR,
    buildProfile: "npm-ci-build",
    artifactDirs,
  });
  console.log(`bootstrap: ${name} rebuilt and stamped at ${pin.commit}`);
}

function ensureVendorBuilds() {
  const pin = readPin();
  const piFork = pin.pi.fork;
  const irisContextPin = pin.irisContext;

  ensureVendorBuild(
    "iris-context",
    CACHE_IRIS_CONTEXT,
    {
      repository: irisContextPin.repository,
      commit: irisContextPin.commit,
      tree: irisContextPin.tree,
    },
    () => {
      // --include=dev：vendor 构建需要 devDeps（typescript/tsx 等）；若宿主
      // 环境 NODE_ENV=production，npm 默认 omit dev —— 必须显式包含。
      runNpm(CACHE_IRIS_CONTEXT, ["ci", "--no-audit", "--no-fund", "--include=dev"]);
      runNpm(CACHE_IRIS_CONTEXT, ["run", "build"]);
    },
  );
  ensureVendorBuild(
    "pi",
    CACHE_PI,
    { repository: piFork.repository, commit: piFork.seamCommit, tree: piFork.seamTree },
    () => {
      runNpm(CACHE_PI, ["ci", "--no-audit", "--no-fund", "--include=dev"]);
      for (const pkg of ["packages/ai", "packages/agent", "packages/storage/sqlite-node"]) {
        runNpm(resolve(CACHE_PI, pkg), ["run", "build"]);
      }
    },
  );
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

if (checkOnly) {
  // A6：--check 必须验证 source pin **和** build stamp/artifact，不只 Git HEAD。
  problems.push(
    ...verifyBuildStamp(
      "pi",
      CACHE_PI,
      { repository: piFork.repository, commit: piFork.seamCommit, tree: piFork.seamTree },
      STAMP_DIR,
      PI_ARTIFACT_DIRS,
    ),
    ...verifyBuildStamp(
      "iris-context",
      CACHE_IRIS_CONTEXT,
      {
        repository: irisContextPin.repository,
        commit: irisContextPin.commit,
        tree: irisContextPin.tree,
      },
      STAMP_DIR,
      IRIS_CONTEXT_ARTIFACT_DIRS,
    ),
  );
  if (problems.length > 0) {
    console.error(
      "bootstrap-vendor-deps: vendor checkouts/builds do not match the production lock:",
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    `bootstrap: vendor checkouts + build stamps OK (pi ${piFork.seamCommit} / iris-context ${irisContextPin.commit})`,
  );
  process.exit(0);
}

if (problems.length > 0) {
  console.error("bootstrap-vendor-deps: provisioning exact-pinned checkouts…");
  try {
    provisionRepo(CACHE_PI, "pi", piFork.repository, piFork.seamCommit, piFork.seamTree);
    provisionRepo(
      CACHE_IRIS_CONTEXT,
      "iris-context",
      irisContextPin.repository,
      irisContextPin.commit,
      irisContextPin.tree,
    );
    ensureVendorBuilds();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
} else {
  ensureVendorBuilds();
}

console.log(
  `bootstrap: vendor deps OK (pi ${piFork.seamCommit} / iris-context ${irisContextPin.commit})`,
);
process.exit(0);
