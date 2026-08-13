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
  return s.split(".").pop().replace(/\.v\d+$/, "").replace(/_/g, "").replace(/^\w/, (c) => c.toUpperCase());
}

function schemaIdToTypeName(schemaId) {
  // iris.context_message_unit.v1 → ContextMessageUnitV1
  const parts = schemaId.replace(/^iris\./, "").replace(/\.v\d+$/, "");
  return parts.split(/[\._]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("") + "V" + (schemaId.match(/\.v(\d+)$/)?.[1] || "1");
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
  fs.writeFileSync(filePath, JSON.stringify(jsonSchema, null, 2) + "\n");
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
  fs.writeFileSync(filePath, JSON.stringify(jsonSchema, null, 2) + "\n");
  semanticSchemaFiles.push({ schemaId, fileName, forbiddenPayloadFields: spec.forbiddenPayloadFields });
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

fs.writeFileSync(path.join(OUTPUT_DIR, "types.ts"), tsOutput);

// --- 3. Generate validators.ts ---
let validatorsOutput = `/**
 * AUTO-GENERATED runtime validators by scripts/codegen.mjs.
 * DO NOT EDIT BY HAND.
 *
 * Uses Ajv with the generated JSON Schema files.
 * Unknown schemas/fields fail closed.
 */

import { createRequire } from "node:module";
import { KNOWN_SEMANTIC_SCHEMA_IDS } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

`;
// Import all schemas (using require for JSON in generated validators.ts)
for (const { schemaId, fileName } of jsonSchemaFiles) {
  const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
  validatorsOutput += `const ${importName} = require("./json-schemas/${fileName}");\n`;
}
for (const { schemaId, fileName } of semanticSchemaFiles) {
  const importName = fileName.replace(/\.schema\.json$/, "").replace(/-/g, "_");
  validatorsOutput += `const ${importName} = require("./json-schemas/${fileName}");\n`;
}

validatorsOutput += `\nconst ajv = new Ajv({ allErrors: true, strict: true });\n`;
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

for (const { schemaId } of jsonSchemaFiles) {
  const fnName = `validate_${schemaId.replace(/\./g, "_")}`;
  validatorsOutput += `export function ${fnName}(data: unknown): { valid: boolean; errors?: string[] } {\n`;
  validatorsOutput += `  const validate = ajv.getSchema("${schemaId}")!;\n`;
  validatorsOutput += `  const valid = validate(data);\n`;
  validatorsOutput += `  if (!valid) {\n`;
  validatorsOutput += `    return { valid: false, errors: validate.errors?.map((e: any) => \`\${e.instancePath}: \${e.message ?? ""}\`) ?? [] };\n`;
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
  validatorsOutput += `  const validate = ajv.getSchema("${schemaId}")!;\n`;
  validatorsOutput += `  const valid = validate(data);\n`;
  validatorsOutput += `  if (!valid) {\n`;
  validatorsOutput += `    return { valid: false, errors: validate.errors?.map((e: any) => \`\${e.instancePath}: \${e.message ?? ""}\`) ?? [] };\n`;
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
validatorsOutput += `  return KNOWN_SEMANTIC_SCHEMA_IDS.includes(id as any);\n`;
validatorsOutput += `}\n`;

fs.writeFileSync(path.join(OUTPUT_DIR, "validators.ts"), validatorsOutput);

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

fs.writeFileSync(path.join(OUTPUT_DIR, "registry.json"), JSON.stringify(manifest, null, 2) + "\n");

// --- Summary ---
console.log("Codegen complete:");
console.log(`  Schemas: ${jsonSchemaFiles.length} + ${semanticSchemaFiles.length} semantic`);
console.log(`  Output: ${path.relative(REPO_ROOT, OUTPUT_DIR)}/`);
console.log(`  Manifest SHA: ${manifest.manifestSha256.slice(0, 16)}...`);
