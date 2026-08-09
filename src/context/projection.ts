import { createHash } from "node:crypto";

import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { findInputPairsByProjection } from "../runtime/context-adapter.js";
import {
  projectSessionMessages,
  type ProjectedSessionMessage,
} from "../runtime/session-projection.js";

/**
 * P0–P5 projection units (01 Context Assembly — Context Layers).
 *
 * P0  System / Safety / runtime invariants
 * P1  PersonaSnapshot
 * P2  stable declarations: tools / skills / body / runtime
 * P3  current-Session Compartments + accepted ContinuitySnapshot
 * P4  stable memory pool + bounded query recall
 * P5  current Runtime Session transcript projection
 *
 * R2 scope: P0/P1/P2 are the immutable+stable system prefix (provided by the
 * prepared InvocationSourceBinding); P3/P4 arrive through stable read ports /
 * fixtures (a production Historian / Memory integration is R3/R4 — never
 * faked here); P5 is the current Session's logical-unit projection built
 * from the RAW Pi entries, preserving source entry ids, ranges, hashes,
 * origins and tool adjacency.
 *
 * Context.db never stores a second raw transcript — the projection is derived
 * per pass from the Pi Session via RuntimeSessionHistoryReadPort semantics.
 */

// ---------------------------------------------------------------------------
// P0 / P1 / P2
// ---------------------------------------------------------------------------

/** P0: System/safety/runtime invariants — the frozen non-negotiables. */
export interface P0System {
  runtimeSessionId: string;
  systemPrompt: string;
  systemProjectionHash: string;
}

/** P1: PersonaSnapshot — immutable persona identity + soul content. */
export interface P1PersonaSnapshot {
  personaSnapshotId: string;
  personaContentHash: string;
  renderedPersona: string;
}

/** P2: stable declarations — tools / skills / body / runtime. */
export interface P2Declarations {
  declarationVersion: string;
  toolDeclarations: Array<{ name: string; version: string; description: string }>;
  runtimeDeclarations: Array<{ key: string; value: string }>;
  declarationsHash: string;
}

// ---------------------------------------------------------------------------
// P3 / P4 (read ports / fixtures in R2 — never faked as implemented)
// ---------------------------------------------------------------------------

/**
 * P3: committed Compartments + accepted ContinuitySnapshot.
 *
 * R2 accepts these ONLY through stable read ports / committed fixtures. The
 * field is explicitly optional and empty when no committed P3 exists; nothing
 * here claims a production Historian.
 */
export interface P3CommittedInput {
  compartments: Array<{
    compartmentId: string;
    runtimeSessionId: string;
    sequence: number;
    startEntrySeq: number;
    endEntrySeq: number;
    title: string;
    p1: string;
    sourceHash: string;
  }>;
  continuitySeed?: {
    continuitySnapshotId: string;
    sourceRuntimeSessionId: string;
    p3Narrative: string;
  };
}

/** P4: stable memory pool + bounded query recall (R4 integration boundary). */
export interface P4MemoryInput {
  stablePoolVersion?: string;
  items: Array<{
    memoryRef: string;
    canonicalText: string;
    canonicalTextHash: string;
  }>;
}

// ---------------------------------------------------------------------------
// P5 logical projection units
// ---------------------------------------------------------------------------

/**
 * One logical unit in the current Session's P5 transcript projection.
 *
 * Each unit preserves the raw source entry identities and the range/hash of
 * the raw entries it was derived from, so downstream consumers (protected
 * tail, LKG, historian) can splice and validate deterministically without
 * re-deriving pairing from a compressed array (iris_agent#6 principle).
 */
