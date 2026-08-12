import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  KIND_TO_SEMANTIC_SCHEMA_ID,
  SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
  computeSemanticContentHash,
  type ContextMessageUnitLifecycleState,
  type ContextMessageUnitV1,
  type JsonValue,
  type RawArchiveRefV1,
  type SemanticDerivationRefsV1,
  type UnitDispositionFilter,
} from "../contracts/context-v27.js";
import type { ContextUnitStorePort } from "./context-ingest.js";

/**
 * F4 (iris_agent#9 / feature 4.1): typed failure for lineage resolution on the
 * normal production write path. An unknown, stale, wrong-data-root or
 * corrupted runtimeSessionId binding must NEVER silently fall back to the
 * store's default lineage (that would write identity-level semantic units
 * under the wrong identity). Recovery flows use the explicit reconciliation
 * API (resolveLineageIdOrNull) instead; they must not reuse this error path.
 */
export class ContextLineageResolutionError extends Error {
  readonly code = "context_lineage_resolution" as const;
  readonly runtimeSessionId: string;
  constructor(runtimeSessionId: string) {
    super(
      `No durable context lineage is bound to runtime session ${runtimeSessionId}; ` +
        "refusing to resolve it to a default lineage (fail-closed). " +
        "Bind the session explicitly (createLineage) or use the reconciliation API.",
    );
    this.name = "ContextLineageResolutionError";
    this.runtimeSessionId = runtimeSessionId;
  }
}

interface UnitRow {
  context_lineage_id: string;
  context_seq: number;
  unit_id: string;
  runtime_event_id: string | null;
  source_event_id: string;
  unit_type: string;
  disposition: string;
  entry_id: string | null;
  entry_seq: number | null;
  content_hash: string;
  payload: string;
  companion_entry_id: string | null;
  pair_key: string | null;
  paired: number;
  derivation_refs: string;
  schema_version: string;
  raw_archive_ref: string | null;
  semantic_schema_id: string | null;
  lifecycle_state: string;
  content_hash_basis: string;
  created_at: string;
}

/**
 * Feature A (#110): a canonical ContextMessageUnitV1 bundled with the
 * persistence-layer-only metadata the SQLite mapping tracks. The V1 DTO has
 * NO fields for sourceEventId/entryId/entrySeq/companionEntryId/pairKey/
 * paired — those are physical mapping details owned by the store and are
 * exposed only through this record (used by the ingest pairing flow).
 */
export interface UnitStoreRecord {
  readonly unit: ContextMessageUnitV1;
  readonly persistenceMeta: {
    readonly sourceEventId: string;
    readonly entryId: string | null;
    readonly entrySeq: number | null;
    readonly companionEntryId: string | null;
    readonly pairKey: string | null;
    readonly paired: boolean;
  };
}

/**
 * Feature A (#110): physical unit_type → canonical V1 kind mapping
 * (input→user, assistant→assistant, tool_result→tool_result). Unknown
 * physical values (schema drift) fail closed — never guessed.
 */
function physicalUnitTypeToKind(unitType: string): ContextMessageUnitV1["kind"] {
  switch (unitType) {
    case "input":
      return "user";
    case "assistant":
      return "assistant";
    case "tool_result":
      return "tool_result";
    default:
      throw new Error(
        `context rowToUnit: unknown physical unit_type ${JSON.stringify(unitType)} (fail closed)`,
      );
  }
}

/**
 * Feature A (#110): V1 kind → physical unit_type for the SQLite CHECK
 * constraint ('input'|'assistant'|'tool_result'). Kinds not representable in
 * the physical schema (tool_call/body_event/operational) fail closed — never
 * guessed into a wrong physical row.
 */
function kindToPhysicalUnitType(
  kind: ContextMessageUnitV1["kind"],
): "input" | "assistant" | "tool_result" {
  switch (kind) {
    case "user":
      return "input";
    case "assistant":
      return "assistant";
    case "tool_result":
      return "tool_result";
    case "tool_call":
    case "body_event":
    case "operational":
      throw new Error(
        `context insertUnit: kind ${kind} has no physical unit_type mapping (fail closed)`,
      );
  }
}

/**
 * Feature A (#110): physical disposition → canonical V1 historianDisposition.
 * The legacy 'retired' value (present in pre-constraint historical rows)
 * maps to 'exclude' — a retired unit must never re-enter the provider or
 * Historian basis view. Unknown values fail closed.
 */
function physicalDispositionToHistorian(
  disposition: string,
): ContextMessageUnitV1["historianDisposition"] {
  switch (disposition) {
    case "include":
    case "reference_only":
    case "exclude":
      return disposition;
    case "retired":
      return "exclude";
    default:
      throw new Error(
        `context rowToUnit: unknown physical disposition ${JSON.stringify(disposition)} (fail closed)`,
      );
  }
}

/**
 * Feature A5 (#113): strict, lossless parse of the stored derivation refs
 * JSON into the canonical SemanticDerivationRefsV1. FAIL CLOSED:
 *
 * - invalid JSON / non-object / wrong-typed members → throw (never silently
 *   omitted, never filtered into a different canonical meaning);
 * - unknown keys → throw (a value with unknown keys is not a valid
 *   SemanticDerivationRefsV1 object);
 * - the DEPRECATED legacy key `sourceContextUnitIds` is explicitly migrated
 *   to `sourceContextMessageUnitIds` when the canonical key is absent (both
 *   present → ambiguous → throw);
 * - a missing schemaId (pre-Feature-A shape) is explicitly migrated by
 *   tagging the canonical schemaId; a PRESENT schemaId must equal the
 *   canonical value.
 *
 * Key presence is preserved (empty arrays stay present), so the parsed
 * object matches byte-for-byte what the write path hashed.
 */
function parseStoredDerivationRefs(raw: string): SemanticDerivationRefsV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `context rowToUnit: corrupt derivation_refs JSON ${JSON.stringify(raw)} (fail closed)`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `context rowToUnit: derivation_refs must be an object, got ${JSON.stringify(raw)} (fail closed)`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const knownKeys = new Set<string>([
    "schemaId",
    "memoryRefs",
    "compartmentIds",
    "workSnapshotVersion",
    "sourceContextMessageUnitIds",
    LEGACY_SOURCE_CONTEXT_MESSAGE_UNIT_IDS_KEY,
  ]);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `context rowToUnit: derivation_refs contains unknown key ${JSON.stringify(key)} (fail closed)`,
      );
    }
  }
  const stringList = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value) || value.some((member) => typeof member !== "string")) {
      throw new Error(
        `context rowToUnit: derivation_refs.${field} must be an array of strings (fail closed)`,
      );
    }
    return value as string[];
  };
  const memoryRefs = stringList(record["memoryRefs"], "memoryRefs");
  const compartmentIds = stringList(record["compartmentIds"], "compartmentIds");
  const sourceContextMessageUnitIds = stringList(
    record["sourceContextMessageUnitIds"],
    "sourceContextMessageUnitIds",
  );
  // Explicit legacy migration: the deprecated pre-v27 key name. Only legal
  // when the canonical key is absent (both present → ambiguous → fail closed).
  const legacySourceIds = stringList(
    record[LEGACY_SOURCE_CONTEXT_MESSAGE_UNIT_IDS_KEY],
    LEGACY_SOURCE_CONTEXT_MESSAGE_UNIT_IDS_KEY,
  );
  if (legacySourceIds !== undefined && sourceContextMessageUnitIds !== undefined) {
    throw new Error(
      "context rowToUnit: derivation_refs carries BOTH sourceContextUnitIds and " +
        "sourceContextMessageUnitIds (ambiguous legacy+canonical) (fail closed)",
    );
  }
  const workSnapshotVersion = record["workSnapshotVersion"];
  if (workSnapshotVersion !== undefined && typeof workSnapshotVersion !== "number") {
    throw new Error(
      `context rowToUnit: derivation_refs.workSnapshotVersion must be a number (fail closed)`,
    );
  }
  const storedSchemaId = record["schemaId"];
  if (storedSchemaId !== undefined && storedSchemaId !== SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID) {
    throw new Error(
      `context rowToUnit: derivation_refs has unknown schemaId ${JSON.stringify(storedSchemaId)} (fail closed)`,
    );
  }
  return {
    schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
    ...(memoryRefs !== undefined ? { memoryRefs } : {}),
    ...(compartmentIds !== undefined ? { compartmentIds } : {}),
    ...(workSnapshotVersion !== undefined ? { workSnapshotVersion } : {}),
    ...(sourceContextMessageUnitIds !== undefined
      ? { sourceContextMessageUnitIds }
      : legacySourceIds !== undefined
        ? { sourceContextMessageUnitIds: legacySourceIds }
        : {}),
  };
}

/**
 * Feature A5 (#113): strict, lossless parse of the stored raw archive ref
 * into a REAL RawArchiveRefV1 object at runtime (no type-cast masquerade).
 *
 * - Canonical JSON form: parsed and structurally validated field by field;
 *   a corrupt or unknown-shaped object fails closed.
 * - Legacy string form (`pi://session/<id>/entry/<entryId>`, pre-Feature-A
 *   rows): EXPLICITLY parsed/migrated into the structured contract. The
 *   session id and entry id are extracted; any other string fails closed.
 */
function parseStoredRawArchiveRef(raw: string): RawArchiveRefV1 {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error(
        `context rowToUnit: corrupt raw_archive_ref JSON ${JSON.stringify(raw)} (fail closed)`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `context rowToUnit: raw_archive_ref must be an object, got ${JSON.stringify(raw)} (fail closed)`,
      );
    }
    const record = parsed as Record<string, unknown>;
    if (record["schemaId"] !== "iris.raw_archive_ref.v1") {
      throw new Error(
        `context rowToUnit: raw_archive_ref has unknown schemaId ${JSON.stringify(record["schemaId"])} (fail closed)`,
      );
    }
    const runtimeSessionId = record["runtimeSessionId"];
    if (typeof runtimeSessionId !== "string" || runtimeSessionId.length === 0) {
      throw new Error(
        "context rowToUnit: raw_archive_ref.runtimeSessionId must be a non-empty string (fail closed)",
      );
    }
    const optionalNumber = (value: unknown, field: string): number | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(
          `context rowToUnit: raw_archive_ref.${field} must be a non-negative integer (fail closed)`,
        );
      }
      return value;
    };
    const optionalStringList = (value: unknown, field: string): readonly string[] | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (!Array.isArray(value) || value.some((member) => typeof member !== "string")) {
        throw new Error(
          `context rowToUnit: raw_archive_ref.${field} must be an array of strings (fail closed)`,
        );
      }
      return value as string[];
    };
    const startEntrySeq = optionalNumber(record["startEntrySeq"], "startEntrySeq");
    const endEntrySeq = optionalNumber(record["endEntrySeq"], "endEntrySeq");
    const entryIds = optionalStringList(record["entryIds"], "entryIds");
    const blobRefs = optionalStringList(record["blobRefs"], "blobRefs");
    const sourceHash = record["sourceHash"];
    if (sourceHash !== undefined && typeof sourceHash !== "string") {
      throw new Error(
        "context rowToUnit: raw_archive_ref.sourceHash must be a string (fail closed)",
      );
    }
    for (const key of Object.keys(record)) {
      if (
        ![
          "schemaId",
          "runtimeSessionId",
          "startEntrySeq",
          "endEntrySeq",
          "entryIds",
          "sourceHash",
          "blobRefs",
        ].includes(key)
      ) {
        throw new Error(
          `context rowToUnit: raw_archive_ref contains unknown key ${JSON.stringify(key)} (fail closed)`,
        );
      }
    }
    const ref: RawArchiveRefV1 = {
      schemaId: "iris.raw_archive_ref.v1",
      runtimeSessionId,
      ...(startEntrySeq !== undefined ? { startEntrySeq } : {}),
      ...(endEntrySeq !== undefined ? { endEntrySeq } : {}),
      ...(entryIds !== undefined ? { entryIds } : {}),
      ...(sourceHash !== undefined ? { sourceHash } : {}),
      ...(blobRefs !== undefined ? { blobRefs } : {}),
    };
    return ref;
  }
  // Legacy string form — explicitly migrated, never cast.
  const legacy = /^pi:\/\/session\/([^/]+)\/entry\/(.+)$/.exec(trimmed);
  const runtimeSessionId = legacy?.[1];
  const entryId = legacy?.[2];
  if (runtimeSessionId === undefined || entryId === undefined) {
    throw new Error(
      `context rowToUnit: unrecognized raw_archive_ref ${JSON.stringify(raw)} (fail closed)`,
    );
  }
  return {
    schemaId: "iris.raw_archive_ref.v1",
    runtimeSessionId,
    entryIds: [entryId],
  };
}

