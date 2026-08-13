#!/usr/bin/env node
/**
 * Deterministic codegen for @iris/agent-contracts.
 *
 * Reads the single machine-readable source (contracts/source/schemas.json)
 * and generates:
 *   1. contracts/generated/types.ts        — TypeScript interfaces
 *   2. contracts/generated/json-schemas/    — Individual JSON Schema files
 *   3. contracts/generated/registry.json    — Release manifest
 *   4. contracts/generated/validators.ts    — Ajv-based runtime validators
 *
 * This is the ONLY code generation step. Production code imports from
 * contracts/generated/. No handwritten duplicate interfaces are permitted.
 *
 * Determinism: same source → same output (sorted keys, stable ordering).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const prettier = require("prettier");

// Repo prettier config (prettier.config.mjs). Generated artifacts are written
// through prettier so codegen output always satisfies `format:check` and the
// freshness gate (regenerating produces the same bytes).
const PRETTIER_OPTS = {
  printWidth: 100,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
};

function formatJson(json) {
  return prettier.format(json, { parser: "json", ...PRETTIER_OPTS });
}

function formatTs(code) {
  return prettier.format(code, { parser: "typescript", ...PRETTIER_OPTS });
}

// prettier v3 API is async. The whole pipeline runs inside an async main so
// every write site can await formatJson/formatTs deterministically.

const main = async () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, "..");
  const SOURCE_PATH = path.join(REPO_ROOT, "contracts", "source", "schemas.json");
  const OUTPUT_DIR = path.join(REPO_ROOT, "contracts", "generated");
  const SCHEMA_DIR = path.join(OUTPUT_DIR, "json-schemas");

  // --- Load source ---
  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));

  // --- Ensure output dirs exist ---
  fs.mkdirSync(SCHEMA_DIR, { recursive: true });

  // --- Helpers ---
  function capitalize(s) {
    return s
      .split(".")
      .pop()
      .replace(/\.v\d+$/, "")
      .replace(/_/g, "")
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  function schemaIdToTypeName(schemaId) {
    // iris.context_message_unit.v1 → ContextMessageUnitV1
    const parts = schemaId.replace(/^iris\./, "").replace(/\.v\d+$/, "");
    return (
      parts
        .split(/[\._]/)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("") +
      "V" +
      (schemaId.match(/\.v(\d+)$/)?.[1] || "1")
    );
  }

  function schemaIdToFileName(schemaId) {
    return schemaId.replace(/^iris\./, "").replace(/\./g, "-") + ".schema.json";
  }

  // --- 1. Generate JSON Schema files ---
  const jsonSchemaFiles = [];
  for (const [schemaId, schema] of Object.entries(source.schemas)) {
    const jsonSchema = sourceSchemaToJsonSchema(schemaId, schema, source);
    const fileName = schemaIdToFileName(schemaId);
    const filePath = path.join(SCHEMA_DIR, fileName);
    fs.writeFileSync(filePath, await formatJson(JSON.stringify(jsonSchema, null, 2) + "\n"));
    jsonSchemaFiles.push({ schemaId, fileName });
  }

  // Also generate semantic payload schemas
  const semanticSchemaFiles = [];
  for (const [schemaId, spec] of Object.entries(source.semanticSchemas || {})) {
    const jsonSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: schemaId,
      ...spec.schema,
    };
    const fileName = schemaId.replace(/^iris\./, "").replace(/\./g, "-") + ".schema.json";
    const filePath = path.join(SCHEMA_DIR, fileName);
    fs.writeFileSync(filePath, await formatJson(JSON.stringify(jsonSchema, null, 2) + "\n"));
    semanticSchemaFiles.push({
      schemaId,
      fileName,
      forbiddenPayloadFields: spec.forbiddenPayloadFields,
    });
  }

  function sourceSchemaToJsonSchema(schemaId, schemaDef, fullSource) {
    const result = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: schemaId,
      title: schemaIdToTypeName(schemaId),
    };

    const resolved = resolveRefs(schemaDef, fullSource);
    Object.assign(result, resolved);
    return result;
  }

  function resolveRefs(obj, fullSource) {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, fullSource));

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "$ref") {
        const ref = value;
        if (ref.startsWith("#/primitives/")) {
          const primName = ref.replace("#/primitives/", "");
          const prim = fullSource.primitives[primName];
          if (prim?.type === "enum") {
            result["enum"] = prim.values;
          }
        } else if (ref.startsWith("#/schemas/")) {
          const refSchemaId = ref.replace("#/schemas/", "");
          const refSchema = fullSource.schemas[refSchemaId];
          if (refSchema) {
            // Inline the referenced schema (without schemaId const constraint for nested use)
            const resolved = resolveRefs({ ...refSchema }, fullSource);
            // For nested object refs, keep as inline schema
            delete resolved.$schema;
            delete resolved.$id;
            delete resolved.title;
            Object.assign(result, resolved);
          }
        }
      } else if (key === "type" && value === "jsonValue") {
        // JsonValue = any valid JSON
        result["type"] = ["string", "number", "boolean", "null", "object", "array"];
      } else {
        result[key] = resolveRefs(value, fullSource);
      }
    }
    return result;
  }

  // --- 2. Generate TypeScript types ---
  function tsTypeFromSchema(propDef, fullSource) {
    if (propDef.$ref) {
      const ref = propDef.$ref;
      if (ref.startsWith("#/primitives/")) {
        return ref.replace("#/primitives/", "");
      } else if (ref.startsWith("#/schemas/")) {
        const refSchemaId = ref.replace("#/schemas/", "");
        return schemaIdToTypeName(refSchemaId);
      }
    }
    if (propDef.type === "jsonValue") return "JsonValue";
    if (propDef.type === "string") return "string";
    if (propDef.type === "integer") return "number";
    if (propDef.type === "number") return "number";
    if (propDef.type === "boolean") return "boolean";
    if (propDef.const !== undefined) return JSON.stringify(propDef.const);
    if (propDef.type === "array") {
      const itemType = tsTypeFromSchema(propDef.items || {}, fullSource);
      return `readonly ${itemType}[]`;
    }
    if (propDef.type === "object") {
      return "Record<string, unknown>";
    }
    return "unknown";
  }

  function generateTsInterface(schemaId, schemaDef, typeName, fullSource) {
    const props = schemaDef.properties || {};
    const required = new Set(schemaDef.required || []);
    const lines = [`export interface ${typeName} {`];

    for (const [propName, propDef] of Object.entries(props)) {
      const isRequired = required.has(propName);
      const tsType = tsTypeFromSchema(propDef, fullSource);
      const optional = isRequired ? "" : "?";
      const readonly = "readonly ";
      lines.push(`  ${readonly}${propName}${optional}: ${tsType};`);
    }
    lines.push("}");
    return lines.join("\n") + "\n";
  }

  let tsOutput = `/**
 * AUTO-GENERATED by scripts/codegen.mjs from contracts/source/schemas.json.
 * DO NOT EDIT BY HAND. All changes must go through the source file + codegen.
 *
 * Registry: ${source.registryId}
 * Status: ${source.registryStatus}
 * Locked: ${source.lockedAt}
 *
 * This is the single machine-authoritative TypeScript contract.
 * No handwritten duplicate interface may exist elsewhere.
 */

