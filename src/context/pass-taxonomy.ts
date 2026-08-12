// MIGRATION ONLY — Not part of current production Context path per Notion v27.
import { createHash } from "node:crypto";

import type { ContextLineage } from "./context-store.js";
import { CARRIER_SCHEMA_VERSION } from "./carriers.js";

/**
 * SOFT+ / SOFT / HARD pass taxonomy (01 Context Assembly — Pass Taxonomy,
 * authority: OpenCode v0.33.0 mustMaterialize).
 *
 *  SOFT+  source/materialization identity unchanged; system/m0/m1 replay
 *         byte-identical; only the current-invocation live delta is appended;
 *         no new drop/reasoning decision.
 *  SOFT   system + m0 unchanged; m1 re-renders (additive/mutation state);
 *         deferred-signal ordering preserved.
 *  HARD   rebuild m0, fold m1 in, re-run decay/tier rendering, update
 *         provider/serializer/materialization epoch, capture a new LKG.
 *
 * HARD reasons (authority mustMaterialize + spec): model_change, system_hash,
 * provider_profile, serializer/carrier version, persona/P2, cache epoch
 * (ttl_idle), context pressure, manual maintenance, baseline structural
 * change. An ordinary ToolResult must NEVER trigger a P0/P1/P2 rebuild.
 */

export type PassClassification = "SOFT+" | "SOFT" | "HARD";

export type HardReason =
  | "first_render"
  | "cached_m1_missing"
  | "model_change"
  | "system_hash"
  | "provider_profile_change"
  | "serializer_change"
  | "carrier_schema_change"
  | "persona_change"
  | "declaration_change"
  | "ttl_idle"
  | "context_pressure"
  | "manual_maintenance";

export interface HardSignals {
  systemHash?: string;
  modelKey?: string;
  providerProfileId?: string;
  contextSerializerVersion?: string;
  carrierSchemaVersion?: string;
  personaSnapshotId?: string;
  declarationVersion?: string;
  cacheExpired?: boolean;
  lastResponseTime?: number;
  manualMaintenance?: boolean;
  contextPressure?: boolean;
}

export interface PassDecision {
  classification: PassClassification;
  /** HARD reason, when classification === "HARD". */
  reason: HardReason | null;
  /** True when this pass advances m0 (HARD) or m1 (SOFT). */
  advancesMaterialization: boolean;
}

const DEFAULT_CARRIER_SCHEMA = CARRIER_SCHEMA_VERSION;

/**
 * Decide the pass classification for a transform pass over a persisted
 * lineage. Authority semantics:
 *  - never materialized → HARD (first_render);
 *  - cached m1 missing → HARD (cached_m1_missing);
 *  - an EMPTY current HARD signal is never a change ("" means "no signal");
 *  - ttl_idle folds ONCE (only when lastResponseTime > m0MaterializedAt);
 *  - ordinary additive state (no HARD signal) → SOFT (m1 re-render);
 *  - pure replay with identical identity and no new state → SOFT+.
 *
 * @param wouldAdvanceLive true when the caller has new live delta to append
 *   (assistant/toolResult). If false AND no HARD signal AND m0/m1 exist AND
 *   identity unchanged → SOFT+ (byte-identical replay).
 */
