/**
 * Feature C6 (#119/#114/#100): Adversarial native-settled proof.
 *
 * Proves that nativeSettlementReceipt is NOT satisfiable by:
 * - harness.abort() returning without native settled event
 * - generator finally / runCompletion resolving without native settled
 * - native settled from a different invocation
 *
 * consume-iris-context 升级（Phase G Finding 1）：除保留源码结构断言外，新增
 * 行为测试 —— 用真实 PiRuntimeAdapter + 真实 AgentHarness（@iris/context
 * 装配）在运行时证明：
 *   - 真实 settled 路径：prompt 结束后 receipt 被消费清空，abort 无凭据 →
 *     fail closed（abort 绑定的是 live receipt，不是 runCompletion）；
 *   - 无 settled 路径：native 流结束但从未 emit settled → 适配器 emit
 *     failed(settled_not_observed) 且 receipt 被 reject，abort 同样 fail
 *     closed（settlementResolve 只由 native settled 事件驱动）。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInput } from "../src/contracts/origin.js";
import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { assembleIrisContext } from "../src/runtime/iris-context.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { PiRuntimeAdapter } from "../src/runtime/pi-runtime-adapter.js";
import {
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareInvocation,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

test("C6: nativeSettlementReceipt structure — abort waits for native settled, not runCompletion", () => {
  const adapterCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "pi-runtime-adapter.ts"),
    "utf8",
  );

  // 1. nativeSettlementReceipt exists
  assert.ok(adapterCode.includes("nativeSettlementReceipt"));

  // 2. settlementResolve is called ONLY on "settled" event
  assert.ok(adapterCode.includes("this.settlementResolve?.();"));

  // 3. settlementReject is called when !settledSeen
  assert.ok(adapterCode.includes("prompt ended without native settled"));

  // 4. abort() races the receipt against a timeout
  assert.ok(adapterCode.includes("Promise.race"));

  // 5. runCompletion is in RuntimeCoordinator, separate from nativeSettlementReceipt
  const coordinatorCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "runtime-coordinator.ts"),
    "utf8",
  );
  assert.ok(coordinatorCode.includes("runCompletion"));
  assert.ok(!coordinatorCode.includes("nativeSettlementReceipt"));
});

test("C6: receipt is invocation-scoped", () => {
  const adapterCode = fs.readFileSync(
    path.join(REPO_ROOT, "src", "runtime", "pi-runtime-adapter.ts"),
    "utf8",
  );

  assert.ok(adapterCode.includes("this.nativeSettlementReceipt = new Promise"));
  assert.ok(adapterCode.includes("this.nativeSettlementReceipt = null;"));
  assert.ok(adapterCode.includes("const receipt = this.nativeSettlementReceipt;"));
});

// ---------------------------------------------------------------------------
// 行为升级：真实适配器 + 真实 harness（@iris/context 装配）运行时证明
// ---------------------------------------------------------------------------

/** 本文件 @iris/context 装配的清理注册表（文件结束统一 close）。 */
const openAssemblies: Array<{ close(): Promise<void> }> = [];
after(async () => {
  for (const assembly of openAssemblies) {
    await assembly.close().catch(() => undefined);
  }
  openAssemblies.length = 0;
});

/** 构造真实 PiRuntimeAdapter（真实 harness + @iris/context 装配）。 */
async function buildRealAdapter(): Promise<{
  adapter: PiRuntimeAdapter;
  binding: ReturnType<typeof prepareInvocation>;
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-c6-"));
  const config = defaultAgentConfig();
  const input = sampleAgentInput();
  const now = "2026-08-01T00:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(now);
  const binding = prepareInvocation(
    input,
    epoch.runtimeSessionId,
    epoch.epochId,
    epoch.ordinalWithinDate,
    config,
    now,
  );
  const { models, model, providerProfileId } = await composeProvider("mock");
  const sessionHandle = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  const session = sessionHandle.session;
  const assembly = await assembleIrisContext({
    dataRoot: paths.dataRoot,
    runtimeSessionId: epoch.runtimeSessionId,
    providerProfileId,
    canonicalSystemPrompt: binding.canonicalSystemPrompt,
    systemProjectionHash: createHash("sha256").update(binding.canonicalSystemPrompt).digest("hex"),
    preparedAt: binding.preparedAt,
    withHistorian: false,
    now: () => now,
    getCurrentSource: () => ({
      canonicalSystemPrompt: binding.canonicalSystemPrompt,
      personaSnapshotId: "persona-default-v1",
      providerProfileId,
      toolDeclarations: ["test_read_tool"],
    }),
  });
  openAssemblies.push(assembly);
  const { harness } = createIrisHarness({
    session,
    instanceEpoch: epoch.ordinalWithinDate,
    models,
    model,
    tools: [makeReadOnlyTestTool()],
    currentInvocation: binding,
    now,
    providerProfileId,
    irisContext: assembly.contextService,
  });
  const adapter = new PiRuntimeAdapter({
    harness,
    session,
    binding,
    repo: sessionHandle.repo,
  });
  return { adapter, binding };
}

