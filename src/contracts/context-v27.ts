/**
 * Roadmap v27 Canonical Context Contracts — single source of truth.
 *
 * These definitions are the authoritative types for the v27 Context model.
 * No handwritten duplicate interface may exist in other files — all code
 * that needs these types imports from here.
 *
 * Key v27 invariants:
 * - ContextMessageUnitV1 is durable (context.db), has contextSeq + lifecycle.
 * - ContextUnitV1 is generation-level, has NO lifecycle, is NOT persisted.
 * - ContextGenerationV1 = { layerEnds[6], units: ContextUnitV1[] } — one
 *   ordered array, P-level membership determined by index + layerEnds.
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
 * projects 1:1 into a generation-level ContextUnitV1.
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

/**
 * A generation-level Context unit. In-memory only, NOT persisted.
 * Does NOT carry layer/pLevel — membership is determined by array index
 * + layerEnds in ContextGenerationV1. Identity comes from contextUnitId
 * (stable across rebuilds), not array index (which is generation-local).
 *
 * Replaces the deprecated `ContextSourceSnapshot` / `PreparedContextSources`
 * per-unit projections.
 */
export interface ContextUnitV1 {
  /** Stable identity (same as the source ContextMessageUnit or source ref). */
  readonly contextUnitId: string;
  /** Location of this unit's slot in P0-P5 is structural (array index +
   * layerEnds), not carried on the unit. Reference to the authoritative source
   * that produced this unit; NOT persisted on the unit. */
  readonly sourceRef: ContextUnitSourceRefV1;
  /** Content for provider rendering. */
  readonly content: ContextUnitContent;
}

/**
 * Reference to the authoritative source that produced a generation unit.
 */
export interface ContextUnitSourceRefV1 {
  /** Source-specific identity (e.g. systemPromptId, personaId, memoryRef, contextUnitId). */
  readonly sourceId: string;
  /** Optional content hash for verification. */
  readonly sourceHash?: string;
}

/**
 * The content payload of a generation unit.
 */
export interface ContextUnitContent {
  /** Provider-renderable text or structured content. */
  readonly body: string;
  /** Content hash for provenance. */
  readonly contentHash: string;
}

/**
 * A validated, in-memory Context generation. The provider cache that is
 * rebuilt from authoritative sources by the canonical BUST pipeline.
 *
 * - layerEnds[6] defines P0-P5 as contiguous index ranges:
 *   P0 = units[0 : layerEnds[0])
 *   P1 = units[layerEnds[0] : layerEnds[1])
 *   ...
 *   P5 = units[layerEnds[4] : layerEnds[5])
 * - Constraint: 0 <= e0 <= e1 <= e2 <= e3 <= e4 <= e5 == units.length
 * - Units do NOT carry layer/pLevel — it's structural from index + layerEnds.
 * - NOT persisted as a whole snapshot; rebuilt from durable sources.
 */
export interface ContextGenerationV1 {
  readonly layerEnds: readonly [number, number, number, number, number, number];
  readonly units: readonly ContextUnitV1[];
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
 * Validate that a ContextGenerationV1 satisfies the v27 layerEnds constraint:
 * 0 <= e0 <= e1 <= e2 <= e3 <= e4 <= e5 == units.length
 */
export function validateGeneration(generation: ContextGenerationV1): boolean {
  const [e0, e1, e2, e3, e4, e5] = generation.layerEnds;
  const len = generation.units.length;
  return 0 <= e0 && e0 <= e1 && e1 <= e2 && e2 <= e3 && e3 <= e4 && e4 <= e5 && e5 === len;
}
