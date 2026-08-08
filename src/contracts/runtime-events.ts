/**
 * RuntimeEvent — canonical event ledger contract (Roadmap v13, R1).
 *
 * v13 正式认知链路的源：Pi runtime 产生 stable lifecycle events（message
 * finalized / session committed / tool execution committed / turn committed /
 * agent settled），Iris 将它们 exactly-once 提交为 immutable RuntimeEvent
 * ledger（contextSeq 在 R2 由 ContextMessageUnit 补充）。本契约与
 * blueforst/pi 的 PI-015/016/017 seam（fork 已合并）对齐。
 */

export type RuntimeEventType =
  | "message_finalized" // 消息条目落盘（user / assistant / tool_result）
  | "turn_committed" // 回合（assistant 响应 + 其 tool results）提交
  | "tool_execution_committed" // 工具执行提交
  | "session_committed" // session 提交边界
  | "agent_settled" // agent 结算（原生 settled）
  | "abort"; // 中止（原生 abort）

export type RuntimeEventDisposition = "include" | "reference_only" | "exclude";

export interface RuntimeEventDerivationRefs {
  memoryRefs: string[];
  compartmentIds: string[];
  sourceContextMessageUnitIds: string[];
  workSnapshotVersion?: string;
}

/**
 * 不可变 RuntimeEvent。`contextSeq` 在 R1 为 undefined，R2 Context ingest
 * 分配后回填（或按 contextSeq 重投影）。`idempotencyKey` 保证 exactly-once。
 */
export interface RuntimeEvent {
  eventId: string;
  runtimeSessionId: string;
  piSessionId?: string;
  type: RuntimeEventType;
  entryId?: string;
  entrySeq?: number;
  contentHash?: string;
  /** message_finalized 的模型可见 role（user/assistant/toolResult/custom）。 */
  role?: string;
  /** message_finalized 的消息内容（canonical JSON AgentMessage；语义单元的数据源）。 */
  payload?: string;
  /** tool_execution_committed 的 attribution。 */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  disposition: RuntimeEventDisposition;
  derivationRefs: RuntimeEventDerivationRefs;
  contextSeq?: number;
  rawArchiveRef?: string;
  occurredAt: string;
  idempotencyKey: string;
}

/**
 * 与 pi fork seam 对齐的输入事件（PI-016/017：message_finalized /
 * turn_committed / tool_execution_committed / settled / abort），并携带
 * SessionCommitReceipt 字段。iris_agent 的 seam adapter 把 fork OwnEvent
 * 转换为本结构，再由 RuntimeEventIngestPort exactly-once 提交。
 */
export interface PiSeamEvent {
  type:
    "message_finalized" | "turn_committed" | "tool_execution_committed" | "agent_settled" | "abort";
  runtimeSessionId: string;
  piSessionId?: string;
  /** message_finalized 携带的 commit receipt 字段。 */
  entryId?: string;
  entrySeq?: number;
  contentHash?: string;
  /** message_finalized 的模型可见 role（user/assistant/toolResult/custom）。 */
  role?: string;
  /** message_finalized 的消息内容（canonical JSON AgentMessage）。 */
  payload?: string;
  /** turn_committed 携带。 */
  toolResultCount?: number;
  hadPendingMutations?: boolean;
  /** tool_execution_committed 携带。 */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  occurredAt: string;
}

/** 窄、版本化的 ingest 契约：RuntimeEvent exactly-once 提交与顺序读取（同步 SQLite）。 */
export interface RuntimeEventIngestPort {
  ingest(event: PiSeamEvent): RuntimeEvent;
  listBySession(
    runtimeSessionId: string,
    options?: { afterEventId?: string; limit?: number },
  ): RuntimeEvent[];
  close(): void;
}
