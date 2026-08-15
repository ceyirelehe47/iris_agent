/**
 * iris_agent#131：clean-layout sensitivity gate。
 *
 * 证明：
 *  - 当前 package.json / package-lock.json 没有 unmanaged required sibling
 *    file 依赖（`file:../...`）；跨仓库依赖（@iris/context、@iris/pi-*）是
 *    `file:../.iris-vendor/...` —— 由 preinstall（bootstrap-vendor-deps.mjs）
 *    按 production-lock 的精确 commit/tree pin 物化的受管缓存，fresh checkout
 *    可自洽；
 *  - 重新引入 `file:../iris-context` 这类 unmanaged sibling file 依赖会使
 *    clean-layout 门失败（sensitivity：门有牙齿）。
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const LOCK_PATH = path.join(REPO_ROOT, "package-lock.json");
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-clean-layout.mjs");

test("F3: package.json carries no unmanaged required sibling file dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allSpecs = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const offenders = Object.entries(allSpecs)
    .filter(
      ([, spec]) =>
        typeof spec === "string" &&
        spec.startsWith("file:../") &&
        !spec.startsWith("file:../.iris-vendor/"),
    )
    .map(([name, spec]) => `${name}=${spec}`);
  assert.deepEqual(
    offenders,
    [],
    "package.json must not depend on unmanaged sibling file paths (file:../…) — " +
      "only the bootstrap-managed file:../.iris-vendor/ cache is allowed",
  );
});

test("F3: cross-repo deps use the exact-pinned managed cache layout", () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(deps["@iris/context"], "file:../.iris-vendor/iris-context");
  assert.equal(deps["@iris/pi-agent-core"], "file:../.iris-vendor/pi/packages/agent");
  assert.equal(deps["@iris/pi-ai"], "file:../.iris-vendor/pi/packages/ai");
  assert.equal(
    deps["@iris/pi-storage-sqlite-node"],
    "file:../.iris-vendor/pi/packages/storage/sqlite-node",
  );
});

test("F3: package-lock.json carries no unmanaged sibling path", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as unknown;
  const offenders: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("file:../") && !value.startsWith("file:../.iris-vendor/")) {
        offenders.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const member of Object.values(value as Record<string, unknown>)) {
        walk(member);
      }
    }
  };
  walk(lock);
  assert.deepEqual(offenders, [], "package-lock.json must not carry unmanaged file:../ paths");
});

test("F3 sensitivity: reintroducing a required sibling file dependency fails the gate", () => {
  // 构造一个 regressed package.json（@iris/context 回到 file:../iris-context），
  // 让 check-clean-layout.mjs 读取它 —— 必须失败。
  const tmpPkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  tmpPkg.dependencies = { ...(tmpPkg.dependencies ?? {}), "@iris/context": "file:../iris-context" };
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "iris-clean-layout-"));
  const regressedPkg = path.join(tmpDir, "package.json");
  const regressedLock = path.join(tmpDir, "package-lock.json");
  fs.writeFileSync(regressedPkg, JSON.stringify(tmpPkg, null, 2));
  // 空 lockfile（不含 file:../ 路径）—— 只有 package.json 回归；门必须仍失败。
  fs.writeFileSync(regressedLock, JSON.stringify({ name: "x", lockfileVersion: 3 }, null, 2));

  let failed = false;
  let output = "";
  try {
    output = execFileSync(
      process.execPath,
      [GATE_SCRIPT, "--package", regressedPkg, "--lockfile", regressedLock],
      { encoding: "utf8" },
    ).toString();
  } catch (error) {
    failed = true;
    output =
      String((error as { stdout?: Buffer }).stdout ?? "") +
      String((error as { stderr?: Buffer }).stderr ?? "");
  }
  assert.equal(
    failed,
    true,
    "check-clean-layout must fail when a required sibling file dependency is reintroduced",
  );
  assert.match(
    output,
    /file:\.\.\/iris-context/,
    "the gate must name the offending sibling file spec",
  );
});
