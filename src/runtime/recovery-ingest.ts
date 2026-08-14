/**
 * Historical-Session Recovery Ingest（thin adapter，非第二套 Context 实现）。
 *
 * ⚠️ @iris/context API gap：ContextService 的公开 API 没有 recovery-mode
 * ingest（ContextIngest(recovery=true) 未从包导出）。历史 Runtime Session
 * （rollover 后）无法经 resolveLineageId 按 session 解析，因此本 adapter 只
 * 为 Recovery Reconciler 提供「按 lineage 直查」的重放/补建：
 *
 *   - 全部权威原语（语义校验、kind→schema、contentHash basis、companion
 *     payload 判定、canonical event/store/unit 行）都来自 @iris/context
 *     （store 经 ContextService.getStore() 获得；validators/hash 来自
 *     @iris/context/contracts）；
 *   - 本文件只实现「recovery-mode 下如何把已提交事件重放为单元」的编排，
 *     不复刻 store/schema/validation/hash 的第二份实现；
 *   - 严格按 @iris/context ContextIngest(recovery=true) 的语义（ensureUnitsUpTo
 *     按 lineage 直查；insertUnit verifySessionBinding=false；companion 幂等
 *     合并；exactly-once 不重分配 contextSeq）。
 *
 * 恢复模式 NEVER 把旧 Session 重新变回 current。
 */
import type { ContextService } from "@iris/context";
import type {
  ContextMessageUnitV1,
  JsonValue,
  SemanticDerivationRefsV1,
} from "@iris/context/contracts";
import {
  KIND_TO_SEMANTIC_SCHEMA_ID,
  SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
  validateSemanticContentForSchema,
} from "@iris/context/contracts";
import type {
  CanonicalRuntimeEventV1,
  RuntimeEventInput,
} from "@iris/context/contracts/runtime-events";
import {
  computeContentTextHash,
  isCompanionEvent,
  isCompanionPayload,
} from "@iris/context/contracts/runtime-events";

/** ContextStore（经 ContextService.getStore() 获得的实例类型）。 */
type ContextStore = ReturnType<ContextService["getStore"]>;

/** 中性 user 折叠（与 @iris/context foldUserPayload 同一规则）。 */
function extractUserText(userPayload: JsonValue): string {
  if (userPayload === null || typeof userPayload !== "object" || Array.isArray(userPayload)) {
    return "";
  }
  const record = userPayload as Record<string, unknown>;
  const content = record["content"];
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        const text = (part as Record<string, unknown>)["text"];
        if (typeof text === "string") {
          return text;
        }
      }
      return "";
    })
    .join("\n");
}

function unitIdPrefixForKind(kind: "user" | "assistant" | "tool_result"): string {
  switch (kind) {
    case "user":
      return "unit-input";
    case "assistant":
      return "unit-assistant";
    case "tool_result":
      return "unit-tool-result";
  }
}

/**
 * 把已提交 RuntimeEventInput 重建为 ContextMessageUnitV1（与 @iris/context
 * ContextIngest.buildUnitBase 同一规则）。
 */
function buildUnitBase(
  input: RuntimeEventInput,
  seq: number,
  lineageId: string,
  kind: "user" | "assistant" | "tool_result",
  semanticContent: JsonValue,
): ContextMessageUnitV1 {
  const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[kind];
  const derivationRefs: SemanticDerivationRefsV1 = {
    schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
    memoryRefs: [...(input.derivationRefs?.memoryRefs ?? [])],
    compartmentIds: [...(input.derivationRefs?.compartmentIds ?? [])],
    ...(input.derivationRefs?.workSnapshotVersion !== undefined
      ? { workSnapshotVersion: input.derivationRefs.workSnapshotVersion }
      : {}),
    sourceContextMessageUnitIds: [...(input.derivationRefs?.sourceContextMessageUnitIds ?? [])],
  };
  return {
    schemaId: "iris.context_message_unit.v1",
    contextUnitId: `${unitIdPrefixForKind(kind)}-${input.eventId}`,
    contextLineageId: lineageId,
    contextSeq: seq,
    runtimeEventId: input.eventId,
    kind,
    semanticSchemaId,
    semanticContent,
    historianDisposition: "include",
    derivationRefs,
    contentHash: computeContextMessageUnitContentHashV1({
      semanticSchemaId,
      kind,
      historianDisposition: "include",
      derivationRefs,
      semanticContent,
    }),
    lifecycleState: "committed",
    ...(input.rawArchiveRef !== undefined ? { rawArchiveRef: input.rawArchiveRef } : {}),
    createdAt: input.occurredAt,
  };
}

/** 用户单元构建（fold user payload，不写 pairing 列 —— 由 companion 合并）。 */
function buildUserUnit(input: RuntimeEventInput, seq: number, lineageId: string) {
  const semanticContent = input.payload;
  return buildUnitBase(input, seq, lineageId, "user", semanticContent);
}

/**
 * Recovery Reconciler 专用：在 contextService 上按 lineage 直查重放。
 *
 * 1. resolveLineageForRecovery（绑定 ledger + checksum + receipt 身份验证，
 *    fail closed）；
 * 2. 重放 pending 事件：为缺失单元建单元（insertUnit verifySessionBinding
 *    = false；contextSeq 在 lineage 内全局连续，不重分配既有 identity）；
 * 3. companion 幂等合并（主单元存在后重新合并配对）；
 * 4. acknowledgeSessionReconciled（对账完成，binding 可回收）。
 */
export class HistoricalSessionRecoveryIngest {
  private readonly store: ContextStore;
  private readonly lineageId: string;

  constructor(contextService: ContextService, lineageId: string) {
    this.store = contextService.getStore();
    this.lineageId = lineageId;
  }

