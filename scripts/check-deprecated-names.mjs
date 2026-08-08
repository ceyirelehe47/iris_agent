#!/usr/bin/env node
/**
 * iris_agent#87 / Roadmap v27: deprecated-name CI gate.
 *
 * Fails CI if production/current code or contracts contain names that v27
 * explicitly prohibits. Historical docs, migration fixtures, explicit
 * negative tests and upstream-only references are exempt.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEPRECATED_NAMES = [
  "ContextSourceSnapshot",
  "PreparedContextSources",
  "ContextMaterializationState",
  "ContextMaterializationSignalPort",
  "prepareInvocationSources",
  "transformMessages",
  "ContextTransformResult",
  "HistoryProjectionUnit",
  "HistoryExchangeUnit",
  "IrisContextState",
  "ProviderContextProjection",
  "ContinuitySnapshotResult",
  "ContextUnitLifecycleState",
  "sourceContextUnitIds",
  "HistoryEntryKind",
  "HistoryPayload",
];

const EXEMPT_PATH_PATTERNS = [
  /node_modules\//,
  /dist\//,
  /\.git\//,
  /scripts\/check-deprecated-names\.mjs$/,
  /src\/db\/migrations\//,
  /ARCHIVE/i,
  /SUPERSEDED/i,
  /design.evolution/i,
  /upstream/i,
  // iris_memory contract artifacts are pinned fixtures — immutable historical
  // records owned by the memory-contracts package, not production code.
  /fixtures\/memory-contracts-artifact\//,
];

const EXEMPT_FILE_MARKERS = ["ARCHIVE", "SUPERSEDED", "design-evolution"];

function isExempt(filepath) {
  for (const pattern of EXEMPT_PATH_PATTERNS) {
    if (pattern.test(filepath)) return true;
  }
  try {
    const content = readFileSync(filepath, "utf-8");
    const lines = content.split("\n").slice(0, 5).join("\n");
    for (const marker of EXEMPT_FILE_MARKERS) {
      if (lines.includes(marker)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

const trackedFiles = execSync("git ls-tree -r --name-only HEAD", {
  cwd: process.cwd(),
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
})
  .trim()
  .split("\n")
  .filter(Boolean);

const violations = [];

for (const file of trackedFiles) {
  if (isExempt(file)) continue;
  if (!file.endsWith(".ts") && !file.endsWith(".json") && !file.endsWith(".mjs")) continue;

  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    continue;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const name of DEPRECATED_NAMES) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`);
      if (regex.test(line)) {
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*");
        // Check if this line has a v27 exception marker (R2 migration TODO).
        // A marker may sit inline on a comment line OR on the immediately
        // preceding comment line (e.g. a // TODO: R2 line placed above a
        // code line that still uses a deprecated name pending v27 removal).
        if (isComment && (line.includes("v27-exception") || line.includes("TODO: R2"))) {
          continue;
        }
        const prevLine = i > 0 ? lines[i - 1] : "";
        const prevTrimmed = prevLine.trim();
        const prevIsComment =
          prevTrimmed.startsWith("//") ||
          prevTrimmed.startsWith("*") ||
          prevTrimmed.startsWith("/*");
        if (
          prevIsComment &&
          (prevLine.includes("v27-exception") || prevLine.includes("TODO: R2"))
        ) {
          continue;
        }
        if (
          isComment &&
          (line.includes("historical") ||
            line.includes("deprecated") ||
            line.includes("removed") ||
            line.includes("superseded") ||
            line.includes("DO NOT IMPLEMENT"))
        ) {
          continue;
        }
        violations.push({ file, name, line: i + 1 });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Deprecated-name check FAILED (${violations.length} violation(s)):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.name}`);
  }
  console.error(`\nThese names are prohibited by Roadmap v27 in production/current contracts.`);
  process.exit(1);
}

console.log("Deprecated-name check passed — no prohibited names in production code.");
