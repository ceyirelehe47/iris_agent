// MIGRATION ONLY — Not part of current production Context path per Notion v27.
import { createHash } from "node:crypto";

import type { AgentMessage } from "@iris/pi-agent-core";

import type { ContextStore, LkgSlot } from "./context-store.js";
import type { ProjectedSessionMessage } from "../runtime/session-projection.js";

/**
 * Iris LKG (last-known-good) — the safe provider-visible recovery prefix.
 *
 * Semantics ported from the locked OpenCode authority
 * (cortexkit/magic-context @ 48ab531d, packages/plugin/src/hooks/magic-context/
 * lkg-replay.ts + lkg-slot.ts), mapped onto Pi `AgentMessage`s.
 *
 * The slot stores the exact prefix (anchor + everything before it) that was
 * successfully visible to the provider on the last good pass, plus the id
 * sequence and content digests of the anchor's input. A later pass whose
 * input reshaped (ids shifted, contents changed, model/provider changed)
 * fails closed with a typed LkgValidationFailure instead of guessing a
 * recovery prefix.
 *
 * R2 scope: this module is the capability layer + SQLite persistence +
 * tests. Wiring into the transform path is the R3 Historian integration
 * (Feature 9/10 gate) — no production call site exists yet.
 */

export type LkgValidationFailure =
  | "lkg_model_mismatch"
  | "lkg_invalidated_reshape"
  | "lkg_content_mismatch"
  | "lkg_unsafe_seam"
  | "lkg_seam_invalid"
  | "lkg_anthropic_reasoning_run_invalid";

/** Deterministic slot key for a runtime session (one LKG slot per lineage). */
export const LKG_SLOT_KEY = "lkg-v1";

export interface LkgEntryProjection {
  /** Raw Pi entry id (SessionTreeEntry.id) — the authoritative id. */
  entryId: string;
  role: string;
  /** True for iris companion (role "custom" carrying iris_input_meta). */
  synthetic: boolean;
  /** Assistant with tool calls that never resolve to a ToolResult. */
  hasIncompleteTool: boolean;
  /** Assistant stop reason mapped to the authority's finish vocabulary. */
  finish: "tool-calls" | "stop" | "length" | "error" | "aborted" | null;
  /** Message timestamp (ms epoch), null when absent. */
  timeCreated: number | null;
  /** Lazy provider-relevant content digest (null when unhashaable). */
  contentDigest: () => string | null;
}

/** Persisted slot payload (stored as lkg_json in context_lkg_slots). */
export interface LkgSlotPayload {
  jsonPrefix: string;
  inputIdSeq: string[];
  inputContentDigests: string[];
  lastInputMessageId: string;
  modelKey: string | null;
  providerKey: string | null;
  capturedAt: number;
}

export interface LkgEntryNote {
  pristineTail: ProjectedSessionMessage[];
  entryInputIds: string[];
  entryContentDigests: string[];
  anchorIndex: number;
}

export interface LkgCaptureInput {
  runtimeSessionId: string;
  input: ProjectedSessionMessage[];
  output: ProjectedSessionMessage[];
  modelKey: string | null;
  providerKey: string | null;
  capturedAt?: number;
}

/**
 * Type-aware sha256 (base64url) over a Pi AgentMessage's provider-relevant
 * fields. Mirrors the authority's lkgContentDigest encoding shape (recursive
 * typed visit), but hashes the stable wire-relevant payload only — runtime
 * metadata (usage/cost/api) is excluded so digest changes track real content
 * changes.
 */