/** 收集一次 prompt 的事件流直到结束。 */
async function drainPrompt(
  adapter: PiRuntimeAdapter,
  input: AgentInput,
): Promise<Array<{ type: string; code?: string }>> {
  const events: Array<{ type: string; code?: string }> = [];
  for await (const event of adapter.prompt(input)) {
    events.push({ type: event.type, ...("code" in event ? { code: event.code } : {}) });
  }
  return events;
}

test("C6 behavior: after a real settled run the receipt is consumed — abort without a live receipt fails closed", async () => {
  const { adapter, binding } = await buildRealAdapter();
  const events = await drainPrompt(adapter, binding.input);
  assert.ok(
    events.some((e) => e.type === "settled"),
    "the real run must settle natively (behavioral proof that the receipt resolves on the settled event)",
  );
  assert.equal(adapter.getPhase(), "idle");
  // The run already ended: the native-settled receipt was consumed and
  // cleared (nativeSettlementReceipt = null). Abort afterwards has NO live
  // receipt — it must fail closed, never be satisfied by runCompletion.
  await assert.rejects(
    adapter.abort(binding.invocationId),
    /no native settlement proof/,
    "abort after the run ended must throw (receipt is per-invocation, not runCompletion)",
  );
});

test("C6 behavior: a native run that ends WITHOUT settled rejects the receipt and fails closed", async () => {
  // Stub harness: prompt() parks, then completes but NEVER emits
  // agent_end/settled — the exact Round-6 `receipt === null` hazard window,
  // driven at runtime. abort() is called WHILE the run is in flight so it
  // awaits the live receipt; the run then ends without settled → the receipt
  // is rejected → abort fails closed.
  const listeners = new Set<(event: { type: string; nextTurnCount?: number }) => void>();
  let releasePrompt: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const stubHarness = {
    subscribe(listener: (event: { type: string; nextTurnCount?: number }) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(): Promise<unknown> {
      await gate;
      return { role: "assistant", content: [{ type: "text", text: "ok" }] };
    },
    async abort(): Promise<unknown> {
      return { ok: true };
    },
    getModel(): unknown {
      return undefined;
    },
    async setModel(): Promise<void> {
      return undefined;
    },
  };
  const binding = prepareInvocation(
    sampleAgentInput(),
    "session-c6-stub",
    "epoch-c6-stub",
    1,
    defaultAgentConfig(),
    "2026-08-01T00:00:00.000Z",
  );
  const adapter = new PiRuntimeAdapter({
    harness: stubHarness as never,
    session: { getEntries: async () => [] } as never,
    binding,
    repo: {
      async [Symbol.asyncDispose](): Promise<void> {
        return undefined;
      },
    },
  });
  const promptPromise = drainPrompt(adapter, binding.input);
  // Let the run start and bind its native-settled receipt, then abort: the
  // abort awaits the LIVE receipt, which is rejected when the run ends
  // without a native settled event (never satisfiable by runCompletion).
  await new Promise((resolve) => setTimeout(resolve, 0));
  const abortPromise = assert.rejects(
    adapter.abort(binding.invocationId),
    /no native settlement proof|prompt ended without native settled/,
    "abort without an exact native settled receipt must fail closed",
  );
  releasePrompt?.();
  await abortPromise;
  const events = await promptPromise;
  assert.ok(
    events.some((e) => e.type === "failed" && e.code === "settled_not_observed"),
    "no native settled → the adapter must emit failed(settled_not_observed), never a fake settled",
  );
});
