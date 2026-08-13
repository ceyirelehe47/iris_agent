// MIGRATION ONLY — Not part of current production Context path per Notion v27.
import { createHash } from "node:crypto";

import type { AgentMessage, SessionTreeEntry } from "@iris/pi-agent-core";

import type { ContextStore, ContextLineage } from "./context-store.js";
import { projectLogicalUnits, type ProjectedLogicalUnits } from "./projection.js";
import { buildCarriers, type BuiltCarrier } from "./carriers.js";
import { decidePass, type PassClassification } from "./pass-taxonomy.js";
import {
  resolveProtectedTail,
  deriveProtectedTailTokenTarget,
  type ProtectedTailPlan,
} from "./protected-tail.js";
import { runReplay, type ReplayResult, type ReplayWatermarks } from "./replay.js";

/**
 * Iris Host product-path Context pipeline (R2 Feature 9).
 *
 * Composes the reviewed Context capability layers into ONE transform pass the
 * Host's `context` event can call:
 *
 *   projection (P0-P5 logical units)
 *     → pass taxonomy (SOFT+/SOFT/HARD decision against the persisted lineage)
 *     → protected-tail plan (boundary + fences)
 *     → replay state machine (frozen reasoning/tool-reclaim suppression)
 *     → materialization decision (reuse / materialize m1 / rebuild m0+m1)
 *     → m0/m1 carriers (byte-stable provider-visible prefix)
 *
 * The decision is PURE: given (projection, lineage, signals) the same inputs
 * always produce the same output. Persistence (materializeM0/M1, watermarks,
 * emergency state) is applied by the caller via the returned `actions` so the
 * pipeline stays testable without a live store.
 *
 * R2 boundary: this wires the decision + carrier layers into the product
 * path. Historian folding of the m0 head, Compartment LLM production and
 * publication are R3.
 */

export interface ContextPassInput {
  runtimeSessionId: string;
  entries: SessionTreeEntry[];
  lineage: ContextLineage | undefined;
  /** System/persona/declaration identity of the CURRENT pass. */
  source: {
    contextSourceSnapshotId: string;
    personaSnapshotId: string;
    declarationVersion: string;
    providerProfileId: string;
    canonicalSystemPrompt: string;
    systemProjectionHash: string;
  };
  model: { provider: string; modelId: string };
  /** Context usage 0-100 (authority usagePercentage); 0 = unknown. */
  usagePercentage?: number;
  /** Context window limit tokens (authority contextLimit). */
  contextLimit?: number;
  /** Execute threshold percentage (authority executeThresholdPercentage). */
  executeThresholdPercentage?: number;
  /** Per-unit token estimates for the protected-tail suffix walk. */
  unitTokenCounts?: number[];
}

export interface ContextPassDecision {
  classification: PassClassification;
  /** Fresh projection of the current session. */
  projection: ProjectedLogicalUnits;
  protectedTail: ProtectedTailPlan;
  replay: ReplayResult;
  /** The materialization action the caller must persist. */
  action:
    | { kind: "reuse" }
    | { kind: "materialize_m1"; m1Body: string }
    | {
        kind: "materialize_m0";
        m0Body: string;
        m1Body: string;
        protectedTailStartEntrySeq: number;
        lastSafeUserAnchorEntrySeq: number | null;
        representedThroughEntrySeq: number;
        /** Current-pass identity recorded into cachedM0* on materialization
         * (the pass that materialized under these is the cache authority;
         * a later pass compares against them — reviewer F1). */
        cachedM0SystemHash: string;
        cachedM0ModelKey: string;
        cachedM0ProviderProfileId: string;
      };
  /** Provider-visible carriers (m0 + m1) to inject when materializing. */
  carriers: BuiltCarrier | undefined;
  /** Updated replay watermarks (only when detect results were committed). */
  nextWatermarks: ReplayWatermarks | undefined;
  /** Fail-closed escalation, when the pass must not proceed. */
  failClosed: "none" | "defer_blocked" | "transform_unavailable" | "emergency_fail_closed";
}

/**
 * Run one Context pass. Pure: no store writes, no Date.now() in the decision
 * path (materialization timestamps are supplied by the caller via `nowMs`).
 */
