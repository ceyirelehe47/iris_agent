/**
 * R2: ContextMessageUnit legacy interface.
 *
 * @deprecated Use ContextMessageUnitV1 from context-v27.ts directly.
 * This file is kept ONLY as a thin compatibility layer for code that
 * has not yet been migrated. The canonical durable Context unit is
 * ContextMessageUnitV1 in context-v27.ts.
 *
 * All new code MUST import from context-v27.ts.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Re-export the canonical types for backward compatibility
export type { ContextMessageUnitV1 } from "./context-v27.js";
export type {
  RuntimeEventKind,
  HistorianDisposition,
  ContextMessageUnitLifecycleState,
  JsonValue,
  SemanticDerivationRefsV1,
} from "./context-v27.js";

/**
 * Legacy unit type used by the existing persistence layer.
 * Maps the old field names to the canonical ContextMessageUnitV1 semantics.
 *
 * Production code should migrate to use ContextMessageUnitV1 directly.
 * This type exists to allow incremental migration without breaking the
 * existing SQLite schema and ingest pipeline.
 */
export interface ContextMessageUnit {
  // Canonical identity — the authoritative durable unit ID.
  // contextUnitId is the v27 canonical name; unitId is kept as a
  // compatibility alias for the physical DB column name.
  contextUnitId: string;
  unitId: string;
  lineageId: string;
  contextSeq: number;
  runtimeEventId?: string;
  sourceEventId: string;
  runtimeSessionId: string;

  // Semantic type — maps to RuntimeEventKind
  unitType: "input" | "assistant" | "tool_result";
  // Semantic schema ID — the canonical discriminator (reused in P5 projection)
  semanticSchemaId: string;

  // Disposition (maps to HistorianDisposition)
  disposition: "include" | "reference_only" | "exclude" | "retired";

  // Content
  contentHash: string;
  payload: AgentMessage;

  // Pi Session archive reference
  entryId?: string;
  entrySeq?: number;
  rawArchiveRef?: string;

  // Companion pairing
  companionEntryId?: string;
  pairKey?: string;
  paired: boolean;

  // Provenance
  derivationRefs: {
    memoryRefs: string[];
    compartmentIds: string[];
    sourceContextMessageUnitIds: string[];
  };

  // Schema version
  schemaVersion: string;
  createdAt: string;
}

/** Legacy filter type. */
export type UnitDispositionFilter = "include" | "all";

/** Legacy context ingest port. */
export interface ContextIngestPort {
  ensureUnitsUpTo(runtimeSessionId: string, options?: { limit?: number }): ContextMessageUnit[];
  listUnits(
    runtimeSessionId: string,
    options?: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    },
  ): ContextMessageUnit[];
  close(): void;
}
