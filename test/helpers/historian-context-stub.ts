/**
 * iris_agent#66/#76 test helper: build a ContextHistoryReadPort stub whose
 * claimHistorianBatch serves ContextMessageUnitV1 rows derived from a
 * mutable SessionTreeEntry[] fixture, keyed by global contextSeq. The
 * Historian's normal semantic input is Context units (never Pi Session
 * transcript), so fixtures that used to feed SessionHistoryReadPort now
 * feed claimHistorianBatch through this adapter — keeping the SAME entry
 * data while exercising the #76 boundary (batch membership = lineage +
 * contextSeq, entrySeq is attribution only).
 *
 * Feature A (#110): the stub serves canonical ContextMessageUnitV1 — the
 * single durable Context DTO. Persistence-only fields (entryId/paired/...)
 * are absent from the V1 rows; attribution ordinals derive from batch
 * position in the runner.
 */
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { historianBatchHash, type HistorianBatchV1 } from "../../src/contracts/historian.js";
import type { ContextMessageUnitV1, JsonValue } from "../../src/contracts/context-v27.js";
import type { ContextHistoryReadPort } from "../../src/context/history-read-port.js";
import type { RuntimeEventDerivationRefs } from "../../src/contracts/runtime-events.js";

function roleOf(entry: SessionTreeEntry): "user" | "assistant" | "toolResult" | "system" {
  if (entry.type === "custom_message") {
    return "system";
  }
  const message = (entry as { message?: { role?: string } }).message;
  return (message?.role as "user" | "assistant" | "toolResult" | "system" | undefined) ?? "user";
}

function kindOf(entry: SessionTreeEntry): ContextMessageUnitV1["kind"] {
  const role = roleOf(entry);
  if (role === "toolResult") {
    return "tool_result";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "user";
}

/** Convert a fixture SessionTreeEntry[] to ContextMessageUnitV1 rows. */
export function contextUnitsFromEntries(entries: SessionTreeEntry[]): ContextMessageUnitV1[] {
  const units: ContextMessageUnitV1[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    units.push({
      schemaId: "iris.context_message_unit.v1",
      contextUnitId: entry.id,
      contextLineageId: "identity-stub",
      contextSeq: index + 1,
      runtimeEventId: entry.id,
      kind: kindOf(entry),
      semanticSchemaId:
        kindOf(entry) === "assistant"
          ? "iris.semantic.context_message.assistant.v1"
          : "iris.semantic.context_message.user.v1",
      semanticContent: (message as unknown as JsonValue) ?? {
        role: "user",
        content: "",
        timestamp: 0,
      },
      historianDisposition: "include",
      contentHash: `stub-${entry.id}`,
      lifecycleState: "committed",
      createdAt: entry.timestamp ?? new Date().toISOString(),
    });
  }
  return units;
}

/** Project canonical V1 derivation refs to the Historian narrow-view shape. */
function toRuntimeEventDerivationRefs(
  refs: ContextMessageUnitV1["derivationRefs"],
): RuntimeEventDerivationRefs {
  if (refs === undefined) {
    return { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] };
  }
  return {
    memoryRefs: [...(refs.memoryRefs ?? [])],
    compartmentIds: [...(refs.compartmentIds ?? [])],
    ...(refs.workSnapshotVersion !== undefined
      ? { workSnapshotVersion: String(refs.workSnapshotVersion) }
      : {}),
    sourceContextMessageUnitIds: [...(refs.sourceContextMessageUnitIds ?? [])],
  };
}

/** Feature A (#110): canonical AgentMessage-shaped semanticContent cast. */
function payloadOf(unit: ContextMessageUnitV1): AgentMessage {
  return unit.semanticContent as unknown as AgentMessage;
}

/** Build a ContextHistoryReadPort stub that serves the fixture units
 * through claimHistorianBatch (the #76 normal input path, keyed by lineage
 * + global contextSeq). */
export function createFixtureHistoryPort(options: {
  units?: () => ContextMessageUnitV1[];
  representedThroughContextSeq?: number;
}): ContextHistoryReadPort {
  const units = options.units ?? (() => []);
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: options.representedThroughContextSeq ?? 0,
        representedThroughEntrySeq: 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    lineageId() {
      return "identity-stub";
    },
    listUnitsForHistorian() {
      return units().map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        kind: unit.kind,
        historianDisposition: unit.historianDisposition,
        contentHash: unit.contentHash,
        derivationRefs: toRuntimeEventDerivationRefs(unit.derivationRefs),
      }));
    },
    listUnitsWithPayload() {
      return units().map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        kind: unit.kind,
        historianDisposition: unit.historianDisposition,
        contentHash: unit.contentHash,
        derivationRefs: toRuntimeEventDerivationRefs(unit.derivationRefs),
        payload: payloadOf(unit),
        payloadTimestamp: unit.createdAt,
      }));
    },
    claimHistorianBatch({
      afterContextSeqExclusive,
      throughContextSeqInclusive,
    }): HistorianBatchV1 {
      const claimed = units().filter(
        (unit) =>
          unit.contextSeq > afterContextSeqExclusive &&
          unit.contextSeq <= throughContextSeqInclusive,
      );
      const actualThrough =
        claimed.length === 0
          ? afterContextSeqExclusive
          : (claimed[claimed.length - 1]?.contextSeq ?? afterContextSeqExclusive);
      const batch: HistorianBatchV1 = {
        schemaVersion: "historian-batch-v1",
        lineageId: "identity-stub",
        afterContextSeqExclusive,
        throughContextSeqInclusive: actualThrough,
        units: claimed,
        batchHash: "",
        frozenAt: new Date().toISOString(),
      };
      batch.batchHash = historianBatchHash(batch);
      return batch;
    },
  };
}
