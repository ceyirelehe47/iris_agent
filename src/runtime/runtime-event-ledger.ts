import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  type PiSeamEvent,
  type RuntimeEvent,
  type RuntimeEventDerivationRefs,
  type RuntimeEventIngestPort,
  type RuntimeEventType,
} from "../contracts/runtime-events.js";
import { migrateDatabase } from "../db/migrate.js";

interface RuntimeEventRow {
  event_seq: number;
  event_id: string;
  runtime_session_id: string;
  pi_session_id: string | null;
  event_type: string;
  entry_id: string | null;
  entry_seq: number | null;
  content_hash: string | null;
  role: string | null;
  payload: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: number | null;
  disposition: string;
  derivation_refs: string;
  context_seq: number | null;
  raw_archive_ref: string | null;
  occurred_at: string;
  idempotency_key: string;
}

function parseDerivationRefs(json: string): RuntimeEventDerivationRefs {
  const parsed = JSON.parse(json) as Partial<RuntimeEventDerivationRefs>;
  return {
    memoryRefs: Array.isArray(parsed.memoryRefs) ? parsed.memoryRefs : [],
    compartmentIds: Array.isArray(parsed.compartmentIds) ? parsed.compartmentIds : [],
    sourceContextMessageUnitIds: Array.isArray(parsed.sourceContextMessageUnitIds)
      ? parsed.sourceContextMessageUnitIds
      : [],
    ...(typeof parsed.workSnapshotVersion === "string"
      ? { workSnapshotVersion: parsed.workSnapshotVersion }
      : {}),
  };
}

function rowToEvent(row: RuntimeEventRow): RuntimeEvent {
  return {
    eventId: row.event_id,
    runtimeSessionId: row.runtime_session_id,
    ...(row.pi_session_id !== null ? { piSessionId: row.pi_session_id } : {}),
    type: row.event_type as RuntimeEventType,
    ...(row.entry_id !== null ? { entryId: row.entry_id } : {}),
    ...(row.entry_seq !== null ? { entrySeq: row.entry_seq } : {}),
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    ...(row.role !== null ? { role: row.role } : {}),
    ...(row.payload !== null ? { payload: row.payload } : {}),
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_name !== null ? { toolName: row.tool_name } : {}),
    ...(row.is_error !== null ? { isError: row.is_error === 1 } : {}),
    disposition: row.disposition as RuntimeEvent["disposition"],
    derivationRefs: parseDerivationRefs(row.derivation_refs),
    ...(row.context_seq !== null ? { contextSeq: row.context_seq } : {}),
    ...(row.raw_archive_ref !== null ? { rawArchiveRef: row.raw_archive_ref } : {}),
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
  };
}

/** 默认 disposition：R1 全部 include（R2 由 Context ingest 决策）。 */
const DEFAULT_DERIVATION_REFS: RuntimeEventDerivationRefs = {
  memoryRefs: [],
  compartmentIds: [],
  sourceContextMessageUnitIds: [],
};

/**
 * RuntimeEvent ledger store（R1）。
 *
 * 持久化 immutable RuntimeEvents；`idempotency_key` 唯一约束实现 exactly-once
 * （重复 ingest 返回既有行，不产生重复 ledger 行）。所有写操作单事务。
 */
