import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import assert from "node:assert/strict";

import { readProductionLock } from "../src/contracts/production-lock.js";
import { readContractPin } from "../src/contracts/memory-pin.js";

/**
 * Production lock gate (Roadmap v13, R0 Exit Gate: production lock 无 TBD;
 * iris_agent#131 clean-checkout).
 *
 * The lock is the single source of truth for pinned versions across the
 * three-project boundary: @iris/context (exact commit/tree), Pi (release
 * packages + controlled fork baseline), Magic Context (OpenCode released
 * authority), memory contracts artifact and the Graphiti/Neo4j candidate lock
 * owned by iris_memory.
 *
 * Since iris_agent#131 the cross-repo deps are consumed through an exact
 * commit/tree pin materialized by scripts/bootstrap-vendor-deps.mjs into the
 * sibling managed cache `<repo>/../.iris-vendor` (preinstall). The gate:
 *   - proves package.json deps match the lock pins;
 *   - proves the materialized vendor checkouts are the pinned commit/tree
 *     (via scripts/bootstrap-vendor-deps.mjs --check — fail closed on drift);
 *   - proves the accepted Pi runtime identity is anchored in the vendored
 *     seam history;
 *   - proves CI derives the vendor provisioning from the pin (bootstrap
 *     script), not from a hardcoded SHA or a nonexistent `blueforst/pi`.
 */

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /\b(TBD|TODO|unknown)\b/i;

