/**
 * iris_agent#66/#76 test helper: build a ContextHistoryReadPort stub whose
 * claimHistorianBatch serves ContextMessageUnit rows derived from a
 * mutable SessionTreeEntry[] fixture, keyed by global contextSeq. The
 * Historian's normal semantic input is Context units (never Pi Session
 * transcript), so fixtures that used to feed SessionHistoryReadPort now
 * feed claimHistorianBatch through this adapter — keeping the SAME entry
 * data while exercising the #76 boundary (batch membership = lineage +
 * contextSeq, entrySeq is attribution only).
 */
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { historianBatchHash, type HistorianBatchV1 } from "../../src/contracts/historian.js";
import type { ContextMessageUnit } from "../../src/contracts/context-units.js";
import type { ContextHistoryReadPort } from "../../src/context/history-read-port.js";

function roleOf(entry: SessionTreeEntry): "user" | "assistant" | "toolResult" | "system" {
  if (entry.type === "custom_message") {
    return "system";
  }
  const message = (entry as { message?: { role?: string } }).message;
  return (message?.role as "user" | "assistant" | "toolResult" | "system" | undefined) ?? "user";
}

function unitTypeOf(entry: SessionTreeEntry): ContextMessageUnit["unitType"] {
  const role = roleOf(entry);
  if (role === "toolResult") {
    return "tool_result";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "input";
}

/** Convert a fixture SessionTreeEntry[] to ContextMessageUnit rows
 * (entrySeq = 1-based fixture position, mirroring the raw archive mapping). */
export function contextUnitsFromEntries(entries: SessionTreeEntry[]): ContextMessageUnit[] {
  const units: ContextMessageUnit[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    units.push({
      lineageId: "identity-stub",
      runtimeSessionId: (entry as { sessionId?: string }).sessionId ?? "stub-session",
      contextSeq: index + 1,
      contextUnitId: entry.id,
      unitId: entry.id,
      sourceEventId: entry.id,
      unitType: unitTypeOf(entry),
      semanticSchemaId:
        unitTypeOf(entry) === "assistant"
          ? "iris.semantic.context_message.assistant.v1"
          : "iris.semantic.context_message.user.v1",
      disposition: "include",
      entryId: entry.id,
      entrySeq: index + 1,
      contentHash: `stub-${entry.id}`,
      payload: (message as ContextMessageUnit["payload"]) ?? {
        role: "user",
        content: "",
        timestamp: 0,
      },
      paired: false,
      derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextMessageUnitIds: [] },
      schemaVersion: "context-unit-v1",
      createdAt: entry.timestamp ?? new Date().toISOString(),
    });
  }
  return units;
}

/** Build a ContextHistoryReadPort stub that serves the fixture units
 * through claimHistorianBatch (the #76 normal input path, keyed by lineage
 * + global contextSeq). */
export function createFixtureHistoryPort(options: {
  units?: () => ContextMessageUnit[];
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
        contextUnitId: unit.unitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
      }));
    },
    listUnitsWithPayload() {
      return units().map((unit) => ({
        contextUnitId: unit.unitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
        payload: unit.payload,
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