`;

  // JsonValue
  tsOutput += `export type JsonPrimitive = string | number | boolean | null;\n`;
  tsOutput += `export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };\n\n`;

  // Primitives (enums)
  for (const [name, def] of Object.entries(source.primitives)) {
    if (def.type === "enum") {
      const union = def.values.map((v) => `"${v}"`).join(" | ");
      tsOutput += `export type ${name} = ${union};\n\n`;
    }
  }

  // Schema ID constants
  tsOutput += `// --- Schema ID constants ---\n`;
  for (const schemaId of Object.keys(source.schemas)) {
    const constName = schemaId.toUpperCase().replace(/\./g, "_");
    tsOutput += `export const ${constName}_SCHEMA_ID = "${schemaId}" as const;\n`;
  }
  tsOutput += `\n`;

  // Semantic schema IDs
  tsOutput += `// --- Semantic schema IDs ---\n`;
  tsOutput += `export const KNOWN_SEMANTIC_SCHEMA_IDS = [\n`;
  for (const schemaId of Object.keys(source.semanticSchemas || {})) {
    tsOutput += `  "${schemaId}",\n`;
  }
  tsOutput += `] as const;\n\n`;

  // KIND_TO_SEMANTIC_SCHEMA_ID
  tsOutput += `// --- RuntimeEventKind → semanticSchemaId mapping ---\n`;
  tsOutput += `export const KIND_TO_SEMANTIC_SCHEMA_ID: Record<RuntimeEventKind, string> = {\n`;
  for (const kind of source.primitives.RuntimeEventKind.values) {
    const semanticId = `iris.semantic.context_message.${kind}.v1`;
    tsOutput += `  ${kind}: "${semanticId}",\n`;
  }
  tsOutput += `};\n\n`;

  // Interfaces from schemas
  for (const [schemaId, schema] of Object.entries(source.schemas)) {
    const typeName = schemaIdToTypeName(schemaId);
    tsOutput += generateTsInterface(schemaId, schema, typeName, source);
    tsOutput += `\n`;
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "types.ts"), await formatTs(tsOutput));

  // --- 3. Generate validators.ts ---
  let validatorsOutput = `/**
 * AUTO-GENERATED runtime validators by scripts/codegen.mjs.
 * DO NOT EDIT BY HAND.
 *
 * Uses Ajv with the generated JSON Schema files.
 * Unknown schemas/fields fail closed.
 */

import { createRequire } from "node:module";
import type { AnySchema, ErrorObject } from "ajv";
import { KNOWN_SEMANTIC_SCHEMA_IDS } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as typeof import("ajv").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

`;
  // Import all schemas (using require for JSON in generated validators.ts)
  for (const { schemaId, fileName } of jsonSchemaFiles) {
    const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
    validatorsOutput += `const ${importName} = require("./json-schemas/${fileName}") as AnySchema;\n`;
  }
  for (const { schemaId, fileName } of semanticSchemaFiles) {
    const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
    validatorsOutput += `const ${importName} = require("./json-schemas/${fileName}") as AnySchema;\n`;
  }

  validatorsOutput += `\n// strictTypes is disabled because generated JsonValue unions are legal JSON\n// Schema (union of primitive/array/object) that Ajv's strictTypes check\n// rejects; all other strict checks stay on and validation remains fail-closed.\nconst ajv = new Ajv({ allErrors: true, strictTypes: false });\n`;
  validatorsOutput += `addFormats(ajv);\n\n`;

  // Register schemas
  for (const { schemaId, fileName } of jsonSchemaFiles) {
    const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
    validatorsOutput += `ajv.addSchema(${importName}, "${schemaId}");\n`;
  }
  validatorsOutput += `\n`;
  for (const { schemaId, fileName } of semanticSchemaFiles) {
    const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
    validatorsOutput += `ajv.addSchema(${importName}, "${schemaId}");\n`;
  }

  validatorsOutput += `\n// --- Generated validator functions ---\n\n`;

  const formatErrorsExpr = `(validate.errors as ErrorObject[] | undefined)?.map((e) => \`\${e.instancePath}: \${e.message ?? ""}\`) ?? []`;

  for (const { schemaId } of jsonSchemaFiles) {
    const fnName = `validate_${schemaId.replace(/\./g, "_")}`;
    validatorsOutput += `export function ${fnName}(data: unknown): { valid: boolean; errors?: string[] } {\n`;
    validatorsOutput += `  const validate = ajv.getSchema("${schemaId}");\n`;
    validatorsOutput += `  if (!validate) return { valid: false, errors: ["schema not registered: ${schemaId}"] };\n`;
    validatorsOutput += `  const valid = validate(data);\n`;
    validatorsOutput += `  if (!valid) {\n`;
    validatorsOutput += `    return { valid: false, errors: ${formatErrorsExpr} };\n`;
    validatorsOutput += `  }\n`;
    validatorsOutput += `  return { valid: true };\n`;
    validatorsOutput += `}\n\n`;
  }

  // Semantic payload validators
  for (const { schemaId, forbiddenPayloadFields } of semanticSchemaFiles) {
    const fnName = `validateSemantic_${schemaId.replace(/\./g, "_")}`;
    validatorsOutput += `export function ${fnName}(data: unknown): { valid: boolean; errors?: string[] } {\n`;
    // First check forbidden fields
    validatorsOutput += `  if (data !== null && typeof data === "object" && !Array.isArray(data)) {\n`;
    validatorsOutput += `    const obj = data as Record<string, unknown>;\n`;
    for (const field of forbiddenPayloadFields) {
      validatorsOutput += `    if ("${field}" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: ${field}"] };\n`;
    }
    validatorsOutput += `  }\n`;
    validatorsOutput += `  const validate = ajv.getSchema("${schemaId}");\n`;
    validatorsOutput += `  if (!validate) return { valid: false, errors: ["schema not registered: ${schemaId}"] };\n`;
    validatorsOutput += `  const valid = validate(data);\n`;
    validatorsOutput += `  if (!valid) {\n`;
    validatorsOutput += `    return { valid: false, errors: ${formatErrorsExpr} };\n`;
    validatorsOutput += `  }\n`;
    validatorsOutput += `  return { valid: true };\n`;
    validatorsOutput += `}\n\n`;
  }

  // Semantic schema dispatch
  validatorsOutput += `// --- Semantic schema registry dispatch ---\n`;
  validatorsOutput += `export function validateSemanticContent(semanticSchemaId: string, content: unknown): { valid: boolean; errors?: string[] } {\n`;
  validatorsOutput += `  switch (semanticSchemaId) {\n`;
  for (const { schemaId } of semanticSchemaFiles) {
    const fnName = `validateSemantic_${schemaId.replace(/\./g, "_")}`;
    validatorsOutput += `    case "${schemaId}":\n`;
    validatorsOutput += `      return ${fnName}(content);\n`;
  }
  validatorsOutput += `    default:\n`;
  validatorsOutput += `      return { valid: false, errors: [\`unknown semanticSchemaId: \\\`\${semanticSchemaId}\\\`\`] };\n`;
  validatorsOutput += `  }\n`;
  validatorsOutput += `}\n\n`;

  // isKnownSemanticSchemaId
  validatorsOutput += `export function isKnownSemanticSchemaId(id: string): boolean {\n`;
  validatorsOutput += `  return (KNOWN_SEMANTIC_SCHEMA_IDS as readonly string[]).includes(id);\n`;
  validatorsOutput += `}\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "validators.ts"), await formatTs(validatorsOutput));

  // --- 4. Generate registry manifest ---
  const manifest = {
    registryId: source.registryId,
    status: source.registryStatus,
    lockedAt: source.lockedAt,
    generatedAt: new Date().toISOString().split("T")[0], // date only for reproducibility
    currentGenerationSchemaId: source.currentGenerationSchemaId,
    currentGenerationUnitSchemaId: source.currentGenerationUnitSchemaId,
    currentGenerationHeaderSchemaId: source.currentGenerationHeaderSchemaId,
    currentGenerationUnitHeaderSchemaId: source.currentGenerationUnitHeaderSchemaId,
    schemas: jsonSchemaFiles.map(({ schemaId, fileName }) => ({
      schemaId,
      file: `json-schemas/${fileName}`,
    })),
    semanticSchemas: semanticSchemaFiles.map(({ schemaId, fileName }) => ({
      schemaId,
      file: `json-schemas/${fileName}`,
    })),
  };

  // Compute manifest hash (canonical compact JSON)
  const manifestJson = JSON.stringify(manifest, Object.keys(manifest).sort());
  manifest.manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "registry.json"),
    await formatJson(JSON.stringify(manifest, null, 2) + "\n"),
  );

  // --- 5. Generate R0 migration fixtures (#123/R0 exit gate) ---
  // Notion R0: codegen MUST publish a V1→V2 fixture migration or an explicit
  // V1 rejection fence, and a generation MUST NOT mix V1 and V2 members.
  // These fixtures are part of the generated release manifest (freshness-gated):
  //   - v1-flat-generation.fixture.json   superseded flat V1 layout (must be REJECTED)
  //   - v1-flat-unit.fixture.json         superseded flat V1 unit (must be REJECTED)
  //   - v2-generation.fixture.json        current structured V2 generation (must PASS)
  //   - v2-v1-mixed-generation.fixture.json  mixed V1+V2 members (must be REJECTED)
  const FIXTURE_DIR = path.join(OUTPUT_DIR, "migration-fixtures");
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const canonicalJson = (value) => {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJson).join(",")}]`;
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${pairs.join(",")}}`;
  };
  const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  const semanticHash = (content) => sha256(canonicalJson(content));

  // A static P0 unit (header hash = semantic content hash, like projectStaticUnit).
  const p0Unit = {
    schemaId: "iris.context_unit.v2",
    header: {
      schemaId: "iris.context_unit_header.v1",
      contextUnitId: "fixture-unit-p0-0001",
      source: {
        schemaId: "iris.context_unit_source_ref.v1",
        sourceSchemaId: "iris.system_prompt.v1",
        sourceId: "system-prompt-v1",
        sourceHash: semanticHash({ role: "user", content: "fixture p0 system prompt" }),
      },
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      contentHash: semanticHash({ role: "user", content: "fixture p0 system prompt" }),
    },
    semanticContent: { role: "user", content: "fixture p0 system prompt" },
  };

  const v2Generation = {
    schemaId: "iris.context_generation.v2",
    header: {
      schemaId: "iris.context_generation_header.v1",
      contextGenerationId: "fixture-gen-v2-0001",
      contextLineageId: "fixture-lineage-v2",
      sourceSnapshotHash: "fixture-source-snapshot-v2",
      layerEnds: [1, 1, 1, 1, 1, 1],
      contextGenerationHash: "",
      createdAt: "2026-08-01T00:00:00Z",
    },
    units: [p0Unit],
  };
  // contextGenerationHash: canonical basis covers schema id, lineage, source
  // snapshot, ordered unit identity/content hashes and layerEnds; excludes
  // the hash field itself and createdAt (equivalent rebuilds verify equal).
  const genHashInput = {
    schemaId: v2Generation.schemaId,
    contextLineageId: v2Generation.header.contextLineageId,
    sourceSnapshotHash: v2Generation.header.sourceSnapshotHash,
    units: v2Generation.units,
    layerEnds: v2Generation.header.layerEnds,
  };
  const h = createHash("sha256");
  h.update(genHashInput.schemaId, "utf8");
  h.update("\0");
  h.update(genHashInput.contextLineageId, "utf8");
  h.update("\0");
  h.update(genHashInput.sourceSnapshotHash, "utf8");
  h.update("\0");
  for (const unit of genHashInput.units) {
    h.update(unit.header.contextUnitId, "utf8");
    h.update("\0");
    h.update(unit.header.semanticSchemaId, "utf8");
    h.update("\0");
    h.update(unit.header.contentHash, "utf8");
    h.update("\0");
    h.update(unit.header.source.sourceId, "utf8");
    h.update("\0");
    h.update(unit.header.source.sourceHash, "utf8");
    h.update("\0");
  }
  h.update(genHashInput.layerEnds.join(","), "utf8");
  v2Generation.header.contextGenerationHash = h.digest("hex");

  // Superseded flat V1 layouts — current contract is V2; these MUST be
  // rejected by the V2 validator (explicit V1 rejection fence).
  const v1FlatGeneration = {
    schemaId: "iris.context_generation.v1",
    contextGenerationId: "fixture-gen-v1-0001",
    contextLineageId: "fixture-lineage-v1",
    sourceSnapshotHash: "fixture-source-snapshot-v1",
    // Flat V1 layout: per-layer arrays, no header/layerEnds/units.
    layers: { p0: [], p1: [], p2: [], p3: [], p4: [], p5: [] },
    contextGenerationHash: "v1-generation-hash",
    createdAt: "2026-08-01T00:00:00Z",
  };
  const v1FlatUnit = {
    schemaId: "iris.context_unit.v1",
    contextUnitId: "fixture-unit-v1-0001",
    contextSeq: 1,
    kind: "user",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    semanticContent: { role: "user", content: "v1 flat unit" },
    contentHash: "v1-content-hash",
    lifecycleState: "committed",
    createdAt: "2026-08-01T00:00:00Z",
  };

  // Forbidden: a V2 generation MUST NOT mix flat V1 members into units[].
  const v2V1MixedGeneration = {
    ...v2Generation,
    header: { ...v2Generation.header, contextGenerationId: "fixture-gen-mixed-0001" },
    units: [
      p0Unit,
      {
        schemaId: "iris.context_unit.v1",
        contextUnitId: "fixture-unit-v1-mixed",
        contextSeq: 2,
        kind: "user",
        semanticSchemaId: "iris.semantic.context_message.user.v1",
        semanticContent: { role: "user", content: "mixed v1 member" },
        contentHash: "mixed-v1-hash",
        lifecycleState: "committed",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ],
  };

  const fixtures = {
    "v1-flat-generation.fixture.json": v1FlatGeneration,
    "v1-flat-unit.fixture.json": v1FlatUnit,
    "v2-generation.fixture.json": v2Generation,
    "v2-v1-mixed-generation.fixture.json": v2V1MixedGeneration,
  };
  for (const [fileName, fixture] of Object.entries(fixtures)) {
    fs.writeFileSync(
      path.join(FIXTURE_DIR, fileName),
      await formatJson(JSON.stringify(fixture, null, 2) + "\n"),
    );
  }

  // --- Summary ---
  console.log("Codegen complete:");
  console.log(`  Schemas: ${jsonSchemaFiles.length} + ${semanticSchemaFiles.length} semantic`);
  console.log(`  Output: ${path.relative(REPO_ROOT, OUTPUT_DIR)}/`);
  console.log(`  Manifest SHA: ${manifest.manifestSha256.slice(0, 16)}...`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