export function lkgContentDigest(message: AgentMessage): string | null {
  const payload = stableMessagePayload(message);
  if (payload === null) return null;
  const hash = createHash("sha256");
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value === null) {
      hash.update("N;");
    } else if (typeof value === "string") {
      hash.update(`S${value.length}:`).update(value);
    } else if (typeof value === "number") {
      hash.update(`D${String(value)};`);
    } else if (typeof value === "boolean") {
      hash.update(value ? "B1;" : "B0;");
    } else if (value === undefined) {
      hash.update("U;");
    } else if (Array.isArray(value)) {
      if (seen.has(value)) throw new Error("cyclic message");
      seen.add(value);
      hash.update(`A${value.length}[`);
      for (const child of value) visit(child);
      hash.update("]");
      seen.delete(value);
    } else if (typeof value === "object") {
      if (seen.has(value)) throw new Error("cyclic message");
      seen.add(value);
      const entries = Object.entries(value);
      hash.update(`O${entries.length}{`);
      for (const [key, child] of entries) {
        hash.update(`K${key.length}:`).update(key);
        visit(child);
      }
      hash.update("}");
      seen.delete(value);
    } else {
      hash.update(`X${typeof value};`);
    }
  };
  try {
    visit(payload);
    return hash.digest("base64url");
  } catch {
    return null;
  }
}

function stableMessagePayload(message: AgentMessage): unknown {
  if (message === null || typeof message !== "object") return null;
  const role = (message as { role?: unknown }).role;
  if (role === "user") {
    const m = message as { content?: unknown; timestamp?: unknown };
    return { role: "user", content: m.content ?? [], timestamp: m.timestamp ?? null };
  }
  if (role === "assistant") {
    const m = message as {
      content?: unknown;
      stopReason?: unknown;
      timestamp?: unknown;
    };
    return {
      role: "assistant",
      content: m.content ?? [],
      stopReason: m.stopReason ?? null,
      timestamp: m.timestamp ?? null,
    };
  }
  if (role === "toolResult") {
    const m = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      isError?: unknown;
      timestamp?: unknown;
    };
    return {
      role: "toolResult",
      toolCallId: m.toolCallId ?? null,
      toolName: m.toolName ?? null,
      content: m.content ?? [],
      isError: m.isError ?? false,
      timestamp: m.timestamp ?? null,
    };
  }
  // custom (companion): hash role + customType + content + display + details.
  const m = message as {
    customType?: unknown;
    content?: unknown;
    display?: unknown;
    details?: unknown;
    timestamp?: unknown;
  };
  return {
    role: "custom",
    customType: m.customType ?? null,
    content: m.content ?? [],
    display: m.display ?? false,
    details: m.details ?? null,
    timestamp: m.timestamp ?? null,
  };
}

function partCallIds(message: ProjectedSessionMessage): string[] {
  const m = message.message;
  if (m.role !== "assistant") return [];
  const ids: string[] = [];
  const content = Array.isArray((m as { content?: unknown }).content)
    ? ((m as { content: unknown[] }).content as Array<Record<string, unknown>>)
    : [];
  for (const part of content) {
    if (part?.["type"] === "toolCall") {
      const callId = part["id"];
      if (typeof callId === "string" && callId.length > 0) ids.push(callId);
    }
  }
  return ids;
}

function partResultIds(message: ProjectedSessionMessage): string[] {
  const m = message.message;
  if (m.role !== "toolResult") return [];
  const callId = (m as { toolCallId?: unknown }).toolCallId;
  return typeof callId === "string" && callId.length > 0 ? [callId] : [];
}

/** Per-part thinking detection (authority partIsAnthropicThinking(part)). */
function partIsAnthropicThinkingPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const type = (part as Record<string, unknown>)["type"];
  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

function partIsReasoningPart(part: unknown): boolean {
  return Boolean(
    part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "reasoning",
  );
}

function isIrisCompanion(message: ProjectedSessionMessage): boolean {
  const m = message.message;
  if (m.role !== "custom") return false;
  const customType = (m as { customType?: unknown }).customType;
  return customType === "iris_input_meta";
}

function isRealUser(message: LkgEntryProjection): boolean {
  return message.role === "user" && !message.synthetic && message.entryId.length > 0;
}

function assistantIsActive(message: LkgEntryProjection): boolean {
  return message.finish === "tool-calls" || message.hasIncompleteTool;
}