export type SessionProjectionUnit =
  | {
      kind: "input";
      unitId: string;
      runtimeSessionId: string;
      userEntryId: string;
      companionEntryId: string | null;
      entryRange: { startEntrySeq: number; endEntrySeq: number };
      contentHash: string;
      inputId?: string;
      pairKey?: string;
      verified: boolean;
      /** Canonical provider-visible text (origin-labelled real content).
       * R3-P0 port：类型级扩展（可选），供 contracts/historian.ts 使用；本
       * 构建器暂不填充（分支上的 provider-visible 渲染器属于被排除的 A-phase
       * 特性，R3-P1..P4 对齐 v13 规格时接入）。 */
      providerVisible?: string;
    }
  | {
      kind: "assistant";
      unitId: string;
      runtimeSessionId: string;
      assistantEntryId: string;
      entrySeq: number;
      contentHash: string;
      toolCallIds: string[];
      providerProfileId?: string;
      modelKey?: string;
      stopReason?: string;
      /** Canonical provider-visible text (real assistant words + tool calls).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    }
  | {
      kind: "tool_result";
      unitId: string;
      runtimeSessionId: string;
      toolResultEntryId: string;
      entrySeq: number;
      contentHash: string;
      toolCallId: string;
      toolName: string;
      toolExecutionKey?: string;
      /** Canonical provider-visible text (real tool result content).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    }
  | {
      kind: "tool_arc";
      unitId: string;
      runtimeSessionId: string;
      assistantEntryId: string;
      toolResultEntryId: string;
      toolCallId: string;
      toolName: string;
      entryRange: { startEntrySeq: number; endEntrySeq: number };
      contentHash: string;
      sealed: boolean;
      /** Provider-visible text: empty (the arc is an atomicity seam).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    }
  | {
      kind: "reasoning";
      unitId: string;
      runtimeSessionId: string;
      assistantEntryId: string;
      entrySeq: number;
      contentHash: string;
      /** Canonical provider-visible text (preserved thinking).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    }
  | {
      kind: "compaction_boundary";
      unitId: string;
      runtimeSessionId: string;
      entryId: string;
      entrySeq: number;
      summary: string;
      firstKeptEntryId?: string;
      /** Provider-visible text (compaction summary marker).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    }
  | {
      kind: "branch_boundary";
      unitId: string;
      runtimeSessionId: string;
      entryId: string;
      entrySeq: number;
      fromId: string;
      summary: string;
      /** Provider-visible text (branch boundary marker).
       * R3-P0 port：类型级扩展（可选），见 input 变体注释。 */
      providerVisible?: string;
    };

export interface ProjectedLogicalUnits {
  runtimeSessionId: string;
  units: SessionProjectionUnit[];
  /** First raw entrySeq represented by the projection (inclusive). */
  fromEntrySeq: number;
  /** Last raw entrySeq represented by the projection (inclusive). */
  toEntrySeq: number;
  /** Projection-level hash over ordered unit ids + hashes (deterministic). */
  projectionHash: string;
  /** Last safe REAL-user anchor: the newest input unit whose pair verified. */
  lastSafeUserAnchor: { unitId: string; entrySeq: number } | null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Deterministic hash of a unit's identity payload (unitId derived from raw
 * entry ids, which are unique per entry). */
function unitContentHash(payload: unknown): string {
  return sha256(JSON.stringify(payload));
}

/**
 * Build the P5 logical-unit projection DIRECTLY from raw Pi entries. Never
 * derives entry identities from filtered-array positions (iris_agent#6):
 * pairing uses the identity-preserving projection + raw adjacency/parent
 * chain, exactly like the ingress reconciliation path.
 */
