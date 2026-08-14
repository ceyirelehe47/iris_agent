#!/usr/bin/env node
/**
 * iris_agent#87 / #96 / Roadmap v27: deprecated-name + architecture CI gate.
 *
 * Fails CI if production/current code or contracts contain names that v27
 * explicitly prohibits. Historical docs, migration fixtures, explicit
 * negative tests and upstream-only references are exempt.
 *
 * iris_agent#96: Also performs STRUCTURAL checks — a trivial rename that
 * preserves the forbidden legacy assembly shape (invocation snapshot,
 * message-transform flow) must fail even if no deprecated name is present.
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
  // iris_agent#96: the V1 flat layout types (no schemaId/header structure)
  // must not appear in NEW production code as the current generation contract.
  // consume-iris-context: the local context-v27.ts / generation-builder.ts are
  // gone — the V2 contract now lives in @iris/context; these legacy names are
  // still forbidden anywhere in this repo.
  "LegacyFlatV1Generation",
  "LegacyFlatV1Unit",
];

// Files where LegacyFlat types are permitted (they define/test the fence).
// consume-iris-context: the old definition files are removed, so no exemption
// is needed anymore.
const LEGACY_TYPE_EXEMPT_FILES = new Set([]);

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
        // LegacyFlat types are only allowed in their definition file + tests
        if (
          (name === "LegacyFlatV1Generation" ||
            name === "LegacyFlatV1Unit" ||
            name === "sourceContextUnitIds") &&
          LEGACY_TYPE_EXEMPT_FILES.has(file)
        ) {
          continue;
        }
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
        // Comment lines that describe deprecated/historical/superseded/removed
        // names in a clearly referential way (e.g. "Replaces the deprecated
        // `X`") are fine — they document history rather than live usage. No
        // escape-hatch markers (TODO: R2 / v27-exception) exist anymore: v27
        // renames are complete, so production code must use current names.
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

// ---------------------------------------------------------------------------
// iris_agent#96: Structural architecture gate
//
// A trivial rename of old DTOs must not bypass the architecture boundary.
// consume-iris-context: the canonical Context semantics now live in
// @iris/context (ContextService + ContextGenerationV2 + RuntimeEventInput).
// This repo must CONSUME those contracts (narrow versioned imports) and must
// NOT re-implement a second Context/Historian engine.
// ---------------------------------------------------------------------------

const STRUCTURAL_CHECKS = [
  {
    description: "package.json must depend on @iris/context (single Context authority)",
    file: "package.json",
    pattern: /"@iris\/context"\s*:/,
  },
  {
    description: "provider renderer must consume @iris/context/contracts (ContextGenerationV2)",
    file: "src/runtime/context-render.ts",
    pattern: /@iris\/context\/contracts/,
  },
  {
    description: "runtime event bridge must consume @iris/context/contracts/runtime-events",
    file: "src/runtime/iris-bridge.ts",
    pattern: /@iris\/context\/contracts\/runtime-events/,
  },
  {
    description: "harness factory must accept irisContext: ContextService (@iris/context)",
    file: "src/runtime/harness-factory.ts",
    pattern: /irisContext\s*:\s*ContextService/,
  },
  {
    description: "assembly root must register P0-P2 contributors (createIrisSourceContributors)",
    file: "src/runtime/iris-context.ts",
    pattern: /createIrisSourceContributors/,
  },
];

const structuralViolations = [];

for (const check of STRUCTURAL_CHECKS) {
  try {
    const content = readFileSync(check.file, "utf-8");
    if (!check.pattern.test(content)) {
      structuralViolations.push(check);
    }
  } catch {
    structuralViolations.push({ ...check, fileMissing: true });
  }
}

if (structuralViolations.length > 0) {
  console.error(
    `Architecture structural check FAILED (${structuralViolations.length} violation(s)):`,
  );
  for (const v of structuralViolations) {
    console.error(`  ${v.description} (${v.file}${v.fileMissing ? " MISSING" : ""})`);
  }
  console.error(`\nThese structural invariants are required by Roadmap v27 (iris_agent#96).`);
  process.exit(1);
}

console.log(
  "Deprecated-name + architecture check passed — no prohibited names or structural violations.",
);
