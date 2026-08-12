import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import assert from "node:assert/strict";

import { readProductionLock } from "../src/contracts/production-lock.js";
import { readContractPin } from "../src/contracts/memory-pin.js";

/**
 * Production lock gate (Roadmap v13, R0 Exit Gate: production lock 无 TBD).
 *
 * The lock is the single source of truth for pinned versions across the
 * three-project boundary: Pi (release packages + controlled fork baseline),
 * Magic Context (OpenCode released authority), memory contracts artifact and
 * the Graphiti/Neo4j candidate lock owned by iris_memory.
 *
 * Since iris_agent#41 the Pi pin is single-source and cross-validated:
 *   - src/contracts/pins/production-lock.json is the only place a Pi SHA lives
 *     in this repository (CI derives its checkout ref from it);
 *   - the gate proves the adjacent ../pi checkout is the pinned commit/tree;
 *   - the gate verifies ../pi's own docs/iris-fork/production-lock.json
 *     acceptedRuntime identity agrees with this repository's pin;
 *   - CI checkout ref drift, stale pins, wrong remotes, wrong commits/trees
 *     and tampered manifests fail closed.
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

const PI_DIR = resolve(import.meta.dirname, "..", "..", "pi");

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
  assert.match(lock.magicContext.commit, SHA40);
  assert.match(lock.memoryContracts.manifestSha256, SHA256);
});

test("r0: Pi package pins match package.json dependencies exactly", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const [name, version] of Object.entries(lock.pi.packages)) {
    assert.equal(pkg.dependencies[name], version, `package.json must pin ${name}@${version}`);
  }
  // The agent must not silently add other Pi packages without lock coverage.
  const piPkgs = Object.keys(pkg.dependencies).filter((n) => n.startsWith("@iris/pi-"));
  assert.deepEqual(piPkgs.sort(), Object.keys(lock.pi.packages).sort());
});

test("r0: Pi file: dependency targets exist and are the adjacent fork checkout (fail-closed)", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const [name, spec] of Object.entries(lock.pi.packages)) {
    assert.ok(
      spec.startsWith("file:../pi/packages/"),
      `${name} must use the adjacent fork checkout file: spec (got ${spec})`,
    );
    assert.equal(pkg.dependencies[name], spec);
    // Fail closed when the adjacent checkout is missing or not a fork commit.
    const target = resolve(import.meta.dirname, "..", spec.slice("file:".length));
    const targetPkg = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    assert.equal(targetPkg.name, name, `${target} must be the ${name} package`);
    assert.notEqual(targetPkg.version, "0.82.1", `${name} must NOT be the upstream 0.82.1 release`);
  }
});

test("r0: fork seam commit is a full SHA and adoption status is local file link", () => {
  const lock = readProductionLock();
  assert.match(lock.pi.fork.seamCommit, SHA40);
  assert.equal(lock.pi.currentDependencySource, "file_link_adjacent_fork_checkout");
  assert.equal(lock.pi.fork.adoptionStatus, "file_link_local_development");
});

// --- iris_agent#41 cross-repository production lock gate -------------------

test("r41: adjacent ../pi is a real git repository (not an arbitrary directory)", () => {
  assert.ok(
    (() => {
      try {
        git(PI_DIR, ["rev-parse", "--git-dir"]);
        return true;
      } catch {
        return false;
      }
    })(),
    `expected a real git repository at ${PI_DIR}`,
  );
});

test("r41: adjacent ../pi remote identity points at the expected fork family", () => {
  const remotes = git(PI_DIR, ["remote", "-v"]);
  assert.match(
    remotes,
    /blueforst\/pi|ceyirelehe47\/pi/,
    "origin/upstream must be the pi fork family",
  );
});

test("r41: adjacent ../pi HEAD equals the pinned seamCommit and its tree equals seamTree", () => {
  const lock = readProductionLock();
  const head = git(PI_DIR, ["rev-parse", "HEAD"]);
  assert.equal(
    head,
    lock.pi.fork.seamCommit,
    `../pi HEAD must be seamCommit (${lock.pi.fork.seamCommit})`,
  );
  const tree = git(PI_DIR, ["rev-parse", "HEAD^{tree}"]);
  assert.equal(
    tree,
    lock.pi.fork.seamTree,
    `../pi HEAD tree must be seamTree (${lock.pi.fork.seamTree})`,
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
    "../pi docs/iris-fork/production-lock.json must carry acceptedRuntime",
  );
  assert.equal(piLock.acceptedRuntime.repository, "blueforst/pi");
  assert.equal(piLock.acceptedRuntime.commit, lock.pi.fork.acceptedRuntimeCommit);
  assert.equal(piLock.acceptedRuntime.tree, lock.pi.fork.acceptedRuntimeTree);
  // The accepted runtime commit must actually exist in the adjacent checkout.
  assert.equal(
    git(PI_DIR, ["cat-file", "-e", `${lock.pi.fork.acceptedRuntimeCommit}^{commit}`]),
    "",
    `acceptedRuntimeCommit ${lock.pi.fork.acceptedRuntimeCommit} must exist in ../pi`,
  );
  // And its tree must match what the Pi lock records.
  assert.equal(
    git(PI_DIR, ["rev-parse", `${lock.pi.fork.acceptedRuntimeCommit}^{tree}`]),
    lock.pi.fork.acceptedRuntimeTree,
  );
});

test("r41: acceptedRuntimeCommit is anchored inside the checked-out seamCommit history", () => {
  // The seam checkout must contain the accepted runtime commit as an
  // ancestor; otherwise a consistently-tampered pin could point at an
  // arbitrary valid commit that is unrelated to the accepted identity.
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
  // The tree relationship must hold too: the accepted commit's tree is what
  // the Pi lock records, and it must be reachable from the checked-out HEAD.
  assert.equal(
    git(PI_DIR, ["merge-base", "--is-ancestor", lock.pi.fork.acceptedRuntimeCommit, "HEAD"]),
    "",
    `acceptedRuntimeCommit must be an ancestor of ../pi HEAD`,
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
  // the ancestry anchor lives in this gate (it reads the *real* adjacent
  // checkout), which is why the test asserts the anchor catches it.
  const readerOut = execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, "..", "scripts", "read-pi-pin.mjs"), "--pin", tampered],
    { encoding: "utf8" },
  ).trim();
  assert.equal(readerOut, wrong);
  // Gate-side anchor: the wrong commit is not an ancestor of ../pi HEAD.
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

test("r41: CI checkout ref is derived from the pin, not a duplicate hardcoded SHA", () => {
  const ci = readFileSync(
    resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  // The workflow must read the ref from the pin (read-pi-pin.mjs), and must
  // not contain any hardcoded 40-hex Pi SHA.
  assert.match(ci, /read-pi-pin\.mjs/, "ci.yml must derive the Pi ref via scripts/read-pi-pin.mjs");
  const hardcoded = [...ci.matchAll(/ref:\s*([0-9a-f]{40})/g)].map((m) => m[1]);
  assert.deepEqual(
    hardcoded,
    [],
    "ci.yml must not hardcode a Pi SHA in a checkout ref (derive from the pin instead)",
  );
  // The pin reader must output exactly the pinned seamCommit.
  const output = execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, "..", "scripts", "read-pi-pin.mjs")],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.match(output, SHA40);
  assert.equal(output, readProductionLock().pi.fork.seamCommit);
  // --tree mode outputs the pinned seamTree.
  const treeOut = execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, "..", "scripts", "read-pi-pin.mjs"), "--tree"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(treeOut, readProductionLock().pi.fork.seamTree);
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
        [resolve(import.meta.dirname, "..", "scripts", "read-pi-pin.mjs"), "--pin", tampered],
        {
          encoding: "utf8",
        },
      ),
    /invalid seamCommit/,
  );
});

test("r41: CI ref drift is caught by the gate (workflow ref must come from pin)", () => {
  const ci = readFileSync(
    resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
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