function mapStopReason(stopReason: unknown): LkgEntryProjection["finish"] {
  if (stopReason === "toolUse") return "tool-calls";
  if (stopReason === "stop") return "stop";
  if (stopReason === "length") return "length";
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return null;
}

/**
 * Project a Pi session message view into LKG entry projections. The
 * hasIncompleteTool flag needs the full window, so unresolved tool call ids
 * are computed from the whole list.
 */
export function projectLkgEntries(messages: ProjectedSessionMessage[]): LkgEntryProjection[] {
  const resolved = new Set<string>();
  for (const message of messages) {
    for (const callId of partResultIds(message)) resolved.add(callId);
  }
  return messages.map((message) => {
    const m = message.message;
    let finish: LkgEntryProjection["finish"] = null;
    let hasIncompleteTool = false;
    if (m.role === "assistant") {
      finish = mapStopReason((m as { stopReason?: unknown }).stopReason);
      hasIncompleteTool = partCallIds(message).some((callId) => !resolved.has(callId));
    }
    return {
      entryId: message.entryId,
      role: m.role,
      synthetic: isIrisCompanion(message),
      hasIncompleteTool,
      finish,
      timeCreated:
        typeof (m as { timestamp?: unknown }).timestamp === "number"
          ? (m as { timestamp: number }).timestamp
          : null,
      contentDigest: () => lkgContentDigest(m),
    };
  });
}

function latestAssistant(messages: LkgEntryProjection[]): LkgEntryProjection | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return null;
}

/**
 * Find the LKG anchor: the newest real-user input. When the latest assistant
 * is active (tool-calls / incomplete tool), a user message created at/before
 * the assistant's timestamp cannot be the anchor (it predates the running
 * invocation). Authority findLkgAnchor.
 */
export function findLkgAnchor(messages: LkgEntryProjection[]): number | null {
  const assistant = latestAssistant(messages);
  const assistantTime = assistant?.timeCreated ?? null;
  if (assistant && assistantTime === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || !isRealUser(message)) continue;
    if (assistant && assistantIsActive(assistant)) {
      if (assistantTime === null || message.timeCreated === null) continue;
      if (message.timeCreated <= assistantTime) continue;
    }
    return index;
  }
  return null;
}

function messageId(message: ProjectedSessionMessage): string | null {
  return message.entryId.length > 0 ? message.entryId : null;
}

function outputMessageIsPostAnchor(
  message: ProjectedSessionMessage,
  inputIndexById: Map<string, number>,
  anchorIndex: number,
): boolean | null {
  const id = messageId(message);
  if (id !== null) {
    const inputIndex = inputIndexById.get(id);
    if (inputIndex !== undefined) return inputIndex > anchorIndex;
    if (!message.message.role.startsWith("custom")) return null;
    // Synthetic companion without a direct id match: treat as pre-anchor
    // scaffolding (authority: synthetic output not linked to input is folded
    // into the prefix).
    return false;
  }
  if (message.message.role.startsWith("custom")) return false;
  return null;
}

/**
 * Build the replay prefix and serialize it once. The returned `jsonPrefix` is
 * the exact artifact stored in the LKG slot; callers must use it as-is.
 * Returns null when no safe anchor / id sequence / digests can be derived.
 */
