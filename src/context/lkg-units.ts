import type { AgentMessage } from "@iris/pi-agent-core";

import type { ContextStore } from "./context-store.js";

/**
 * R2-P1 unit-based LKG（last-known-good）—— provider 失败时的安全回放前缀。
 *
 * 与 v12 lkg.ts（session-entry 锚点）不同，本模块的捕获/验证/回放完全基于
 * R2 的 immutable ContextMessageUnit + m0/m1 物化状态：
 *
 *  - 捕获：把 provider-visible 前缀指纹（system hash + m0/m1 content hash +
 *    representedThroughContextSeq）连同实际下发的 prefixMessages（[m0, m1,
 *    ...p5Tail]）持久化到 context_lkg_slots（既有表，runtime_session_id +
 *    slot_key 主键）；
 *  - 验证：provider 失败时用"当前 render 的指纹"验证缓存前缀未被
 *    reshape/失效 —— 指纹一致才允许回放；
 *  - 回退：回放 = 捕获的 prefixMessages + 原始 live delta（当前 invocation
 *    的 live 单元 payload）。NEVER synthetic repair —— 绝不拼接猜测/占位修复
 *    内容（fail-closed：指纹不一致 → 类型化失败，交 Historian R3 决定）。
 *
 * R2-P1 wiring 说明：本模块是 capability layer + SQLite 持久化 + 测试。
 * provider 失败时的调用点（harness before_provider_request / 重试路径）属于
 * R3 Historian 集成 —— 与 v12 lkg.ts 相同的"无生产调用点"状态（v12 亦如此）。
 */

/** 本模块的 slot key（与 v12 的 lkg-v1 并存，互不干扰）。 */
export const LKG_UNITS_SLOT_KEY = "lkg-units-v1";

/** 捕获/验证用前缀指纹：任何一项变化即视为前缀失效。 */
export interface UnitsLkgFingerprint {
  systemHash: string;
  m0ContentHash: string;
  m1ContentHash: string;
  representedThroughContextSeq: number;
}

export interface UnitsLkgCaptureInput extends UnitsLkgFingerprint {
  runtimeSessionId: string;
  m0Body: string;
  m1Body: string;
  /** 实际下发的 provider-visible 前缀（[m0, m1, ...p5Tail]）。 */
  prefixMessages: AgentMessage[];
  modelKey: string | null;
  providerKey: string | null;
  capturedAt?: number;
}

export type LkgUnitsFailure =
  "lkg_units_missing" | "lkg_units_fingerprint_mismatch" | "lkg_units_corrupt";

export type LkgUnitsReplayResult =
  { ok: true; messages: AgentMessage[] } | { ok: false; reason: LkgUnitsFailure };

interface LkgUnitsSlotPayload {
  kind: "units-v1";
  systemHash: string;
  m0Body: string;
  m1Body: string;
  m0ContentHash: string;
  m1ContentHash: string;
  representedThroughContextSeq: number;
  modelKey: string | null;
  providerKey: string | null;
  capturedAt: number;
  prefixMessages: AgentMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** 从 slot 行解析并做形状校验（corrupt → undefined，不抛未捕获异常）。 */
function parseSlotPayload(lkgJson: string): LkgUnitsSlotPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lkgJson) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (
    parsed["kind"] !== "units-v1" ||
    typeof parsed["systemHash"] !== "string" ||
    typeof parsed["m0Body"] !== "string" ||
    typeof parsed["m1Body"] !== "string" ||
    typeof parsed["m0ContentHash"] !== "string" ||
    typeof parsed["m1ContentHash"] !== "string" ||
    typeof parsed["representedThroughContextSeq"] !== "number" ||
    !Array.isArray(parsed["prefixMessages"])
  ) {
    return undefined;
  }
  const modelKey: unknown = parsed["modelKey"];
  const providerKey: unknown = parsed["providerKey"];
  const capturedAt: unknown = parsed["capturedAt"];
  if (
    (modelKey !== null && typeof modelKey !== "string") ||
    (providerKey !== null && typeof providerKey !== "string") ||
    typeof capturedAt !== "number"
  ) {
    return undefined;
  }
  return {
    kind: "units-v1",
    systemHash: parsed["systemHash"] as string,
    m0Body: parsed["m0Body"] as string,
    m1Body: parsed["m1Body"] as string,
    m0ContentHash: parsed["m0ContentHash"] as string,
    m1ContentHash: parsed["m1ContentHash"] as string,
    representedThroughContextSeq: parsed["representedThroughContextSeq"] as number,
    modelKey,
    providerKey,
    capturedAt,
    prefixMessages: parsed["prefixMessages"] as AgentMessage[],
  };
}