/**
 * Feature A5 (#113): the canonical unit lifecycle states, fail-closed parsed
 * from the persisted column — never fabricated.
 */
const CANONICAL_LIFECYCLE_STATES: readonly ContextMessageUnitLifecycleState[] = [
  "committed",
  "historian_eligible",
  "historian_claimed",
  "compartmentalized_pending_bust",
  "represented_in_p3",
  "retired",
];

function parseLifecycleState(raw: string): ContextMessageUnitLifecycleState {
  if ((CANONICAL_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return raw as ContextMessageUnitLifecycleState;
  }
  throw new Error(
    `context rowToUnit: unknown lifecycle_state ${JSON.stringify(raw)} (fail closed)`,
  );
}

/**
 * Schema version of the Context domain model. Every migration file under
 * src/db/migrations/context/ must be applied in order; the store fails closed
 * if the on-disk schema_migrations.max(version) is NEWER than this constant
 * (a newer binary wrote state this binary cannot read).
 */
// iris_agent#113: legacy fence — this key name is prohibited in new contracts
// but must be read for backward-compatible SQLite deserialization
const LEGACY_SOURCE_CONTEXT_MESSAGE_UNIT_IDS_KEY = "sourceContextUnitIds";
export const LATEST_MIGRATION_VERSION = "0008_lifecycle_state";

/**
 * R2-P3：每 session 的 context_units 软 cap（语义 ledger 有界化的第一级）。
 * 单元总数（含已排除行）达到该值时，新单元以 disposition="exclude" 写入：
 * provider 视图不可见（listUnits 默认过滤），且作为 R3 Historian 的裁剪候选。
 * append-only 不变量不变——行永不物理删除，只改 disposition 标记。
 */
export const MAX_UNITS_PER_SESSION = 10_000;

/**
 * R2-P3：每 session 的 context_units 硬 cap（= 2× 软 cap，安全阀）。
 * 单元总数达到该值时 insertUnit 拒绝写入并抛 ContextBoundsExceededError →
 * 记录 lineage 紧急态 emergency_fail_closed → 错误经 seam 传播使 slice 大声失败
 * （fail-closed：绝不允许语义 ledger 无界增长，也不允许超限后继续正常渲染）。
 */
export const HARD_UNITS_CAP = 2 * MAX_UNITS_PER_SESSION;

/**
 * R2-P3：context_units 硬 cap 超限的 typed 失败（fail-closed）。insertUnit 检测到
 * 该 session 单元总数 >= 硬 cap 时抛出；经 ingest → seam subscribe 回调（emitOwn
 * rethrow）自然传播，使 harness.prompt / runMinimalSlice 大声失败。抛出前绝不
 * 删除任何行（append-only 不变量绑定）。
 */
export class ContextBoundsExceededError extends Error {
  constructor(
    readonly runtimeSessionId: string,
    readonly hardCap: number,
  ) {
    super(
      `context_units hard cap exceeded: session ${runtimeSessionId} reached ${hardCap} units (fail closed)`,
    );
    this.name = "ContextBoundsExceededError";
  }
}

/**
 * iris_agent#63: bounded historical Session→lineage binding ledger.
 *
 * Retention policy (documented here and in migration 0006; synchronized to
 * the Notion deployment/Context docs):
 *  - SOFT_LIMIT_HISTORICAL_BINDINGS: when the historical binding count
 *    exceeds this, bindCurrentSession/createLineage opportunistically
 *    reclaims reconciled bindings outside the retain window. Reclaim is
 *    best-effort — a soft breach is NOT fail-closed (rollover must never be
 *    blocked by audit bookkeeping).
 *  - HARD_LIMIT_HISTORICAL_BINDINGS: when even after opportunistic reclaim
 *    the historical count still exceeds this, binding a NEW current session
 *    fails closed with a typed error. The ledger is therefore bounded: it
 *    can never grow past HARD_LIMIT + RETAIN_RECENT_HISTORICAL_BINDINGS.
 *  - RETAIN_RECENT_HISTORICAL_BINDINGS: the most recent historical bindings
 *    are NEVER reclaimed (audit checkpoint + late-recovery margin — the
 *    newest bindings are the ones most likely to still be needed by an
 *    in-flight rollover/recovery window).
 *
 * Reclaim eligibility is tied to authoritative evidence, NOT wall-clock:
 * a historical binding is reclaimable only after the Recovery Reconciler
 * acknowledged the Session (acknowledgeSessionReconciled) — proving its
 * pending Pi receipt window is fully consumed. Unacknowledged bindings stay
 * resolvable forever. Pruned bindings are copied to
 * session_lineage_bindings_audit before deletion (audit provenance kept),
 * and resolution of a pruned session fails closed with the typed
 * ContextLineageResolutionError — no old Session can become current again.
 */
export const SOFT_LIMIT_HISTORICAL_BINDINGS = 4_096;
export const HARD_LIMIT_HISTORICAL_BINDINGS = 16_384;
export const RETAIN_RECENT_HISTORICAL_BINDINGS = 64;

/** iris_agent#63: typed fail-closed for an unbounded binding ledger. */
export class ContextBindingLedgerExceededError extends Error {
  constructor(readonly hardLimit: number) {
    super(
      `historical session->lineage binding ledger exceeded the hard limit ` +
        `${hardLimit} even after opportunistic reclaim (fail closed); ` +
        "resolve pending recovery windows or raise the limit",
    );
    this.name = "ContextBindingLedgerExceededError";
  }
}

/**
 * iris_agent#74: typed fail-closed for an unbounded binding AUDIT STAGING
 * backlog inside the active context.db. Reclaimed rows are staged in
 * session_lineage_bindings_audit and drained to the EXTERNAL archive
 * (context-archive.db) by archiveBindingAudit(); if the drain cannot keep
 * up (archive unavailable/disk failure) and the staging backlog crosses the
 * hard cap, binding a new current Session fails closed — the active
 * context.db must never become a lifetime archive.
 */
export class ContextAuditBacklogExceededError extends Error {
  constructor(readonly hardCap: number) {
    super(
      `session_lineage_bindings_audit staging backlog exceeded the hard cap ` +
        `${hardCap} (fail closed); the external binding archive is not draining — ` +
        "restore archive write access or raise the cap",
    );
    this.name = "ContextAuditBacklogExceededError";
  }
}

/**
 * iris_agent#74: binding audit staging caps — the active context.db only
 * holds the in-flight staging window; the lifetime archive lives in the
 * external context-archive.db.
 */
export const AUDIT_STAGING_SOFT_CAP = 1_024;
export const AUDIT_STAGING_HARD_CAP = 16_384;

/** ContextStore.open 的构造选项（R2-P3 cap 注入：测试用极小值在少量单元内触发 cap 路径）。 */
export interface ContextStoreOpenOptions {
  /** 每 session 软 cap（超限单元标记 disposition="exclude"）。缺省 = MAX_UNITS_PER_SESSION。 */
  maxUnitsPerSession?: number;
  /**
   /** R2 (iris_agent#9)：identity-level lineage id。一个 Iris identity/data
    * root 恰好一条 durable Context lineage（one lineage → many bounded
    * Runtime Sessions）。调用方（vertical-slice/host）从 data root 派生稳定
    * id（如 sha256(dataRoot) 前缀）。缺省时用 "identity-default"（单根
    * 开发环境语义）。legacy session-scoped 行已被 0004 quarantine，永不读取。
    */
  lineageId?: string;
  /**
   * iris_agent#63: binding-ledger retention bounds (test injection).
   * Defaults are the production constants SOFT_LIMIT_HISTORICAL_BINDINGS /
   * HARD_LIMIT_HISTORICAL_BINDINGS / RETAIN_RECENT_HISTORICAL_BINDINGS.
   */
  bindingSoftLimit?: number;
  bindingHardLimit?: number;
  bindingRetainRecent?: number;
  /**
   * iris_agent#74: external binding-audit archive path. Defaults to
   * `<dirname(contextDbPath)>/context-archive.db` — a SEPARATE SQLite file
   * owned outside the active context.db (the active db stays bounded).
   */
  archiveDbPath?: string;
  /** iris_agent#74: audit staging soft cap (default AUDIT_STAGING_SOFT_CAP). */
  auditStagingSoftCap?: number;
  /** iris_agent#74: audit staging hard cap (default AUDIT_STAGING_HARD_CAP). */
  auditStagingHardCap?: number;
}

export interface ContextLineage {
  /** R2 (iris_agent#9)：identity-level lineage id（one per data root）。 */
  lineageId: string;
  /** 当前绑定的 Pi Runtime Session（rollover 时更新，lineage 不换）。 */
  currentRuntimeSessionId: string;
  contextSourceSnapshotId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  continuitySeedId?: string;
  runtimeRecoveryNoticeId?: string;
  stableMemoryPoolVersion?: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  materializationId: string;
  contextSerializerVersion: string;
  carrierSchemaVersion: string;
  m0Body: string | null;
  m1Body: string | null;
  m0ContentHash: string | null;
  m1ContentHash: string | null;
  m0MaterializedAt: number | null;
  m1UpdatedAt: number | null;
  cachedM0SystemHash: string | null;
  cachedM0ModelKey: string | null;
  cachedM0ProviderProfileId: string | null;
  lastResponseTime: number | null;
  /** v12 legacy narrow mapping（entrySeq 空间）；v13 权威是 contextSeq。 */
  representedThroughEntrySeq: number;
  /** R2-P1：Provider Renderer 的 context_seq 空间 watermark（ContextMessageUnit
   * 序号，非 Session entrySeq）。m0 物化前缀覆盖到该 seq；其后的单元是 live
   * tail（p5Tail）。 */
  representedThroughContextSeq: number;
  protectedTailStartEntrySeq: number | null;
  lastSafeUserAnchorEntrySeq: number | null;
  clearedReasoningThroughTag: number;
  toolReclaimWatermark: number;
  mutationReplayWatermark: number;
  deferredSignalCursor: number;
  emergencyState: "ok" | "transform_unavailable" | "emergency_fail_closed";
  lastTransformError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLineageInput {
  /** R2 (iris_agent#9)：identity-level lineage id（one per data root）。
   * 缺省 = runtimeSessionId（兼容旧调用方/测试；生产由调用方从 data root
   * 派生稳定 id）。 */
  lineageId?: string;
  /** 创建时绑定的首个 Pi Runtime Session。 */
  runtimeSessionId: string;
  contextSourceSnapshotId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  materializationId: string;
  contextSerializerVersion: string;
  carrierSchemaVersion: string;
}

export interface MaterializeM0Input {
  runtimeSessionId: string;
  m0Body: string;
  m1Body: string;
  m0ContentHash: string;
  m1ContentHash: string;
  cachedM0SystemHash: string;
  cachedM0ModelKey: string;
  cachedM0ProviderProfileId: string;
  representedThroughEntrySeq: number;
  protectedTailStartEntrySeq: number;
  lastSafeUserAnchorEntrySeq: number;
  atMs: number;
}

export interface MaterializeM1Input {
  runtimeSessionId: string;
  m1Body: string;
  m1ContentHash: string;
  representedThroughEntrySeq: number;
  atMs: number;
}

/**
 * R2-P1：HARD 物化（context_seq 语义）。与 v12 materializeM0 的唯一区别是
 * watermark 为 represented_through_context_seq（ContextMessageUnit 序号），
 * 绝不回写 v12 的 represented_through_entry_seq —— 两者空间不同，不得混用。
 */
export interface MaterializeM0ByContextSeqInput {
  runtimeSessionId: string;
  m0Body: string;
  m1Body: string;
  m0ContentHash: string;
  m1ContentHash: string;
  cachedM0SystemHash: string;
  cachedM0ModelKey: string;
  cachedM0ProviderProfileId: string;
  representedThroughContextSeq: number;
  atMs: number;
}

/** R2-P1：SOFT 物化（context_seq 语义），仅更新 m1，不推进物化 watermark
 * （watermark 只在 HARD fold 时推进；SOFT 的 m1 从物化水位后累积渲染，
 * 保证未进 m0 的单元始终在 provider 视图内，内容不丢失）。 */
export interface MaterializeM1ByContextSeqInput {
  runtimeSessionId: string;
  m1Body: string;
  m1ContentHash: string;
  atMs: number;
}

interface LineageRow {
  context_lineage_id: string;
  current_runtime_session_id: string;
  context_source_snapshot_id: string;
  epoch_id: string;
  persona_snapshot_id: string;
  declaration_version: string;
  continuity_seed_id: string | null;
  runtime_recovery_notice_id: string | null;
  stable_memory_pool_version: string | null;
  provider_profile_id: string;
  canonical_system_prompt: string;
  system_projection_hash: string;
  prepared_at: string;
  materialization_id: string;
  context_serializer_version: string;
  carrier_schema_version: string;
  m0_body: string | null;
  m1_body: string | null;
  m0_content_hash: string | null;
  m1_content_hash: string | null;
  m0_materialized_at: number | null;
  m1_updated_at: number | null;
  cached_m0_system_hash: string | null;
  cached_m0_model_key: string | null;
  cached_m0_provider_profile_id: string | null;
  last_response_time: number | null;
  represented_through_entry_seq: number;
  represented_through_context_seq: number;
  protected_tail_start_entry_seq: number | null;
  last_safe_user_anchor_entry_seq: number | null;
  cleared_reasoning_through_tag: number;
  tool_reclaim_watermark: number;
  mutation_replay_watermark: number;
  deferred_signal_cursor: number;
  emergency_state: string;
  last_transform_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToLineage(row: LineageRow): ContextLineage {
  const base: ContextLineage = {
    lineageId: row.context_lineage_id,
    currentRuntimeSessionId: row.current_runtime_session_id,
    contextSourceSnapshotId: row.context_source_snapshot_id,
    epochId: row.epoch_id,
    personaSnapshotId: row.persona_snapshot_id,
    declarationVersion: row.declaration_version,
    providerProfileId: row.provider_profile_id,
    canonicalSystemPrompt: row.canonical_system_prompt,
    systemProjectionHash: row.system_projection_hash,
    preparedAt: row.prepared_at,
    materializationId: row.materialization_id,
    contextSerializerVersion: row.context_serializer_version,
    carrierSchemaVersion: row.carrier_schema_version,
    m0Body: row.m0_body,
    m1Body: row.m1_body,
    m0ContentHash: row.m0_content_hash,
    m1ContentHash: row.m1_content_hash,
    m0MaterializedAt: row.m0_materialized_at,
    m1UpdatedAt: row.m1_updated_at,
    cachedM0SystemHash: row.cached_m0_system_hash,
    cachedM0ModelKey: row.cached_m0_model_key,
    cachedM0ProviderProfileId: row.cached_m0_provider_profile_id,
    lastResponseTime: row.last_response_time,
    representedThroughEntrySeq: row.represented_through_entry_seq,
    representedThroughContextSeq: row.represented_through_context_seq,
    protectedTailStartEntrySeq: row.protected_tail_start_entry_seq,
    lastSafeUserAnchorEntrySeq: row.last_safe_user_anchor_entry_seq,
    clearedReasoningThroughTag: row.cleared_reasoning_through_tag,
    toolReclaimWatermark: row.tool_reclaim_watermark,
    mutationReplayWatermark: row.mutation_replay_watermark,
    deferredSignalCursor: row.deferred_signal_cursor,
    emergencyState: row.emergency_state as ContextLineage["emergencyState"],
    lastTransformError: row.last_transform_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return base;
}

export interface DeferredOperation {
  seq: number;
  lineageId: string;
  opKind: string;
  opPayload: string;
  enqueuedAt: string;
}

export interface LkgSlot {
  /** R2 (iris_agent#9)：identity-level lineage id。 */
  lineageId: string;
  slotKey: string;
  lkgJson: string;
  capturedAt: string;
}

/**
 * Session-scoped Context SQLite authority. One ContextStore owns context.db.
 *
 * Fail-closed rules:
 *  - newer schema (on-disk max version > LATEST_MIGRATION_VERSION) → throw;
 *  - storage unavailable (open/migration failure) → throw;
 *  - materialization commits are single-row transactions: a failed write
 *    never partially advances m0/m1 state.
 *
 * Context.db is REBUILDABLE from durable state (Pi Session + ingested
 * sources): the in-memory cache may be dropped, SQLite state is the
 * transform authority. It never stores a second copy of raw Pi messages.
 */
export class ContextStore implements ContextUnitStorePort {
  private readonly db: DatabaseSync;
  /** R2-P3：每 session 软 cap（超限 → disposition="exclude"）。 */
  private readonly maxUnitsPerSession: number;
  /** R2-P3：每 session 硬 cap（超限 → 抛 ContextBoundsExceededError，fail-closed）。 */
  private readonly hardUnitsCap: number;
  /** iris_agent#63: binding-ledger retention bounds (production constants by default). */
  private readonly bindingSoftLimit: number;
  private readonly bindingHardLimit: number;
  private readonly bindingRetainRecent: number;
  /** iris_agent#74: external binding-audit archive path (separate file). */
  private readonly archiveDbPath: string;
  private readonly auditStagingSoftCap: number;
  private readonly auditStagingHardCap: number;
  /** iris_agent#74: attached archive handle (lazy). */
  private archiveDb: DatabaseSync | undefined;
  /** R2 (iris_agent#9)：identity-level lineage id（one per data root）。 */
  readonly lineageId: string;
  private closed = false;

  private constructor(db: DatabaseSync, options: ContextStoreOpenOptions) {
    this.db = db;
    this.lineageId = options.lineageId ?? "identity-default";
    this.maxUnitsPerSession = options.maxUnitsPerSession ?? MAX_UNITS_PER_SESSION;
    this.hardUnitsCap = 2 * this.maxUnitsPerSession;
    this.bindingSoftLimit = options.bindingSoftLimit ?? SOFT_LIMIT_HISTORICAL_BINDINGS;
    this.bindingHardLimit = options.bindingHardLimit ?? HARD_LIMIT_HISTORICAL_BINDINGS;
    this.bindingRetainRecent = options.bindingRetainRecent ?? RETAIN_RECENT_HISTORICAL_BINDINGS;
    this.archiveDbPath =
      options.archiveDbPath ?? join(dirname(process.cwd()), "context-archive.db");
    this.auditStagingSoftCap = options.auditStagingSoftCap ?? AUDIT_STAGING_SOFT_CAP;
    this.auditStagingHardCap = options.auditStagingHardCap ?? AUDIT_STAGING_HARD_CAP;
  }

  static open(contextDbPath: string, options: ContextStoreOpenOptions = {}): ContextStore {
    try {
      mkdirSync(dirname(contextDbPath), { recursive: true });
    } catch {
      // dirname of a bare filename is "." — always creatable.
    }
    const db = new DatabaseSync(contextDbPath);
    try {
      // Busy timeout before WAL so a transient writer (e.g. a diagnostic tool
      // opening context.db concurrently) waits instead of failing SQLITE_BUSY
      // (reviewer F2). The Host's data-root lock still guarantees a single
      // writer in production; this is defense-in-depth.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(contextDbPath, migrationsDirFor(contextDbPath));
      // Newer-schema fence: after migrations run, the on-disk max version must
      // not exceed what THIS binary knows. migrateDatabase() already throws on
      // checksum drift; this catches the "newer binary wrote state" case.
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        { version: string | null } | undefined;
      const maxVersion = row?.version;
      if (
        maxVersion !== null &&
        maxVersion !== undefined &&
        maxVersion !== LATEST_MIGRATION_VERSION
      ) {
        // Files are lexicographically ordered; the max is the last applied.
        const all = db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as unknown as Array<{ version: string }>;
        const last = all[all.length - 1]?.version;
        if (last !== undefined && last !== LATEST_MIGRATION_VERSION) {
          db.close();
          throw new Error(
            `context.db schema ${last} is newer than supported ${LATEST_MIGRATION_VERSION} — ` +
              "refusing to open (fail closed); upgrade the Host binary",
          );
        }
      }
      return new ContextStore(db, {
        ...options,
        archiveDbPath: options.archiveDbPath ?? join(dirname(contextDbPath), "context-archive.db"),
      });
    } catch (error) {
      try {
        db.close();
      } catch {
        // already closed
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.archiveDb?.close();
    this.archiveDb = undefined;
    this.db.close();
  }

  // ---- R2: ContextMessageUnit 持久化（context_units 表，ContextUnitStorePort）----

  hasUnitForEvent(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM context_units WHERE source_event_id = ? LIMIT 1")
      .get(eventId) as { hit: number } | undefined;
    return row !== undefined;
  }

  insertUnit(
    unit: ContextMessageUnitV1,
    options?: {
      /**
       * iris_agent#52: recovery mode skips the session-binding validation.
       * The Recovery Reconciler has ALREADY verified the historical session
       * through resolveLineageForRecovery (binding ledger + checksum +
       * receipt identity), so re-resolving by session would fail closed for
       * a legitimately historical session. Default (production ingest) keeps
       * the fail-closed session check.
       */
      verifySessionBinding?: boolean;
      /**
       * Feature A (#110): the current Runtime Session id used for the
       * fail-closed session→lineage binding check, per-lineage cap accounting
       * and emergency-state marking. The V1 DTO is lineage-bound and carries
       * no session id; the ingest layer supplies the session. Absent → the
       * insert degrades to lineage-direct semantics (recovery-style, no
       * session verification).
       */
      runtimeSessionId?: string;
    },
  ): void {
    const sessionId = options?.runtimeSessionId;
    const verify = options?.verifySessionBinding !== false && sessionId !== undefined;
    const count = verify
      ? this.countUnits(sessionId)
      : this.countUnitsByLineage(unit.contextLineageId);
    if (count >= this.hardUnitsCap) {
      const error = new ContextBoundsExceededError(
        sessionId ?? unit.contextLineageId,
        this.hardUnitsCap,
      );
      if (sessionId !== undefined) {
        const lineage = verify
          ? this.getLineage(sessionId)
          : this.getLineageByLineageId(unit.contextLineageId);
        if (lineage !== undefined) {
          this.setEmergencyState(
            sessionId,
            "emergency_fail_closed",
            error.message,
            verify ? undefined : unit.contextLineageId,
          );
        }
      }
      throw error;
    }
    const disposition = count >= this.maxUnitsPerSession ? "exclude" : unit.historianDisposition;
    const boundLineageId = verify ? this.resolveLineageId(sessionId) : unit.contextLineageId;
    if (verify && unit.contextLineageId !== boundLineageId) {
      throw new ContextLineageResolutionError(sessionId);
    }
    // Physical mapping (SQLite columns are implementation details; the V1
    // DTO maps losslessly at this boundary):
    //  - unit_type: kind user→'input' (CHECK constraint), others 1:1;
    //  - source_event_id: exactly-once anchor := runtimeEventId (the ingest
    //    source event IS the runtime event);
    //  - entry_id/entry_seq: denormalized from rawArchiveRef (Pi archive
    //    attribution — never stored on the V1 DTO itself);
    //  - paired/companion_entry_id/pair_key: fresh inserts are always
    //    unpaired; the companion flow owns pairing via updateUnitPairing;
    //  - schema_version: physical-only constant (V1 dropped schemaVersion);
    //  - raw_archive_ref: canonical JSON of the V1 RawArchiveRefV1.
    const archiveRef = unit.rawArchiveRef;
    const entryId = archiveRef?.entryIds?.[0] ?? null;
    const entrySeq = archiveRef?.startEntrySeq ?? archiveRef?.endEntrySeq ?? null;
    const derivationRefs: SemanticDerivationRefsV1 = unit.derivationRefs ?? {
      schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
      memoryRefs: [],
      compartmentIds: [],
      sourceContextMessageUnitIds: [],
    };
    // Feature A5 (#113): content_hash is the canonical hash of the row's OWN
    // durable semantic state, and the basis covers historianDisposition. The
    // soft cap may force the effective disposition to 'exclude' AFTER the
    // caller built the unit (ingest/fixtures hash over their declared
    // disposition); the stored hash must cover the disposition AS STORED, so
    // recompute over the effective disposition — write and restart/read
    // verification then agree on ONE hash for ONE stored state.
    const contentHash =
      disposition === unit.historianDisposition
        ? unit.contentHash
        : computeContextMessageUnitContentHashV1({
            semanticSchemaId: unit.semanticSchemaId,
            kind: unit.kind,
            historianDisposition: disposition,
            derivationRefs,
            semanticContent: unit.semanticContent,
          });
    this.db
      .prepare(
        `INSERT INTO context_units (
          context_lineage_id, context_seq, unit_id, runtime_event_id, source_event_id,
          unit_type, disposition, entry_id, entry_seq, content_hash, payload,
          companion_entry_id, pair_key, paired, derivation_refs, schema_version,
          raw_archive_ref, lifecycle_state, content_hash_basis, created_at, semantic_schema_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        boundLineageId,
        unit.contextSeq,
        unit.contextUnitId,
        unit.runtimeEventId,
        unit.runtimeEventId,
        kindToPhysicalUnitType(unit.kind),
        disposition,
        entryId,
        entrySeq,
        contentHash,
        JSON.stringify(unit.semanticContent),
        null,
        null,
        0,
        JSON.stringify(derivationRefs),
        "context-unit-v1",
        archiveRef === undefined ? null : JSON.stringify(archiveRef),
        // Feature A5 (#113): persist the REAL lifecycle state and mark the
        // row as written on the one versioned canonical hash basis ('v2').
        unit.lifecycleState,
        "v2",
        unit.createdAt,
        unit.semanticSchemaId,
      );
  }

  updateUnitPairing(
    runtimeSessionId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void {
    this.updateUnitPairingAtomic(
      this.resolveLineageId(runtimeSessionId),
      contextSeq,
      update,
      "updateUnitPairing",
    );
  }

  /**
   * iris_agent#52: lineage-direct variant of {@link updateUnitPairing} for
   * the Recovery Reconciler (historical Session, no session resolution).
   */
  updateUnitPairingByLineage(
    lineageId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void {
    this.updateUnitPairingAtomic(lineageId, contextSeq, update, "updateUnitPairingByLineage");
  }

  /**
   * Feature A5 (#113): user companion folding is an ATOMIC canonical semantic
   * update. Replacing the stored payload (semanticContent) MUST update the
   * canonical content_hash in the SAME SQL transaction — the persisted hash
   * always equals the canonical hash of the resulting durable semantic state
   * (semanticContent + kind + historianDisposition + derivationRefs +
   * semanticSchemaId of the row, one versioned basis). The row also migrates
   * to the 'v2' hash basis in the same statement. A missing row or any
   * failure rolls back the whole update (never a payload/hash split).
   */
  private updateUnitPairingAtomic(
    lineageId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
    scope: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT unit_type, disposition, derivation_refs, semantic_schema_id
           FROM context_units WHERE context_lineage_id = ? AND context_seq = ?`,
        )
        .get(lineageId, contextSeq) as
        | {
            unit_type: string;
            disposition: string;
            derivation_refs: string;
            semantic_schema_id: string | null;
          }
        | undefined;
      if (row === undefined) {
        throw new Error(`context ${scope} failed: no unit ${lineageId}/${contextSeq}`);
      }
      const kind = physicalUnitTypeToKind(row.unit_type);
      const historianDisposition = physicalDispositionToHistorian(row.disposition);
      const derivationRefs = parseStoredDerivationRefs(row.derivation_refs);
      const semanticSchemaId =
        row.semantic_schema_id ??
        KIND_TO_SEMANTIC_SCHEMA_ID[kind] ??
        "iris.semantic.context_message.unknown.v1";
      const contentHash = computeContextMessageUnitContentHashV1({
        semanticSchemaId,
        kind,
        historianDisposition,
        derivationRefs,
        semanticContent: update.payload as unknown as JsonValue,
      });
      const result = this.db
        .prepare(
          `UPDATE context_units SET
            companion_entry_id = ?, pair_key = ?, paired = ?, payload = ?,
            content_hash = ?, content_hash_basis = 'v2'
          WHERE context_lineage_id = ? AND context_seq = ?`,
        )
        .run(
          update.companionEntryId,
          update.pairKey,
          update.paired ? 1 : 0,
          JSON.stringify(update.payload),
          contentHash,
          lineageId,
          contextSeq,
        );
      if (result.changes !== 1) {
        throw new Error(`context ${scope} failed: no unit ${lineageId}/${contextSeq}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listUnits(
    runtimeSessionId: string,
    options: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    } = {},
  ): ContextMessageUnitV1[] {
    // R2-P3：store 级默认过滤——只返回 disposition="include" 的单元（provider
    // 视图），renderer（renderForProviderCall / renderProviderMessages /
    // rebuildM0Body / renderHistorySince）与 harness 均消费本方法，因此 excluded
    // / reference_only 单元在读取源头即不可见。需要读全部行（R3 Historian 裁剪
    // 候选）时显式传 disposition: "all"。
    const disposition = options.disposition ?? "include";
    const afterContextSeq = options.afterContextSeq;
    let sql = "SELECT * FROM context_units WHERE context_lineage_id = ?";
    const params: Array<string | number> = [this.resolveLineageId(runtimeSessionId)];
    if (disposition !== "all") {
      sql += " AND disposition = ?";
      params.push(disposition);
    }
    if (afterContextSeq !== undefined) {
      sql += " AND context_seq > ?";
      params.push(afterContextSeq);
    }
    sql += " ORDER BY context_seq";
    const rows = this.db.prepare(sql).all(...params) as unknown as UnitRow[];
    const limit = options.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => this.rowToUnit(row));
  }

  /**
   * iris_agent#52: lineage-direct variant of {@link listUnits} for the
   * Recovery Reconciler (historical Session, no session resolution).
   */
  listUnitsByLineage(
    lineageId: string,
    options: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    } = {},
  ): ContextMessageUnitV1[] {
    const disposition = options.disposition ?? "include";
    const afterContextSeq = options.afterContextSeq;
    let sql = "SELECT * FROM context_units WHERE context_lineage_id = ?";
    const params: Array<string | number> = [lineageId];
    if (disposition !== "all") {
      sql += " AND disposition = ?";
      params.push(disposition);
    }
    if (afterContextSeq !== undefined) {
      sql += " AND context_seq > ?";
      params.push(afterContextSeq);
    }
    sql += " ORDER BY context_seq";
    const rows = this.db.prepare(sql).all(...params) as unknown as UnitRow[];
    const limit = options.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => this.rowToUnit(row));
  }

  /**
   * R3 (anti-echo)：按 lineage 内 entrySeq 闭区间 [fromEntrySeq, toEntrySeq]
   * 读取单元（窄归档映射;entry_seq IS NULL 的单元不参与）。供 Historian
   * 把 Session-scoped safe prefix 映射到 Context 单元视图。
   */
  listUnitsByEntrySeqRange(
    lineageId: string,
    fromEntrySeq: number,
    toEntrySeq: number,
  ): ContextMessageUnitV1[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM context_units WHERE context_lineage_id = ? AND entry_seq BETWEEN ? AND ? ORDER BY context_seq",
      )
      .all(lineageId, fromEntrySeq, toEntrySeq) as unknown as UnitRow[];
    return rows.map((row) => this.rowToUnit(row));
  }
  /**
   * R3 (anti-echo)：按 lineage 内闭区间 [fromContextSeq, toContextSeq] 读取
   * 全部单元（含 reference_only / exclude —— Historian 需要完整分类视图）。
   * 供 ContextHistoryReadPort.listUnitsForHistorian 消费（values-only）。
   */
  listUnitsByLineageRange(
    lineageId: string,
    fromContextSeq: number,
    toContextSeq: number,
  ): ContextMessageUnitV1[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM context_units WHERE context_lineage_id = ? AND context_seq BETWEEN ? AND ? ORDER BY context_seq",
      )
      .all(lineageId, fromContextSeq, toContextSeq) as unknown as UnitRow[];
    return rows.map((row) => this.rowToUnit(row));
  }

  /** R2-P3：该 session 的 context_units 行数（软/硬 cap 判定基准，含 excluded）。 */
  private countUnits(runtimeSessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM context_units WHERE context_lineage_id = ?")
      .get(this.resolveLineageId(runtimeSessionId)) as { count: number };
    return row.count;
  }

  /** iris_agent#52: lineage-direct count for recovery-mode inserts. */
  private countUnitsByLineage(lineageId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM context_units WHERE context_lineage_id = ?")
      .get(lineageId) as { count: number };
    return row.count;
  }

  lastUnpairedInputSeq(runtimeSessionId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(context_seq) AS seq FROM context_units
         WHERE context_lineage_id = ? AND unit_type = 'input' AND paired = 0`,
      )
      .get(this.resolveLineageId(runtimeSessionId)) as { seq: number | null } | undefined;
    const seq = row?.seq;
    return seq ?? undefined;
  }

  findBySourceEvent(eventId: string): UnitStoreRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_units WHERE source_event_id = ? LIMIT 1")
      .get(eventId) as UnitRow | undefined;
    return row === undefined ? undefined : this.rowToUnitRecord(row);
  }

  maxContextSeq(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(context_seq), 0) AS seq FROM context_units WHERE context_lineage_id = ?",
      )
      .get(this.resolveLineageId(runtimeSessionId)) as { seq: number };
    return row.seq;
  }

  /**
   * iris_agent#52: lineage-direct variant of {@link maxContextSeq} for the
   * Recovery Reconciler — the recovered Session is historical, so session
   * resolution would fail closed; the lineage id comes from
   * {@link resolveLineageForRecovery} instead. Context seq stays global and
   * monotonic WITHIN the lineage across sessions (rollover never resets it).
   */
  maxContextSeqByLineage(lineageId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(context_seq), 0) AS seq FROM context_units WHERE context_lineage_id = ?",
      )
      .get(lineageId) as { seq: number };
    return row.seq;
  }

  /**
   * R3-P1：entrySeqOf(representedThroughContextSeq) 的 SQL 实现——context_seq
   * <= watermark 的单元中取 MAX(entry_seq)，跳过 entry_seq 为 NULL 的行
   * （非 message 事件可能无 entrySeq；message_finalized 收据的 entrySeq 为
   * 可选）。watermark 为 0 或前缀内无携带 entry_seq 的单元 → null。
   *
   * 选择专用聚合而非 listUnits + 过滤（设计决策）：单条 SQL 聚合为 O(log n)，
   * 且不受 listUnits 默认 disposition 过滤（include）影响——映射面向全部语义
   * 单元（R3 Historian 的 raw-replacement 裁剪候选），不能因 excluded 单元而
   * 产生错误边界。语义参考实现见 history-read-port.ts 的纯函数
   * resolveEntrySeqForWatermark。
   */
  maxEntrySeqAtOrBelowWatermark(runtimeSessionId: string, watermark: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(entry_seq) AS seq FROM context_units
         WHERE context_lineage_id = ? AND context_seq <= ? AND entry_seq IS NOT NULL`,
      )
      .get(this.resolveLineageId(runtimeSessionId), watermark) as
      { seq: number | null } | undefined;
    return row?.seq ?? null;
  }

  /**
   * Feature A (#110): SQLite row → canonical ContextMessageUnitV1 (the
   * single durable Context semantic DTO). Physical column names are
   * implementation details; the V1 shape maps losslessly at this boundary.
   */
  private rowToUnit(row: UnitRow): ContextMessageUnitV1 {
    return this.rowToUnitRecord(row).unit;
  }

  /** Row → V1 unit + persistence-layer-only metadata (entry/pairing). */
  private rowToUnitRecord(row: UnitRow): UnitStoreRecord {
    const kind = physicalUnitTypeToKind(row.unit_type);
    const historianDisposition = physicalDispositionToHistorian(row.disposition);
    // Feature A5 (#113): the REAL persisted lifecycle state — never
    // fabricated as 'committed' (that would silently collapse
    // historian_eligible/claimed/pending_bust/represented_in_p3/retired
    // across restart).
    const lifecycleState = parseLifecycleState(row.lifecycle_state);
    // semanticSchemaId from the new column (migration 0005 backfills existing
    // rows); fallback derives it from unit_type via the canonical map.
    const semanticSchemaId =
      row.semantic_schema_id ??
      KIND_TO_SEMANTIC_SCHEMA_ID[kind] ??
      "iris.semantic.context_message.unknown.v1";
    const derivationRefs = parseStoredDerivationRefs(row.derivation_refs);
    const semanticContent = JSON.parse(row.payload) as JsonValue;
    this.verifyStoredContentHash({
      storedHash: row.content_hash,
      basis: row.content_hash_basis,
      kind,
      historianDisposition,
      semanticSchemaId,
      derivationRefs,
      semanticContent,
      unitId: row.unit_id,
    });
    const unit: ContextMessageUnitV1 = {
      schemaId: "iris.context_message_unit.v1",
      contextUnitId: row.unit_id,
      contextLineageId: row.context_lineage_id,
      contextSeq: row.context_seq,
      runtimeEventId: row.runtime_event_id ?? row.source_event_id,
      kind,
      semanticSchemaId,
      semanticContent,
      historianDisposition,
      derivationRefs,
      ...(row.raw_archive_ref !== null
        ? { rawArchiveRef: parseStoredRawArchiveRef(row.raw_archive_ref) }
        : {}),
      contentHash: row.content_hash,
      lifecycleState,
      createdAt: row.created_at,
    };
    return {
      unit,
      persistenceMeta: {
        sourceEventId: row.source_event_id,
        entryId: row.entry_id,
        entrySeq: row.entry_seq,
        companionEntryId: row.companion_entry_id,
        pairKey: row.pair_key,
        paired: row.paired === 1,
      },
    };
  }

  /**
   * Feature A5 (#113): restart/read verification against the ONE versioned
   * canonical hash basis. The stored content_hash must equal the canonical
   * hash of the row's own durable semantic state; any mismatch means a
   * hash-basis field (semanticContent, kind, historianDisposition,
   * derivationRefs, semanticSchemaId, or the hash itself) was tampered or
   * corrupted → fail closed.
   *
   * - 'v2' rows (written by this feature): full versioned basis recompute.
   * - 'v1' rows (pre-#113): legacy payload-only basis recompute — payload
   *   tamper still fails closed; the row is explicitly fenced as legacy
   *   until a pairing update or rewrite migrates it to 'v2'.
   */
  private verifyStoredContentHash(input: {
    storedHash: string;
    basis: string;
    kind: ContextMessageUnitV1["kind"];
    historianDisposition: ContextMessageUnitV1["historianDisposition"];
    semanticSchemaId: string;
    derivationRefs: SemanticDerivationRefsV1;
    semanticContent: JsonValue;
    unitId: string;
  }): void {
    let expectedHash: string;
    if (input.basis === "v2") {
      expectedHash = computeContextMessageUnitContentHashV1({
        semanticSchemaId: input.semanticSchemaId,
        kind: input.kind,
        historianDisposition: input.historianDisposition,
        derivationRefs: input.derivationRefs,
        semanticContent: input.semanticContent,
      });
    } else if (input.basis === "v1") {
      // Legacy pre-#113 basis: content_hash covered the payload plane only.
      expectedHash = computeSemanticContentHash(input.semanticContent);
    } else {
      throw new Error(
        `context rowToUnit: unknown content_hash_basis ${JSON.stringify(input.basis)} for unit ${input.unitId} (fail closed)`,
      );
    }
    if (input.storedHash !== expectedHash) {
      throw new Error(
        `context rowToUnit: content_hash mismatch for unit ${input.unitId} ` +
          `(stored ${input.storedHash}, canonical ${expectedHash}); a hash-basis field ` +
          `(semanticContent/kind/historianDisposition/derivationRefs/semanticSchemaId) was ` +
          `tampered or corrupted (fail closed)`,
      );
    }
  }

  /** Raw prepared-statement access for the replay/consumer layers. */
  raw(): DatabaseSync {
    return this.db;
  }

  createLineage(input: CreateLineageInput): ContextLineage {
    const now = new Date().toISOString();
    const lineageId = input.lineageId ?? input.runtimeSessionId;
    // F4 (iris_agent#9 / 4.1): a runtime session may be the current binding of
    // at most ONE lineage. Duplicate current binding would make session→
    // lineage resolution ambiguous and must fail closed.
    const existingSessionBinding = this.db
      .prepare(
        "SELECT context_lineage_id AS id FROM context_lineages WHERE current_runtime_session_id = ? LIMIT 1",
      )
      .get(input.runtimeSessionId) as { id: string } | undefined;
    if (existingSessionBinding !== undefined && existingSessionBinding.id !== lineageId) {
      throw new Error(
        `context createLineage failed: runtime session ${input.runtimeSessionId} is already the current binding of lineage ${existingSessionBinding.id} (cannot bind ${lineageId})`,
      );
    }
    const row: LineageRow = {
      context_lineage_id: lineageId,
      current_runtime_session_id: input.runtimeSessionId,
      context_source_snapshot_id: input.contextSourceSnapshotId,
      epoch_id: input.epochId,
      persona_snapshot_id: input.personaSnapshotId,
      declaration_version: input.declarationVersion,
      continuity_seed_id: null,
      runtime_recovery_notice_id: null,
      stable_memory_pool_version: null,
      provider_profile_id: input.providerProfileId,
      canonical_system_prompt: input.canonicalSystemPrompt,
      system_projection_hash: input.systemProjectionHash,
      prepared_at: input.preparedAt,
      materialization_id: input.materializationId,
      context_serializer_version: input.contextSerializerVersion,
      carrier_schema_version: input.carrierSchemaVersion,
      m0_body: null,
      m1_body: null,
      m0_content_hash: null,
      m1_content_hash: null,
      m0_materialized_at: null,
      m1_updated_at: null,
      cached_m0_system_hash: null,
      cached_m0_model_key: null,
      cached_m0_provider_profile_id: null,
      last_response_time: null,
      represented_through_entry_seq: 0,
      represented_through_context_seq: 0,
      protected_tail_start_entry_seq: null,
      last_safe_user_anchor_entry_seq: null,
      cleared_reasoning_through_tag: 0,
      tool_reclaim_watermark: 0,
      mutation_replay_watermark: 0,
      deferred_signal_cursor: 0,
      emergency_state: "ok",
      last_transform_error: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO context_lineages (
          context_lineage_id, current_runtime_session_id, context_source_snapshot_id, epoch_id,
          persona_snapshot_id, declaration_version, continuity_seed_id, runtime_recovery_notice_id,
          stable_memory_pool_version, provider_profile_id, canonical_system_prompt,
          system_projection_hash, prepared_at, materialization_id,
          context_serializer_version, carrier_schema_version,
          m0_body, m1_body, m0_content_hash, m1_content_hash,
          m0_materialized_at, m1_updated_at,
          cached_m0_system_hash, cached_m0_model_key, cached_m0_provider_profile_id,
          last_response_time, represented_through_entry_seq,
          represented_through_context_seq,
          protected_tail_start_entry_seq, last_safe_user_anchor_entry_seq,
          cleared_reasoning_through_tag, tool_reclaim_watermark,
          mutation_replay_watermark, deferred_signal_cursor,
          emergency_state, last_transform_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.context_lineage_id,
        row.current_runtime_session_id,
        row.context_source_snapshot_id,
        row.epoch_id,
        row.persona_snapshot_id,
        row.declaration_version,
        row.continuity_seed_id,
        row.runtime_recovery_notice_id,
        row.stable_memory_pool_version,
        row.provider_profile_id,
        row.canonical_system_prompt,
        row.system_projection_hash,
        row.prepared_at,
        row.materialization_id,
        row.context_serializer_version,
        row.carrier_schema_version,
        row.m0_body,
        row.m1_body,
        row.m0_content_hash,
        row.m1_content_hash,
        row.m0_materialized_at,
        row.m1_updated_at,
        row.cached_m0_system_hash,
        row.cached_m0_model_key,
        row.cached_m0_provider_profile_id,
        row.last_response_time,
        row.represented_through_entry_seq,
        row.represented_through_context_seq,
        row.protected_tail_start_entry_seq,
        row.last_safe_user_anchor_entry_seq,
        row.cleared_reasoning_through_tag,
        row.tool_reclaim_watermark,
        row.mutation_replay_watermark,
        row.deferred_signal_cursor,
        row.emergency_state,
        row.last_transform_error,
        row.created_at,
        row.updated_at,
      );
    // iris_agent#52: record the authoritative binding in the append-only
    // ledger (idempotent: re-creating the same lineage/session pair is a
    // no-op; a DIFFERENT lineage already bound to this session fails closed
    // above).
    this.db
      .prepare(
        `INSERT INTO session_lineage_bindings
          (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at, binding_checksum)
         VALUES (?, ?, 'current', ?, NULL, ?)
         ON CONFLICT(runtime_session_id, context_lineage_id) DO NOTHING`,
      )
      .run(
        row.current_runtime_session_id,
        row.context_lineage_id,
        now,
        this.bindingChecksum(row.current_runtime_session_id, row.context_lineage_id),
      );
    return rowToLineage(row);
  }

  /**
   * iris_agent#52: integrity checksum of a binding row.
   * sha256(runtimeSessionId + ":" + contextLineageId).
   */
  private bindingChecksum(runtimeSessionId: string, lineageId: string): string {
    return createHash("sha256").update(`${runtimeSessionId}:${lineageId}`).digest("hex");
  }

  /**
   * iris_agent#63: authoritative-evidence mark — the Recovery Reconciler
   * calls this AFTER proving the Session's pending Pi receipt window is
   * fully consumed (all receipts replayed/acked or none remained). Only
   * bindings with reconciled_at set may ever be reclaimed. Idempotent.
   */
  acknowledgeSessionReconciled(runtimeSessionId: string): void {
    this.db
      .prepare(
        `UPDATE session_lineage_bindings
         SET reconciled_at = COALESCE(reconciled_at, ?)
         WHERE runtime_session_id = ?`,
      )
      .run(new Date().toISOString(), runtimeSessionId);
  }

  /**
   * iris_agent#63: reclaim reconciled historical bindings OUTSIDE the retain
   * window (audit checkpoint / late-recovery margin). Each pruned row is
   * copied to session_lineage_bindings_audit BEFORE deletion (audit
   * provenance is never lost), then removed from the active ledger.
   * Returns the number of rows pruned. Eligibility is evidence-based:
   * reconciled_at IS NOT NULL is mandatory — an unacknowledged Session can
   * still require recovery resolution and is never pruned.
   * When called inside a caller-owned transaction (bindCurrentSession's
   * rollover gate), pass transaction: "caller" so no nested BEGIN is issued.
   */
  reclaimReconciledBindings(
    options: { retainRecent?: number; transaction?: "own" | "caller" } = {},
  ): number {
    const retain = options.retainRecent ?? this.bindingRetainRecent;
    const ownTransaction = options.transaction !== "caller";
    if (ownTransaction) {
      this.db.exec("BEGIN IMMEDIATE");
    }
    try {
      const prunable = this.db
        .prepare(
          `SELECT runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at,
                  binding_checksum, reconciled_at
           FROM session_lineage_bindings
           WHERE binding_role = 'historical' AND reconciled_at IS NOT NULL
             AND runtime_session_id NOT IN (
               SELECT runtime_session_id FROM session_lineage_bindings
               WHERE binding_role = 'historical'
               ORDER BY superseded_at DESC NULLS LAST, bound_at DESC
               LIMIT ?
             )`,
        )
        .all(retain) as Array<{
        runtime_session_id: string;
        context_lineage_id: string;
        binding_role: string;
        bound_at: string;
        superseded_at: string | null;
        binding_checksum: string;
        reconciled_at: string | null;
      }>;
      for (const row of prunable) {
        this.db
          .prepare(
            `INSERT INTO session_lineage_bindings_audit
              (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at,
               binding_checksum, reconciled_at, pruned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.runtime_session_id,
            row.context_lineage_id,
            row.binding_role,
            row.bound_at,
            row.superseded_at,
            row.binding_checksum,
            row.reconciled_at,
            new Date().toISOString(),
          );
        this.db
          .prepare(
            `DELETE FROM session_lineage_bindings
             WHERE runtime_session_id = ? AND context_lineage_id = ? AND binding_role = 'historical'`,
          )
          .run(row.runtime_session_id, row.context_lineage_id);
      }
      if (ownTransaction) {
        this.db.exec("COMMIT");
      }
      return prunable.length;
    } catch (error) {
      if (ownTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /** iris_agent#63/#74: capacity metrics for the binding ledger (health/readiness). */
  bindingLedgerStats(): {
    total: number;
    current: number;
    historical: number;
    reconciled: number;
    reclaimable: number;
    auditRows: number;
    staged: number;
  } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number };
      return row.n;
    };
    const total = count("SELECT COUNT(*) AS n FROM session_lineage_bindings");
    const current = count(
      "SELECT COUNT(*) AS n FROM session_lineage_bindings WHERE binding_role = 'current'",
    );
    const historical = count(
      "SELECT COUNT(*) AS n FROM session_lineage_bindings WHERE binding_role = 'historical'",
    );
    const reconciled = count(
      "SELECT COUNT(*) AS n FROM session_lineage_bindings WHERE binding_role = 'historical' AND reconciled_at IS NOT NULL",
    );
    const retain = this.bindingRetainRecent;
    const reclaimable = count(
      `SELECT COUNT(*) AS n FROM session_lineage_bindings
       WHERE binding_role = 'historical' AND reconciled_at IS NOT NULL
         AND runtime_session_id NOT IN (
           SELECT runtime_session_id FROM session_lineage_bindings
           WHERE binding_role = 'historical'
           ORDER BY superseded_at DESC NULLS LAST, bound_at DESC
           LIMIT ${retain}
         )`,
    );
    const auditRows = count("SELECT COUNT(*) AS n FROM session_lineage_bindings_audit");
    const staged = count(
      "SELECT COUNT(*) AS n FROM session_lineage_bindings_audit WHERE archived_batch_id IS NOT NULL",
    );
    return { total, current, historical, reconciled, reclaimable, auditRows, staged };
  }

  // ---- iris_agent#74: external binding-audit archive ----

  /**
   * External archive (context-archive.db): the LIFETIME provenance store for
   * reclaimed Session→lineage bindings. It lives in a SEPARATE SQLite file
   * owned outside the active context.db — the active database only ever
   * holds the in-flight staging window, so repeated safe reclamation cannot
   * grow the active context.db by rows/bytes over the lifetime of the data
   * root. The archive is opened lazily and kept as its own handle (never
   * ATTACHed), so every phase below is a SINGLE-file atomic transaction —
   * no cross-file atomicity assumptions.
   */
  private ensureArchiveAttached(): DatabaseSync {
    if (this.archiveDb === undefined) {
      mkdirSync(dirname(this.archiveDbPath), { recursive: true });
      const archive = new DatabaseSync(this.archiveDbPath);
      archive.exec("PRAGMA busy_timeout = 5000");
      archive.exec("PRAGMA journal_mode = WAL");
      // iris_agent#74: external binding-audit archive path (separate file).
      archive.exec("PRAGMA synchronous = NORMAL");
      archive.exec("PRAGMA foreign_keys = ON");
      archive.exec(`
        CREATE TABLE IF NOT EXISTS binding_audit_archive (
          batch_id INTEGER NOT NULL,
          runtime_session_id TEXT NOT NULL,
          context_lineage_id TEXT NOT NULL,
          binding_role TEXT NOT NULL,
          bound_at TEXT NOT NULL,
          superseded_at TEXT,
          binding_checksum TEXT NOT NULL,
          reconciled_at TEXT,
          pruned_at TEXT NOT NULL,
          PRIMARY KEY (batch_id, runtime_session_id, context_lineage_id)
        );
        CREATE INDEX IF NOT EXISTS idx_binding_audit_archive_batch
          ON binding_audit_archive(batch_id);
        CREATE TABLE IF NOT EXISTS archive_manifest (
          batch_id INTEGER PRIMARY KEY,
          archived_at TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          rows_hash TEXT NOT NULL,
          lineage_id TEXT NOT NULL
        );
      `);
      this.archiveDb = archive;
    }
    return this.archiveDb;
  }

  /**
   * iris_agent#74: drain the audit staging backlog out of the ACTIVE
   * context.db into the external archive. Crash-safe handoff protocol:
   *
   *  Phase A (active db, one atomic txn): mark up to `batchLimit` unmarked
   *    audit rows with a fresh batch id (monotonic, derived from the
   *    archive's max batch + 1).
   *  Phase B (archive db, one atomic txn): copy EVERY staged batch (rows +
   *    manifest row with count + deterministic rows_hash) into the archive
   *    (INSERT OR IGNORE / OR REPLACE — idempotent replay).
   *  Phase C (active db, one atomic txn): delete active rows whose batch id
   *    is already present in the archive manifest.
   *
   * Crash at ANY point is safe: rows are either still in the active staging
   * window (provenance intact, next call re-drains) or already manifest'd in
   * the archive (Phase C replay deletes them). A still-recoverable Session
   * is never affected — only already-reconciled historical bindings are
   * ever staged (reclaim eligibility is evidence-driven).
   *
   * Returns the total rows moved out of the active db by this call.
   */
  archiveBindingAudit(options: { batchLimit?: number } = {}): {
    archived: number;
    stagedRemaining: number;
    batchId: number | null;
  } {
    const archive = this.ensureArchiveAttached();
    const batchLimit = options.batchLimit ?? 512;

    // Phase A: stage a fresh batch (only if unmarked rows exist).
    const unmarkedCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_lineage_bindings_audit WHERE archived_batch_id IS NULL",
        )
        .get() as { n: number }
    ).n;
    let newBatchId: number | null = null;
    if (unmarkedCount > 0) {
      const archiveMax = archive
        .prepare("SELECT COALESCE(MAX(batch_id), 0) AS m FROM archive_manifest")
        .get() as { m: number };
      newBatchId = archiveMax.m + 1;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE session_lineage_bindings_audit SET archived_batch_id = ?
             WHERE rowid IN (
               SELECT rowid FROM session_lineage_bindings_audit
               WHERE archived_batch_id IS NULL
               LIMIT ?
             )`,
          )
          .run(newBatchId, batchLimit);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    // Phase B + C: drain EVERY staged batch (covers crash-replay of older
    // batches too).
    const stagedRows = this.db
      .prepare(
        `SELECT archived_batch_id AS batch_id, runtime_session_id, context_lineage_id,
                binding_role, bound_at, superseded_at, binding_checksum, reconciled_at, pruned_at
         FROM session_lineage_bindings_audit
         WHERE archived_batch_id IS NOT NULL
         ORDER BY archived_batch_id, pruned_at`,
      )
      .all() as Array<{
      batch_id: number;
      runtime_session_id: string;
      context_lineage_id: string;
      binding_role: string;
      bound_at: string;
      superseded_at: string | null;
      binding_checksum: string;
      reconciled_at: string | null;
      pruned_at: string;
    }>;
    const byBatch = new Map<number, typeof stagedRows>();
    for (const row of stagedRows) {
      const batch = byBatch.get(row.batch_id);
      if (batch === undefined) {
        byBatch.set(row.batch_id, [row]);
      } else {
        batch.push(row);
      }
    }

    archive.exec("BEGIN IMMEDIATE");
    try {
      for (const [batchId, rows] of byBatch) {
        const canonical = rows
          .map(
            (row) =>
              `${row.batch_id}|${row.runtime_session_id}|${row.context_lineage_id}|` +
              `${row.binding_role}|${row.bound_at}|${row.superseded_at ?? ""}|` +
              `${row.binding_checksum}|${row.reconciled_at ?? ""}|${row.pruned_at}`,
          )
          .join("\n");
        const rowsHash = createHash("sha256").update(canonical).digest("hex");
        const insertRow = archive.prepare(
          `INSERT OR IGNORE INTO binding_audit_archive
            (batch_id, runtime_session_id, context_lineage_id, binding_role, bound_at,
             superseded_at, binding_checksum, reconciled_at, pruned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of rows) {
          insertRow.run(
            row.batch_id,
            row.runtime_session_id,
            row.context_lineage_id,
            row.binding_role,
            row.bound_at,
            row.superseded_at,
            row.binding_checksum,
            row.reconciled_at,
            row.pruned_at,
          );
        }
        archive
          .prepare(
            `INSERT OR REPLACE INTO archive_manifest
              (batch_id, archived_at, row_count, rows_hash, lineage_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(batchId, new Date().toISOString(), rows.length, rowsHash, this.lineageId);
      }
      archive.exec("COMMIT");
    } catch (error) {
      archive.exec("ROLLBACK");
      throw error;
    }

    // iris_agent#85: DURABILITY BARRIER — after Phase B commits the archive
    // transaction but BEFORE Phase C deletes the active rows, checkpoint the
    // archive's WAL to the main DB file. Under `synchronous=NORMAL`, a COMMIT
    // only writes to the WAL journal — it is NOT fsync'd into the main file.
    // A power loss can drop uncheckpointed WAL frames, so deleting the active
    // rows immediately after COMMIT would silently lose provenance if the
    // archive's WAL is lost but the active DB's WAL (which auto-checkpoints
    // more frequently due to higher write volume) survives.
    //
    // `wal_checkpoint(TRUNCATE)` forces all WAL frames into the main DB file
    // and truncates the WAL to zero bytes. This establishes the same durability
    // boundary as `synchronous=FULL` without the per-transaction overhead.
    // If the checkpoint fails (busy or I/O error), Phase C is skipped — the
    // active rows remain and will be re-drained on the next call.
    const drainedBatchIds = [...byBatch.keys()];
    if (drainedBatchIds.length > 0) {
      const checkpointResult = archive.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };
      if (checkpointResult.busy !== 0) {
        // Checkpoint could not complete (another reader holds the WAL).
        // Skip deletion — the rows are safe in both archive (WAL, pending
        // next checkpoint) and active staging. The next drain retry will
        // checkpoint again.
        const remaining = (
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM session_lineage_bindings_audit WHERE archived_batch_id IS NOT NULL",
            )
            .get() as { n: number }
        ).n;
        return {
          archived: stagedRows.length,
          stagedRemaining: remaining,
          batchId: newBatchId,
        };
      }

      // Phase C: delete active rows whose batch was copied IN THIS CALL (the
      // staged scan above already includes every batch still present after a
      // crash, so replay deletes old batches too — but only the batches
      // actually present, never the whole archive manifest: that would make
      // every drain O(archive lifetime)).
      const deleteRow = this.db.prepare(
        `DELETE FROM session_lineage_bindings_audit WHERE archived_batch_id IN (${drainedBatchIds
          .map(() => "?")
          .join(", ")})`,
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        deleteRow.run(...drainedBatchIds);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const stagedRemaining = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_lineage_bindings_audit WHERE archived_batch_id IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    return { archived: stagedRows.length, stagedRemaining, batchId: newBatchId };
  }

  /** iris_agent#74: binding-audit archive capacity metrics (health). */
  bindingArchiveStats(): {
    archiveRows: number;
    archiveBatches: number;
    staged: number;
    stagingSoftCap: number;
    stagingHardCap: number;
    activeDbBytes: number;
    walBytes: number;
  } {
    const archive = this.ensureArchiveAttached();
    const archiveRows = (
      archive.prepare("SELECT COUNT(*) AS n FROM binding_audit_archive").get() as { n: number }
    ).n;
    const archiveBatches = (
      archive.prepare("SELECT COUNT(*) AS n FROM archive_manifest").get() as { n: number }
    ).n;
    const staged = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_lineage_bindings_audit WHERE archived_batch_id IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number })
      .page_count;
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    return {
      archiveRows,
      archiveBatches,
      staged,
      stagingSoftCap: this.auditStagingSoftCap,
      stagingHardCap: this.auditStagingHardCap,
      activeDbBytes: pageCount * pageSize,
      walBytes: checkpoint.log * pageSize,
    };
  }

  /**
   * iris_agent#74: capacity maintenance — truncating checkpoint + full
   * vacuum, then report the resulting active DB/WAL sizes. Capacity tests
   * use this to prove the active context.db returns to a plateau after
   * long-running rollover churn; operators can call it during idle windows.
   */
  maintenance(): { walBytesAfter: number; activeDbBytesAfter: number } {
    const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    this.db.exec("VACUUM");
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number })
      .page_count;
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    return {
      walBytesAfter: checkpoint.log * pageSize,
      activeDbBytesAfter: pageCount * pageSize,
    };
  }

  /**
   * R2 (iris_agent#9)：按 identity-level lineage id 查询（one per data root）。
   * rollover 只更新 current_runtime_session_id，不创建新 lineage。
   */
  getLineageByLineageId(lineageId: string): ContextLineage | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_lineages WHERE context_lineage_id = ?")
      .get(lineageId) as LineageRow | undefined;
    return row === undefined ? undefined : rowToLineage(row);
  }

  /**
   * R2 (iris_agent#9)：把 lineage 绑定到新的 Pi Runtime Session（rollover
   * 路径）。仅更新 current_runtime_session_id；lineage 的 m0/m1/watermark/
   * replay 状态全部保留。绑定不存在的 lineage → throw（fail-closed）。
   *
   * iris_agent#52：rollover 在同一个事务里把旧的 current binding 标记为
   * historical（superseded_at，行永不删除）并写入新的 current binding——
   * 历史 Session→lineage 解析路径在 rollover 后依然可用（仅限 Recovery
   * Reconciler / audit，见 {@link resolveLineageForRecovery}），普通生产
   * ingest 仍然只认 current_runtime_session_id。
   */
  bindCurrentSession(lineageId: string, runtimeSessionId: string): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // iris_agent#63: bounded ledger gate. Every rollover appends a new
      // historical binding; before that, opportunistically reclaim
      // reconciled bindings once the SOFT limit is breached, and fail
      // closed (typed) if the HARD limit survives reclaim — the active
      // ledger can never grow without bound. Retained recent bindings are
      // never pruned, so the limit is a hard ceiling, not a watermark.
      const historicalCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM session_lineage_bindings WHERE binding_role = 'historical'",
          )
          .get() as { n: number }
      ).n;
      if (historicalCount >= this.bindingSoftLimit) {
        this.reclaimReconciledBindings({ transaction: "caller" });
        const afterReclaim = (
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM session_lineage_bindings WHERE binding_role = 'historical'",
            )
            .get() as { n: number }
        ).n;
        if (afterReclaim >= this.bindingHardLimit) {
          throw new ContextBindingLedgerExceededError(this.bindingHardLimit);
        }
        // iris_agent#74: the reclaim staged audit rows inside this
        // transaction — the staging backlog must stay bounded too (the
        // external archive drain is the only thing that can shrink it).
        const totalAudit = (
          this.db.prepare("SELECT COUNT(*) AS n FROM session_lineage_bindings_audit").get() as {
            n: number;
          }
        ).n;
        if (totalAudit > this.auditStagingHardCap) {
          throw new ContextAuditBacklogExceededError(this.auditStagingHardCap);
        }
      }
      // iris_agent#52: a runtime session may be the current binding of at most
      // ONE lineage (same invariant createLineage enforces). Without this
      // guard, bindCurrentSession could give a session a SECOND current
      // binding on another lineage, making recovery resolution ambiguous
      // (review finding: probe-ambiguity).
      const existingOther = this.db
        .prepare(
          "SELECT context_lineage_id AS id FROM session_lineage_bindings WHERE runtime_session_id = ? AND binding_role = 'current' AND context_lineage_id != ? LIMIT 1",
        )
        .get(runtimeSessionId, lineageId) as { id: string } | undefined;
      if (existingOther !== undefined) {
        throw new Error(
          `context bindCurrentSession failed: runtime session ${runtimeSessionId} is already the current binding of lineage ${existingOther.id} (cannot bind ${lineageId})`,
        );
      }
      const previous = this.db
        .prepare(
          "SELECT runtime_session_id FROM session_lineage_bindings WHERE context_lineage_id = ? AND binding_role = 'current' LIMIT 1",
        )
        .get(lineageId) as { runtime_session_id: string } | undefined;
      if (previous !== undefined && previous.runtime_session_id !== runtimeSessionId) {
        this.db
          .prepare(
            `UPDATE session_lineage_bindings
             SET binding_role = 'historical', superseded_at = ?
             WHERE runtime_session_id = ? AND context_lineage_id = ?`,
          )
          .run(now, previous.runtime_session_id, lineageId);
      }
      this.db
        .prepare(
          `INSERT INTO session_lineage_bindings
            (runtime_session_id, context_lineage_id, binding_role, bound_at, superseded_at, binding_checksum)
           VALUES (?, ?, 'current', ?, NULL, ?)
           ON CONFLICT(runtime_session_id, context_lineage_id) DO UPDATE SET
             binding_role = 'current', bound_at = ?, superseded_at = NULL`,
        )
        .run(
          runtimeSessionId,
          lineageId,
          now,
          this.bindingChecksum(runtimeSessionId, lineageId),
          now,
        );
      const result = this.db
        .prepare(
          "UPDATE context_lineages SET current_runtime_session_id = ?, updated_at = ? WHERE context_lineage_id = ?",
        )
        .run(runtimeSessionId, now, lineageId);
      if (result.changes !== 1) {
        throw new Error(`context bindCurrentSession failed: no lineage ${lineageId}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // iris_agent#74: after the binding transaction commits, drain any
    // staging backlog into the EXTERNAL archive — the active context.db
    // only holds the in-flight window. A failure here propagates (the
    // binding itself is committed; the next operation sees the typed
    // backlog error once the hard cap is hit, and health metrics expose
    // the staging level continuously).
    const pendingAudit = (
      this.db.prepare("SELECT COUNT(*) AS n FROM session_lineage_bindings_audit").get() as {
        n: number;
      }
    ).n;
    if (pendingAudit > 0) {
      this.archiveBindingAudit();
    }
  }

  /**
   * iris_agent#52 Recovery Reconciler API：把经过验证的历史 Runtime Session
   * 解析回其 durable identity lineage。与生产路径（resolveLineageId，只认
   * current）严格分离：
   * - 只有本 data root 的 binding ledger 中存在该 Session（行级存在 +
   *   checksum 完整性校验）才解析；
   * - receipt 必须属于该 Session（receipt.sessionId === runtimeSessionId）
   *   且携带格式合法的 content hash（实际 hash 重算由 Pi 恢复流程完成）；
   * - 解析是只读的：绝不把旧 Session 重新变回 current，也不允许普通
   *   post-rollover 写入使用本 API。
   * 未知/伪造/损坏/被删除的 binding 一律 fail closed（typed error）。
   */
  resolveLineageForRecovery(
    runtimeSessionId: string,
    receipt: { sessionId: string; entryId: string; contentHash: string },
  ): string {
    if (receipt.sessionId !== runtimeSessionId) {
      throw new Error(
        `context resolveLineageForRecovery failed: receipt ${receipt.entryId} belongs to session ` +
          `${receipt.sessionId} but the request is for ${runtimeSessionId} (fail closed)`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(receipt.contentHash)) {
      throw new Error(
        `context resolveLineageForRecovery failed: receipt ${receipt.entryId} has a malformed content hash ` +
          `(fail closed)`,
      );
    }
    const rows = this.db
      .prepare(
        "SELECT context_lineage_id, binding_role, binding_checksum FROM session_lineage_bindings WHERE runtime_session_id = ? ORDER BY bound_at",
      )
      .all(runtimeSessionId) as {
      context_lineage_id: string;
      binding_role: string;
      binding_checksum: string;
    }[];
    if (rows.length === 0) {
      throw new Error(
        `context resolveLineageForRecovery failed: no binding for runtime session ${runtimeSessionId} in this data root ` +
          `(fail closed: foreign or fabricated session)`,
      );
    }
    if (rows.length > 1) {
      // Defensive ambiguity gate: a session must never resolve to more than
      // one lineage (bindCurrentSession/createLineage enforce a single
      // current binding, so this can only happen via external tampering).
      throw new Error(
        `context resolveLineageForRecovery failed: runtime session ${runtimeSessionId} has ${rows.length} bindings ` +
          `(${rows.map((r) => r.context_lineage_id).join(", ")}); refusing to resolve ambiguously (fail closed)`,
      );
    }
    const row = rows[0];
    if (row === undefined) {
      // Unreachable after the length checks above; keep the type narrow.
      throw new Error(
        `context resolveLineageForRecovery failed: no binding for ${runtimeSessionId}`,
      );
    }
    const expected = this.bindingChecksum(runtimeSessionId, row.context_lineage_id);
    if (expected !== row.binding_checksum) {
      throw new Error(
        `context resolveLineageForRecovery failed: binding for session ${runtimeSessionId} failed its checksum ` +
          `(recorded ${row.binding_checksum}, expected ${expected}); refusing to resolve (fail closed)`,
      );
    }
    return row.context_lineage_id;
  }

  getLineage(runtimeSessionId: string): ContextLineage | undefined {
    // R2: lineage 是 identity-level；查询按 lineageId。兼容旧调用方（按
    // session 查询）：先精确匹配 lineage_id（测试/显式 id），再按当前绑定
    // session 反查。rollover 后旧 session 不再 current，正常路径只查当前。
    const row = this.db
      .prepare(
        "SELECT * FROM context_lineages WHERE context_lineage_id = ? OR current_runtime_session_id = ? LIMIT 1",
      )
      .get(runtimeSessionId, runtimeSessionId) as LineageRow | undefined;
    return row === undefined ? undefined : rowToLineage(row);
  }

  /**
   * R2 (iris_agent#9)：把调用方的 runtimeSessionId（attribution）解析为
   * identity-level lineage id。解析优先级：
   *   1) context_lineages.context_lineage_id 精确匹配（显式 id / 测试）；
   *   2) context_lineages.current_runtime_session_id 反查（生产路径）。
   *
   * F4 (iris_agent#9 / feature 4.1) fail-closed：都不命中时抛出
   * {@link ContextLineageResolutionError}，绝不静默回退到构造默认 lineage。
   * 未知 Session、rollover 后的过期 Session、错误 data root 或损坏绑定都
   * 会在写入 identity-level 语义单元之前被拒绝。恢复流程必须走
   * {@link ContextStore.resolveLineageIdOrNull}（显式 reconciliation API），
   * 不得复用本方法或绕过 fail-closed 守卫。
   */
  private resolveLineageId(runtimeSessionId: string): string {
    const byId = this.db
      .prepare(
        "SELECT context_lineage_id AS id FROM context_lineages WHERE context_lineage_id = ? LIMIT 1",
      )
      .get(runtimeSessionId) as { id: string } | undefined;
    if (byId !== undefined) {
      return byId.id;
    }
    const bySession = this.db
      .prepare(
        "SELECT context_lineage_id AS id FROM context_lineages WHERE current_runtime_session_id = ? LIMIT 1",
      )
      .get(runtimeSessionId) as { id: string } | undefined;
    if (bySession !== undefined) {
      return bySession.id;
    }
    throw new ContextLineageResolutionError(runtimeSessionId);
  }

  /**
   * F4 (iris_agent#9 / feature 4.1) reconciliation API：与
   * {@link ContextStore.resolveLineageId} 相同的解析规则，但未知 Session
   * 返回 null 而非抛错。仅供恢复/审计流程显式使用（启动 reconciliation、
   * 诊断工具）；正常生产写路径禁止调用本方法作为 fallback —— 它们必须用
   * resolveLineageId 的 fail-closed 语义。
   */
  resolveLineageIdOrNull(runtimeSessionId: string): string | null {
    try {
      return this.resolveLineageId(runtimeSessionId);
    } catch (error) {
      if (error instanceof ContextLineageResolutionError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * HARD materialization: (re)build m0 + reset m1 atomically. A failure here
   * must not leave m0 advanced while m1 is stale — single-row transaction.
   */
  materializeM0(input: MaterializeM0Input): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m0_body = ?, m1_body = ?, m0_content_hash = ?, m1_content_hash = ?,
           m0_materialized_at = ?, m1_updated_at = ?,
           cached_m0_system_hash = ?, cached_m0_model_key = ?,
           cached_m0_provider_profile_id = ?,
           represented_through_entry_seq = ?,
           protected_tail_start_entry_seq = ?,
           last_safe_user_anchor_entry_seq = ?,
           updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(
        input.m0Body,
        input.m1Body,
        input.m0ContentHash,
        input.m1ContentHash,
        input.atMs,
        input.atMs,
        input.cachedM0SystemHash,
        input.cachedM0ModelKey,
        input.cachedM0ProviderProfileId,
        input.representedThroughEntrySeq,
        input.protectedTailStartEntrySeq,
        input.lastSafeUserAnchorEntrySeq,
        now,
        this.resolveLineageId(input.runtimeSessionId),
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM0 failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  /** SOFT materialization: update only m1 (m0 stays byte-identical). */
  materializeM1(input: MaterializeM1Input): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m1_body = ?, m1_content_hash = ?, m1_updated_at = ?,
           represented_through_entry_seq = ?,
           updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(
        input.m1Body,
        input.m1ContentHash,
        input.atMs,
        input.representedThroughEntrySeq,
        now,
        this.resolveLineageId(input.runtimeSessionId),
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM1 failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  /**
   * R2-P1 HARD materialization（context_seq 语义）：重建 m0 + 重置/渲染 m1，
   * 并推进 represented_through_context_seq。单行事务：失败绝不留下 m0 已推进、
   * watermark 未推进的中间态。cached_m0_* 记录本次 fold 的 cache 身份
   * （provider-side cache 是在这个身份下构建的；后续 pass 与之比对 → 变化即
   * HARD）。v12 的 represented_through_entry_seq 保持不动（不同空间）。
   */
  materializeM0ByContextSeq(input: MaterializeM0ByContextSeqInput): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m0_body = ?, m1_body = ?, m0_content_hash = ?, m1_content_hash = ?,
           m0_materialized_at = ?, m1_updated_at = ?,
           cached_m0_system_hash = ?, cached_m0_model_key = ?,
           cached_m0_provider_profile_id = ?,
           represented_through_context_seq = ?,
           updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(
        input.m0Body,
        input.m1Body,
        input.m0ContentHash,
        input.m1ContentHash,
        input.atMs,
        input.atMs,
        input.cachedM0SystemHash,
        input.cachedM0ModelKey,
        input.cachedM0ProviderProfileId,
        input.representedThroughContextSeq,
        now,
        this.resolveLineageId(input.runtimeSessionId),
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM0ByContextSeq failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  /**
   * R2-P1 SOFT materialization（context_seq 语义）：只更新 m1（m0 保持
   * byte-identical）。不推进 represented_through_context_seq（watermark
   * 只在 HARD fold 时推进，见 B1 parity 修复：SOFT 累积渲染 m1）。
   */
  materializeM1ByContextSeq(input: MaterializeM1ByContextSeqInput): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m1_body = ?, m1_content_hash = ?, m1_updated_at = ?,
           updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(
        input.m1Body,
        input.m1ContentHash,
        input.atMs,
        now,
        this.resolveLineageId(input.runtimeSessionId),
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM1ByContextSeq failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  /**
   * R2-P1：仅推进 represented_through_context_seq watermark（SOFT+ 字节不变
   * 通过后用于幂等对齐；也供测试直接驱动）。
   */
  updateRepresentedThrough(runtimeSessionId: string, representedThroughContextSeq: number): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           represented_through_context_seq = ?, updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(representedThroughContextSeq, now, this.resolveLineageId(runtimeSessionId));
    if (result.changes !== 1) {
      throw new Error(
        `context updateRepresentedThrough failed: no lineage for ${runtimeSessionId}`,
      );
    }
  }

  setEmergencyState(
    runtimeSessionId: string,
    state: ContextLineage["emergencyState"],
    error: string | null,
    lineageIdOverride?: string,
  ): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET emergency_state = ?, last_transform_error = ?, updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(state, error, now, lineageIdOverride ?? this.resolveLineageId(runtimeSessionId));
    if (result.changes !== 1) {
      throw new Error(`context setEmergencyState failed: no lineage for ${runtimeSessionId}`);
    }
  }

  /**
   * Persist advanced replay watermarks (monotonic single-row update). The
   * caller commits detect results ONLY on a cache-busting pass — a defer pass
   * must never advance these (byte-identical replay contract).
   */
  persistWatermarks(
    runtimeSessionId: string,
    watermarks: {
      clearedReasoningThroughTag: number;
      toolReclaimWatermark: number;
      mutationReplayWatermark: number;
    },
  ): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           cleared_reasoning_through_tag = ?, tool_reclaim_watermark = ?,
           mutation_replay_watermark = ?, updated_at = ?
         WHERE context_lineage_id = ?`,
      )
      .run(
        watermarks.clearedReasoningThroughTag,
        watermarks.toolReclaimWatermark,
        watermarks.mutationReplayWatermark,
        now,
        this.resolveLineageId(runtimeSessionId),
      );
    if (result.changes !== 1) {
      throw new Error(`context persistWatermarks failed: no lineage for ${runtimeSessionId}`);
    }
  }

  enqueueDeferredOperation(
    runtimeSessionId: string,
    opKind: string,
    opPayload: string,
  ): DeferredOperation {
    const now = new Date().toISOString();
    const lineage = this.getLineage(runtimeSessionId);
    if (lineage === undefined) {
      throw new Error(`context enqueueDeferred failed: no lineage for ${runtimeSessionId}`);
    }
    const cursor = lineage.deferredSignalCursor;
    const result = this.db
      .prepare(
        `INSERT INTO context_deferred_operations
           (context_lineage_id, op_kind, op_payload, enqueued_at, consumed_after_cursor)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.resolveLineageId(runtimeSessionId), opKind, opPayload, now, cursor);
    return {
      seq: Number(result.lastInsertRowid),
      lineageId: this.resolveLineageId(runtimeSessionId),
      opKind,
      opPayload,
      enqueuedAt: now,
    };
  }

  listDeferredOperations(runtimeSessionId: string): DeferredOperation[] {
    const rows = this.db
      .prepare(
        "SELECT seq, context_lineage_id, op_kind, op_payload, enqueued_at FROM context_deferred_operations WHERE context_lineage_id = ? ORDER BY seq",
      )
      .all(this.resolveLineageId(runtimeSessionId)) as unknown as Array<{
      seq: number;
      context_lineage_id: string;
      op_kind: string;
      op_payload: string;
      enqueued_at: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      lineageId: row.context_lineage_id,
      opKind: row.op_kind,
      opPayload: row.op_payload,
      enqueuedAt: row.enqueued_at,
    }));
  }

  setDeferredSignalCursor(runtimeSessionId: string, cursor: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE context_lineages SET deferred_signal_cursor = ?, updated_at = ? WHERE context_lineage_id = ?",
      )
      .run(cursor, now, this.resolveLineageId(runtimeSessionId));
  }

  captureLkgSlot(slot: LkgSlot): void {
    const result = this.db
      .prepare(
        `INSERT INTO context_lkg_slots (context_lineage_id, slot_key, lkg_json, captured_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (context_lineage_id, slot_key) DO UPDATE SET
           lkg_json = excluded.lkg_json, captured_at = excluded.captured_at`,
      )
      .run(slot.lineageId, slot.slotKey, slot.lkgJson, slot.capturedAt);
    if (result.changes === 0) {
      throw new Error(`context captureLkgSlot failed for ${slot.lineageId}/${slot.slotKey}`);
    }
  }

  getLkgSlot(runtimeSessionId: string, slotKey: string): LkgSlot | undefined {
    // LKG 是 lineage 级状态：参数是 lineageId（identity-level），直接精确
    // 匹配，不走 resolveLineageId（避免对不存在 lineage 回退默认键）。
    const row = this.db
      .prepare(
        "SELECT context_lineage_id, slot_key, lkg_json, captured_at FROM context_lkg_slots WHERE context_lineage_id = ? AND slot_key = ?",
      )
      .get(runtimeSessionId, slotKey) as
      | { context_lineage_id: string; slot_key: string; lkg_json: string; captured_at: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      lineageId: row.context_lineage_id,
      slotKey: row.slot_key,
      lkgJson: row.lkg_json,
      capturedAt: row.captured_at,
    };
  }

  /**
   * Invariant check used by migration/crash tests: a corrupt or newer DB must
   * refuse to open, while an empty DB initializes cleanly.
   */
  static checksumOf(sql: string): string {
    return createHash("sha256").update(sql, "utf8").digest("hex");
  }
}

/** Migration dir for a given context.db path (tests may pass a temp copy). */
function migrationsDirFor(contextDbPath: string): string {
  void contextDbPath;
  // The migration SQL files live beside the schema; resolve relative to this
  // source file so src/ and dist/ builds both work.
  return fileURLToPath(new URL("../db/migrations/context", import.meta.url));
}
