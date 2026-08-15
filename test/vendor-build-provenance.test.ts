/**
 * A6：vendor build provenance（iris_agent#131 + #132 A6）poisoned-cache 测试。
 *
 * 目标：受管 vendor 检出的**构建产物**必须与精确 pin（commit/tree）+
 * package-lock + build stamp + artifact manifest 绑定。任何 poisoned cache
 * 状态（正确 HEAD + 伪造旧 dist marker；正确 HEAD + 篡改 dist 文件；
 * commit 切换后遗留 dist；build stamp 与 package-lock 不匹配）都必须重建
 * 或 fail-closed，**绝不**继续使用旧 artifact。
 *
 * 直接单测 scripts/vendor-build-manifest.mjs（纯文件系统函数，不执行 npm）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStampValid,
  cleanVendorBuild,
  computeLockHash,
  readBuildStamp,
  verifyBuildStamp,
  writeBuildStamp,
} from "../scripts/vendor-build-manifest.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function tempVendor() {
  const dir = mkdtempSync(join(tmpdir(), "iris-vendor-provenance-"));
  mkdirSync(join(dir, "vendor"));
  mkdirSync(join(dir, "stamps"));
  return { root: dir, vendor: join(dir, "vendor"), stamps: join(dir, "stamps") };
}

const PIN = { repository: "fake/repo", commit: "a".repeat(40), tree: "b".repeat(40) };

function seedVendor(
  vendor: string,
  opts: { withLock?: boolean; withDist?: boolean; distFiles?: Record<string, string> } = {},
) {
  if (opts.withLock !== false) {
    writeFileSync(join(vendor, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  }
  if (opts.withDist) {
    mkdirSync(join(vendor, "dist", "src"), { recursive: true });
    const files = opts.distFiles ?? { "dist/src/index.js": "export const x = 1;" };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(vendor, rel.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(vendor, rel), content);
    }
  }
}

test("A6: correct HEAD + forged old dist marker (no stamp) → must rebuild / fail closed", () => {
  const { vendor, stamps } = tempVendor();
  try {
    // 伪造的旧 dist marker 存在（好像构建过），但没有任何 build stamp。
    seedVendor(vendor, { withDist: true });
    const check = buildStampValid("iris-context", vendor, PIN, stamps);
    assert.equal(check.valid, false, "missing build stamp must invalidate the build");
    assert.match(check.reason ?? "", /build stamp missing/);
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: correct HEAD + tampered dist file → artifact hash mismatch → invalid", () => {
  const { vendor, stamps } = tempVendor();
  try {
    seedVendor(vendor, { withDist: true });
    writeBuildStamp({ name: "iris-context", dir: vendor, pin: PIN, stampDir: stamps });
    // 篡改 dist 产物（构建后再修改）。
    writeFileSync(join(vendor, "dist", "src", "index.js"), "export const x = 2; // TAMPERED");
    const check = buildStampValid("iris-context", vendor, PIN, stamps);
    assert.equal(check.valid, false, "tampered artifact must invalidate the build");
    assert.match(check.reason ?? "", /do not match the stamp manifest/);
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: commit switch with leftover dist → stamp.commit != HEAD → invalid", () => {
  const { vendor, stamps } = tempVendor();
  try {
    seedVendor(vendor, { withDist: true });
    writeBuildStamp({ name: "iris-context", dir: vendor, pin: PIN, stampDir: stamps });
    // commit 切换：pin 变了，但旧 dist 遗留。
    const newPin = { ...PIN, commit: "c".repeat(40), tree: "d".repeat(40) };
    const check = buildStampValid("iris-context", vendor, newPin, stamps);
    assert.equal(check.valid, false, "commit switch must invalidate the old build");
    assert.match(check.reason ?? "", /stamp commit/);
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: build stamp with package-lock mismatch → invalid", () => {
  const { vendor, stamps } = tempVendor();
  try {
    seedVendor(vendor, { withDist: true });
    writeBuildStamp({ name: "iris-context", dir: vendor, pin: PIN, stampDir: stamps });
    // package-lock 内容变化（依赖漂移）→ lockHash 不匹配。
    writeFileSync(
      join(vendor, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, drifted: true }),
    );
    const check = buildStampValid("iris-context", vendor, PIN, stamps);
    assert.equal(check.valid, false, "package-lock drift must invalidate the build");
    assert.match(check.reason ?? "", /lockHash/);
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: valid stamp round-trips and --check passes (verifyBuildStamp)", () => {
  const { vendor, stamps } = tempVendor();
  try {
    seedVendor(vendor, { withDist: true });
    writeBuildStamp({ name: "iris-context", dir: vendor, pin: PIN, stampDir: stamps });
    const stamp = readBuildStamp("iris-context", stamps);
    assert.ok(stamp !== undefined);
    assert.equal(stamp.commit, PIN.commit);
    assert.equal(stamp.tree, PIN.tree);
    assert.equal(stamp.lockHash, computeLockHash(vendor));
    assert.ok(stamp.node.startsWith("v"), "stamp records Node version");
    assert.deepEqual(verifyBuildStamp("iris-context", vendor, PIN, stamps), [], "stamp valid");
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: cleanVendorBuild only removes dist/node_modules/build stamp inside the managed dir", () => {
  const { vendor, stamps } = tempVendor();
  try {
    seedVendor(vendor, { withDist: true, distFiles: { "dist/a.js": "1", "dist/b.js": "2" } });
    mkdirSync(join(vendor, "node_modules"), { recursive: true });
    writeFileSync(join(vendor, "node_modules", "x"), "1");
    writeFileSync(join(vendor, "package-lock.json"), "{}");
    writeBuildStamp({ name: "iris-context", dir: vendor, pin: PIN, stampDir: stamps });
    cleanVendorBuild(vendor, "iris-context", stamps);
    // dist / node_modules / stamp 被清。
    assert.ok(!existsSync(join(vendor, "dist")));
    assert.ok(!existsSync(join(vendor, "node_modules")));
    assert.ok(!existsSync(join(stamps, "iris-context.build-stamp.json")));
    // 仓库内源文件（package-lock.json）保留。
    assert.ok(existsSync(join(vendor, "package-lock.json")));
  } finally {
    rmSync(resolve(vendor, ".."), { recursive: true, force: true });
  }
});

test("A6: bootstrap --check fails closed when build stamps are missing (env-injected temp root)", () => {
  const { root, vendor, stamps } = tempVendor();
  try {
    // 两个 fake vendor git 检出（HEAD/tree 与 pin 一致），但**没有** build stamp。
    const fakeGit = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const tree = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }).trim();
      return { head, tree };
    };
    const pi = fakeGit(join(vendor, "pi"));
    const ictx = fakeGit(join(vendor, "iris-context"));
    // 生成一个与 fake vendor HEAD 一致的 pin 文件。
    const pinPath = join(root, "production-lock.json");
    const pin = {
      pi: { fork: { repository: "fake/pi", seamCommit: pi.head, seamTree: pi.tree } },
      irisContext: { repository: "fake/iris-context", commit: ictx.head, tree: ictx.tree },
    };
    writeFileSync(pinPath, JSON.stringify(pin, null, 2));

    // --check 必须失败：source pin 一致但 build stamp 缺失（A6：不只 Git HEAD）。
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [resolve(REPO_ROOT, "scripts", "bootstrap-vendor-deps.mjs"), "--check"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              IRIS_VENDOR_ROOT: vendor,
              IRIS_VENDOR_PIN_PATH: pinPath,
              IRIS_VENDOR_STAMP_DIR: stamps,
            },
          },
        ),
      /build stamp missing|do not match|stamp/,
      "--check must fail closed when build stamps are missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A6: bootstrap --check passes only when stamps are valid (env-injected temp root)", () => {
  const { root, vendor, stamps } = tempVendor();
  try {
    const fakeGit = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const tree = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }).trim();
      return { head, tree };
    };
    const pi = fakeGit(join(vendor, "pi"));
    const ictx = fakeGit(join(vendor, "iris-context"));
    const pinPath = join(root, "production-lock.json");
    const pin = {
      pi: { fork: { repository: "fake/pi", seamCommit: pi.head, seamTree: pi.tree } },
      irisContext: { repository: "fake/iris-context", commit: ictx.head, tree: ictx.tree },
    };
    writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    // 写有效 build stamp（带 dist artifact manifest）。
    mkdirSync(join(vendor, "pi", "dist"), { recursive: true });
    writeFileSync(join(vendor, "pi", "dist", "index.js"), "1");
    writeBuildStamp({
      name: "pi",
      dir: join(vendor, "pi"),
      pin: { repository: pin.pi.fork.repository, commit: pi.head, tree: pi.tree },
      stampDir: stamps,
    });
    mkdirSync(join(vendor, "iris-context", "dist", "src"), { recursive: true });
    writeFileSync(join(vendor, "iris-context", "dist", "src", "index.js"), "1");
    writeBuildStamp({
      name: "iris-context",
      dir: join(vendor, "iris-context"),
      pin: { repository: pin.irisContext.repository, commit: ictx.head, tree: ictx.tree },
      stampDir: stamps,
    });
    const out = execFileSync(
      process.execPath,
      [resolve(REPO_ROOT, "scripts", "bootstrap-vendor-deps.mjs"), "--check"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          IRIS_VENDOR_ROOT: vendor,
          IRIS_VENDOR_PIN_PATH: pinPath,
          IRIS_VENDOR_STAMP_DIR: stamps,
        },
      },
    );
    assert.match(out, /build stamps OK/, "--check must pass with valid stamps");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
