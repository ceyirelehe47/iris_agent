/**
 * Roadmap v27 Canonical Context Contracts — single source of truth.
 *
 * V2 structured-header contract. Supersedes the flat V1 layout.
 *
 * Key v27 invariants:
 * - ContextMessageUnitV1 is durable (context.db), has contextSeq + lifecycle.
 * - ContextUnitV2 is generation-level, in-memory only, NOT persisted.
 * - ContextGenerationV2 = { header: { layerEnds[6] }, units: ContextUnitV2[] } —
 *   one ordered array, P-level membership determined by index + layerEnds.
 * - BUST is the only refresh path; fail-closed on failure.
 * - Pi Session is raw archive only, never a Context semantic source.
 */

/**
 * The lifecycle state of a durable ContextMessageUnit.
 * Replaces the deprecated `ContextUnitLifecycleState`.
 *
 * Authoritative lifecycle (Notion R2):
 * committed → historian_eligible → historian_claimed →
 * compartmentalized_pending_bust → represented_in_p3 → retired
 */
export type ContextMessageUnitLifecycleState =
  | "committed"
  | "historian_eligible"
  | "historian_claimed"
  | "compartmentalized_pending_bust"
  | "represented_in_p3"
  | "retired";

/**
 * A durable, identity-level Context semantic unit stored in context.db.
 * Has a global monotonic contextSeq within its lineage, carries lifecycle
 * state, and is the Historian's normal input. When selected for P5, it
 * projects 1:1 into a generation-level ContextUnitV2.
 *
 * Replaces the deprecated `HistoryProjectionUnit` (which conflated the
 * durable view with the generation-level projection).
 */
export interface ContextMessageUnitV1 {
  /** Stable identity within the lineage. */
  readonly contextUnitId: string;
  /** Global monotonic sequence within the lineage. Primary ordering key. */
  readonly contextSeq: number;
  /** The canonical RuntimeEvent that produced this unit. */
  readonly runtimeEventId: string;
  /** Semantic unit type. */
  readonly unitType: ContextUnitType;
  /** Whether this unit is included in generation, reference-only, or excluded. */
  readonly disposition: ContextMessageUnitDisposition;
  /** Content hash for provenance verification. */
  readonly contentHash: string;
  /**
   * Lifecycle state
   * (committed/historian_eligible/historian_claimed/compartmentalized_pending_bust/
   * represented_in_p3/retired).
   */
  readonly lifecycleState: ContextMessageUnitLifecycleState;
  /** Optional raw archive reference (for recovery/audit only). */
  readonly rawArchiveRef?: RawArchiveRefV1;
}

// --- V2 Generation types (in-memory, not persisted) ---

/**
 * A validated, in-memory Context generation. Rebuildable from durable sources.
 */
export interface ContextGenerationV2 {
  readonly schemaId: "iris.context-generation.v2";
  readonly header: ContextGenerationHeaderV1;
  readonly units: readonly ContextUnitV2[];
}

/**
 * Header for a Context generation. layerEnds[6] defines P0-P5 as contiguous ranges.
 */
export interface ContextGenerationHeaderV1 {
  /** Generation identity (deterministic from sources). */
  readonly generationId: string;
  /** Identity-level lineage this generation belongs to. */
  readonly lineageId: string;
  /** P0-P5 boundaries: P_i = units[layerEnds[i-1] : layerEnds[i]). layerEnds[-1] is implicitly 0. */
  readonly layerEnds: readonly [number, number, number, number, number, number];
  /** Hash over all unit hashes in order (deterministic provenance). */
  readonly generationHash: string;
}

/**
 * A generation-level Context unit. In-memory only. No layer/pLevel.
 */
export interface ContextUnitV2 {
  readonly schemaId: "iris.context-unit.v2";
  readonly header: ContextUnitHeaderV1;
  readonly semanticContent: string;
}

/**
 * Header for a Context unit. semanticSchemaId is the ONLY semantic type discriminator.
 */
export interface ContextUnitHeaderV1 {
  /** Stable identity across rebuilds (not array index). */
  readonly contextUnitId: string;
  /** Source reference that produced this unit. */
  readonly source: ContextUnitSourceRefV1;
  /** The ONLY semantic type discriminator. No type/kind duplication. */
  readonly semanticSchemaId: string;
  /** Content hash of semanticContent. */
  readonly contentHash: string;
}

/**
 * Reference to the authoritative source.
 */
export interface ContextUnitSourceRefV1 {
  /** Source-specific identity (e.g. systemPromptId, personaId, memoryRef, contextUnitId). */
  readonly sourceId: string;
  /** Optional content hash for verification. */
  readonly sourceHash?: string;
}

/**
 * Semantic derivation references for provenance tracking.
 * Uses `sourceContextMessageUnitIds` (NOT the deprecated `sourceContextUnitIds`).
 */
export interface SemanticDerivationRefsV1 {
  readonly memoryRefs: readonly string[];
  readonly compartmentIds: readonly string[];
  readonly sourceContextMessageUnitIds: readonly string[];
}

// ---- Supporting types ----

export type ContextUnitType =
  "input" | "output" | "tool_call" | "tool_result" | "system" | "operational";

export type ContextMessageUnitDisposition = "include" | "reference_only" | "exclude";

export interface RawArchiveRefV1 {
  readonly runtimeSessionId: string;
  readonly entryId: string;
  readonly entrySeq?: number;
}

// ---- Validation helpers ----

/**
 * Validate ContextGenerationV2: layerEnds constraint + hash verification.
 */
export function validateGenerationV2(generation: ContextGenerationV2): boolean {
  const [e0, e1, e2, e3, e4, e5] = generation.header.layerEnds;
  const len = generation.units.length;
  // Monotonic non-decreasing, last === length
  if (!(0 <= e0 && e0 <= e1 && e1 <= e2 && e2 <= e3 && e3 <= e4 && e4 <= e5 && e5 === len)) {
    return false;
  }
  // Every unit must have V2 schemaId
  for (const unit of generation.units) {
    if (unit.schemaId !== "iris.context-unit.v2") return false;
  }
  return true;
}

/**
 * Compute layerEnds[6] from per-layer unit counts.
 */
export function computeLayerEnds(
  counts: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  let cumulative = 0;
  const result = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    cumulative += counts[i]!;
    result[i] = cumulative;
  }
  return result as [number, number, number, number, number, number];
}

/**
 * V1→V2 rejection fence. If input data carries the old V1 schema (flat layout
 * without structured headers), reject it — no V1/V2 mixing.
 */
export function isV1ContextUnit(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  // V1 units have sourceRef + content but NO schemaId + header structure
  return "sourceRef" in o && "content" in o && !("schemaId" in o) && !("header" in o);
}

export function rejectV1Generation(obj: unknown): never {
  if (typeof obj === "object" && obj !== null) {
    const o = obj as Record<string, unknown>;
    if ("layerEnds" in o && "units" in o && !("schemaId" in o)) {
      throw new Error("V1 ContextGeneration detected — reject: V1/V2 mixing is forbidden");
    }
  }
  throw new Error("Invalid Context generation: does not match V2 schema");
}