export function runContextPass(input: ContextPassInput): ContextPassDecision {
  const projection = projectLogicalUnits(input.runtimeSessionId, input.entries);
  const lineage = input.lineage;

  // Replay state machine runs BEFORE taxonomy: whether the wire is allowed
  // to change (wouldAdvanceLive) feeds the pass classification.
  const watermarks: ReplayWatermarks = lineage
    ? {
        clearedReasoningThroughTag: lineage.clearedReasoningThroughTag,
        toolReclaimWatermark: lineage.toolReclaimWatermark,
        mutationReplayWatermark: lineage.mutationReplayWatermark,
      }
    : {
        clearedReasoningThroughTag: 0,
        toolReclaimWatermark: 0,
        mutationReplayWatermark: 0,
      };
  const tokenTarget = deriveTokenTarget(input);
  const protectedTail = resolveProtectedTail(projection, tokenTarget, {
    ...(input.unitTokenCounts === undefined ? {} : { unitTokenCounts: input.unitTokenCounts }),
    ...(input.usagePercentage === undefined ? {} : { usagePercentage: input.usagePercentage }),
  });

  // Pass taxonomy against the persisted lineage. wouldAdvanceLive = the
  // projection has live content BEYOND what the last materialization already
  // represented (representedThroughEntrySeq) — a pure replay with nothing new
  // is SOFT+.
  const representedThrough = lineage?.representedThroughEntrySeq ?? 0;
  const liveDelta = projection.units.some((unit) => unitEndSeq(unit) > representedThrough);
  const pass = decidePass(
    lineage,
    {
      modelKey: `${input.model.provider}:${input.model.modelId}`,
      providerProfileId: input.source.providerProfileId,
      systemHash: input.source.systemProjectionHash,
      personaSnapshotId: input.source.personaSnapshotId,
      declarationVersion: input.source.declarationVersion,
    },
    { wouldAdvanceLive: liveDelta },
  );

  // DETECT only on a cache-busting pass (HARD or SOFT — the wire is allowed
  // to change).
  const detect = pass.classification === "HARD" || pass.classification === "SOFT";
  const replay = runReplay(projection, watermarks, {
    detect,
    protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
  });

  // Fail-closed: a defer pass (SOFT+) never runs DETECT (detect=false), so
  // nothing can be pending-committed on it — the replay layer already enforces
  // this. LKG invalidation escalation is the R3 wiring concern (Feature 9/10).
  if (pass.classification === "SOFT+") {
    assertReplayClean(replay);
  }

  // Materialization decision.
  const action = classifyAction(pass.classification, protectedTail);
  if (action.kind === "reuse") {
    return {
      classification: pass.classification,
      projection,
      protectedTail,
      replay,
      action,
      carriers: undefined,
      nextWatermarks: undefined,
      failClosed: "none",
    };
  }

  // A cache-busting pass commits newly-detected reclaims into the watermark.
  const nextWatermarks =
    replay.newlyReclaimedToolArcUnitIds.length > 0
      ? {
          clearedReasoningThroughTag: watermarks.clearedReasoningThroughTag,
          toolReclaimWatermark: Math.max(
            watermarks.toolReclaimWatermark,
            replay.newlyReclaimedMaxEndSeq,
          ),
          mutationReplayWatermark: watermarks.mutationReplayWatermark,
        }
      : undefined;

  if (action.kind === "materialize_m1") {
    return {
      classification: pass.classification,
      projection,
      protectedTail,
      replay,
      action,
      carriers: undefined,
      nextWatermarks,
      failClosed: "none",
    };
  }

  // HARD: rebuild m0 + reset m1. Carriers built from the projected prefix.
  const m0Body = renderM0Head(projection, protectedTail);
  const m1Body = ""; // reset; SOFT/HARD deltas accumulate in later passes.
  const carriers = buildCarriers({
    runtimeSessionId: input.runtimeSessionId,
    materializationId: `mat-${input.source.contextSourceSnapshotId}-${projection.projectionHash}`,
    providerProfileId: input.source.providerProfileId,
    m0Body,
    m1Body,
    atMs: 0, // deterministic; caller stamps on persistence
  });
  return {
    classification: pass.classification,
    projection,
    protectedTail,
    replay,
    action: {
      kind: "materialize_m0",
      m0Body,
      m1Body,
      protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
      lastSafeUserAnchorEntrySeq: protectedTail.lastSafeUserAnchorEntrySeq,
      // representedThrough = the projection's LAST entry seq: the pass
      // materialized m0/m1 covering the entire current projection, so an
      // identical second pass has no live delta → SOFT+ (authority
      // isCacheBustingPass:false semantics — reviewer F2).
      representedThroughEntrySeq: projection.toEntrySeq,
      cachedM0SystemHash: input.source.systemProjectionHash,
      cachedM0ModelKey: `${input.model.provider}:${input.model.modelId}`,
      cachedM0ProviderProfileId: input.source.providerProfileId,
    },
    carriers,
    nextWatermarks,
    failClosed: "none",
  };
}

