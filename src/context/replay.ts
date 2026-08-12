// MIGRATION ONLY — Not part of current production Context path per Notion v27.
import { createHash } from "node:crypto";

import type { ProjectedLogicalUnits } from "./projection.js";

/**
 * Iris reasoning/drop/mutation/invalidation replay state machine (R2 Feature 8).
 *
 * Every pass of the provider-visible transform must REPLAY the persisted
 * decisions from prior passes so the wire is byte-identical on defer passes
 * (SOFT+ contract) and only advances on cache-busting passes.
 *
 * Semantics ported from the locked OpenCode authority (magic-context @
 * 48ab531d):
 * - drop-stale-reduce-calls.ts: the REPLAY/DETECT split. REPLAY strips the
 *   FROZEN id set on every pass (growth-invariant, byte-identical); DETECT
 *   (cache-busting passes only) scans the pre-protected region for NEWLY aged
 *   targets and returns their ids so the caller advances the persisted
 *   watermark. A message without a stable id is never newly detected.
 * - emergency-drop.ts: the idempotence latch (same-input-sample no-op) and
 *   the fixedFloor/tier model are the R3 emergency path; R2 keeps only the
 *   watermark semantics + fail-closed escalation here.
 *
 * R2 scope: pure decision layer + tests. Wiring into the transform is the R3
 * Historian integration (Feature 9/10 gate).
 */

export interface ReplayWatermarks {
  /** Reasoning cleared through this tag (entrySeq). REPLAY every pass. */
  clearedReasoningThroughTag: number;
  /** Tool-arc reclaim watermark (max endEntrySeq frozen). REPLAY every pass. */
  toolReclaimWatermark: number;
  /** Mutation replay watermark (deferred op seq). REPLAY every pass. */
  mutationReplayWatermark: number;
}