function walkStrings(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(`${path}=${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkStrings(v, `${path}[${i}]`, out);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, `${path}.${k}`, out);
    }
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PI_DIR = resolve(REPO_ROOT, "..", ".iris-vendor", "pi");
const IRIS_CONTEXT_DIR = resolve(REPO_ROOT, "..", ".iris-vendor", "iris-context");
const BOOTSTRAP = resolve(REPO_ROOT, "scripts", "bootstrap-vendor-deps.mjs");

test("r0: production lock schemaVersion is 2 and documented", () => {
  const lock = readProductionLock();
  assert.equal(lock.schemaVersion, 2);
  assert.match(lock.documentedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("r0: production lock contains no TBD/TODO/unknown placeholder", () => {
  const lock = readProductionLock();
  const strings: string[] = [];
  walkStrings(lock, "lock", strings);
  const offenders = strings.filter((s) => PLACEHOLDER.test(s));
  assert.deepEqual(offenders, [], "production lock must not contain unset placeholders");
});

test("r0: all pinned SHAs are full-length hex", () => {
  const lock = readProductionLock();
  assert.match(lock.pi.fork.baselineCommit, SHA40);
  assert.match(lock.pi.fork.seamCommit, SHA40);
  assert.match(lock.pi.fork.seamTree, SHA40);
  assert.match(lock.pi.fork.acceptedRuntimeCommit, SHA40);
  assert.match(lock.pi.fork.acceptedRuntimeTree, SHA40);
  assert.match(lock.pi.fork.upstreamBaseCommit, SHA40);
  assert.match(lock.pi.fork.upstreamAuditBaselineCommit, SHA40);
  assert.match(lock.irisContext.commit, SHA40);
  assert.match(lock.irisContext.tree, SHA40);
  assert.match(lock.magicContext.commit, SHA40);
  assert.match(lock.memoryContracts.manifestSha256, SHA256);
});

// --- iris_agent#131: @iris/context exact pin ---------------------------------

test("r131: @iris/context pin matches package.json dependency", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(lock.irisContext.package, "@iris/context");
  assert.equal(
    pkg.dependencies["@iris/context"],
    `file:${lock.irisContext.vendorPath}`,
    "package.json must consume @iris/context through the exact-pinned vendored path",
  );
});

test("r131: DSH runtime packages are exact-pinned and match package.json", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries(lock.dshRuntime.packages)) {
    assert.equal(
      pkg.dependencies[name],
      version,
      `package.json must pin DSH runtime ${name}@${version} (no floating latest)`,
    );
    assert.match(version, /^0\.1\.0-rc\.6$/, `${name} must be the exact pinned DSH release`);
  }
  assert.equal(lock.dshRuntime.upstream.repository, "deepseek-ai/deepseek-harness");
  assert.equal(lock.dshRuntime.upstream.release, "0.1.0-rc.6");
  // The real DSH ingress adapter must exist and consume the pinned packages.
  assert.ok(
    readFileSync(resolve(REPO_ROOT, "src", "runtime", "dsh-adapter.ts"), "utf8").includes(
      "@deepseek-ai/dsh-session",
    ),
    "src/runtime/dsh-adapter.ts must consume the pinned DSH session package",
  );
});

test("r131: Pi package pins match package.json dependencies exactly", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries(lock.pi.packages)) {
    assert.equal(pkg.dependencies[name], version, `package.json must pin ${name}@${version}`);
  }
  // The agent must not silently add other Pi packages without lock coverage.
  const piPkgs = Object.keys(pkg.dependencies).filter((n) => n.startsWith("@iris/pi-"));
  assert.deepEqual(piPkgs.sort(), Object.keys(lock.pi.packages).sort());
});

test("r131: cross-repo deps point into the managed .iris-vendor cache, not a project checkout", () => {
  const lock = readProductionLock();
  for (const [name, spec] of Object.entries(lock.pi.packages)) {
    assert.ok(
      spec.startsWith("file:../.iris-vendor/"),
      `${name} must use the bootstrap-managed vendored spec (got ${spec})`,
    );
  }
  assert.ok(
    lock.irisContext.vendorPath.startsWith("../.iris-vendor/"),
    "@iris/context must use the bootstrap-managed vendored path",
  );
  // The regression the issue guards against: no `file:../iris-context` and no
  // `file:../pi` (project sibling checkouts).
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.notEqual(pkg.dependencies["@iris/context"], "file:../iris-context");
  assert.ok(
    !Object.values(pkg.dependencies).some(
      (s) =>
        s === "file:../pi/packages/agent" ||
        s === "file:../pi/packages/ai" ||
        s === "file:../pi/packages/storage/sqlite-node",
    ),
  );
});

test("r131: vendored checkouts match the exact pinned commit/tree (bootstrap --check)", () => {
  // The bootstrap --check verifies BOTH vendor dirs (commit + tree) and exits
  // non-zero on any drift — this is the machine-verifiable exact pin gate.
  execFileSync(process.execPath, [BOOTSTRAP, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const lock = readProductionLock();
  // Direct git identity too (belt and braces).
  assert.equal(git(PI_DIR, ["rev-parse", "HEAD"]), lock.pi.fork.seamCommit);
  assert.equal(git(PI_DIR, ["rev-parse", "HEAD^{tree}"]), lock.pi.fork.seamTree);
  assert.equal(git(IRIS_CONTEXT_DIR, ["rev-parse", "HEAD"]), lock.irisContext.commit);
  assert.equal(git(IRIS_CONTEXT_DIR, ["rev-parse", "HEAD^{tree}"]), lock.irisContext.tree);
});

test("r131: fork seam commit is a full SHA and adoption status is the vendored exact pin", () => {
  const lock = readProductionLock();
  assert.match(lock.pi.fork.seamCommit, SHA40);
  assert.equal(lock.pi.currentDependencySource, "vendored_exact_git_pin");
  assert.equal(lock.pi.fork.adoptionStatus, "vendored_exact_git_pin");
  // The pinned Pi repository must be the real accessible fork (blueforst/pi
  // does not exist on GitHub — this was the #131 checkout failure).
  assert.ok(
    lock.pi.fork.repository === "ceyirelehe47/pi",
    "pi.fork.repository must be the real accessible fork",
  );
});

// --- iris_agent#41 cross-repository production lock gate (vendor layout) -----

test("r41: vendored ../.iris-vendor/pi is a real git repository (not an arbitrary directory)", () => {
  assert.ok(
    (() => {
      try {
        git(PI_DIR, ["rev-parse", "--git-dir"]);
        return true;
      } catch {
        return false;
      }
    })(),
    `expected a real git repository at ${PI_DIR} (run \`npm ci\` / bootstrap-vendor-deps.mjs)`,
  );
});

