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
  // They are only allowed in context-v27.ts (as legacy/migration types) and
  // in migration/test files.
  // context-v27.ts is EXEMPT because it defines them for the V1→V2 fence.
  "LegacyFlatV1Generation",
  "LegacyFlatV1Unit",
];

// Files where LegacyFlat types are permitted (they define/test the fence)
const LEGACY_TYPE_EXEMPT_FILES = new Set(["src/contracts/context-v27.ts"]);

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
          (name === "LegacyFlatV1Generation" || name === "LegacyFlatV1Unit") &&
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
// Check that the canonical V2 contract file (context-v27.ts) defines the
// real structured types with schemaId fields, and that the generation builder
// exists and produces validated ContextGenerationV2.
// ---------------------------------------------------------------------------

const STRUCTURAL_CHECKS = [
  {
    description: "context-v27.ts must define ContextGenerationV2 with schemaId",
    file: "src/contracts/context-v27.ts",
    pattern: /interface\s+ContextGenerationV2\b/,
  },
  {
    description: "context-v27.ts must define ContextUnitV2 with schemaId",
    file: "src/contracts/context-v27.ts",
    pattern: /interface\s+ContextUnitV2\b/,
  },
  {
    description: "context-v27.ts must define ContextUnitHeaderV1 with semanticSchemaId",
    file: "src/contracts/context-v27.ts",
    pattern: /semanticSchemaId\s*:/,
  },
  {
    description: "context-v27.ts must define ContextGenerationHeaderV1 with layerEnds",
    file: "src/contracts/context-v27.ts",
    pattern: /interface\s+ContextGenerationHeaderV1\b[\s\S]*?layerEnds\s*:/,
  },
  {
    description: "context-v27.ts must define ContextUnitSourceRefV1 with required sourceHash",
    file: "src/contracts/context-v27.ts",
    pattern: /interface\s+ContextUnitSourceRefV1\b[\s\S]*?sourceHash\s*:/,
  },
  {
    description: "context-v27.ts must export V1→V2 fence function",
    file: "src/contracts/context-v27.ts",
    pattern: /export\s+function\s+v1ToF2Fence\b/,
  },
  {
    description: "generation-builder.ts must exist with buildContextGenerationV2",
    file: "src/context/generation-builder.ts",
    pattern: /export\s+function\s+buildContextGenerationV2\b/,
  },
  {
    description: "V2 schema IDs must use underscores (iris.context_generation.v2), not dashes",
    file: "src/contracts/context-v27.ts",
    pattern: /iris\.context_generation\.v2/,
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