  /** 验证并解析历史 Session 的 lineage（绑定 ledger + checksum + receipt）。 */
  resolveLineageForRecovery(
    runtimeSessionId: string,
    receipt: { sessionId: string; entryId: string; contentHash: string },
  ): string {
    const lineageId = this.store.resolveLineageForRecovery(runtimeSessionId, receipt);
    if (lineageId !== this.lineageId) {
      throw new Error(
        `recovery ingest: receipt resolves to lineage ${lineageId}, expected ${this.lineageId} (fail closed)`,
      );
    }
    return lineageId;
  }

  /**
   * 原子 ingest 一个 RuntimeEventInput（recovery 模式：按 lineage 直查；
   * 不对历史 Session 做 session-resolution 校验）。
   */
  ingestRuntimeEvent(input: RuntimeEventInput): {
    event: CanonicalRuntimeEventV1;
    unit: ContextMessageUnitV1 | null;
  } {
    this.validateInput(input);
    const existing = this.store.findRuntimeEventByEventId(input.eventId);
    if (existing !== undefined) {
      return {
        event: existing,
        unit: this.store.findBySourceEvent(input.eventId)?.unit ?? null,
      };
    }
    const seq = this.store.nextContextSeqForLineage(this.lineageId);
    this.store.beginAtomicIngest();
    try {
      const event = this.store.ingestRuntimeEvent(input, {
        contextLineageId: this.lineageId,
        contextSeq: seq,
      });
      if (isCompanionEvent(input)) {
        this.mergeCompanion(input);
        this.store.commitAtomicIngest();
        return { event, unit: null };
      }
      const built = this.buildUnit(input, seq);
      if (built !== null && !this.store.hasUnitForEvent(input.eventId)) {
        this.store.insertUnit(built.unit, { verifySessionBinding: false });
      }
      this.store.commitAtomicIngest();
      return { event, unit: built?.unit ?? null };
    } catch (error) {
      this.store.rollbackAtomicIngest();
      throw error;
    }
  }

  /** 重放/恢复对账：按 lineage 读取已提交事件，为缺失单元建单元（幂等）。 */
  ensureUnitsUpTo(): ContextMessageUnitV1[] {
    const events = this.store.listStoredEventsByLineage(this.lineageId);
    for (const event of events) {
      const input = this.store.reconstructRuntimeEventInput(event);
      if (isCompanionEvent(input)) {
        if (input.companionOf !== undefined) {
          this.mergeCompanion(input); // 幂等；主单元缺失则跳过
        }
        continue;
      }
      if (this.store.hasUnitForEvent(event.runtimeEventId)) {
        continue; // exactly-once
      }
      const built = this.buildUnit(input, event.contextSeq);
      if (built === null) {
        continue; // ledger-only 事件
      }
      this.store.insertUnit(built.unit, { verifySessionBinding: false });
    }
    return this.store.listUnitsByLineage(this.lineageId);
  }

  /** 标记对账完成（binding 可回收的前提）。 */
  acknowledgeSessionReconciled(runtimeSessionId: string): void {
    this.store.acknowledgeSessionReconciled(runtimeSessionId);
  }

  private validateInput(input: RuntimeEventInput): void {
    if (isCompanionEvent(input)) {
      if (!isCompanionPayload(input.payload)) {
        throw new Error(
          `recovery ingest: companion event ${input.eventId} payload must be CompanionPayloadV1 (fail closed)`,
        );
      }
      return;
    }
    const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[input.kind];
    if (semanticSchemaId === undefined) {
      throw new Error(
        `recovery ingest: unknown RuntimeEventKind ${JSON.stringify(input.kind)} (fail closed)`,
      );
    }
    const error = validateSemanticContentForSchema(semanticSchemaId, input.payload);
    if (error !== null) {
      throw new Error(
        `recovery ingest: semantic content for kind ${input.kind} failed validation: ${error} (fail closed)`,
      );
    }
  }

  private mergeCompanion(input: RuntimeEventInput): void {
    const mainEventId = input.companionOf;
    if (mainEventId === undefined) {
      return; // 孤立 companion：fail-conservative
    }
    const mainRecord = this.store.findBySourceEvent(mainEventId);
    if (mainRecord?.unit.kind !== "user") {
      return;
    }
    if (mainRecord.persistenceMeta.paired) {
      return; // 已配对：幂等
    }
    if (!isCompanionPayload(input.payload)) {
      return;
    }
    const payload = input.payload as {
      pairKey?: string;
      contentHash?: string;
    };
    const text = extractUserText(mainRecord.unit.semanticContent);
    const pairKey = typeof payload.pairKey === "string" ? payload.pairKey : "";
    const contentHash = typeof payload.contentHash === "string" ? payload.contentHash : undefined;
    const verified = contentHash !== undefined && computeContentTextHash(text) === contentHash;
    this.store.updateUnitPairingColumns(this.lineageId, mainRecord.unit.contextSeq, {
      companionEntryId: input.eventId,
      pairKey,
      paired: verified,
    });
  }

  private buildUnit(input: RuntimeEventInput, seq: number): { unit: ContextMessageUnitV1 } | null {
    switch (input.kind) {
      case "user":
        return { unit: buildUserUnit(input, seq, this.lineageId) };
      case "assistant":
      case "tool_result":
        return { unit: buildUnitBase(input, seq, this.lineageId, input.kind, input.payload) };
      case "tool_call":
      case "body_event":
      case "operational":
        return null;
      default:
        throw new Error(
          `recovery ingest: unhandled kind ${JSON.stringify(input.kind)} (fail closed)`,
        );
    }
  }
}