export function buildLkgPrefix(
  input: ProjectedSessionMessage[],
  output: ProjectedSessionMessage[],
): {
  anchorIndex: number;
  anchorMessageId: string;
  inputIdSeq: string[];
  inputContentDigests: string[];
  jsonPrefix: string;
} | null {
  const projected = projectLkgEntries(input);
  const anchorIndex = findLkgAnchor(projected);
  if (anchorIndex === null) return null;
  const ids = projected.map((entry) => entry.entryId);
  if (ids.some((id) => id.length === 0)) return null;
  const validIds = ids as string[];
  if (new Set(validIds).size !== validIds.length) return null;
  const anchorEntry = projected[anchorIndex];
  if (anchorEntry === undefined) return null;
  const anchorMessageId = validIds[anchorIndex];
  if (anchorMessageId === undefined) return null;
  const inputContentDigests = projected
    .slice(0, anchorIndex + 1)
    .map((entry) => entry.contentDigest());
  if (inputContentDigests.some((digest) => digest === null)) return null;
  const inputIndexById = new Map(validIds.map((id, index) => [id, index]));
  const prefix: ProjectedSessionMessage[] = [];
  for (const message of output) {
    const postAnchor = outputMessageIsPostAnchor(message, inputIndexById, anchorIndex);
    if (postAnchor === null) return null;
    if (!postAnchor) prefix.push(message);
  }
  let jsonPrefix: string;
  try {
    jsonPrefix = JSON.stringify(prefix);
    if (typeof jsonPrefix !== "string") return null;
  } catch {
    return null;
  }
  return {
    anchorIndex,
    anchorMessageId,
    inputIdSeq: validIds.slice(0, anchorIndex + 1),
    inputContentDigests: inputContentDigests as string[],
    jsonPrefix,
  };
}

function slotBytes(payload: LkgSlotPayload): number {
  const digestBytes = payload.inputContentDigests.reduce(
    (total, digest) => total + 2 * digest.length,
    0,
  );
  return 2 * payload.jsonPrefix.length + digestBytes + 256;
}

/** Authority budgets: single slot <= 24 MiB (kept for parity; Iris slots are
 * normally tiny). A slot exceeding the budget is refused (capture fails). */
const LKG_SINGLE_SLOT_BYTES = 24 * 1024 * 1024;

/**
 * Capture the LKG slot for a runtime session. Persists the serialized prefix
 * + anchor identity. Returns false when no safe anchor or the slot exceeds
 * the single-slot budget (authority captureSlot semantics).
 */
export function captureLkgSlot(store: ContextStore, args: LkgCaptureInput): boolean {
  const built = buildLkgPrefix(args.input, args.output);
  if (!built) return false;
  const payload: LkgSlotPayload = {
    jsonPrefix: built.jsonPrefix,
    inputIdSeq: built.inputIdSeq,
    inputContentDigests: built.inputContentDigests,
    lastInputMessageId: built.anchorMessageId,
    modelKey: args.modelKey,
    providerKey: args.providerKey,
    capturedAt: args.capturedAt ?? Date.now(),
  };
  if (payload.inputContentDigests.length !== payload.inputIdSeq.length) return false;
  if (payload.inputContentDigests.some((digest) => digest.length === 0)) return false;
  if (slotBytes(payload) > LKG_SINGLE_SLOT_BYTES) return false;
  const slot: LkgSlot = {
    lineageId: args.runtimeSessionId,
    slotKey: LKG_SLOT_KEY,
    lkgJson: JSON.stringify(payload),
    capturedAt: new Date(payload.capturedAt).toISOString(),
  };
  store.captureLkgSlot(slot);
  return true;
}

function entryIdsAreValid(payload: LkgSlotPayload, entryIds: string[]): boolean {
  if (payload.inputIdSeq.length === 0 || entryIds.length < payload.inputIdSeq.length) {
    return false;
  }
  if (payload.inputIdSeq[payload.inputIdSeq.length - 1] !== payload.lastInputMessageId) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of entryIds) {
    if (!id || seen.has(id)) return false;
    seen.add(id);
  }
  if (entryIds.indexOf(payload.lastInputMessageId) !== payload.inputIdSeq.length - 1) {
    return false;
  }
  for (let index = 0; index < payload.inputIdSeq.length; index += 1) {
    if (entryIds[index] !== payload.inputIdSeq[index]) return false;
  }
  return true;
}

