import { createHash } from "node:crypto";

import type { SessionProjectionUnit, ProjectedLogicalUnits } from "./projection.js";

/**
 * R2 Feature 6 — Protected tail & tool-arc fences.
 *
 * Authority: OpenCode Magic Context v0.33.0 protected-tail-boundary.ts
 * (commit 48ab531d), algorithmically ported to Iris's raw-entry projection.
 *
 * The protected tail is the newest suffix of the current Runtime Session that
 * MUST be presented to the provider verbatim: from the last safe real-user
 * anchor forward, all logical units (input pairs, tool arcs, reasoning) are
 * protected. The FOLD head is everything before that anchor, bounded by the
 * dynamic token target N.
 *
 * Fences (never cut through):
 *  - a sealed tool arc (assistant toolCall → its ToolResult) is atomic;
 *  - an incomplete tool arc (open, unsealed) is protected — never folded;
 *  - a reasoning unit (thinking part) is atomic — never spliced mid-seam;
 *  - a compaction/branch boundary is atomic.
 *
 * All constants below are locked from the authority's golden fixture set
 * (see evidence/context-golden/provenance.md) so parity is byte-verifiable.
 */

// --- Authority-locked constants (protected-tail-boundary.ts) ---
export const ALPHA = 0.3;
export const FLOOR_RATIO = 0.08;
export const FLOOR_MIN = 2_000;
export const FLOOR_MAX = 12_000;
export const ABS_CAP = 96_000;
export const MAX_USABLE_RATIO = 0.4;
export const RESERVED_HEADROOM_MIN = 1_000;
export const RESERVED_HEADROOM_RATIO = 0.02;
export const NON_EMERGENCY_MAX_CAP = 250_000;
export const FORCE80_MAX_CAP = 500_000;
export const FORCE95_MAX_CAP = 750_000;
export const NORMAL_HYSTERESIS_TOKENS = 256;
export const RECOVERY_NO_HEAD_LIMIT = 2;
export const MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1_000;

// trigger-budget derivation (derive-budgets.ts, authority-locked)
const TRIGGER_BUDGET_PERCENTAGE = 0.05;
const TRIGGER_BUDGET_MIN = 5_000;
const TRIGGER_BUDGET_MAX = 50_000;

export interface ProtectedTailTokenTarget {
  usable: number;
  rawN: number;
  floorN: number;
  ceilingN: number;
  effectiveFloor: number;
  N: number;
  headroom: number;
  triggerBudget: number;
  reserve: number;
}

export interface ProtectedTailPlan {
  /** Raw entry seq (1-based) of the last safe real-user anchor, or null when
   * the projection has no verified input (fail-conservative: fold nothing). */
  lastSafeUserAnchorEntrySeq: number | null;
  /** First raw entry seq included in the protected tail (inclusive). */
  protectedTailStartEntrySeq: number;
  /** Last raw entry seq allowed to be folded (inclusive; < tail start). */
  headEndEntrySeq: number;
  /** Dynamic token target N (authority deriveProtectedTailTokenTarget). */
  tokenTarget: number;
  /** True when the head boundary was pulled back onto a fence (atomic unit). */
  fenced: boolean;
  /** True when an atomic head unit alone exceeds the cap. */
  oversizeAtomicUnit: boolean;
  /** Hysteresis applied: boundary unchanged from the previous plan. */
  hysteresisHeld: boolean;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Authority deriveTriggerBudget (derive-budgets.ts). */
export function deriveTriggerBudget(
  mainContextLimit: number,
  executeThresholdPercentage: number,
): number {
  if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
    return TRIGGER_BUDGET_MIN;
  }
  const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
  const usable = mainContextLimit * thresholdFraction;
  const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
  return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

/** Authority deriveProtectedTailTokenTarget (protected-tail-boundary.ts). */
export function deriveProtectedTailTokenTarget(args: {
  contextLimit: number;
  executeThresholdPercentage: number;
  usagePercentage: number;
  triggerBudget?: number;
}): ProtectedTailTokenTarget {
  const safeContextLimit =
    Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128_000;
  const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
    ? Math.max(0, args.executeThresholdPercentage)
    : 65;
  const usable = Math.max(1, Math.round((safeContextLimit * safeThreshold) / 100));
  const usage = clampPercentage(args.usagePercentage);
  const triggerBudget = args.triggerBudget ?? deriveTriggerBudget(safeContextLimit, safeThreshold);
  const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
  const rawN = Math.round(usable * ALPHA * (1 - usage / 100));
  const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
  const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5));
  const ceilingN = Math.max(
    1,
    Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom),
  );
  const effectiveFloor = Math.min(floorN, ceilingN);
  const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN));
  return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve };
}

