/**
 * R2: ContextMessageUnit compatibility re-export.
 *
 * The canonical durable Context unit is ContextMessageUnitV1 in
 * context-v27.ts (single authority, Notion v27 — Feature A #110). This file
 * contains NO interface definitions — it is a PURE type re-export shim so
 * that legacy imports of the old `ContextMessageUnit` name resolve to the
 * canonical V1 type.
 *
 * The structural architecture gate (test/context-durable-contract-authority
 * .test.ts) scans every production file for competing durable unit DTOs,
 * including this one — context-v27.ts is the ONLY exempt definition site.
 *
 * All new code MUST import from context-v27.ts.
 */

export type { ContextMessageUnitV1 as ContextMessageUnit } from "./context-v27.js";
export type { ContextIngestPort, UnitDispositionFilter } from "./context-v27.js";