export interface ReplayResult {
  /** Reasoning unit ids suppressed by the cleared-reasoning watermark. */
  suppressedReasoningUnitIds: string[];
  /** Tool-arc unit ids suppressed by the reclaim watermark. */
  reclaimedToolArcUnitIds: string[];
  /**
   * Tool arcs NEWLY aged past the reclaim window on this pass — only
   * populated when detect=true and the arc's END sits strictly below the
   * protected tail. The caller commits these (advancing the watermark) only
   * on a cache-busting pass.
   */
  newlyReclaimedToolArcUnitIds: string[];
  /** Max endEntrySeq among newly-reclaimed arcs (0 when none). */
  newlyReclaimedMaxEndSeq: number;
  /** True if any suppression applied this pass. */
  didSuppress: boolean;
  /** Deterministic hash over the applied replay decisions. */
  replayHash: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Run the replay state machine over a projection.
 *
 * REPLAY semantics (always, every pass):
 * - reasoning units with entrySeq <= clearedReasoningThroughTag are suppressed
 *   (they were cleared on a prior pass; re-suppressing keeps the wire stable);
 * - tool arcs whose endEntrySeq <= toolReclaimWatermark are suppressed
 *   (frozen reclaim set, growth-invariant).
 *
 * DETECT semantics (detect=true, cache-busting passes only):
 * - tool arcs whose end is strictly below the caller-provided
 *   protectedTailStartEntrySeq AND above the current watermark are newly aged
 *   and returned in newlyReclaimedToolArcUnitIds so the caller advances the
 *   watermark. Units at/inside the protected tail are never detected (they
 *   are live continuation context — authority dropStaleReduceCalls
 *   protectedCount).
 */
export function runReplay(
  projection: ProjectedLogicalUnits,
  watermarks: ReplayWatermarks,
  opts: {
    detect?: boolean;
    /** Protected-tail start (entrySeq). Detect only below this. */
    protectedTailStartEntrySeq?: number;
  } = {},
): ReplayResult {
  const detect = opts.detect ?? false;
  const protectedStart = opts.protectedTailStartEntrySeq ?? Number.POSITIVE_INFINITY;
  const suppressedReasoningUnitIds: string[] = [];
  const reclaimedToolArcUnitIds: string[] = [];
  const newlyReclaimedToolArcUnitIds: string[] = [];
  let newlyReclaimedMaxEndSeq = 0;
  let didSuppress = false;

  for (const unit of projection.units) {
    if (unit.kind === "reasoning") {
      if (unit.entrySeq <= watermarks.clearedReasoningThroughTag) {
        suppressedReasoningUnitIds.push(unit.unitId);
        didSuppress = true;
      }
      continue;
    }
    if (unit.kind === "tool_arc") {
      const endSeq = unit.entryRange.endEntrySeq;
      if (endSeq <= watermarks.toolReclaimWatermark) {
        reclaimedToolArcUnitIds.push(unit.unitId);
        didSuppress = true;
        continue;
      }
      // DETECT: a tool arc that has aged past the reclaim window but is NOT
      // yet frozen, and sits entirely below the protected tail. Only
      // meaningful when the caller is on a cache-busting pass.
      if (detect && endSeq < protectedStart) {
        newlyReclaimedToolArcUnitIds.push(unit.unitId);
        newlyReclaimedMaxEndSeq = Math.max(newlyReclaimedMaxEndSeq, endSeq);
      }
    }
  }

  // Deterministic replay hash: the decisions must be byte-identical on defer
  // passes. Include suppressed ids in order + the watermark snapshot.
  const replayHash = sha256(
    JSON.stringify({
      clearedReasoningThroughTag: watermarks.clearedReasoningThroughTag,
      toolReclaimWatermark: watermarks.toolReclaimWatermark,
      suppressedReasoningUnitIds,
      reclaimedToolArcUnitIds,
    }),
  );

  return {
    suppressedReasoningUnitIds,
    reclaimedToolArcUnitIds,
    newlyReclaimedToolArcUnitIds,
    newlyReclaimedMaxEndSeq,
    didSuppress,
    replayHash,
  };
}

/**
 * Advance the watermarks after a cache-busting pass. The caller persists the
 * result; detect results are only committed when the wire is allowed to
 * change (a HARD/SOFT pass), never on a defer (SOFT+) pass.
 */
export function advanceWatermarks(
  current: ReplayWatermarks,
  opts: {
    /** Max endEntrySeq among newly reclaimed arcs this pass. */
    newlyReclaimedMaxEndSeq?: number;
    /** Next reasoning tag to clear through (entrySeq), if any. */
    clearedReasoningThroughTag?: number;
    /** Highest deferred op seq replayed this pass. */
    mutationReplayWatermark?: number;
  },
): ReplayWatermarks {
  return {
    clearedReasoningThroughTag: Math.max(
      current.clearedReasoningThroughTag,
      opts.clearedReasoningThroughTag ?? 0,
    ),
    toolReclaimWatermark: Math.max(current.toolReclaimWatermark, opts.newlyReclaimedMaxEndSeq ?? 0),
    mutationReplayWatermark: Math.max(
      current.mutationReplayWatermark,
      opts.mutationReplayWatermark ?? 0,
    ),
  };
}

/**
 * Fail-closed escalation classification (authority emergency-drop latch +
 * LKG invalidation). Returns "ok" when the replay is consistent, or the
 * emergency state the transform must enter.
 */
export function classifyReplayFailure(opts: {
  /** LKG replay failed this pass (invalidated reshape / model mismatch). */
  lkgInvalid?: boolean;
  /** True when the current pass is a defer (SOFT+) pass. */
  deferPass: boolean;
  /** True when a newly-detected reclaim would need a cache bust. */
  pendingDetect: boolean;
}): "ok" | "defer_blocked" | "transform_unavailable" | "emergency_fail_closed" {
  if (opts.lkgInvalid && opts.deferPass) {
    // A defer pass must replay byte-identical; an invalid LKG means the
    // cached prefix is no longer authoritative — fail closed rather than
    // emit a mutated wire.
    return "emergency_fail_closed";
  }
  if (opts.lkgInvalid) {
    return "transform_unavailable";
  }
  if (opts.pendingDetect && opts.deferPass) {
    // Detect results must never be committed on a defer pass.
    return "defer_blocked";
  }
  return "ok";
}
