/**
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

const raw_archive_ref_v1 = require("./json-schemas/raw_archive_ref-v1.schema.json");
const semantic_derivation_refs_v1 = require("./json-schemas/semantic_derivation_refs-v1.schema.json");
const context_message_unit_v1 = require("./json-schemas/context_message_unit-v1.schema.json");
const context_unit_source_ref_v1 = require("./json-schemas/context_unit_source_ref-v1.schema.json");
const context_unit_header_v1 = require("./json-schemas/context_unit_header-v1.schema.json");
const context_unit_v2 = require("./json-schemas/context_unit-v2.schema.json");
const context_generation_header_v1 = require("./json-schemas/context_generation_header-v1.schema.json");
const context_generation_v2 = require("./json-schemas/context_generation-v2.schema.json");
const semantic_context_message_user_v1 = require("./json-schemas/semantic-context_message-user-v1.schema.json");
const semantic_context_message_assistant_v1 = require("./json-schemas/semantic-context_message-assistant-v1.schema.json");
const semantic_context_message_tool_call_v1 = require("./json-schemas/semantic-context_message-tool_call-v1.schema.json");
const semantic_context_message_tool_result_v1 = require("./json-schemas/semantic-context_message-tool_result-v1.schema.json");
const semantic_context_message_body_event_v1 = require("./json-schemas/semantic-context_message-body_event-v1.schema.json");
const semantic_context_message_operational_v1 = require("./json-schemas/semantic-context_message-operational-v1.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

ajv.addSchema(raw_archive_ref_v1, "iris.raw_archive_ref.v1");
ajv.addSchema(semantic_derivation_refs_v1, "iris.semantic_derivation_refs.v1");
ajv.addSchema(context_message_unit_v1, "iris.context_message_unit.v1");
ajv.addSchema(context_unit_source_ref_v1, "iris.context_unit_source_ref.v1");
ajv.addSchema(context_unit_header_v1, "iris.context_unit_header.v1");
ajv.addSchema(context_unit_v2, "iris.context_unit.v2");
ajv.addSchema(context_generation_header_v1, "iris.context_generation_header.v1");
ajv.addSchema(context_generation_v2, "iris.context_generation.v2");

ajv.addSchema(semantic_context_message_user_v1, "iris.semantic.context_message.user.v1");
ajv.addSchema(semantic_context_message_assistant_v1, "iris.semantic.context_message.assistant.v1");
ajv.addSchema(semantic_context_message_tool_call_v1, "iris.semantic.context_message.tool_call.v1");
ajv.addSchema(semantic_context_message_tool_result_v1, "iris.semantic.context_message.tool_result.v1");
ajv.addSchema(semantic_context_message_body_event_v1, "iris.semantic.context_message.body_event.v1");
ajv.addSchema(semantic_context_message_operational_v1, "iris.semantic.context_message.operational.v1");

// --- Generated validator functions ---

export function validate_iris_raw_archive_ref_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.raw_archive_ref.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_semantic_derivation_refs_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.semantic_derivation_refs.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_message_unit_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_message_unit.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_unit_source_ref_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_unit_source_ref.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_unit_header_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_unit_header.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_unit_v2(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_unit.v2")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_generation_header_v1(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_generation_header.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validate_iris_context_generation_v2(data: unknown): { valid: boolean; errors?: string[] } {
  const validate = ajv.getSchema("iris.context_generation.v2")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_user_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("runtimeEventId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: runtimeEventId"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("lifecycleState" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: lifecycleState"] };
    if ("historianDisposition" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: historianDisposition"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
    if ("sourceKind" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: sourceKind"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.user.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_assistant_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("runtimeEventId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: runtimeEventId"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("lifecycleState" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: lifecycleState"] };
    if ("historianDisposition" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: historianDisposition"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
    if ("sourceKind" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: sourceKind"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.assistant.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_tool_call_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.tool_call.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_tool_result_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.tool_result.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_body_event_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.body_event.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

export function validateSemantic_iris_semantic_context_message_operational_v1(data: unknown): { valid: boolean; errors?: string[] } {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if ("contextUnitId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextUnitId"] };
    if ("contextLineageId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextLineageId"] };
    if ("contextSeq" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contextSeq"] };
    if ("semanticSchemaId" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: semanticSchemaId"] };
    if ("contentHash" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: contentHash"] };
    if ("layer" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: layer"] };
    if ("pLevel" in obj) return { valid: false, errors: ["forbidden control metadata field in semanticContent: pLevel"] };
  }
  const validate = ajv.getSchema("iris.semantic.context_message.operational.v1")!;
  const valid = validate(data);
  if (!valid) {
    return { valid: false, errors: validate.errors?.map((e: any) => `${e.instancePath}: ${e.message ?? ""}`) ?? [] };
  }
  return { valid: true };
}

// --- Semantic schema registry dispatch ---
export function validateSemanticContent(semanticSchemaId: string, content: unknown): { valid: boolean; errors?: string[] } {
  switch (semanticSchemaId) {
    case "iris.semantic.context_message.user.v1":
      return validateSemantic_iris_semantic_context_message_user_v1(content);
    case "iris.semantic.context_message.assistant.v1":
      return validateSemantic_iris_semantic_context_message_assistant_v1(content);
    case "iris.semantic.context_message.tool_call.v1":
      return validateSemantic_iris_semantic_context_message_tool_call_v1(content);
    case "iris.semantic.context_message.tool_result.v1":
      return validateSemantic_iris_semantic_context_message_tool_result_v1(content);
    case "iris.semantic.context_message.body_event.v1":
      return validateSemantic_iris_semantic_context_message_body_event_v1(content);
    case "iris.semantic.context_message.operational.v1":
      return validateSemantic_iris_semantic_context_message_operational_v1(content);
    default:
      return { valid: false, errors: [`unknown semanticSchemaId: \`${semanticSchemaId}\``] };
  }
}

export function isKnownSemanticSchemaId(id: string): boolean {
  return KNOWN_SEMANTIC_SCHEMA_IDS.includes(id as any);
}
