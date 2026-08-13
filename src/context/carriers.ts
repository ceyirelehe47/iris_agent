// MIGRATION ONLY — Not part of current production Context path per Notion v27.
import { createHash } from "node:crypto";

import type { CustomMessage } from "@iris/pi-agent-core";

import {
  M0_EMPTY_BODY,
  M1_EMPTY_PLACEHOLDER,
  type IrisContextCarrierDetails,
} from "../contracts/context.js";
import type { ContextLineage } from "./context-store.js";

/**
 * Ephemeral m0/m1 carriers (01 Context Assembly — Physical Layout).
 *
 * Two hidden CustomMessages are returned ONLY by the context hook and are
 * NEVER written to the Pi Session. Fixed order: m0, m1, live tail.
 *
 *  - m0 = stable baseline (folded P3 through baseline watermarks + baseline
 *        P4). Empty session → M0_EMPTY_BODY.
 *  - m1 = volatile delta (new committed P3/P4 after m0). Empty delta →
 *        M1_EMPTY_PLACEHOLDER — the placeholder is NEVER omitted, and m0/m1
 *        are NEVER merged.
 *
 * Byte stability: the same source/materialization/provider-profile must
 * produce byte-identical carriers on every replay, so the provider prompt
 * cache prefix (system + m0 + m1) stays stable. A different provider profile
 * (or serializer/carrier version) invalidates the prefix.
 */

export const CARRIER_SCHEMA_VERSION = "1";
export const CARRIER_SERIALIZER_VERSION = "iris-context-carrier-v1";

/** The fixed provider-visible carrier type (distinct from input companions). */
export const IRIS_CONTEXT_CARRIER_CUSTOM_TYPE = "iris_context_carrier";

export interface CarrierBuildInput {
  runtimeSessionId: string;
  materializationId: string;
  providerProfileId: string;
  m0Body: string;
  m1Body: string;
  atMs: number;
}

export interface BuiltCarrier {
  m0: CustomMessage<unknown>;
  m1: CustomMessage<unknown>;
  /** sha256 of the m0 carrier message object (canonical JSON). */
  m0ContentHash: string;
  /** sha256 of the m1 carrier message object (canonical JSON). */
  m1ContentHash: string;
  /** Combined byte fingerprint of both carriers (deterministic). */
  carrierFingerprint: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Canonical JSON: sorted keys for deterministic hashing. */
export function canonicalCarrierJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCarrierJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalCarrierJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function makeCarrier(
  input: CarrierBuildInput,
  surface: "m0" | "m1",
  body: string,
  contentHash: string,
): CustomMessage<unknown> {
  const details: IrisContextCarrierDetails = {
    irisContext: {
      schemaVersion: 1,
      runtimeSessionId: input.runtimeSessionId,
      surface,
      materializationId: input.materializationId,
      contentHash,
      carrierSchemaVersion: CARRIER_SCHEMA_VERSION,
      providerProfileId: input.providerProfileId,
    },
  };
  return {
    role: "custom",
    customType: IRIS_CONTEXT_CARRIER_CUSTOM_TYPE,
    content: body,
    display: false,
    details,
    timestamp: input.atMs,
  };
}

/**
 * Build the ephemeral m0 + m1 carriers from the materialized lineage state.
 * Byte-stable for identical (runtimeSessionId, materializationId,
 * providerProfileId, m0Body, m1Body); never writes to the Session.
 */
export function buildCarriers(input: CarrierBuildInput): BuiltCarrier {
  const m0Body = input.m0Body === "" ? M0_EMPTY_BODY : input.m0Body;
  const m1Body = input.m1Body === "" ? M1_EMPTY_PLACEHOLDER : input.m1Body;

  // Content hashes over the carrier message object (sorted canonical JSON).
  const m0Canonical = canonicalCarrierJson({
    role: "custom",
    customType: IRIS_CONTEXT_CARRIER_CUSTOM_TYPE,
    content: m0Body,
    display: false,
    surface: "m0",
    runtimeSessionId: input.runtimeSessionId,
    materializationId: input.materializationId,
    carrierSchemaVersion: CARRIER_SCHEMA_VERSION,
    providerProfileId: input.providerProfileId,
  });
  const m1Canonical = canonicalCarrierJson({
    role: "custom",
    customType: IRIS_CONTEXT_CARRIER_CUSTOM_TYPE,
    content: m1Body,
    display: false,
    surface: "m1",
    runtimeSessionId: input.runtimeSessionId,
    materializationId: input.materializationId,
    carrierSchemaVersion: CARRIER_SCHEMA_VERSION,
    providerProfileId: input.providerProfileId,
  });
  const m0ContentHash = sha256(m0Canonical);
  const m1ContentHash = sha256(m1Canonical);

  const m0 = makeCarrier(input, "m0", m0Body, m0ContentHash);
  const m1 = makeCarrier(input, "m1", m1Body, m1ContentHash);
  return {
    m0,
    m1,
    m0ContentHash,
    m1ContentHash,
    carrierFingerprint: sha256(`${m0Canonical}\0${m1Canonical}`),
  };
}

/**
 * Build carriers directly from a persisted lineage. Returns undefined when the
 * lineage has no m0 (never materialized) — the transform must decide
 * (SOFT+/SOFT/HARD) rather than fabricate a fake baseline.
 */
export function buildCarriersFromLineage(lineage: ContextLineage): BuiltCarrier | undefined {
  if (lineage.m0Body === null || lineage.m0Body === undefined) {
    return undefined;
  }
  return buildCarriers({
    runtimeSessionId: lineage.currentRuntimeSessionId,
    materializationId: lineage.materializationId,
    providerProfileId: lineage.cachedM0ProviderProfileId ?? lineage.providerProfileId,
    m0Body: lineage.m0Body,
    m1Body: lineage.m1Body ?? "",
    atMs: lineage.m0MaterializedAt ?? Date.now(),
  });
}

/** Deterministic "represented prefix" placeholder used when m1 is empty. */
export function emptyM1Placeholder(): string {
  return M1_EMPTY_PLACEHOLDER;
}