function classifyAction(
  classification: PassClassification,
  protectedTail: ProtectedTailPlan,
): ContextPassDecision["action"] {
  switch (classification) {
    case "SOFT+":
      return { kind: "reuse" };
    case "SOFT":
      return { kind: "materialize_m1", m1Body: "" };
    case "HARD":
      // The HARD full action (with m0Body + cached identity) is constructed by
      // runContextPass after renderM0Head; this placeholder only satisfies the
      // union type before the branch is replaced. representedThrough uses the
      // projection's last entry seq so an identical pass resolves SOFT+.
      return {
        kind: "materialize_m0",
        m0Body: "",
        m1Body: "",
        protectedTailStartEntrySeq: protectedTail.protectedTailStartEntrySeq,
        lastSafeUserAnchorEntrySeq: protectedTail.lastSafeUserAnchorEntrySeq,
        representedThroughEntrySeq: 0,
        cachedM0SystemHash: "",
        cachedM0ModelKey: "",
        cachedM0ProviderProfileId: "",
      };
  }
}

/**
 * Deterministic m0 head rendering for R2: the stable prefix is the protected
 * tail's FOLDED head — but Historian folding is R3, so R2 materializes the
 * current projection's head text as the m0 body (a bounded, verifiable
 * snapshot). The live tail is rendered by the caller from the projection.
 */
function renderM0Head(projection: ProjectedLogicalUnits, protectedTail: ProtectedTailPlan): string {
  const headUnits = projection.units.filter(
    (unit) => unitEntrySeq(unit) <= protectedTail.headEndEntrySeq,
  );
  if (headUnits.length === 0) return "";
  const rendered = headUnits
    .map((unit) => {
      switch (unit.kind) {
        case "input":
          return `[input ${unit.entryRange.startEntrySeq}-${unit.entryRange.endEntrySeq}]`;
        case "assistant":
          return `[assistant ${unit.entrySeq}]`;
        case "tool_arc":
          return `[tool_arc ${unit.entryRange.startEntrySeq}-${unit.entryRange.endEntrySeq} ${unit.toolName}]`;
        case "tool_result":
          return `[tool_result ${unit.entrySeq} ${unit.toolName}]`;
        case "reasoning":
          return `[reasoning ${unit.entrySeq}]`;
        case "compaction_boundary":
          return `[compaction ${unit.entrySeq}]`;
        case "branch_boundary":
          return `[branch ${unit.entrySeq}]`;
        default:
          return `[unit ${unitEntrySeq(unit)}]`;
      }
    })
    .join("\n");
  return rendered;
}

function unitEntrySeq(unit: ProjectedLogicalUnits["units"][number]): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.startEntrySeq;
    default:
      return unit.entrySeq;
  }
}

function unitEndSeq(unit: ProjectedLogicalUnits["units"][number]): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.endEntrySeq;
    default:
      return unit.entrySeq;
  }
}

function deriveTokenTarget(input: ContextPassInput): number {
  // Reuse the authority-locked protected-tail token target (single source of
  // truth for N; includes ABS_CAP/FLOOR/headroom clamps — reviewer F1). The
  // usage percentage defaults to 0 when unknown (authority clampPercentage).
  return deriveProtectedTailTokenTarget({
    contextLimit: input.contextLimit ?? 0,
    executeThresholdPercentage: input.executeThresholdPercentage ?? 0,
    usagePercentage: input.usagePercentage ?? 0,
  }).N;
}

/**
 * Persist a materialization decision to the ContextStore. Throws on missing
 * lineage (fail closed). `nowMs` is supplied by the caller so the pipeline
 * stays deterministic.
 */
