import type { AgentMessage, CustomMessage } from "@iris/pi-agent-core";

import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../contracts/context.js";
import {
  KIND_TO_SEMANTIC_SCHEMA_ID,
  SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
  type ContextIngestPort,
  type ContextMessageUnitV1,
  type JsonValue,
  type RawArchiveRefV1,
  type SemanticDerivationRefsV1,
  type UnitDispositionFilter,
} from "../contracts/context-v27.js";
import type { RuntimeEvent, RuntimeEventIngestPort } from "../contracts/runtime-events.js";
import {
  type IrisInputMetaDetails,
  decodeInputFrames,
  verifyCompanionLayoutHash,
} from "../runtime/companion.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";
import type { OriginEnvelope } from "../contracts/origin.js";
import type { UnitStoreRecord } from "./context-store.js";

/**
 * R2-P0：ContextMessageUnitV1 的持久化端口（context.db，context_units 表）。
 *
 * Feature A (#110)：端口携带 canonical ContextMessageUnitV1。Entry/pairing
 * 元数据（entryId/entrySeq/paired/companionEntryId/pairKey）不在 V1 DTO 上 —
 * 那是持久化层私有细节，通过 UnitStoreRecord（findBySourceEvent）或
 * updateUnitPairing 物理列更新暴露。
 */
