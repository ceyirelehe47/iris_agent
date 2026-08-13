/**
 * R3 Historian 模块移植说明（R3-P0 port）：
 *
 * 本文件从已通过审查的 `agent/r2-product-parity-fix-r3-historian` 分支
 * （commit 5b94db7，R3 v13 对齐实现 B1–B8）原样移植到 main，作为 R3
 * Historian 子系统的基座（issue #8 Phase B）。代码逻辑与分支保持逐字节一致；
 * 所有针对 main 依赖集的适配点均以内联中文注释（"移植说明/R3-P0"）标注。
 * 后续 R3-P1..P4 工作项负责对齐 v13 规格的增量（ContextHistoryReadPort
 * m0-clamp 等）。
 *
 * iris_agent#66：本端口（RuntimeSessionHistoryReadPort / SessionHistoryReadPort）
 * 是 **recovery/audit/raw-archive-only** 接口 —— Historian 的正常语义输入
 * 只允许 Context-owned 的 ContextHistoryReadPort（committed ContextMessageUnit）。
 * 生产 HistorianManager/Runner 构造不接受本端口（类型层面无法接入），
 * 只有显式 recovery/audit 路径（以及测试 fixture）可以使用它。
 */
import type { SessionTreeEntry } from "@iris/pi-agent-core";

import { stableHash } from "../contracts/historian.js";
import type {
  HistoryGap,
  RuntimeSessionHistoryReadPort,
  SequencedSessionEntry,
  SessionHistoryPage,
} from "../contracts/historian.js";

/**
 * Historian read port implementation (issue #8 Phase B Feature B1).
 *
 * A narrow, cursor-based view over the CURRENT Runtime Session's raw Pi
 * entries. entrySeq = the raw 1-based ordinal (the SAME basis the Context
 * projection uses — `entrySeqById.set(entry.id, index + 1)`), so the
 * Historian's range/cursor invariants align with the Context projection's
 * unit boundaries. ALL raw entry types are surfaced (message, custom_message,
 * model_change, active_tools_change, compaction, branch_summary, label, ...)
 * — never a filtered/compressed index inference (iris_agent#6).
 *
 * The port NEVER reads the Context repository (m0/m1/LKG). It consumes the
 * Session entries through a caller-supplied narrow read closure — the Host
 * wires it to the Pi Session's getEntries(); the Historian itself never
 * holds a Pi Session object.
 */

export interface HistoryReadPortOptions {
  /** Read the CURRENT raw entries of the active Runtime Session. */
  readRawEntries: () => Promise<SessionTreeEntry[]>;
}

/** Decode a raw entry into a hashable byte form (best-effort, stable). */
function entryContent(entry: SessionTreeEntry): unknown {
  // Keep the raw entry payload as-is; the content hash is over the whole
  // entry so ANY change (message content, custom details, timestamp,
  // parentId) invalidates the hash.
  return entry;
}

export class SessionHistoryReadPort implements RuntimeSessionHistoryReadPort {
  private readonly readRawEntries: () => Promise<SessionTreeEntry[]>;

  constructor(options: HistoryReadPortOptions) {
    this.readRawEntries = options.readRawEntries;
  }

  async readEntries(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive?: number;
    limit: number;
  }): Promise<SessionHistoryPage> {
    const raw = await this.readRawEntries();
    const after = input.afterEntrySeqExclusive ?? 0;
    const limit = Math.max(1, Math.floor(input.limit));

    const all: SequencedSessionEntry[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index];
      if (entry === undefined) {
        continue;
      }
      const entrySeq = index + 1; // raw 1-based ordinal (shared basis)
      if (entrySeq <= after) {
        continue;
      }
      all.push({
        runtimeSessionId: input.runtimeSessionId,
        entrySeq,
        entryId: entry.id,
        entry: entryContent(entry),
        contentHash: stableHash(entryContent(entry)),
      });
    }

    const page = all.slice(0, limit);
    const endOfSession = page.length === all.length;
    return {
      entries: page,
      nextCursor: endOfSession ? 0 : (page[page.length - 1]?.entrySeq ?? 0),
      endOfSession,
      gap: null,
    };
  }

  /**
   * Read all remaining entries in bounded pages (B3 finite-batch runner).
   * Each page re-reads from the Session — the caller freezes the boundary
   * FIRST and never widens the range (runner uses the frozen
   * eligibleThroughEntrySeq as its ceiling).
   */
  async readRangeUpTo(input: {
    runtimeSessionId: string;
    afterEntrySeqExclusive: number;
    throughEntrySeqInclusive: number;
    pageSize?: number;
  }): Promise<SequencedSessionEntry[]> {
    const raw = await this.readRawEntries();
    const out: SequencedSessionEntry[] = [];
    for (let index = input.afterEntrySeqExclusive; index < raw.length; index += 1) {
      const entry = raw[index];
      if (entry === undefined) {
        continue;
      }
      const entrySeq = index + 1;
      if (entrySeq > input.throughEntrySeqInclusive) {
        break; // frozen ceiling — the runner NEVER widens the range
      }
      out.push({
        runtimeSessionId: input.runtimeSessionId,
        entrySeq,
        entryId: entry.id,
        entry: entryContent(entry),
        contentHash: stableHash(entryContent(entry)),
      });
    }
    return out;
  }

  /**
   * Detect a durable gap (sequence) — surfaces, never guesses. Decode/schema
   * gaps do not occur at this layer (entries are surfaced raw, never
   * decoded); a decode layer above the port (B2) surfaces those HistoryGap
   * kinds. Sequence gaps are structurally impossible from an array-derived
   * ordinal, but the detector exists for consumers that re-derive ordinals.
   */
  static detectGap(entries: Array<{ entrySeq: number }>): HistoryGap | null {
    for (let index = 0; index < entries.length - 1; index += 1) {
      const current = entries[index];
      const next = entries[index + 1];
      if (current === undefined || next === undefined) {
        continue;
      }
      if (next.entrySeq !== current.entrySeq + 1) {
        return {
          fromEntrySeq: current.entrySeq + 1,
          toEntrySeq: next.entrySeq - 1,
          kind: "sequence_gap",
          detail: `raw entrySeq jumped from ${current.entrySeq} to ${next.entrySeq}`,
        };
      }
    }
    return null;
  }
}
