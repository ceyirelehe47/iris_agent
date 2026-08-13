#!/usr/bin/env node
/**
 * Codegen freshness gate: verifies contracts/generated/ is up-to-date.
 * Runs codegen and checks if any files changed. Fails if stale.
 */
import { execSync } from "node:child_process";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

try {
  execSync("node scripts/codegen.mjs", { cwd: REPO_ROOT, stdio: "pipe" });
  execSync("git diff --exit-code -- contracts/generated/", {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  console.log("Generated artifacts are fresh");
  process.exit(0);
} catch (error) {
  if (error.status === 1) {
    console.error("Generated artifacts are STALE. Run: node scripts/codegen.mjs");
    process.exit(1);
  }
  console.error("Codegen failed:", error.message);
  process.exit(1);
}