export function projectLogicalUnits(
  runtimeSessionId: string,
  entries: SessionTreeEntry[],
): ProjectedLogicalUnits {
  const projected = projectSessionMessages(entries);

  const units: SessionProjectionUnit[] = [];
  let lastSafeUserAnchor: ProjectedLogicalUnits["lastSafeUserAnchor"] = null;

  // Index: entrySeq -> entry (raw order). Session-local ordinals.
  const entrySeqById = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined) {
      entrySeqById.set(entry.id, index + 1);
    }
  }

  // Raw-entry pair discovery — REUSES findInputPairsByProjection directly so
  // the projection shares the SAME companion predicate (content/display/
  // pairKey) and the same raw-adjacency / parent-chain linkage rule as the
  // ingress reconciliation path (one pairing basis for the whole path,
  // reviewer F1). Never reimplements a weaker predicate here.
  const companionByUserEntryId = new Map<string, ProjectedSessionMessage>();
  for (const pair of findInputPairsByProjection(projected)) {
    companionByUserEntryId.set(pair.user.entryId, pair.companion);
  }

  // Tool-call adjacency: assistant toolCall parts → toolResult messages.
  // ToolResult details.iris carries the authoritative assistantEntryId +
  // toolCallOrdinal (harness-factory), so adjacency is proven by the durable
  // key, not by array position. Index is pre-built in a FIRST pass so the
  // assistant unit can seal its arcs when encountered (the toolResult entry
  // appears AFTER its assistant in raw order).
  const toolResultByCallId = new Map<string, ProjectedSessionMessage>();
  for (const item of projected) {
    const message = item.message;
    if (message.role !== "toolResult") {
      continue;
    }
    const callId = (message as AgentMessage & { toolCallId?: string }).toolCallId ?? "";
    if (callId !== "") {
      toolResultByCallId.set(callId, item);
    }
  }

  // Build units in raw order.
  for (let index = 0; index < projected.length; index += 1) {
    const item = projected[index];
    if (item === undefined) {
      continue;
    }
    const entrySeq = entrySeqById.get(item.entryId) ?? index + 1;
    const message = item.message;

    if (message.role === "user") {
      const companion = companionByUserEntryId.get(item.entryId);
      // Companion is a ProjectedSessionMessage whose lifted message has
      // role "custom" — its details carry the iris meta.
      const companionMessage = companion?.message;
      const details =
        companionMessage?.role === "custom"
          ? (companionMessage.details as { iris?: { inputId?: string; pairKey?: string } })
          : undefined;
      const inputId = details?.iris?.inputId;
      const pairKey = details?.iris?.pairKey;
      const endEntrySeq =
        companion === undefined ? entrySeq : (entrySeqById.get(companion.entryId) ?? entrySeq);
      const inputUnit: SessionProjectionUnit = {
        kind: "input",
        unitId: `input-${item.entryId}`,
        runtimeSessionId,
        userEntryId: item.entryId,
        companionEntryId: companion?.entryId ?? null,
        entryRange: { startEntrySeq: entrySeq, endEntrySeq },
        contentHash: unitContentHash({
          kind: "input",
          userEntryId: item.entryId,
          companionEntryId: companion?.entryId ?? null,
          entryRange: { startEntrySeq: entrySeq, endEntrySeq },
          ...(inputId === undefined ? {} : { inputId }),
          ...(pairKey === undefined ? {} : { pairKey }),
          verified: companion !== undefined,
        }),
        ...(inputId === undefined ? {} : { inputId }),
        ...(pairKey === undefined ? {} : { pairKey }),
        verified: companion !== undefined,
      };
      if (inputUnit.verified && entrySeq > (lastSafeUserAnchor?.entrySeq ?? 0)) {
        lastSafeUserAnchor = { unitId: inputUnit.unitId, entrySeq };
      }
      units.push(inputUnit);
      continue;
    }

    if (message.role === "custom") {
      // Companion entries are folded into their input unit; isolated ones are
      // dropped (fail-conservative — never synthesized).
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.content)
        ? message.content.filter(
            (part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall",
          )
        : [];
      const toolCallIds = toolCalls.map((call) => call.id ?? "");
      const assistantUnit: SessionProjectionUnit = {
        kind: "assistant",
        unitId: `assistant-${item.entryId}`,
        runtimeSessionId,
        assistantEntryId: item.entryId,
        entrySeq,
        contentHash: unitContentHash({
          kind: "assistant",
          assistantEntryId: item.entryId,
          entrySeq,
          toolCallIds,
        }),
        toolCallIds,
      };
      units.push(assistantUnit);

      // Open tool arcs: an assistant with tool calls expects a subsequent
      // sealed arc. Non-sealed arcs are fence material (Feature 6).
      for (const call of toolCalls) {
        const callId = call.id ?? "";
        const result = toolResultByCallId.get(callId);
        if (result !== undefined) {
          const resultSeq = entrySeqById.get(result.entryId) ?? entrySeq;
          const arc: SessionProjectionUnit = {
            kind: "tool_arc",
            unitId: `arc-${callId}`,
            runtimeSessionId,
            assistantEntryId: item.entryId,
            toolResultEntryId: result.entryId,
            toolCallId: callId,
            toolName: call.name ?? "",
            entryRange: { startEntrySeq: entrySeq, endEntrySeq: resultSeq },
            contentHash: sha256(`${item.entryId}\0${result.entryId}\0${callId}`),
            sealed: true,
          };
          units.push(arc);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const callId = (message as AgentMessage & { toolCallId?: string }).toolCallId ?? "";
      // Pi ToolResultMessage carries its native toolName (message.toolName);
      // details.iris.toolExecutionKey is the derived durable key (F2).
      const nativeToolName = (message as AgentMessage & { toolName?: string }).toolName ?? "";
      const details = (message as AgentMessage & { details?: unknown }).details as
        { iris?: { toolExecutionKey?: string; assistantEntryId?: string } } | undefined;
      const toolResultUnit: SessionProjectionUnit = {
        kind: "tool_result",
        unitId: `tool-result-${item.entryId}`,
        runtimeSessionId,
        toolResultEntryId: item.entryId,
        entrySeq,
        contentHash: unitContentHash({
          kind: "tool_result",
          toolResultEntryId: item.entryId,
          entrySeq,
          toolCallId: callId,
          toolName: nativeToolName,
          ...(details?.iris?.toolExecutionKey === undefined
            ? {}
            : { toolExecutionKey: details.iris.toolExecutionKey }),
        }),
        toolCallId: callId,
        toolName: nativeToolName,
        ...(details?.iris?.toolExecutionKey === undefined
          ? {}
          : { toolExecutionKey: details.iris.toolExecutionKey }),
      };
      units.push(toolResultUnit);
      continue;
    }
  }

  // Reasoning units: assistant messages that carry thinking parts.
  for (const item of projected) {
    const message = item.message;
    if (message.role !== "assistant") {
      continue;
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    const hasReasoning = parts.some((part) => part.type === "thinking");
    if (!hasReasoning) {
      continue;
    }
    const entrySeq = entrySeqById.get(item.entryId) ?? 1;
    units.push({
      kind: "reasoning",
      unitId: `reasoning-${item.entryId}`,
      runtimeSessionId,
      assistantEntryId: item.entryId,
      entrySeq,
      contentHash: sha256(`${item.entryId}\0reasoning`),
    });
  }

  // Compaction / branch boundaries from raw non-message entries.
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const entrySeq = index + 1;
    if (entry.type === "compaction") {
      units.push({
        kind: "compaction_boundary",
        unitId: `compaction-${entry.id}`,
        runtimeSessionId,
        entryId: entry.id,
        entrySeq,
        summary: entry.summary,
        ...(entry.firstKeptEntryId === undefined
          ? {}
          : { firstKeptEntryId: entry.firstKeptEntryId }),
      });
    } else if (entry.type === "branch_summary") {
      units.push({
        kind: "branch_boundary",
        unitId: `branch-${entry.id}`,
        runtimeSessionId,
        entryId: entry.id,
        entrySeq,
        fromId: entry.fromId,
        summary: entry.summary,
      });
    }
  }

  // Deterministic ordering by raw position.
  const ordered = units.sort((a, b) => entrySeqOfOrder(a, b));

  const fromEntrySeq = entries.length === 0 ? 0 : 1;
  const toEntrySeq = entries.length;
  const projectionHash = sha256(
    ordered.map((unit) => `${unit.unitId}\0${unitContentHash(unit)}`).join("\n"),
  );

  return {
    runtimeSessionId,
    units: ordered,
    fromEntrySeq,
    toEntrySeq,
    projectionHash,
    lastSafeUserAnchor,
  };
}

function entrySeqOfOrder(a: SessionProjectionUnit, b: SessionProjectionUnit): number {
  const seqOf = (unit: SessionProjectionUnit): number => {
    switch (unit.kind) {
      case "input":
        return unit.entryRange.startEntrySeq;
      case "assistant":
      case "reasoning":
      case "tool_result":
      case "compaction_boundary":
      case "branch_boundary":
        return unit.entrySeq;
      case "tool_arc":
        return unit.entryRange.startEntrySeq;
    }
  };
  return seqOf(a) - seqOf(b);
}