export function applyContextPass(
  store: ContextStore,
  runtimeSessionId: string,
  decision: ContextPassDecision,
  nowMs: number,
): void {
  if (decision.failClosed !== "none") {
    store.setEmergencyState(
      runtimeSessionId,
      decision.failClosed === "emergency_fail_closed"
        ? "emergency_fail_closed"
        : "transform_unavailable",
      `context pass blocked: ${decision.failClosed}`,
    );
    return;
  }
  switch (decision.action.kind) {
    case "reuse":
      break;
    case "materialize_m1": {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage?.m0Body === undefined || lineage.m0Body === null) {
        throw new Error(
          `applyContextPass materialize_m1: no materialized m0 for ${runtimeSessionId}`,
        );
      }
      const m1Body =
        decision.action.m1Body === ""
          ? "<session-history-since>(delta)</session-history-since>"
          : decision.action.m1Body;
      store.materializeM1({
        runtimeSessionId,
        m1Body,
        m1ContentHash: sha256(m1Body),
        // representedThrough = the projection's last entry seq (F2): m0/m1 now
        // cover the whole projection, so an identical pass is SOFT+.
        representedThroughEntrySeq: decision.projection.toEntrySeq,
        atMs: nowMs,
      });
      break;
    }
    case "materialize_m0": {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage === undefined) {
        throw new Error(`applyContextPass materialize_m0: no lineage for ${runtimeSessionId}`);
      }
      const m0Body =
        decision.action.m0Body === ""
          ? "<session-history></session-history>"
          : decision.action.m0Body;
      const m1Body =
        decision.action.m1Body === ""
          ? "<session-history-since>(no new content since last materialization)</session-history-since>"
          : decision.action.m1Body;
      store.materializeM0({
        runtimeSessionId,
        m0Body,
        m1Body,
        m0ContentHash: sha256(m0Body),
        m1ContentHash: sha256(m1Body),
        atMs: nowMs,
        // F1: record the CURRENT pass identity as the cache authority —
        // the m0 cache was built under these; a later pass compares against
        // them (model/system/provider change → HARD).
        cachedM0SystemHash: decision.action.cachedM0SystemHash,
        cachedM0ModelKey: decision.action.cachedM0ModelKey,
        cachedM0ProviderProfileId: decision.action.cachedM0ProviderProfileId,
        representedThroughEntrySeq: decision.action.representedThroughEntrySeq,
        protectedTailStartEntrySeq: decision.action.protectedTailStartEntrySeq,
        lastSafeUserAnchorEntrySeq: decision.action.lastSafeUserAnchorEntrySeq ?? 0,
      });
      break;
    }
  }
  if (decision.nextWatermarks !== undefined) {
    // Persist advanced replay watermarks (single-row update; monotonic).
    const lineage = store.getLineage(runtimeSessionId);
    if (lineage !== undefined) {
      const next = decision.nextWatermarks;
      if (
        next.toolReclaimWatermark > lineage.toolReclaimWatermark ||
        next.clearedReasoningThroughTag > lineage.clearedReasoningThroughTag
      ) {
        store.persistWatermarks(runtimeSessionId, next);
      }
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Defensive invariant: a defer pass must never produce pending detect
 * results (detect is off, so this can only trip on a bug). */
function assertReplayClean(replay: ReplayResult): void {
  if (replay.newlyReclaimedToolArcUnitIds.length > 0) {
    throw new Error(
      `context pipeline invariant violated: SOFT+ pass produced pending detect results (${replay.newlyReclaimedToolArcUnitIds.length})`,
    );
  }
}

/** Provider-visible output: carriers + the live tail (R2 raw-message
 * passthrough elimination — the live tail is the projected view, not raw
 * transcript copies). */
export function renderProviderVisible(
  decision: ContextPassDecision,
  liveTailFrom: ProjectedLogicalUnits,
): { messages: AgentMessage[] } {
  const messages: AgentMessage[] = [];
  if (decision.carriers !== undefined) {
    messages.push(decision.carriers.m0 as unknown as AgentMessage);
    messages.push(decision.carriers.m1 as unknown as AgentMessage);
  }
  // Live tail: every unit strictly after the protected tail start is emitted
  // as a synthetic provider-visible message with its unit id.
  for (const unit of liveTailFrom.units) {
    if (unitEntrySeq(unit) < decision.protectedTail.protectedTailStartEntrySeq) continue;
    messages.push({
      role: "custom",
      customType: "iris_context_carrier",
      content: `[live ${unit.kind} ${unitEntrySeq(unit)}]`,
      display: false,
      details: { irisContext: { surface: "live", unitId: unit.unitId } },
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  return { messages };
}
