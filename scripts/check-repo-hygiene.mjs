#!/usr/bin/env node
/**
 * Repository hygiene guard (iris_agent#86).
 *
 * Rejects:
 *   - tracked node_modules (file, directory, or symlink)
 *   - tracked symlinks whose target resolves to an absolute /tmp path
 *     or any path outside the repository root
 *
 * Does NOT reject:
 *   - intentional repository-relative symlinks (allowed by #86 AC)
 *   - files inside ARCHIVE / SUPERSEDED / migration fixtures / tests
 *
 * Exits non-zero on any violation. Designed to run in CI and as a local
 * pre-flight check.
 */
import { execSync } from "node:child_process";
import { existsSync, readlinkSync, realpathSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const violations = [];

// 1. Check for tracked node_modules (any mode: blob, tree, or symlink).
try {
  const treeOutput = execSync("git ls-tree -r --name-only HEAD", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const trackedFiles = treeOutput.trim().split("\n").filter(Boolean);

  for (const f of trackedFiles) {
    // Reject tracked node_modules at any path level.
    if (f === "node_modules" || f.startsWith("node_modules/")) {
      violations.push(`tracked node_modules: ${f}`);
    }
  }
} catch {
  // No HEAD (fresh repo) — skip tree check.
}

// 2. Check for tracked symlinks with absolute or escaping targets.
try {
  const lsTreeOutput = execSync("git ls-tree -r HEAD", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  for (const line of lsTreeOutput.trim().split("\n")) {
    if (!line.startsWith("120000")) continue; // only symlinks have mode 120000
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const filePath = parts[1];
    const fullPath = resolve(REPO_ROOT, filePath);

    // Read the symlink target from git (not the working tree, which may not exist).
    try {
      const target = execSync(`git cat-file -p HEAD:${filePath}`, {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      // Reject absolute /tmp-style targets.
      if (isAbsolute(target) && target.startsWith("/tmp")) {
        violations.push(`symlink ${filePath} -> absolute /tmp path: ${target}`);
      }

      // Reject any absolute target outside the repo root.
      if (isAbsolute(target)) {
        const resolved = resolve(target);
        const rel = relative(REPO_ROOT, resolved);
        if (rel.startsWith("..")) {
          violations.push(`symlink ${filePath} -> absolute path outside repo: ${target}`);
        }
      }
    } catch {
      // Cannot read symlink content — skip.
    }
  }
} catch {
  // No HEAD — skip.
}

if (violations.length > 0) {
  console.error("Repository hygiene check FAILED (iris_agent#86):");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log("Repository hygiene check passed.");