function entryContentIsValid(payload: LkgSlotPayload, entryDigests: string[]): boolean {
  return (
    entryDigests.length >= payload.inputContentDigests.length &&
    payload.inputContentDigests.every((digest, index) => entryDigests[index] === digest)
  );
}

/**
 * The Anthropic adapter merges adjacent assistant messages before sending.
 * A merged run may contain only one leading thinking block; moving or
 * retaining a later signed block would invalidate its provider signature, so
 * recovery declines the entire replay (authority validateAnthropicReasoningRuns).
 */
export function validateAnthropicReasoningRuns(messages: ProjectedSessionMessage[]): boolean {
  let index = 0;
  while (index < messages.length) {
    const current = messages[index];
    if (current?.message.role !== "assistant") {
      index += 1;
      continue;
    }
    let thinkingBlocks = 0;
    let sawOtherContent = false;
    while (index < messages.length && messages[index]?.message.role === "assistant") {
      const message = messages[index];
      if (message === undefined) break;
      const m = message.message;
      const content = Array.isArray((m as { content?: unknown }).content)
        ? ((m as { content: unknown[] }).content as unknown[])
        : [];
      for (const part of content) {
        if (partIsAnthropicThinkingPart(part)) {
          thinkingBlocks += 1;
          if (thinkingBlocks > 1 || sawOtherContent) return false;
        } else {
          sawOtherContent = true;
        }
      }
      index += 1;
    }
  }
  return true;
}

export function validateLkgSeamBoundary(
  prefix: ProjectedSessionMessage[],
  tail: ProjectedSessionMessage[],
): boolean {
  const last = prefix[prefix.length - 1];
  const first = tail[0];
  if (!last || !first) return true;
  const lastCalls = partCallIds(last);
  if (lastCalls.length === 0) return true;
  const firstCalls = new Set([...partCallIds(first), ...partResultIds(first)]);
  if (first.message.role === "toolResult" || lastCalls.some((callId) => firstCalls.has(callId))) {
    return false;
  }
  // Authority: the prefix must not end with an assistant whose tool calls
  // never completed — a dangling tool_use would reach the wire. Every open
  // call id of the last message must have a matching result somewhere in the
  // tail; otherwise the seam is unsafe.
  const tailResultIds = new Set<string>();
  for (const message of tail) {
    for (const callId of partResultIds(message)) tailResultIds.add(callId);
  }
  return lastCalls.every((callId) => tailResultIds.has(callId));
}

export function validateLkgSeam(
  prefix: ProjectedSessionMessage[],
  tail: ProjectedSessionMessage[],
): boolean {
  const all = [...prefix, ...tail];
  const ids = new Set<string>();
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of all) {
    const id = messageId(message);
    if (id !== null) {
      if (ids.has(id)) return false;
      ids.add(id);
    }
    for (const callId of partCallIds(message)) {
      if (calls.has(callId)) return false;
      calls.add(callId);
    }
    for (const callId of partResultIds(message)) {
      if (results.has(callId)) return false;
      results.add(callId);
    }
    if (message.message.role !== "assistant") {
      const m = message.message;
      const content = Array.isArray((m as { content?: unknown }).content)
        ? ((m as { content: unknown[] }).content as unknown[])
        : [];
      if (content.some(partIsReasoningPart)) return false;
    }
  }
  if (!validateLkgSeamBoundary(prefix, tail)) return false;
  return true;
}

/** Build an entry note from the current message window (authority noteEntry). */
export function noteLkgEntry(messages: ProjectedSessionMessage[]): LkgEntryNote | null {
  const projected = projectLkgEntries(messages);
  const anchorIndex = findLkgAnchor(projected);
  if (anchorIndex === null) return null;
  const ids = projected.map((entry) => entry.entryId);
  if (ids.some((id) => id.length === 0)) return null;
  if (new Set(ids).size !== ids.length) return null;
  const digests = projected.map((entry) => entry.contentDigest());
  if (digests.some((digest) => digest === null)) return null;
  const anchorEntry = projected[anchorIndex];
  if (anchorEntry === undefined) return null;
  return {
    pristineTail: messages.slice(anchorIndex + 1),
    entryInputIds: ids as string[],
    entryContentDigests: digests as string[],
    anchorIndex,
  };
}