/** 指纹是否与捕获时一致（当前 render 可用于安全回放）。 */
export function fingerprintMatches(
  fingerprint: UnitsLkgFingerprint,
  payload: Pick<
    LkgUnitsSlotPayload,
    "systemHash" | "m0ContentHash" | "m1ContentHash" | "representedThroughContextSeq"
  >,
): boolean {
  return (
    fingerprint.systemHash === payload.systemHash &&
    fingerprint.m0ContentHash === payload.m0ContentHash &&
    fingerprint.m1ContentHash === payload.m1ContentHash &&
    fingerprint.representedThroughContextSeq === payload.representedThroughContextSeq
  );
}

/**
 * 捕获 LKG 前缀。返回 false 当 shape 校验失败或 slot 已存在同 key 但指纹
 * 不同（绝不允许覆盖一个已失效的 slot —— 那会让"看起来可回放"）。
 */
export function captureUnitsLkg(store: ContextStore, input: UnitsLkgCaptureInput): boolean {
  const slot = store.getLkgSlot(input.runtimeSessionId, LKG_UNITS_SLOT_KEY);
  if (slot !== undefined) {
    const existing = parseSlotPayload(slot.lkgJson);
    if (
      existing !== undefined &&
      !fingerprintMatches(
        {
          systemHash: input.systemHash,
          m0ContentHash: input.m0ContentHash,
          m1ContentHash: input.m1ContentHash,
          representedThroughContextSeq: input.representedThroughContextSeq,
        },
        existing,
      )
    ) {
      return false;
    }
  }
  const payload: LkgUnitsSlotPayload = {
    kind: "units-v1",
    systemHash: input.systemHash,
    m0Body: input.m0Body,
    m1Body: input.m1Body,
    m0ContentHash: input.m0ContentHash,
    m1ContentHash: input.m1ContentHash,
    representedThroughContextSeq: input.representedThroughContextSeq,
    modelKey: input.modelKey,
    providerKey: input.providerKey,
    capturedAt: input.capturedAt ?? Date.now(),
    prefixMessages: input.prefixMessages,
  };
  store.captureLkgSlot({
    lineageId: input.runtimeSessionId,
    slotKey: LKG_UNITS_SLOT_KEY,
    lkgJson: JSON.stringify(payload),
    capturedAt: new Date(payload.capturedAt).toISOString(),
  });
  return true;
}

/** 读取并校验 slot（corrupt / 缺失 → undefined）。 */
export function readUnitsLkg(
  store: ContextStore,
  runtimeSessionId: string,
): LkgUnitsSlotPayload | undefined {
  const slot = store.getLkgSlot(runtimeSessionId, LKG_UNITS_SLOT_KEY);
  return slot === undefined ? undefined : parseSlotPayload(slot.lkgJson);
}

/** 验证当前 render 的指纹与捕获的前缀一致（provider 失败前调用）。 */
export function verifyUnitsLkg(
  store: ContextStore,
  args: { runtimeSessionId: string; fingerprint: UnitsLkgFingerprint },
): boolean {
  const payload = readUnitsLkg(store, args.runtimeSessionId);
  if (payload === undefined) {
    return false;
  }
  return fingerprintMatches(args.fingerprint, payload);
}

/**
 * 回放 LKG：验证通过 → 捕获前缀 + 原始 live delta；否则类型化失败
 * （NEVER synthetic repair）。liveDelta 为当前 invocation 的 live 单元 payload
 * （replay 不重建、不猜测）。
 */
export function replayUnitsLkg(
  store: ContextStore,
  args: {
    runtimeSessionId: string;
    fingerprint: UnitsLkgFingerprint;
    liveDelta: AgentMessage[];
  },
): LkgUnitsReplayResult {
  const payload = readUnitsLkg(store, args.runtimeSessionId);
  if (payload === undefined) {
    return { ok: false, reason: "lkg_units_missing" };
  }
  if (!fingerprintMatches(args.fingerprint, payload)) {
    return { ok: false, reason: "lkg_units_fingerprint_mismatch" };
  }
  return { ok: true, messages: [...payload.prefixMessages, ...args.liveDelta] };
}