/** Authority deriveMinForceEligibleTokens. */
export function deriveMinForceEligibleTokens(scaledN: number): number {
  return Math.min(MIN_FORCE_ELIGIBLE_TOKENS_CAP, Math.max(1, Math.floor(scaledN / 8)));
}

/** Authority nonEmergencyPerRunCap. */
export function nonEmergencyPerRunCap(usable: number, N: number): number {
  return Math.min(
    NON_EMERGENCY_MAX_CAP,
    Math.max(2 * N, Math.min(Math.round(0.25 * usable), 100_000)),
  );
}

/** Authority force80PerRunCap (usage >= 80). */
export function force80PerRunCap(usable: number, N: number): number {
  return Math.min(FORCE80_MAX_CAP, Math.max(3 * N, Math.min(Math.round(0.35 * usable), 150_000)));
}

/** Authority force95PerRunCap (usage >= 95). */
export function force95PerRunCap(usable: number, N: number): number {
  return Math.min(FORCE95_MAX_CAP, Math.max(4 * N, Math.min(Math.round(0.5 * usable), 250_000)));
}

/** Authority selectPerRunCap (pressure-gated tool reclaim). */
export function selectPerRunCap(args: {
  contextLimit: number;
  executeThresholdPercentage: number;
  usagePercentage: number;
  N: number;
}): number {
  const usable = Math.max(
    1,
    Math.round((args.contextLimit * args.executeThresholdPercentage) / 100),
  );
  if (args.usagePercentage >= 95) return force95PerRunCap(usable, args.N);
  if (args.usagePercentage >= 80) return force80PerRunCap(usable, args.N);
  return nonEmergencyPerRunCap(usable, args.N);
}

/**
 * Walk raw-entry token counts from the END of the session and return the
 * first raw entry seq whose suffix (itself..end) reaches `targetTokens`.
 * Mirrors authority findSuffixStartForTokens. Returns entries.length+1 when
 * the whole session is below target (i.e. fold nothing beyond the start).
 */
export function findSuffixStartForTokens(rawTokenCounts: number[], targetTokens: number): number {
  if (targetTokens <= 0) return rawTokenCounts.length + 1;
  let acc = 0;
  for (let index = rawTokenCounts.length - 1; index >= 0; index -= 1) {
    const tokens = rawTokenCounts[index];
    if (tokens === undefined) continue;
    acc += tokens;
    if (acc >= targetTokens) return index + 1;
  }
  return 1;
}

function unitEntrySeq(unit: SessionProjectionUnit): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.startEntrySeq;
    default:
      return unit.entrySeq;
  }
}

/** An OPEN (incomplete) tool arc — an assistant with toolCallIds whose callId
 * never resolves to a ToolResult. Detected by callId set difference (the
 * projection only emits sealed tool_arc units; unresolved calls remain as
 * assistant units carrying toolCallIds). */
export function openToolCallIds(
  units: SessionProjectionUnit[],
): Array<{ assistantEntrySeq: number; callId: string }> {
  const resolved = new Set<string>();
  for (const unit of units) {
    if (unit.kind === "tool_arc" || unit.kind === "tool_result") {
      resolved.add(unit.toolCallId);
    }
  }
  const open: Array<{ assistantEntrySeq: number; callId: string }> = [];
  for (const unit of units) {
    if (unit.kind !== "assistant") continue;
    for (const callId of unit.toolCallIds) {
      if (!resolved.has(callId)) {
        open.push({ assistantEntrySeq: unit.entrySeq, callId });
      }
    }
  }
  return open;
}