export interface ContextUnitStorePort {
  hasUnitForEvent(eventId: string): boolean;
  insertUnit(
    unit: ContextMessageUnitV1,
    options?: { verifySessionBinding?: boolean; runtimeSessionId?: string },
  ): void;
  updateUnitPairing(
    runtimeSessionId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void;
  listUnits(
    runtimeSessionId: string,
    options?: { afterContextSeq?: number; limit?: number; disposition?: UnitDispositionFilter },
  ): ContextMessageUnitV1[];
  /** 按源事件找单元（companion 邻接配对的幂等锚点），携带持久化元数据。 */
  findBySourceEvent(eventId: string): UnitStoreRecord | undefined;
  lastUnpairedInputSeq(runtimeSessionId: string): number | undefined;
  maxContextSeq(runtimeSessionId: string): number;
  /**
   * iris_agent#52: lineage-direct variants for the Recovery Reconciler.
   * The recovered Runtime Session is historical (not current), so the
   * session-resolving methods would fail closed; the lineage id comes from
   * ContextStore.resolveLineageForRecovery instead.
   */
  maxContextSeqByLineage(lineageId: string): number;
  listUnitsByLineage(
    lineageId: string,
    options?: { afterContextSeq?: number; limit?: number; disposition?: UnitDispositionFilter },
  ): ContextMessageUnitV1[];
  updateUnitPairingByLineage(
    lineageId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void;
  close(): void;
}

/**
 * 注（R2-P3）：ensureUnitsUpTo 内调用 insertUnit 时，若该 session 已超过硬 cap
 * （HARD_UNITS_CAP），insertUnit 抛 ContextBoundsExceededError（typed、文档化），
 * 本方法不捕获、原样向上传播。seam 的 subscribe 回调（runtime-event-seam.ts 不可
 * 修改）经 harness emitOwn rethrow 把该错误继续传播到 prompt 调用方 → slice 大声
 * 失败（fail-closed）。
 */

/**
 * Feature A (#110): stable contextUnitId prefix for a V1 kind. Keeps the
 * legacy id convention (input-/assistant-/tool_result-) so durable unit
 * identities are stable across the legacy→V1 migration.
 */
function unitIdPrefixForKind(kind: "user" | "assistant" | "tool_result"): string {
  switch (kind) {
    case "user":
      return "input";
    case "assistant":
      return "assistant";
    case "tool_result":
      return "tool_result";
  }
}

function isInputMetaCompanion(message: AgentMessage): message is CustomMessage<unknown> {
  return (
    message.role === "custom" &&
    message.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
    message.content === IRIS_INPUT_META_CONTENT &&
    message.display === false
  );
}

function authorityLabel(authority: OriginEnvelope["authority"]): string {
  switch (authority) {
    case "user_request":
      return "USER REQUEST";
    case "notice_only":
      return "NOTICE ONLY";
    case "data_only":
      return "DATA ONLY";
    case "internal_control":
      return "INTERNAL CONTROL";
  }
}

function sourceLabel(origin: OriginEnvelope): string {
  const kind = origin.principalKind.toUpperCase();
  const channel = origin.channel;
  return `[${kind} | ${channel} | ${authorityLabel(origin.authority)} | ${origin.trust.toUpperCase()}]`;
}

function frameOrigins(
  blocks: IrisBlockLayoutV1[] | undefined,
  frameCount: number,
): Array<OriginEnvelope | undefined> {
  if (!Array.isArray(blocks)) {
    return Array.from({ length: frameCount }, () => undefined);
  }
  const origins: Array<OriginEnvelope | undefined> = [];
  for (const block of blocks) {
    origins.push(block.sourceOrigin);
  }
  return origins;
}

/**
 * Model-visible 折叠文本（与 v12 transformContextMessages 的 projectedUserText
 * 同构）。未验证或无法解码 → UNVERIFIED 占位（fail-conservative，绝不猜测）。
 */
function projectedUserText(
  frames: ReturnType<typeof decodeInputFrames> | undefined,
  blocks: IrisBlockLayoutV1[] | undefined,
  verified: boolean,
): string {
  if (frames === undefined || !verified) {
    return "[USER REQUEST | UNVERIFIED]";
  }
  const origins = frameOrigins(blocks, frames.length);
  return frames
    .map((frame, index) => {
      const origin = origins[index];
      if (origin === undefined) {
        return `[DATA ONLY | UNTRUSTED]\n${frame.payload}`;
      }
      return `${sourceLabel(origin)}\n${frame.payload}`;
    })
    .join("\n\n");
}

/** user 消息折叠为 provider-visible 文本后的 payload。 */
function foldUserPayload(
  userMessage: AgentMessage & { role: "user" },
  companion: CustomMessage<unknown>,
): { payload: AgentMessage; paired: boolean; pairKey: string } {
  const details = companion.details as IrisInputMetaDetails | undefined;
  const iris = details?.iris;
  const pairKey = typeof iris?.pairKey === "string" ? iris.pairKey : "";
  const verified = verifyCompanionLayoutHash(details ?? {});
  const raw = Array.isArray(userMessage.content)
    ? userMessage.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : userMessage.content;
  let frames: ReturnType<typeof decodeInputFrames> | undefined;
  try {
    const decoded = decodeInputFrames(raw);
    frames = decoded.length > 0 ? decoded : undefined;
  } catch {
    frames = undefined;
  }
  const text = projectedUserText(frames, iris?.blocks, verified && pairKey !== "");
  return {
    payload: {
      role: "user",
      content: text,
      timestamp: userMessage.timestamp,
    },
    paired: verified && pairKey !== "",
    pairKey,
  };
}

/**
 * R2-P0：确定性可重放 Context ingest。从 runtime-event ledger 读取已提交
 * message_finalized 事件，为缺失的 source_event_id 创建 ContextMessageUnit
 * （context_seq 每 session 单调分配），companion 配对按事件顺序（ledger
 * event_seq 邻接，等价于 pi append 顺序）折叠。
 */
export class ContextIngest implements ContextIngestPort {
  constructor(
    private readonly ledger: RuntimeEventIngestPort,
    private readonly units: ContextUnitStorePort,
    /** R2 (iris_agent#9)：identity-level lineage id（one per data root）。 */
    private readonly lineageId: string,
    /**
     * iris_agent#52: recovery mode for the Recovery Reconciler. When true,
     * every unit-store query is addressed BY LINEAGE (no session resolution):
     * the ingested Runtime Session is historical after rollover, so
     * session-based resolution would fail closed. The lineage id is the one
     * resolved by ContextStore.resolveLineageForRecovery (verified binding).
     * Recovery mode NEVER makes the old session current again.
     */
    private readonly recovery = false,
  ) {}

  /** R2 (iris_agent#9)：该 lineage 的下一个 contextSeq（lineage 内全局单调，跨
   * Runtime Session 连续——rollover 不重置）。恢复模式按 lineage 直查。 */
  private nextContextSeq(runtimeSessionId: string): number {
    if (this.recovery) {
      return this.units.maxContextSeqByLineage(this.lineageId) + 1;
    }
    return this.units.maxContextSeq(runtimeSessionId) + 1;
  }

  /**
   * Feature A (#110)：为已提交的 message_finalized 事件构建 canonical
   * ContextMessageUnitV1。
   *
   * 映射（legacy → V1）：
   *  - unitType input/assistant/tool_result → kind user/assistant/tool_result；
   *  - payload (AgentMessage) → semanticContent (JsonValue)；
   *  - disposition → historianDisposition；
   *  - schemaVersion → 移除（V1 只有 schemaId）；
   *  - sourceEventId → runtimeEventId（源事件即运行时事件）；
   *  - entryId/entrySeq/paired/companionEntryId/pairKey → 持久化层元数据
   *    （entryId/entrySeq 从 rawArchiveRef 派生；配对走 updateUnitPairing）；
   *  - contentHash → computeSemanticContentHash(semanticContent)——绝不是 raw
   *    event hash（wire 字节永不进入语义平面）。
   */
  private buildUnit(
    runtimeSessionId: string,
    event: RuntimeEvent,
    seq: number,
    kind: "user" | "assistant" | "tool_result",
    semanticContent: JsonValue,
  ): ContextMessageUnitV1 {
    const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[kind];
    const derivationRefs: SemanticDerivationRefsV1 = {
      schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
      memoryRefs: [],
      compartmentIds: [],
      sourceContextMessageUnitIds: [],
    };
    const unit: ContextMessageUnitV1 = {
      schemaId: "iris.context_message_unit.v1",
      contextUnitId: `${unitIdPrefixForKind(kind)}-${event.entryId ?? event.eventId}`,
      contextLineageId: this.lineageId,
      contextSeq: seq,
      runtimeEventId: event.eventId,
      kind,
      semanticSchemaId,
      semanticContent,
      historianDisposition: "include",
      derivationRefs,
      // Feature A5 (#113): the ONE versioned canonical basis — semanticContent
      // + kind + historianDisposition + derivationRefs + semanticSchemaId —
      // not a payload-only hash (never the raw event hash either).
      contentHash: computeContextMessageUnitContentHashV1({
        semanticSchemaId,
        kind,
        historianDisposition: "include",
        derivationRefs,
        semanticContent,
      }),
      lifecycleState: "committed",
      ...(event.entryId !== undefined
        ? {
            // Pi Session 只作 raw archive（v27：永不作为 Context 语义源）。
            rawArchiveRef: {
              schemaId: "iris.raw_archive_ref.v1",
              runtimeSessionId,
              ...(event.entrySeq !== undefined
                ? { startEntrySeq: event.entrySeq, endEntrySeq: event.entrySeq }
                : {}),
              entryIds: [event.entryId],
            } satisfies RawArchiveRefV1,
          }
        : {}),
      createdAt: event.occurredAt,
    };
    return unit;
  }

  ensureUnitsUpTo(
    runtimeSessionId: string,
    options: { limit?: number } = {},
  ): ContextMessageUnitV1[] {
    const events = this.ledger.listBySession(runtimeSessionId, options);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event?.type !== "message_finalized") {
        continue;
      }
      if (this.units.hasUnitForEvent(event.eventId)) {
        continue; // exactly-once：已建单元的事件跳过
      }
      if (event.payload === undefined) {
        continue; // 无内容的事件无法建语义单元（fail-closed：不猜测）
      }
      let message: AgentMessage;
      try {
        message = JSON.parse(event.payload) as AgentMessage;
      } catch {
        continue; // 损坏 payload：跳过（fail-closed）
      }

      if (message.role === "user") {
        const seq = this.nextContextSeq(runtimeSessionId);
        // 插入时用 UNVERIFIED 占位：context.db 永不存 raw wire（reviewer A
        // NB-2）；companion 到达时折叠为 provenance 文本。contentHash 覆盖
        // 该语义内容（Feature A #110：不是 raw event hash）。
        const semanticContent: JsonValue = {
          role: "user",
          content: "[USER REQUEST | UNVERIFIED]",
          timestamp: message.timestamp,
        };
        this.units.insertUnit(
          this.buildUnit(runtimeSessionId, event, seq, "user", semanticContent),
          this.recovery ? { verifySessionBinding: false } : { runtimeSessionId },
        );
        continue;
      }

      if (isInputMetaCompanion(message)) {
        // 事件邻接配对：companion 只与紧邻前驱 user 事件配对（ledger
        // event_seq 顺序 = pi append 顺序）。历史 companion 重放时前驱 user
        // unit 已配对 → 幂等跳过，绝不与"最新未配对 input"错配
        // （reviewer B BLOCKING #1）。配对元数据（paired/companionEntryId/
        // pairKey）是持久化层细节，经 UnitStoreRecord + updateUnitPairing
        // 访问（V1 DTO 不携带）。
        const prev = events[index - 1];
        if (
          prev?.type !== "message_finalized" ||
          prev.role !== "user" ||
          prev.payload === undefined
        ) {
          continue; // 邻接失败：孤立/乱序 companion（fail-closed）
        }
        const userUnit = this.units.findBySourceEvent(prev.eventId);
        if (userUnit?.unit.kind !== "user" || userUnit.persistenceMeta.paired) {
          continue; // 前驱 user 无单元或已配对（重放幂等）
        }
        // 折叠数据源是前驱事件 payload（raw user message，在事件 ledger）；
        // user unit 的 semanticContent 从插入到配对保持 UNVERIFIED 占位，
        // context.db 永不存 raw wire（reviewer A NB-2）。
        let prevMessage: AgentMessage;
        try {
          prevMessage = JSON.parse(prev.payload) as AgentMessage;
        } catch {
          continue;
        }
        const folded = foldUserPayload(prevMessage as AgentMessage & { role: "user" }, message);
        if (this.recovery) {
          this.units.updateUnitPairingByLineage(this.lineageId, userUnit.unit.contextSeq, {
            companionEntryId: event.entryId ?? "",
            pairKey: folded.pairKey,
            paired: folded.paired,
            payload: folded.payload,
          });
        } else {
          this.units.updateUnitPairing(runtimeSessionId, userUnit.unit.contextSeq, {
            companionEntryId: event.entryId ?? "",
            pairKey: folded.pairKey,
            paired: folded.paired,
            payload: folded.payload,
          });
        }
        continue;
      }

      const kind =
        message.role === "assistant"
          ? "assistant"
          : message.role === "toolResult"
            ? "tool_result"
            : null;
      if (kind === null) {
        continue; // 其他 role（如 reasoning/compaction 标签）不建单元
      }
      const seq = this.nextContextSeq(runtimeSessionId);
      this.units.insertUnit(
        this.buildUnit(runtimeSessionId, event, seq, kind, message as unknown as JsonValue),
        this.recovery ? { verifySessionBinding: false } : { runtimeSessionId },
      );
    }
    if (this.recovery) {
      return this.units.listUnitsByLineage(this.lineageId);
    }
    return this.units.listUnits(runtimeSessionId);
  }

  listUnits(
    runtimeSessionId: string,
    options: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    } = {},
  ): ContextMessageUnitV1[] {
    return this.units.listUnits(runtimeSessionId, options);
  }

  close(): void {
    this.units.close();
  }
}
