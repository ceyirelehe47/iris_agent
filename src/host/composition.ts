import type { AgentHarness } from "@earendil-works/pi-agent-core";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput } from "../contracts/origin.js";
import type { SliceProviderMode } from "../runtime/vertical-slice.js";
import {
  closeSessionStorage,
  composeProvider,
  openOrCreateSession,
  prepareContextSources,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { createIrisHarness, type InvocationBinding } from "../runtime/harness-factory.js";
import { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.js";
import { ActiveRuntimeRegistry, activeRuntimeHandle } from "../runtime/active-runtime-registry.js";
import { RuntimeCoordinator, type ModelOverridePort } from "../runtime/runtime-coordinator.js";
import type { Model } from "@earendil-works/pi-ai";
import { RuntimeEpochStore } from "../runtime/epoch-manager.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import { initializeDataRoot, resolveDataRootPaths } from "./data-root.js";
import { HOST_INSTANCE_EPOCH } from "./host.js";
import { acquireDataRootLock, type DataRootLockHandle } from "./lock.js";
import { SqliteSessionRepository } from "@earendil-works/pi-storage-sqlite-node";
import { createNodeSqliteFactory } from "@earendil-works/pi-storage-sqlite-node";
import { nodeSqliteRepoEnv } from "../runtime/pi-env.js";

/**
 * Host composition (00 Module Boundaries): the product path that both
 * `iris serve` and `iris run` share. It owns startup recovery (discards
 * stale 'creating' Epochs and their orphan Pi Session rows), the active
 * Runtime Session, the Pi Harness and the RuntimeCoordinator. This is the
 * real composition seam the CLI uses — not a one-shot library call.
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
  close(): Promise<void>;
}

export interface OpenHostOptions {
  dataRoot: string;
  config?: AgentConfigV3;
  provider: SliceProviderMode;
}

export async function openHost(options: OpenHostOptions): Promise<HostComposition> {
  const config = options.config ?? defaultAgentConfig();
  const paths = resolveDataRootPaths(options.dataRoot, config);
  const lock: DataRootLockHandle = await acquireDataRootLock(options.dataRoot, paths.lockFile);
  // Staged handles so every acquired resource is released even when a later
  // setup step throws (review blocker #2, fourth pass): nested finally keeps
  // Session storage, Epoch store and the lock independent.
  let epochStore: RuntimeEpochStore | undefined;
  let sessionHandle: Awaited<ReturnType<typeof openOrCreateSession>> | undefined;
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
    // re-entrant — the next startup still sees the creating rows and retries
    // (review blocker #1, fourth pass).
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
    const currentInvocation: InvocationBinding = {
      input: emptyPlaceholderInput(),
      prepared: prepareContextSources(
        emptyPlaceholderInput(),
        epoch.runtimeSessionId,
        epoch.epochId,
        config,
        new Date().toISOString(),
      ),
      invocationId: `invocation-${epoch.runtimeSessionId}`,
    };
    const { harness } = createIrisHarness({
      session,
      // review-pass-7 #2 (subagent-review fix): bind the Host's STABLE
      // instanceEpoch (dedupe namespace), not the session ordinal — the
      // ordinal increments on rollover and would break restart verification.
      instanceEpoch: HOST_INSTANCE_EPOCH,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now: new Date().toISOString(),
      providerProfileId,
    });
    const adapter = new PiRuntimeAdapter({
      harness,
      session,
      binding: currentInvocation,
      repo: sessionHandle.repo,
    });
    const registry = new ActiveRuntimeRegistry();
    registry.install(activeRuntimeHandle(epoch, adapter, currentInvocation));

    // iris_agent#89: production model override port — lets the Recovery
    // Supervisor resolve and apply fallback models through the real
    // PiRuntimeAdapter (harness.setModel()), not a test-injected dispatcher.
    const modelOverride: ModelOverridePort = {
      resolveModel(modelId: string) {
        // Search across all providers for a model with this id.
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
        prepareContextSources(input, runtimeSessionId, epochId, config, new Date().toISOString()),
    });

    let closed = false;
    // All staged handles are guaranteed present here: any earlier setup
    // failure would have thrown into the outer catch and released them.
    const readyEpochStore = epochStore;
    // Narrowed local: TS cannot narrow the outer `sessionHandle` inside
    // closures (it may be reassigned by the catch path).
    const stagedRepo = sessionHandle.repo;
    const host: HostComposition = {
      dataRoot: options.dataRoot,
      config,
      epochStore: readyEpochStore,
      epoch,
      coordinator,
      currentInvocation,
      registry,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        // Nested cleanup: each resource is released independently, and one
        // failure does not skip the others or leak the lock (review blocker
        // #2, fourth pass). The original error is preserved.
        let firstError: unknown;
        try {
          await closeSessionStorage(stagedRepo);
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
    // Setup failed partway: release every resource that was already acquired
    // (Session storage, Epoch store, lock), preserving the original error.
    let firstError: unknown = error;
    try {
      if (sessionHandle !== undefined) {
        await closeSessionStorage(sessionHandle.repo);
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