export class RuntimeEventLedger implements RuntimeEventIngestPort {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): RuntimeEventLedger {
    migrateDatabase(path, migrationsDirFor());
    const db = new DatabaseSync(path);
    // WAL 为持久属性（migrateDatabase 已设置）；synchronous=FULL 消除 WAL 默认
    // NORMAL 的掉电丢提交窗口——ledger 语义下值得显式钉住。
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    return new RuntimeEventLedger(db);
  }

  ingest(event: PiSeamEvent): RuntimeEvent {
    if (this.closed) {
      throw new Error("runtime event ledger is closed");
    }
    const eventId = randomUUID();
    const idempotencyKey = buildIdempotencyKey(event);
    const row: RuntimeEventRow = {
      event_seq: 0, // 由 SQLite AUTOINCREMENT 分配，占位。
      event_id: eventId,
      runtime_session_id: event.runtimeSessionId,
      pi_session_id: event.piSessionId ?? null,
      event_type: event.type,
      entry_id: event.entryId ?? null,
      entry_seq: event.entrySeq ?? null,
      content_hash: event.contentHash ?? null,
      role: event.role ?? null,
      payload: event.payload ?? null,
      tool_call_id: event.toolCallId ?? null,
      tool_name: event.toolName ?? null,
      is_error: event.isError === undefined ? null : event.isError ? 1 : 0,
      disposition: "include",
      derivation_refs: JSON.stringify(DEFAULT_DERIVATION_REFS),
      context_seq: null,
      raw_archive_ref: null,
      occurred_at: event.occurredAt,
      idempotency_key: idempotencyKey,
    };
    // exactly-once：ON CONFLICT(idempotency_key) DO NOTHING 使 INSERT 原子——
    // 重复或并发同键插入不产生新行，返回既有行；单写者假设下无竞态，
    // 跨连接场景也不会抛未处理的约束异常。
    const result = this.db
      .prepare(
        `INSERT INTO runtime_events (
           event_id, runtime_session_id, pi_session_id, event_type, entry_id, entry_seq,
           content_hash, role, payload, tool_call_id, tool_name, is_error,
           disposition, derivation_refs, context_seq, raw_archive_ref,
           occurred_at, idempotency_key, ingested_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        row.event_id,
        row.runtime_session_id,
        row.pi_session_id,
        row.event_type,
        row.entry_id,
        row.entry_seq,
        row.content_hash,
        row.role,
        row.payload,
        row.tool_call_id,
        row.tool_name,
        row.is_error,
        row.disposition,
        row.derivation_refs,
        row.context_seq,
        row.raw_archive_ref,
        row.occurred_at,
        row.idempotency_key,
        new Date().toISOString(),
      );
    if (result.changes === 0) {
      const existing = this.db
        .prepare("SELECT * FROM runtime_events WHERE idempotency_key = ?")
        .get(idempotencyKey) as RuntimeEventRow | undefined;
      if (existing !== undefined) {
        return rowToEvent(existing);
      }
      throw new Error("runtime event ingest conflict without existing row");
    }
    return rowToEvent(row);
  }

  listBySession(
    runtimeSessionId: string,
    options: { afterEventId?: string; limit?: number } = {},
  ): RuntimeEvent[] {
    const rows = (options.afterEventId === undefined
      ? this.db
          .prepare("SELECT * FROM runtime_events WHERE runtime_session_id = ? ORDER BY event_seq")
          .all(runtimeSessionId)
      : this.db
          .prepare(
            `SELECT * FROM runtime_events WHERE runtime_session_id = ? AND event_seq >
               (SELECT event_seq FROM runtime_events
                 WHERE event_id = ? AND runtime_session_id = ?)
             ORDER BY event_seq`,
          )
          .all(
            runtimeSessionId,
            options.afterEventId,
            runtimeSessionId,
          )) as unknown as RuntimeEventRow[];
    const limit = options.limit ?? rows.length;
    return rows.slice(0, limit).map(rowToEvent);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

function buildIdempotencyKey(event: PiSeamEvent): string {
  // message_finalized 以 entry 为 exactly-once 单元；其余以类型 + 时间戳为单元
  // （同 batch 内同类型事件靠时间戳区分，重复投递时时间戳相同 → 幂等）。
  if (event.type === "message_finalized" && event.entryId !== undefined) {
    return `message_finalized:${event.runtimeSessionId}:${event.entryId}`;
  }
  return `${event.type}:${event.runtimeSessionId}:${event.occurredAt}:${event.toolCallId ?? ""}`;
}

function migrationsDirFor(): string {
  // 迁移 SQL 与 schema 同目录；相对本源码文件解析，src/ 与 dist/ 构建均可用。
  return fileURLToPath(new URL("../db/migrations/runtime-events", import.meta.url));
}