test("r41: vendored ../.iris-vendor/pi HEAD equals the pinned seamCommit and its tree equals seamTree", () => {
  const lock = readProductionLock();
  const head = git(PI_DIR, ["rev-parse", "HEAD"]);
  assert.equal(
    head,
    lock.pi.fork.seamCommit,
    `vendored pi HEAD must be seamCommit (${lock.pi.fork.seamCommit})`,
  );
  const tree = git(PI_DIR, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(
    tree,
    lock.pi.fork.seamTree,
    `vendored pi HEAD tree must be seamTree (${lock.pi.fork.seamTree})`,
  );
});

test("r41: Pi authoritative lock acceptedRuntime agrees with this repository pin", () => {
  const lock = readProductionLock();
  const piLock = JSON.parse(
    readFileSync(resolve(PI_DIR, "docs", "iris-fork", "production-lock.json"), "utf8"),
  ) as {
    acceptedRuntime?: {
      repository: string;
      commit: string;
      tree: string;
    };
  };
  assert.ok(
    piLock.acceptedRuntime,
    "vendored pi docs/iris-fork/production-lock.json must carry acceptedRuntime",
  );
  assert.equal(piLock.acceptedRuntime.repository, "blueforst/pi");
  assert.equal(piLock.acceptedRuntime.commit, lock.pi.fork.acceptedRuntimeCommit);
  assert.equal(piLock.acceptedRuntime.tree, lock.pi.fork.acceptedRuntimeTree);
  // The accepted runtime commit must actually exist in the vendored checkout.
  assert.equal(
    git(PI_DIR, ["cat-file", "-e", `${lock.pi.fork.acceptedRuntimeCommit}^{commit}`]),
    "",
    `acceptedRuntimeCommit ${lock.pi.fork.acceptedRuntimeCommit} must exist in the vendored pi`,
  );
  // And its tree must match what the Pi lock records.
  assert.equal(
    git(PI_DIR, ["rev-parse", `${lock.pi.fork.acceptedRuntimeCommit}^{tree}`]),
    lock.pi.fork.acceptedRuntimeTree,
  );
});

test("r41: acceptedRuntimeCommit is anchored inside the vendored seamCommit history", () => {
  const lock = readProductionLock();
  assert.equal(
    git(PI_DIR, [
      "merge-base",
      "--is-ancestor",
      lock.pi.fork.acceptedRuntimeCommit,
      lock.pi.fork.seamCommit,
    ]),
    "",
    `acceptedRuntimeCommit ${lock.pi.fork.acceptedRuntimeCommit} must be an ancestor of seamCommit ${lock.pi.fork.seamCommit}`,
  );
  assert.equal(
    git(PI_DIR, ["merge-base", "--is-ancestor", lock.pi.fork.acceptedRuntimeCommit, "HEAD"]),
    "",
    `acceptedRuntimeCommit must be an ancestor of the vendored pi HEAD`,
  );
});

test("r41: a consistent but wrong pin (valid hex, unrelated identity) is rejected", () => {
  // Tamper the pin with a *valid* 40-hex commit that is NOT an ancestor of
  // the real accepted commit: every SHA-shape check passes, only the ancestry
  // anchor catches it. This proves the gate is fail-closed against consistent
  // tampering, not just malformed SHAs.
  const dir = mkdtempSync(join(tmpdir(), "iris-pin-swap-"));
  const tampered = join(dir, "production-lock.json");
  const lock = readProductionLock();
  const wrong = "f".repeat(40); // valid shape, not an ancestor of anything real
  const swapped = JSON.parse(JSON.stringify(lock)) as typeof lock;
  swapped.pi.fork.seamCommit = wrong;
  swapped.pi.fork.seamTree = wrong;
  writeFileSync(tampered, JSON.stringify(swapped, null, 2));
  // The pin reader itself only validates shape, so it would accept the swap;
  // the ancestry anchor lives in this gate (it reads the *real* vendored
  // checkout), which is why the test asserts the anchor catches it.
  const readerOut = execFileSync(
    process.execPath,
    [resolve(REPO_ROOT, "scripts", "read-pi-pin.mjs"), "--pin", tampered],
    { encoding: "utf8" },
  ).trim();
  assert.equal(readerOut, wrong);
  // Gate-side anchor: the wrong commit is not an ancestor of the vendored pi HEAD.
  const head = git(PI_DIR, ["rev-parse", "HEAD"]);
  assert.notEqual(head, wrong);
  const anchor = (() => {
    try {
      git(PI_DIR, ["merge-base", "--is-ancestor", wrong, head]);
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(anchor, false, "wrong valid-hex commit must fail the ancestry anchor");
});

test("r41: CI derives vendor provisioning from the pin, not a duplicate hardcoded SHA", () => {
  const ci = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // The workflow must rely on the pin-driven bootstrap (preinstall), and must
  // not check out a nonexistent blueforst/pi or hardcode a Pi SHA.
  assert.match(
    ci,
    /bootstrap-vendor-deps\.mjs|npm ci/,
    "ci.yml must rely on the pin-driven vendor bootstrap (npm ci preinstall)",
  );
  const hardcoded = [...ci.matchAll(/ref:\s*([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.deepEqual(
    hardcoded,
    [],
    "ci.yml must not hardcode a Pi SHA in a checkout ref (derive from the pin instead)",
  );
  assert.doesNotMatch(
    ci,
    /repository:\s*blueforst\/pi/,
    "ci.yml must not check out the nonexistent blueforst/pi repository",
  );
  // The pin reader must output exactly the pinned seamCommit.
  const output = execFileSync(
    process.execPath,
    [resolve(REPO_ROOT, "scripts", "read-pi-pin.mjs")],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.match(output, SHA40);
  assert.equal(output, readProductionLock().pi.fork.seamCommit);
});

// --- failure modes (fail-closed) -------------------------------------------

test("r41: a tampered seamCommit fails the pin reader (fail-closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-pin-tamper-"));
  const tampered = join(dir, "production-lock.json");
  const lock = readProductionLock();
  const original = lock.pi.fork.seamCommit;
  writeFileSync(tampered, JSON.stringify(lock).replace(original, "not-a-sha"));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [resolve(REPO_ROOT, "scripts", "read-pi-pin.mjs"), "--pin", tampered],
        {
          encoding: "utf8",
        },
      ),
    /invalid seamCommit/,
  );
});

test("r41: CI ref drift is caught by the gate (workflow ref must come from pin)", () => {
  const ci = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // A future edit that reintroduces a literal SHA as checkout ref fails here.
  assert.doesNotMatch(
    ci,
    /ref:\s*[0-9a-f]{40}/,
    "CI must derive the Pi ref from the pin, not hardcode it",
  );
});

test("r0: memory contract pin and production lock agree on the artifact", () => {
  const lock = readProductionLock();
  const pin = readContractPin();
  assert.equal(lock.memoryContracts.package, pin.package);
  assert.equal(lock.memoryContracts.version, pin.version);
  assert.equal(lock.memoryContracts.manifestSha256, pin.manifestSha256);
  assert.equal(lock.memoryContracts.owner, pin.owner);
});

test("r0: agent has no direct Graphiti/Neo4j dependency", () => {
  const lock = readProductionLock();
  assert.equal(lock.graphitiNeo4j.agentDirectDependency, false);
  assert.equal(lock.graphitiNeo4j.owner, "blueforst/iris_memory");
});

test("r0: toolchain lock is npm with package-lock.json and Node 22.19+", () => {
  const lock = readProductionLock();
  assert.equal(lock.toolchain.packageManager, "npm");
  assert.equal(lock.toolchain.lockfile, "package-lock.json");
  assert.equal(lock.toolchain.nodeCiExact, "22.19.0");
});

test("r0: Magic Context authority is the released OpenCode implementation", () => {
  const lock = readProductionLock();
  assert.equal(lock.magicContext.repository, "cortexkit/magic-context");
  assert.equal(lock.magicContext.release, "v0.33.0");
  assert.ok(lock.magicContext.authoritativePath.includes("magic-context"));
  assert.ok(lock.magicContext.explicitlyNotAdopted.includes("experimental.memory_mural"));
});