export interface EstimateTokensArgs {
  units: SessionProjectionUnit[];
  /** Per-unit token estimates aligned by index; falls back to 512/unit. */
  unitTokenCounts?: number[];
}

/**
 * Build the protected-tail plan for the current Runtime Session.
 *
 * @param projection the current-Session logical projection
 * @param tokenTarget the dynamic token target N (deriveProtectedTailTokenTarget)
 * @param opts.unitTokenCounts optional per-unit token estimates
 * @param opts.previousPlan protectedTailStartEntrySeq from the previous pass
 *   for hysteresis (authority NORMAL_HYSTERESIS_TOKENS)
 * @param opts.usagePercentage context usage 0-100 (authority usagePercentage)
 * @param opts.emergencyTailScale emergency tail scale factor (authority
 *   emergencyTailScale). When set (emergency path) the routine live-user
 *   anchor floor is LIFTED so a sparse session stays compactable under
 *   genuine pressure (authority #132; protected-tail-boundary.ts "Live-prompt
 *   floor" comment).
 */
export function resolveProtectedTail(
  projection: ProjectedLogicalUnits,
  tokenTarget: number,
  opts: {
    unitTokenCounts?: number[];
    previousPlan?: ProtectedTailPlan;
    usagePercentage?: number;
    emergencyTailScale?: number;
  } = {},
): ProtectedTailPlan {
  const { units } = projection;
  const counts = opts.unitTokenCounts ?? units.map(() => 512); // conservative per-unit default
  const usagePercentage = opts.usagePercentage ?? 0;
  const isEmergency = opts.emergencyTailScale !== undefined;
  // Authority live-prompt floor exemption: on routine (non-emergency) passes
  // with usage < 80 the floor is enforced; at force pressure (>=80%) or on
  // the emergency-scaled path the floor is lifted so the eligible head can be
  // reclaimed (sparse #132 session stays compactable).
  const anchorFloorActive = !isEmergency && usagePercentage < 80;
  if (units.length === 0) {
    return {
      lastSafeUserAnchorEntrySeq: null,
      protectedTailStartEntrySeq: 1,
      headEndEntrySeq: 0,
      tokenTarget,
      fenced: false,
      oversizeAtomicUnit: false,
      hysteresisHeld: false,
    };
  }

  // 1. Last safe real-user anchor = newest VERIFIED input unit (issue #6
  //    pairing basis). Unverified/orphan inputs are never anchors.
  let anchorUnitIndex: number | null = null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit?.kind === "input" && unit.verified === true) {
      anchorUnitIndex = index;
    }
  }
  const anchorUnit = anchorUnitIndex === null ? undefined : units[anchorUnitIndex];
  const anchorSeq = anchorUnit === undefined ? null : unitEntrySeq(anchorUnit);

  // 2. Suffix walk from the end (unit-aligned counts): the newest N tokens
  //    form the tail. findSuffixStartForTokens returns a 1-based UNIT
  //    position — clamp to [1, units.length].
  let tailStartUnitIndex = Math.min(
    units.length,
    Math.max(1, findSuffixStartForTokens(counts, tokenTarget)),
  );
  // 3. Routine live-user floor (authority "Live-prompt floor"): on routine
  //    non-emergency passes with usage < 80 the tail always covers the last
  //    safe real-user anchor AND everything after it (newest todo/tool state
  //    is protected; the anchor input pair itself is included). The floor is
  //    LIFTED at force pressure (>=80%) or on the emergency-scaled path so a
  //    sparse session stays compactable (authority #132).
  if (anchorUnitIndex !== null && anchorFloorActive) {
    tailStartUnitIndex = Math.min(tailStartUnitIndex, anchorUnitIndex + 1);
  }

  // 4. Fence — authority fenceBoundaryForToolArcs semantics, in entrySeq
  //    space:
  //    - SEALED arc: when the boundary falls INSIDE [arcStart, arcEnd] the
  //      arc is pushed wholly into the head (boundary = arcEnd + 1). Its
  //      ToolResult is already persisted, so folding the whole range is safe
  //      (no wire-dangling tool_use); a boundary at/before arcStart or
  //      after arcEnd needs no move.
  //    - OPEN arc (in-flight invocation): a boundary at/after the invocation
  //      is pulled back to the invocation start so the current call is
  //      protected (authority: an open arc inside the live window fences).
  const boundaryUnit = units[tailStartUnitIndex - 1] ?? units[0];
  let boundary = boundaryUnit === undefined ? 1 : unitEntrySeq(boundaryUnit);
  let fenced = false;

  // 4a. Sealed arcs: push the boundary forward (into the head) when it lands
  //     inside a sealed arc's raw span.
  for (const unit of units) {
    if (unit.kind !== "tool_arc" || unit.sealed !== true) continue;
    const start = unit.entryRange.startEntrySeq;
    const end = unit.entryRange.endEntrySeq;
    if (start < boundary && boundary <= end) {
      boundary = end + 1;
      fenced = true;
    }
  }

  // 4b. Open arcs: pull the boundary back to the invocation start when the
  //     in-flight call sits at/after the current boundary.
  for (const open of openToolCallIds(units)) {
    if (open.assistantEntrySeq >= boundary) {
      boundary = open.assistantEntrySeq;
      fenced = true;
    }
  }

  // 5. Hysteresis (authority NORMAL_HYSTERESIS_TOKENS=256): hold the previous
  //    boundary when the boundary move is a small churn. Note: the authority
  //    measures the eligible head's TOKEN total against 256; Iris compares the
  //    boundary ENTRY-SEQ delta as its per-unit token budget proxy (reviewer
  //    F3 — acknowledged deviation, kept simple; token-accurate hysteresis is
  //    deferred to the fold-path integration in R3).
  let hysteresisHeld = false;
  if (opts.previousPlan !== undefined && opts.previousPlan.protectedTailStartEntrySeq > 0) {
    const prev = opts.previousPlan.protectedTailStartEntrySeq;
    if (Math.abs(boundary - prev) < NORMAL_HYSTERESIS_TOKENS) {
      boundary = prev;
      hysteresisHeld = true;
    }
  }

  const headEnd = boundary - 1;
  // Oversize atomic unit: the first unit of the tail (at the boundary) alone
  // exceeds the fold budget — the fold cannot satisfy the token target
  // without cutting an atomic unit (authority oversizeAtomicUnit, adapted:
  // authority compares the first ELIGIBLE HEAD message against the per-run
  // cap; Iris compares the first tail unit against the token target N —
  // reviewer F4, acknowledged difference).
  let oversizeAtomicUnit = false;
  const firstTailUnit = units.find((u) => unitEntrySeq(u) >= boundary);
  if (firstTailUnit !== undefined) {
    const index = units.indexOf(firstTailUnit);
    const tokens = index >= 0 ? (counts[index] ?? 0) : 0;
    if (tokens > tokenTarget) {
      oversizeAtomicUnit = true;
    }
  }

  return {
    lastSafeUserAnchorEntrySeq: anchorSeq,
    protectedTailStartEntrySeq: Math.max(1, boundary),
    headEndEntrySeq: Math.max(0, headEnd),
    tokenTarget,
    fenced,
    oversizeAtomicUnit,
    hysteresisHeld,
  };
}

/** sha256 fingerprint of the protected-tail plan identity (deterministic). */
export function protectedTailFingerprint(plan: ProtectedTailPlan): string {
  return createHash("sha256")
    .update(
      [
        plan.lastSafeUserAnchorEntrySeq ?? "null",
        plan.protectedTailStartEntrySeq,
        plan.headEndEntrySeq,
        plan.tokenTarget,
        plan.fenced ? "1" : "0",
      ].join("\0"),
    )
    .digest("hex");
}