export function decidePass(
  lineage: ContextLineage | undefined,
  hard: HardSignals,
  options: { wouldAdvanceLive: boolean },
): PassDecision {
  if (lineage?.m0Body === null || lineage?.m0Body === undefined) {
    return { classification: "HARD", reason: "first_render", advancesMaterialization: true };
  }
  if (lineage.m1Body === null || lineage.m1Body === undefined) {
    return { classification: "HARD", reason: "cached_m1_missing", advancesMaterialization: true };
  }

  // HARD: provider-side cache eviction — fold is "free" while re-caching.
  // Empty current signal never treated as a change.
  if (hard.modelKey !== "" && hard.modelKey !== undefined) {
    if (hard.modelKey !== (lineage.cachedM0ModelKey ?? "")) {
      return { classification: "HARD", reason: "model_change", advancesMaterialization: true };
    }
  }
  if (hard.systemHash !== "" && hard.systemHash !== undefined) {
    if (hard.systemHash !== (lineage.cachedM0SystemHash ?? "")) {
      return { classification: "HARD", reason: "system_hash", advancesMaterialization: true };
    }
  }
  if (hard.providerProfileId !== "" && hard.providerProfileId !== undefined) {
    if (
      hard.providerProfileId !== (lineage.cachedM0ProviderProfileId ?? lineage.providerProfileId)
    ) {
      return {
        classification: "HARD",
        reason: "provider_profile_change",
        advancesMaterialization: true,
      };
    }
  }
  if (hard.contextSerializerVersion !== "" && hard.contextSerializerVersion !== undefined) {
    if (hard.contextSerializerVersion !== lineage.contextSerializerVersion) {
      return { classification: "HARD", reason: "serializer_change", advancesMaterialization: true };
    }
  }
  if (hard.carrierSchemaVersion !== "" && hard.carrierSchemaVersion !== undefined) {
    if (hard.carrierSchemaVersion !== (lineage.carrierSchemaVersion ?? DEFAULT_CARRIER_SCHEMA)) {
      return {
        classification: "HARD",
        reason: "carrier_schema_change",
        advancesMaterialization: true,
      };
    }
  }
  if (hard.personaSnapshotId !== "" && hard.personaSnapshotId !== undefined) {
    if (hard.personaSnapshotId !== lineage.personaSnapshotId) {
      return { classification: "HARD", reason: "persona_change", advancesMaterialization: true };
    }
  }
  if (hard.declarationVersion !== "" && hard.declarationVersion !== undefined) {
    if (hard.declarationVersion !== lineage.declarationVersion) {
      return {
        classification: "HARD",
        reason: "declaration_change",
        advancesMaterialization: true,
      };
    }
  }
  // Authority semantics (inject-compartments.ts mustMaterialize): ttl_idle
  // folds ONLY on a genuine current-flight signal — lastResponseTime present
  // AND > 0 AND > m0MaterializedAt. An absent current signal is never a
  // change, so lineage.lastResponseTime is NOT consulted (reviewer F2).
  if (hard.cacheExpired === true) {
    const lastResponse = hard.lastResponseTime;
    const materializedAt = lineage.m0MaterializedAt ?? 0;
    if (lastResponse !== undefined && lastResponse > 0 && lastResponse > materializedAt) {
      return { classification: "HARD", reason: "ttl_idle", advancesMaterialization: true };
    }
  }
  if (hard.manualMaintenance === true) {
    return { classification: "HARD", reason: "manual_maintenance", advancesMaterialization: true };
  }
  if (hard.contextPressure === true) {
    return { classification: "HARD", reason: "context_pressure", advancesMaterialization: true };
  }

  // No HARD signal: SOFT when there is new additive state, else SOFT+.
  if (options.wouldAdvanceLive) {
    return { classification: "SOFT", reason: null, advancesMaterialization: true };
  }
  return { classification: "SOFT+", reason: null, advancesMaterialization: false };
}

export interface ProjectedPrefix {
  system: string;
  m0: string;
  m1: string;
}

/**
 * The provider-visible cache-sensitive prefix. Byte-stable for identical
 * (system, m0, m1); live tail is appended AFTER the prefix (Feature 9).
 */
export function projectPrefix(
  systemPrompt: string,
  m0Body: string,
  m1Body: string,
): ProjectedPrefix {
  return { system: systemPrompt, m0: m0Body, m1: m1Body };
}

export function prefixFingerprint(prefix: ProjectedPrefix): string {
  return createHash("sha256").update(`${prefix.system}\0${prefix.m0}\0${prefix.m1}`).digest("hex");
}
