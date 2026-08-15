// Deterministic local Pi checkout bootstrap for iris_agent (iris_agent#41).
//
// Verifies the adjacent ../pi checkout against the production lock, or
// provisions a dedicated detached worktree pinned to the accepted runtime
// identity — without ever resetting, moving, or deleting a developer's
// existing branches or working tree.
//
// The production lock is the single source of truth:
//   src/contracts/pins/production-lock.json -> pi.fork.seamCommit/seamTree
//
// Usage:
//   node scripts/bootstrap-pi-checkout.mjs [--check] [--worktree <dir>]
//
//   --check            Verify only. Exit 0 if the adjacent ../pi checkout
//                      (or the worktree dir, if given) matches the pin.
//   --worktree <dir>   Provision/verify a detached worktree at <dir> pinned
//                      to the accepted commit. Never touches ../pi or any
//                      developer branch. Implies --check for that dir.
//   --fetch <remote>   Optional remote URL to fetch the accepted commit from
//                      when the worktree's repository does not have it yet.
//                      Defaults to https://github.com/ceyirelehe47/pi.git (the real
//                      accessible fork; blueforst/pi does not exist on GitHub)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PIN_PATH = resolve(REPO_ROOT, "src", "contracts", "pins", "production-lock.json");
const DEFAULT_PI_PATH = resolve(REPO_ROOT, "..", "pi");
const DEFAULT_FETCH_URL = "https://github.com/ceyirelehe47/pi.git";

const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
const expectedCommit = pin.pi.fork.seamCommit;
const expectedTree = pin.pi.fork.seamTree;
const expectedRepo = pin.pi.fork.repository;

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (error) {
    return { ok: false, out: "", err: String(error.stderr ?? error.message).trim() };
  }
}

function isGitRepo(dir) {
  return run("git", ["-C", dir, "rev-parse", "--git-dir"]).ok;
}

// Returns a list of diagnostics, empty when the checkout matches the pin.
function verifyCheckout(dir) {
  const problems = [];
  if (!existsSync(dir)) {
    problems.push(`missing checkout: ${dir}`);
    return problems;
  }
  if (!isGitRepo(dir)) {
    problems.push(`not a git repository: ${dir}`);
    return problems;
  }
  const head = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (!head.ok) {
    problems.push(`cannot resolve HEAD in ${dir}: ${head.err}`);
    return problems;
  }
  if (head.out !== expectedCommit) {
    problems.push(
      `HEAD ${head.out} != expected seamCommit ${expectedCommit} (${expectedRepo}) in ${dir}\n` +
        `  -> run: node scripts/bootstrap-pi-checkout.mjs --worktree <dir> to provision the accepted identity without touching your branches`,
    );
    return problems;
  }
  const tree = run("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]);
  if (!tree.ok) {
    problems.push(`cannot resolve tree in ${dir}: ${tree.err}`);
    return problems;
  }
  if (tree.out !== expectedTree) {
    problems.push(`HEAD tree ${tree.out} != expected seamTree ${expectedTree} in ${dir}`);
  }
  const remote = run("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (remote.ok && !remote.out.includes("github.com") && !remote.out.includes("github.com/")) {
    problems.push(`origin remote looks unexpected: ${remote.out}`);
  }
  return problems;
}

function provisionWorktree(worktreeDir, fetchUrl) {
  const parent = resolve(worktreeDir, "..");
  mkdirSync(parent, { recursive: true });
  if (!existsSync(worktreeDir)) {
    // Worktree needs a hosting repository; use a bare mirror beside it.
    const mirror = resolve(parent, `.pi-mirror-${process.pid}`);
    const clone = run("git", ["clone", "--mirror", fetchUrl, mirror]);
    if (!clone.ok) {
      throw new Error(`cannot mirror ${fetchUrl}: ${clone.err}`);
    }
    // A mirror clone fetches all remote refs; the accepted commit must be
    // reachable from one of them. If it is not, fetch it explicitly by SHA.
    const has = run("git", ["--git-dir", mirror, "cat-file", "-e", `${expectedCommit}^{commit}`]);
    if (!has.ok) {
      const fetch = run("git", ["--git-dir", mirror, "fetch", fetchUrl, expectedCommit]);
      if (!fetch.ok) {
        throw new Error(`cannot fetch ${expectedCommit} from ${fetchUrl}: ${fetch.err}`);
      }
    }
    const worktreeAdd = run("git", [
      "--git-dir",
      mirror,
      "worktree",
      "add",
      "--detach",
      worktreeDir,
      expectedCommit,
    ]);
    if (!worktreeAdd.ok) {
      throw new Error(`cannot create worktree at ${worktreeDir}: ${worktreeAdd.err}`);
    }
    console.log(`provisioned detached worktree ${worktreeDir} at ${expectedCommit}`);
    return;
  }
  // Existing dir: fetch the accepted commit if missing, then verify.
  if (isGitRepo(worktreeDir)) {
    const has = run("git", ["-C", worktreeDir, "cat-file", "-e", `${expectedCommit}^{commit}`]);
    if (!has.ok) {
      const fetch = run("git", ["-C", worktreeDir, "fetch", fetchUrl, expectedCommit]);
      if (!fetch.ok) {
        throw new Error(`cannot fetch ${expectedCommit} into ${worktreeDir}: ${fetch.err}`);
      }
    }
  } else {
    throw new Error(`existing path is not a git repository: ${worktreeDir}`);
  }
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const worktreeFlag = args.indexOf("--worktree");
const worktreeDir = worktreeFlag >= 0 ? args[worktreeFlag + 1] : undefined;
const fetchFlag = args.indexOf("--fetch");
const fetchUrl = fetchFlag >= 0 ? args[fetchFlag + 1] : DEFAULT_FETCH_URL;

let problems;
if (worktreeDir) {
  try {
    provisionWorktree(worktreeDir, fetchUrl);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
  problems = verifyCheckout(worktreeDir);
} else {
  problems = verifyCheckout(DEFAULT_PI_PATH);
}

if (problems.length === 0) {
  const target = worktreeDir ?? DEFAULT_PI_PATH;
  console.log(`OK: ${target} matches production lock (${expectedCommit} @ ${expectedTree})`);
  process.exit(0);
}
console.error("FAIL: adjacent Pi checkout does not match the production lock:");
for (const problem of problems) {
  console.error(`- ${problem}`);
}
process.exit(1);
