import type { AgentHarness } from "@iris/pi-agent-core";
import { createHash } from "node:crypto";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput } from "../contracts/origin.js";
import type { SliceProviderMode } from "../runtime/vertical-slice.js";
import {
  closeSessionStorage,
  composeProvider,
  openOrCreateSession,
  prepareInvocation,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { createIrisHarness, type InvocationBinding } from "../runtime/harness-factory.js";
import { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.js";
import { ActiveRuntimeRegistry, activeRuntimeHandle } from "../runtime/active-runtime-registry.js";
import { RuntimeCoordinator, type ModelOverridePort } from "../runtime/runtime-coordinator.js";
import type { Model } from "@iris/pi-ai";
import { RuntimeEpochStore } from "../runtime/epoch-manager.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import { initializeDataRoot, resolveDataRootPaths } from "./data-root.js";
import { HOST_INSTANCE_EPOCH } from "./host.js";
import { acquireDataRootLock, type DataRootLockHandle } from "./lock.js";
import { SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";
import { createNodeSqliteFactory } from "@iris/pi-storage-sqlite-node";
import { nodeSqliteRepoEnv } from "../runtime/pi-env.js";
import {
  assembleIrisContext,
  type IrisContextAssembly,
  type CurrentContextSource,
} from "../runtime/iris-context.js";
import { IrisContextBridge } from "../runtime/iris-bridge.js";

/**
 * Host composition (00 Module Boundaries): the product path that both
 * `iris serve` and `iris run` share. It owns startup recovery (discards
 * stale 'creating' Epochs and their orphan Pi Session rows), the active
 * Runtime Session, the Pi Harness, the RuntimeCoordinator AND the
 * @iris/context assembly (ContextService + Historian + contributors).
 * This is the real composition seam the CLI uses — not a one-shot library
 * call.
 *
 * The long-lived `IrisHost` (host.ts) builds on the same seam; openHost is
 * kept as the composition root for one-shot/test/dev entry points.
 */
export interface HostComposition {
  dataRoot: string;
  config: AgentConfigV3;
  epochStore: RuntimeEpochStore;
  epoch: RuntimeSessionEpoch;
  coordinator: RuntimeCoordinator;
  currentInvocation: InvocationBinding;
  registry: ActiveRuntimeRegistry;
  /** @iris/context 装配（ContextService + Historian；Identity scope）。 */
  irisContext: IrisContextAssembly;
  close(): Promise<void>;
}

export interface OpenHostOptions {
  dataRoot: string;
  config?: AgentConfigV3;
  provider: SliceProviderMode;
}

function currentSourceFor(holder: { current: CurrentContextSource }): () => CurrentContextSource {
  return () => holder.current;
}

export async function openHost(options: OpenHostOptions): Promise<HostComposition> {
  const config = options.config ?? defaultAgentConfig();
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock: DataRootLockHandle = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  let epochStore: RuntimeEpochStore | undefined;
  let sessionHandle: Awaited<ReturnType<typeof openOrCreateSession>> | undefined;
  let irisAssembly: IrisContextAssembly | undefined;
  try {
    initializeDataRoot(options.dataRoot, config);
    epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );

    // Re-entrant startup recovery: (1) read stale creating Epochs WITHOUT
    // deleting, (2) idempotently delete their orphan Pi Session rows, (3)
    // only then remove the Epoch rows. A crash between (2) and (3) is
    // re-entrant — the next startup still sees the creating rows and retries.
    const staleCreating = epochStore.listCreating();
    if (staleCreating.length > 0) {
      const repo = new SqliteSessionRepository({
        env: nodeSqliteRepoEnv(options.dataRoot),
        sqlite: createNodeSqliteFactory(),
        databasePath: paths.sessionDb,
      });
      const list = await repo.list({ cwd: options.dataRoot });
      const cleaned: string[] = [];
      for (const stale of staleCreating) {
        const metadata = list.find((candidate) => candidate.id === stale.runtimeSessionId);
        if (metadata !== undefined) {
          await repo.delete?.(metadata);
        }
        cleaned.push(stale.runtimeSessionId);
      }
      epochStore.recoverCreating(cleaned);
    }

    // Corrupt-state gate (03 Host Runtime, Recovery): more than one durably
    // active Epoch means the local registry is corrupt. Enter not-ready
    // instead of silently guessing one by creation time.
    if (epochStore.countActive() > 1) {
      throw new Error(
        `runtime epoch registry is corrupt: ${epochStore.countActive()} active epochs found`,
      );
    }

    const epoch = epochStore.ensureActive(new Date().toISOString());
    sessionHandle = await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
    const session = sessionHandle.session;
    const { models, model, providerProfileId } = await composeProvider(options.provider);
    const now = new Date().toISOString();
    const binding: InvocationBinding = prepareInvocation(
      emptyPlaceholderInput(),
      epoch.runtimeSessionId,
      epoch.epochId,
      HOST_INSTANCE_EPOCH,
      config,
      now,
    );
    const contextSourceHolder: { current: CurrentContextSource } = {
      current: {
        canonicalSystemPrompt: binding.canonicalSystemPrompt,
        personaSnapshotId: "persona-default-v1",
        providerProfileId,
        toolDeclarations: ["test_read_tool"],
      },
    };
    irisAssembly = await assembleIrisContext({
      dataRoot: paths.dataRoot,
      runtimeSessionId: epoch.runtimeSessionId,
      providerProfileId,
      canonicalSystemPrompt: binding.canonicalSystemPrompt,
      systemProjectionHash: createHash("sha256")
        .update(binding.canonicalSystemPrompt)
        .digest("hex"),
      preparedAt: binding.preparedAt,
      withHistorian: true,
      now: () => new Date().toISOString(),
      getCurrentSource: currentSourceFor(contextSourceHolder),
    });
    const { harness } = createIrisHarness({
      session,
      // review-pass-7 #2 (subagent-review fix): bind the Host's STABLE
      // instanceEpoch (dedupe namespace), not the session ordinal — the
      // ordinal increments on rollover and would break restart verification.
      instanceEpoch: HOST_INSTANCE_EPOCH,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: binding,
      now,
      providerProfileId,
      irisContext: irisAssembly.contextService,
    });
    const bridge = new IrisContextBridge({
      runtimeSessionId: epoch.runtimeSessionId,
      instanceEpoch: HOST_INSTANCE_EPOCH,
      contextService: irisAssembly.contextService,
      getInput: () => binding.input,
      now: () => new Date().toISOString(),
    });
    bridge.attach(harness);
    const adapter = new PiRuntimeAdapter({
      harness,
      session,
      binding,
      repo: sessionHandle.repo,
    });
    const registry = new ActiveRuntimeRegistry();
    registry.install(activeRuntimeHandle(epoch, adapter, binding));

    // iris_agent#89: production model override port — lets the Recovery
    // Supervisor resolve and apply fallback models through the real
    // PiRuntimeAdapter (harness.setModel()), not a test-injected dispatcher.
    const modelOverride: ModelOverridePort = {
      resolveModel(modelId: string) {
        const allModels = models.getModels();
        return allModels.find((m) => m.id === modelId) as Model<string> | undefined;
      },
      async applyModelOverride(model) {
        await adapter.setModel(model as Model<string>);
      },
    };

    const coordinator = new RuntimeCoordinator({
      activeRuntime: registry,
      modelOverride,
      prepareInvocation: async (input: AgentInput, runtimeSessionId: string, epochId: string) =>
        prepareInvocation(
          input,
          runtimeSessionId,
          epochId,
          HOST_INSTANCE_EPOCH,
          config,
          new Date().toISOString(),
        ),
    });

    let closed = false;
    const readyEpochStore = epochStore;
    const stagedRepo = sessionHandle.repo;
    const readyAssembly = irisAssembly;
    const host: HostComposition = {
      dataRoot: options.dataRoot,
      config,
      epochStore: readyEpochStore,
      epoch,
      coordinator,
      currentInvocation: binding,
      registry,
      irisContext: readyAssembly,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        let firstError: unknown;
        try {
          await closeSessionStorage(stagedRepo);
        } catch (error) {
          firstError ??= error;
        }
        try {
          await readyAssembly.close();
        } catch (error) {
          firstError ??= error;
        }
        try {
          readyEpochStore.close();
        } catch (error) {
          firstError ??= error;
        }
        try {
          await lock.release();
        } catch (error) {
          firstError ??= error;
        }
        if (firstError !== undefined) {
          throw normalizeCleanupError(firstError);
        }
      },
    };
    return host;
  } catch (error) {
    let firstError: unknown = error;
    try {
      if (sessionHandle !== undefined) {
        await closeSessionStorage(sessionHandle.repo);
      }
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    try {
      if (irisAssembly !== undefined) {
        await irisAssembly.close();
      }
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    try {
      epochStore?.close();
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    try {
      await lock.release();
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    throw normalizeCleanupError(firstError);
  }
}

function emptyPlaceholderInput(): AgentInput {
  return {
    inputId: "host-placeholder",
    triggerOrigin: {
      schemaVersion: 1,
      channel: "host",
      principalKind: "system",
      authority: "internal_control",
      trust: "trusted",
    },
    blocks: [
      {
        blockId: "host-placeholder-block",
        sourceOrigin: {
          schemaVersion: 1,
          channel: "host",
          principalKind: "system",
          authority: "internal_control",
          trust: "trusted",
        },
        content: { mode: "inline_text", text: "" },
        contentHash: "",
      },
    ],
  };
}

function normalizeCleanupError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "unknown cleanup error";
  return new Error(message);
}

export type { AgentHarness };