export interface ReplayLkgArgs {
  runtimeSessionId: string;
  messages: ProjectedSessionMessage[];
  modelKey: string | null;
  providerKey: string | null;
  entry?: LkgEntryNote | null;
  skipSeamValidation?: boolean;
}

export type ReplayLkgResult =
  { ok: true; messages: ProjectedSessionMessage[] } | { ok: false; reason: LkgValidationFailure };

/**
 * Replay the last-known-good prefix. Fails closed with a typed reason on any
 * identity/content/seam/model mismatch; on success returns
 * `prefix + pristineTail` for the provider-visible transform.
 */
export function replayLkg(store: ContextStore, args: ReplayLkgArgs): ReplayLkgResult {
  const slot = store.getLkgSlot(args.runtimeSessionId, LKG_SLOT_KEY);
  if (!slot) return { ok: false, reason: "lkg_invalidated_reshape" };
  let payload: LkgSlotPayload;
  try {
    const parsed = JSON.parse(slot.lkgJson) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, reason: "lkg_seam_invalid" };
    }
    payload = parsed as LkgSlotPayload;
  } catch {
    return { ok: false, reason: "lkg_seam_invalid" };
  }
  // Shape validation: a corrupt/partial slot must fail closed with a typed
  // reason instead of throwing a TypeError mid-validation (reviewer F5).
  if (
    typeof payload.jsonPrefix !== "string" ||
    !Array.isArray(payload.inputIdSeq) ||
    !payload.inputIdSeq.every((id) => typeof id === "string") ||
    !Array.isArray(payload.inputContentDigests) ||
    !payload.inputContentDigests.every((digest) => typeof digest === "string") ||
    typeof payload.lastInputMessageId !== "string"
  ) {
    return { ok: false, reason: "lkg_seam_invalid" };
  }
  if (payload.modelKey !== args.modelKey || payload.providerKey !== args.providerKey) {
    return { ok: false, reason: "lkg_model_mismatch" };
  }
  const entry = args.entry ?? noteLkgEntry(args.messages);
  if (entry === undefined || entry === null) {
    return { ok: false, reason: "lkg_invalidated_reshape" };
  }
  if (
    entry.anchorIndex !== payload.inputIdSeq.length - 1 ||
    !entryIdsAreValid(payload, entry.entryInputIds)
  ) {
    return { ok: false, reason: "lkg_invalidated_reshape" };
  }
  if (!entryContentIsValid(payload, entry.entryContentDigests)) {
    return { ok: false, reason: "lkg_content_mismatch" };
  }
  let prefix: ProjectedSessionMessage[];
  try {
    const parsed = JSON.parse(payload.jsonPrefix) as unknown;
    if (!Array.isArray(parsed)) throw new Error("prefix is not an array");
    prefix = parsed as ProjectedSessionMessage[];
  } catch {
    return { ok: false, reason: "lkg_seam_invalid" };
  }
  if (!args.skipSeamValidation) {
    if (!validateLkgSeamBoundary(prefix, entry.pristineTail)) {
      return { ok: false, reason: "lkg_unsafe_seam" };
    }
    if (!validateLkgSeam(prefix, entry.pristineTail)) {
      return { ok: false, reason: "lkg_seam_invalid" };
    }
  }
  const replayed = [...prefix, ...entry.pristineTail];
  if (payload.providerKey === "anthropic" && !validateAnthropicReasoningRuns(replayed)) {
    return { ok: false, reason: "lkg_anthropic_reasoning_run_invalid" };
  }
  return { ok: true, messages: replayed };
}

export function validateLkgEntry(payload: LkgSlotPayload, entryIds: string[]): boolean {
  return entryIdsAreValid(payload, entryIds);
}
