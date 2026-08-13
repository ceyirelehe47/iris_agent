import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Session } from "@iris/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../config/schema.js";
import { defaultAgentConfig } from "../config/load.js";
import type { AgentInput, ExternalizedPayloadRef } from "../contracts/origin.js";
import type { AgentRuntimeEvent } from "../contracts/ports.js";
import type { RuntimeSessionEpoch } from "../contracts/runtime.js";
import { initializeDataRoot, resolveDataRootPaths } from "./data-root.js";
import { acquireDataRootLock, type DataRootLockHandle } from "./lock.js";
import {
  IngressConflictError,
  IngressQueueFullError,
  InputAcceptanceLedger,
  type IngressAcceptOutcome,
  type InputAcceptanceRecord,
} from "./ingress.js";
import { RuntimeEpochStore } from "../runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../runtime/pi-env.js";
import {
  composeProvider,
  openOrCreateSession,
  prepareContextSources,
  makeReadOnlyTestTool,
} from "../runtime/vertical-slice.js";
import { findInputPairsByProjection } from "../runtime/context-adapter.js";
import {
  computeContentLayoutHash,
  decodeInputFrames,
  derivePairKey,
  encodeInputFrames,
  encodeInputFramesFromFrames,
  verifyCompanionLayoutHash,
  type InputFrame,
  type IrisInputMetaDetails,
} from "../runtime/companion.js";
import { AgentInputValidationError, validateAgentInput } from "./input-validation.js";
import { originHash } from "../contracts/origin.js";
import { createIrisHarness, type InvocationBinding } from "../runtime/harness-factory.js";
import { PiRuntimeAdapter } from "../runtime/pi-runtime-adapter.js";
import { projectSessionMessages } from "../runtime/session-projection.js";
import {
  ActiveRuntimeRegistry,
  activeRuntimeHandle,
  type ActiveRuntimeHandle,
} from "../runtime/active-runtime-registry.js";
import {
  RuntimeCoordinator,
  resolveFallbackModel,
  type ModelOverridePort,
} from "../runtime/runtime-coordinator.js";
import type { Model } from "@iris/pi-ai";
import {
  RecoverySupervisor,
  type RecoveryEscalationEvent,
} from "../runtime/recovery-supervisor.js";
import {
  DurableOutcomeResolutionStore,
  defaultFallbackConfig,
  freshRecoveryState,
  logicalExecutionIdFor,
  RecoveryStateStore,
} from "../runtime/recovery-state.js";

export interface IrisHostOptions {
  dataRoot: string;
  config?: AgentConfigV3;
  /** Provider mode for the active Capsule. */
  provider: "mock" | "live";
  /**
   * Test seam: when provider === "mock", make the faux provider throw this
   * error on its first provider call. The REAL harness failure path then runs
   * (emitRunFailure → failure message → agent_end → native settled), which is
   * how production provider dispatch failures behave.
   */
  mockProviderError?: Error;
  /**
   * Durable ingress dedupe identity dimension (M4). Semantics: the Host
   * INSTANCE epoch, NOT the Runtime Session Epoch ordinal. It is stable
   * across rollover and restart so a client retrying the same inputId always
   * hits the same dedupe namespace (window-5: session_committed inputs are
   * never re-prompted). Defaults to 1; override only for tests.
   */
  instanceEpoch?: number;
  /**
   * iris_agent#111: Operation-specific outcome_unknown reconciliation seam.
   * When the supervisor encounters a possibly-accepted (outcome_unknown)
   * dispatch, it calls this reconciler with the logical execution identity
   * and input identity. The reconciler should query each affected subsystem's
   * durable authority (provider dispatch status, tool idempotency receipt,
   * Memory Publication acceptance, Body adapter receipt) and return:
   * - `confirmed_applied`: the prior dispatch's effects were confirmed applied
   *   → settle without replay (zero duplicate side effects).
   * - `replay_safe`: the prior dispatch was confirmed NOT applied → replay
   *   with the same logical execution/idempotency identity and retry budget.
   * - `ambiguous`: cannot determine → fail closed (zero replay across restarts).
   *
   * Ingress `session_committed` MUST NOT be accepted as provider/effect
   * outcome proof — it only proves user input entered Pi Session.
   *
   * When omitted, the default is always `ambiguous` (safe fail-closed).
   */
  outcomeReconciler?: (signal: {
    logicalExecutionId: string;
    inputId: string;
    dispatchId: string;
  }) => Promise<"confirmed_applied" | "replay_safe" | "ambiguous">;
}

/** Default Host instance epoch for the durable ingress dedupe namespace. */
export const HOST_INSTANCE_EPOCH = 1;

export interface IrisHostHealth {
  ready: boolean;
  dataRoot: string;
  epochId: string;
  runtimeSessionId: string;
  coordinatorPhase: string;
  queuedInputs: number;
  rolloverPending: boolean;
}

export interface SessionStatusView {
  epochId: string;
  runtimeSessionId: string;
  localDate: string;
  ordinalWithinDate: number;
  status: string;
  previousEpochId?: string;
  createdAt: string;
  closedAt?: string;
}

export interface ArchiveEntryView {
  epochId: string;
  runtimeSessionId: string;
  status: string;
  localDate: string;
  ordinalWithinDate: number;
  createdAt: string;
  closedAt?: string;
}

export type HostRuntimeEvent =
  | AgentRuntimeEvent
  | RecoveryEscalationEvent
  | {
      type: "rollover_completed";
      epochId: string;
      runtimeSessionId: string;
      settledEpochId: string;
    }
  | { type: "ingress_accepted"; inputId: string; instanceEpoch: number; state: string };

/**
 * IrisHost — the single long-lived Host process (00 Module Boundaries, 03
 * Host Runtime). It:
 *
 *  1. acquires <dataRoot>/iris.lock and holds it for the FULL lifetime;
 *  2. runs startup recovery (stale creating Epochs + orphan Pi Sessions);
 *  3. opens the active Epoch + Pi Session and constructs the Capsule;
 *  4. constructs the RuntimeCoordinator + ActiveRuntimeRegistry;
 *  5. starts the durable ingress pump (auto-consumes the FIFO queue);
 *  6. drives settled-only rollover when requested;
 *  7. reports ready only after startup; flips not-ready on shutdown.
 *
 * The CLI / HTTP / future clients are Host clients; they never open the data
 * root or construct another Iris.
 */
export class IrisHost {
  private readonly dataRoot: string;
  private readonly config: AgentConfigV3;
  private readonly lock: DataRootLockHandle;
  private readonly epochStore: RuntimeEpochStore;
  private readonly ingress: InputAcceptanceLedger;
  private readonly registry: ActiveRuntimeRegistry;
  private readonly coordinator: RuntimeCoordinator;
  /** iris_agent#99: owns the production dispatch path (bounded retry,
   * fallback, watchdog, outcome_unknown reconciliation). */
  private readonly supervisor: RecoverySupervisor;
  /** SQLite-backed durable recovery state (one row per logical execution). */
  private readonly recoveryStore: RecoveryStateStore;
  private readonly providerMode: "mock" | "live";
  private readonly mockProviderError: Error | undefined;

  private readyFlag = false;
  private shuttingDown = false;
  private failedFlag = false;
  private pumpPromise: Promise<void> | null = null;
  /** A7: transport owned by the Host lifecycle; closed BEFORE lock release. */
  private transportClose: (() => Promise<void>) | null = null;
  /** A3: one-time native-settled authorization bound to the active Epoch.
   * Shared mutable box so static open() can wire the Coordinator callback
   * before the instance exists. */
  private readonly settledTokenBox: { value: { epochId: string; invocationId: string } | null };
  private readonly listeners = new Set<(event: HostRuntimeEvent) => void>();
  private readonly wake = createWakeSignal();
  private currentEpoch: RuntimeSessionEpoch;
  private instanceEpoch: number;

  private constructor(options: {
    dataRoot: string;
    config: AgentConfigV3;
    provider: "mock" | "live";
    lock: DataRootLockHandle;
    epochStore: RuntimeEpochStore;
    ingress: InputAcceptanceLedger;
    registry: ActiveRuntimeRegistry;
    coordinator: RuntimeCoordinator;
    supervisor: RecoverySupervisor;
    recoveryStore: RecoveryStateStore;
    currentEpoch: RuntimeSessionEpoch;
    instanceEpoch: number;
    settledTokenBox: { value: { epochId: string; invocationId: string } | null };
    mockProviderError?: Error;
  }) {
    this.dataRoot = options.dataRoot;
    this.config = options.config;
    this.providerMode = options.provider;
    this.mockProviderError = options.mockProviderError;
    this.lock = options.lock;
    this.epochStore = options.epochStore;
    this.ingress = options.ingress;
    this.settledTokenBox = options.settledTokenBox;
    this.registry = options.registry;
    this.coordinator = options.coordinator;
    this.supervisor = options.supervisor;
    this.recoveryStore = options.recoveryStore;
    this.currentEpoch = options.currentEpoch;
    this.instanceEpoch = options.instanceEpoch;
  }

  getReady(): boolean {
    return this.readyFlag;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isFailed(): boolean {
    return this.failedFlag;
  }

  /**
   * A7 (审查 #7): attach the ingress/admin transport to the Host lifecycle.
   * shutdown() closes the transport FIRST (stop accepting clients), then
   * drains the runtime and releases the lock — there is never a window where
   * the lock is free while an old HTTP server is still reachable.
   */
  attachTransport(close: () => Promise<void>): void {
    this.transportClose = close;
  }

  getDataRoot(): string {
    return this.dataRoot;
  }

  getEpochStore(): RuntimeEpochStore {
    return this.epochStore;
  }

  getIngress(): InputAcceptanceLedger {
    return this.ingress;
  }

  getRegistry(): ActiveRuntimeRegistry {
    return this.registry;
  }

  getCoordinator(): RuntimeCoordinator {
    return this.coordinator;
  }

  getCurrentEpoch(): RuntimeSessionEpoch {
    return this.currentEpoch;
  }

  onEvent(listener: (event: HostRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostRuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  health(): IrisHostHealth {
    void this.registry.getActiveOrNull();
    return {
      ready: this.readyFlag && !this.shuttingDown && !this.failedFlag,
      dataRoot: this.dataRoot,
      epochId: this.currentEpoch.epochId,
      runtimeSessionId: this.currentEpoch.runtimeSessionId,
      coordinatorPhase: this.coordinator.getPhase(),
      queuedInputs: this.ingress.queuedCount(),
      rolloverPending: this.epochStore.isRolloverPending(),
    };
  }

  sessionStatus(): SessionStatusView {
    const epoch = this.epochStore.getActive();
    if (epoch === null) {
      return {
        epochId: this.currentEpoch.epochId,
        runtimeSessionId: this.currentEpoch.runtimeSessionId,
        localDate: this.currentEpoch.localDate,
        ordinalWithinDate: this.currentEpoch.ordinalWithinDate,
        status: "none",
        createdAt: this.currentEpoch.createdAt,
      };
    }
    return {
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      localDate: epoch.localDate,
      ordinalWithinDate: epoch.ordinalWithinDate,
      status: epoch.status,
      ...(epoch.previousEpochId !== undefined ? { previousEpochId: epoch.previousEpochId } : {}),
      createdAt: epoch.createdAt,
      ...(epoch.closedAt !== undefined ? { closedAt: epoch.closedAt } : {}),
    };
  }

  archives(limit: number): ArchiveEntryView[] {
    const rows = this.epochStore.listAll(limit);
    return rows.map((epoch) => ({
      epochId: epoch.epochId,
      runtimeSessionId: epoch.runtimeSessionId,
      status: epoch.status,
      localDate: epoch.localDate,
      ordinalWithinDate: epoch.ordinalWithinDate,
      createdAt: epoch.createdAt,
      ...(epoch.closedAt !== undefined ? { closedAt: epoch.closedAt } : {}),
    }));
  }

  /**
   * Durable input acceptance (03 Host Runtime). Validates the envelope
   * identity, writes the accepted record + normalized envelope, enqueues for
   * the active runtime and wakes the pump. Retries of an accepted-but-
   * uncommitted input re-enter the normal single-writer path; a
   * session_committed input returns its existing result without re-prompting.
   */
  /**
   * review-pass-2 #5: the Host is the ONLY normalization/validation authority.
   * Every transport (HTTP, CLI, future Body/adapter) goes through this
   * method: the envelope is validated, the dedupe instanceEpoch is
   * HOST-owned (callers cannot choose the namespace), and the transport
   * inputId must equal the envelope inputId.
   */
  acceptInput(input: unknown, inputId: string): IngressAcceptOutcome {
    // Host-owned validation: a poisoned envelope is rejected BEFORE it can
    // ever become a durable `accepted` record.
    const validated = validateAgentInput(input);
    if (validated.inputId !== inputId) {
      throw new AgentInputValidationError(
        "input_invalid",
        `transport inputId '${inputId}' does not match envelope inputId '${validated.inputId}'`,
      );
    }
    try {
      const outcome = this.ingress.accept(validated, validated.inputId, this.instanceEpoch);
      if (outcome.outcome === "accepted") {
        this.emit({
          type: "ingress_accepted",
          inputId: validated.inputId,
          instanceEpoch: outcome.record.instanceEpoch,
          state: outcome.record.state,
        });
      }
      this.wake.notify();
      return outcome;
    } catch (error) {
      if (error instanceof IngressQueueFullError || error instanceof IngressConflictError) {
        throw error;
      }
      throw error;
    }
  }

  /** Explicit rollover request (admin). Switch happens only after native settled. */
  requestRollover(reason: string): void {
    this.epochStore.requestRollover(reason);
    this.wake.notify();
  }

  /** Precise abort forwarded to the current invocation (waits for settled). */
  async abort(invocationId: string): Promise<void> {
    await this.coordinator.abort(invocationId);
  }

  /**
   * Mark the host ready AFTER startup + recovery complete. The HTTP transport
   * must not report ready before this call.
   */
  markReady(): void {
    if (this.shuttingDown) {
      throw new Error("cannot mark ready after shutdown started");
    }
    this.readyFlag = true;
  }

  /** Long-lived pump: auto-consumes the bounded FIFO and drives rollover. */
  run(): Promise<void> {
    if (this.pumpPromise !== null) {
      throw new Error("host pump already started");
    }
    this.markReady();
    this.pumpPromise = this.pumpLoop();
    return this.pumpPromise;
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (!this.shuttingDown) {
        // M2: a failed invocation enters not-ready; the pump keeps waiting for
        // operator recovery (recover()) instead of dying on the next input.
        if (this.failedFlag) {
          await this.wake.wait();
          continue;
        }
        // 1. If a rollover was requested AND a native-settled token exists for
        //    the current active Epoch, switch now. Without a token the pump
        //    must NOT block: it keeps consuming inputs so an in-flight input
        //    can settle and produce the token (A3).
        if (
          this.epochStore.isRolloverPending() &&
          this.settledTokenBox.value !== null &&
          this.settledTokenBox.value.epochId === this.epochStore.getActive()?.epochId
        ) {
          const switched = await this.maybeRolloverAfterSettled();
          if (switched) {
            continue;
          }
          // Token consumed or switch failed: fall through to input processing.
        }

        // 2. Consume one accepted input.
        const entry = this.ingress.dequeue();
        if (entry === undefined) {
          await this.wake.wait();
          continue;
        }

        // review-pass-6 #2: the verified load is the ONLY envelope read path
        // (raw-bytes ref hash/byteLength + canonical payload_hash all checked
        // by the ledger). A missing or tampered blob is a typed reject and is
        // dropped from the FIFO — never JSON.parse'd and delivered.
        const envelope = this.ingress.loadEnvelopeVerified(entry.inputId, entry.instanceEpoch);
        if (envelope === undefined) {
          this.ingress.markRejected(entry.inputId, entry.instanceEpoch, "envelope_integrity");
          this.emit({
            type: "failed",
            invocationId: `ingress-${entry.inputId}`,
            code: "envelope_integrity",
          });
          continue;
        }
        await this.runInvocation(entry.inputId, entry.instanceEpoch, envelope);
      }
    } catch (error) {
      // The pump must never die silently: record the failure, flip not-ready,
      // and re-raise so the caller (serve) surfaces it. Data remains durable.
      this.failedFlag = true;
      this.emit({ type: "failed", invocationId: "host-pump", code: "pump_error" });
      throw error;
    }
  }

  private async runInvocation(
    inputId: string,
    instanceEpoch: number,
    envelope: unknown,
  ): Promise<void> {
    const input = envelope as AgentInput;
    // The Coordinator reads the CURRENT active runtime from the registry, so
    // a rollover between queued inputs automatically routes the next input to
    // the fresh Capsule (03 Runtime Coordinator, Queued-input Provenance).
    try {
      // Consume the FULL generator: breaking early would return() the
      // Coordinator generator and skip its phase transition to idle, leaving
      // the single-writer latch held forever.
      let settled: (AgentRuntimeEvent & { type: "settled" }) | undefined;
      let failed = false;
      try {
        // iris_agent#99: production dispatch routes through the
        // RecoverySupervisor (bounded retry, fallback, watchdog,
        // outcome_unknown reconciliation) instead of calling the Coordinator
        // directly. The logical execution identity is stable across
        // rollover/restart (instanceEpoch + inputId); durable recovery state
        // is loaded BEFORE any dispatch and persisted after every transition.
        const logicalExecutionId = logicalExecutionIdFor(instanceEpoch, inputId);
        const initialState =
          this.recoveryStore.load(logicalExecutionId) ??
          freshRecoveryState(logicalExecutionId, new Date().toISOString());
        const events = this.supervisor.prompt(input, {
          logicalExecutionId,
          initialState,
          onStateChange: (snapshot) => {
            this.recoveryStore.save(snapshot);
          },
        });
        for await (const event of events) {
          this.emit(event);
          // iris_agent#99: a native `failed` event is an ATTEMPT failure —
          // the supervisor may escalate past it (same-model retry, fallback)
          // to a settled outcome. The invocation is failed only when the
          // supervisor generator throws (budget exhausted / terminal).
          if (event.type === "settled") {
            settled = event;
          }
        }
      } catch (error) {
        // M2: no native settled — a harness/encoding/provider error, or a
        // recovery escalation that exhausted its budget
        // (RecoveryExhaustedError). The input stays `accepted` in the ledger
        // (never committed) and is dropped from in-flight so a later client
        // retry (accept -> duplicate) or a restart recovery re-enters it
        // through the normal single-writer path. The Host flips not-ready and
        // the pump waits for operator recovery; the input is NOT auto-requeued
        // (a poisoned input must not loop forever).
        failed = true;
        this.failedFlag = true;
        this.ingress.dropInFlight(inputId, instanceEpoch);
        this.emit({
          type: "failed",
          invocationId: `invocation-${inputId}`,
          code: "invocation_error",
        });
        void error;
      }
      // After native settled: resolve the committed Pi input pair and mark
      // session_committed (never a synthetic repair).
      if (settled !== undefined && !failed) {
        const settledHandle = this.registry.getActiveRuntime();
        const pair = await (settledHandle.runtime as PiRuntimeAdapter).resolveCommittedPair();
        if (pair !== undefined) {
          this.ingress.markSessionCommitted(
            inputId,
            instanceEpoch,
            settledHandle.runtimeSessionId,
            pair.userEntryId,
          );
        }
      }
    } finally {
      this.wake.notify();
    }
  }

  /**
   * Operator recovery after a failed invocation (M2): resets the Coordinator
   * latch AND the Capsule adapter (both may be in a failed state after a
   * provider/encoding error), then clears the not-ready flag so the pump
   * resumes consuming the FIFO. The failed input stays durably `accepted`;
   * a client retry or restart recovery re-enters it.
   */
  recover(): void {
    if (!this.failedFlag) {
      return;
    }
    // review-pass-4 #2: fail-stop — after a rollover post-construction fault
    // the old Capsule may be disposed / registry inconsistent. recover() is
    // FORBIDDEN; only restart recovery is allowed.
    if (this.failStop) {
      throw new Error(
        "cannot recover a fail-stop host (rollover fault left inconsistent runtime state); restart required",
      );
    }
    this.coordinator.reset();
    // review-pass-2 #3: a failed invocation must not leave a stale settled
    // token that a later rollover request could mis-consume.
    this.settledTokenBox.value = null;
    const handle = this.registry.getActiveOrNull();
    if (handle !== null) {
      const runtime = handle.runtime;
      if (runtime instanceof PiRuntimeAdapter) {
        runtime.reset();
      }
    }
    this.failedFlag = false;
    this.wake.notify();
  }

  /**
   * review-pass-3 #3 / review-pass-4 #2 / review-pass-5 #3: fault-injection
   * seam (TESTS ONLY) — SIMULATES a real post-construction rollover failure.
   * fail-stop is NOT set here; it is set by the real catch inside
   * maybeRolloverAfterSettled() so production exceptions behave identically.
   */
  private faultPoint: "dispose_old" | "activate_rollover" | "cas_swap" | "construct_new" | null =
    null;
  private failStop = false;
  _setFaultPoint(
    point: "dispose_old" | "activate_rollover" | "cas_swap" | "construct_new" | null,
  ): void {
    this.faultPoint = point;
  }
  isFailStop(): boolean {
    return this.failStop;
  }

  /**
   * Settled-only rollover (02 Runtime Sessions, Rollover Boundary): old
   * Session frozen after native settled, new empty Pi Session created, fresh
   * Harness constructed, then the Epoch + active runtime handle CAS together.
   * The settled authorization comes from the Coordinator observing Pi native
   * settled on the CURRENT active Epoch — never from a caller-supplied string.
   */
  private async maybeRolloverAfterSettled(): Promise<boolean> {
    if (this.coordinator.getPhase() !== "idle") {
      return false;
    }
    const active = this.epochStore.getActive();
    if (active === null) {
      throw new Error("cannot rollover without an active epoch");
    }
    // A3 (审查 #3): a rollover requires a ONE-TIME native-settled
    // authorization produced by the Coordinator when Pi settled on THIS
    // active Epoch. `idle` alone is NOT authorization (a freshly started or
    // recovered Host is also idle). Consume the token exactly once.
    if (this.settledTokenBox.value?.epochId !== active.epochId) {
      return false;
    }
    const token = this.settledTokenBox.value;
    this.settledTokenBox.value = null; // consume
    void token.invocationId;
    // The registry must point at the same active Epoch whose invocation
    // reached settled.
    const handle = this.registry.getActiveRuntime();
    if (handle.epochId !== active.epochId) {
      this.settledTokenBox.value = null;
      throw new Error(
        `rollover refused: registry epoch ${handle.epochId} does not match active epoch ${active.epochId}`,
      );
    }

    const now = new Date().toISOString();
    const pending = this.epochStore.beginRollover(now);

    // review-pass-2 #4: staged Capsule construction — build the ENTIRE new
    // Capsule (new Session + fresh Harness + adapter) BEFORE touching the old
    // one. If any step fails, only the new resources need cleanup and the old
    // Capsule stays fully serviceable (not-ready only on real corruption).
    let newSession: Session | undefined;
    let nextHandle: ActiveRuntimeHandle | undefined;
    let newSessionHandle: Awaited<ReturnType<typeof openOrCreateSession>> | undefined;
    try {
      // Create the empty new Pi Session (a REAL row, not a missing one).
      newSessionHandle = await openOrCreateSession(
        this.dataRoot,
        this.config,
        pending.runtimeSessionId,
      );
      newSession = newSessionHandle.session;
      if (this.faultPoint === "construct_new") {
        throw new Error("fault-injected: new Capsule construction failure");
      }

      // Construct a fresh Harness + fresh Context lineage for the new Session.
      const { models, model, providerProfileId } = await composeProvider(this.providerMode);
      const binding: InvocationBinding = {
        input: emptyPlaceholderInput(),
        prepared: prepareContextSources(
          emptyPlaceholderInput(),
          pending.runtimeSessionId,
          pending.epochId,
          this.config,
          now,
        ),
        invocationId: `invocation-${pending.runtimeSessionId}`,
      };
      const { harness } = createIrisHarness({
        session: newSession,
        // review-pass-7 #2 (subagent-review fix): the companion's pairKey
        // must bind the Host's STABLE instanceEpoch (dedupe namespace),
        // NOT the Runtime Session Epoch ordinal — the ordinal increments on
        // every rollover and would make the pair unverifiable on restart.
        instanceEpoch: this.instanceEpoch,
        models,
        model,
        tools: [makeReadOnlyTestTool()],
        currentInvocation: binding,
        now,
        providerProfileId,
      });
      const adapter = new PiRuntimeAdapter({
        harness,
        session: newSession,
        binding,
        repo: newSessionHandle.repo,
      });
      nextHandle = activeRuntimeHandle(pending, adapter, binding);
    } catch (error) {
      // New Capsule construction failed (review-pass-6 #5 / review-pass-7 #1):
      // this is a FAIL-STOP (restart-only). Roll back in a RE-ENTRANT-SAFE
      // order: (1) close the provisional handle, (2) idempotently delete the
      // provisional Session metadata, and ONLY AFTER IT SUCCEEDS (3) delete
      // the creating Epoch row. If the Session delete fails (or the process
      // dies between 2 and 3), the creating row is KEPT so the next startup
      // still knows the Session is an orphan — never delete the only durable
      // tracking row first.
      this.failStop = true;
      // 0.83.0+: Session has no storage accessor; the repo.delete below
      // (after the fail-stop order) is the complete removal path. Also
      // release the provisional Capsule's own repo connection (review: the
      // previous storage.cleanup() used to close it; the fail-stop path must
      // not leak an open SQLite handle).
      if (newSessionHandle !== undefined) {
        try {
          await newSessionHandle.repo[Symbol.asyncDispose]();
        } catch (cleanupError) {
          void cleanupError;
        }
      }
      let sessionDeleted = false;
      try {
        const paths = resolveDataRootPaths(this.dataRoot, this.config);
        const repo = new SqliteSessionRepository({
          env: nodeSqliteRepoEnv(this.dataRoot),
          sqlite: createNodeSqliteFactory(),
          databasePath: paths.sessionDb,
        });
        const list = await repo.list({ cwd: this.dataRoot });
        const metadata = list.find((candidate) => candidate.id === pending.runtimeSessionId);
        if (metadata !== undefined) {
          await repo.delete?.(metadata);
          sessionDeleted = true;
        }
      } catch (cleanupError) {
        // Session metadata delete failed: KEEP the creating row so a future
        // startup retries the orphan cleanup (recoverCreating is skipped).
        void cleanupError;
      }
      if (sessionDeleted) {
        try {
          this.epochStore.recoverCreating([pending.runtimeSessionId]);
        } catch (cleanupError) {
          void cleanupError;
        }
      }
      throw error;
    }

    // The new Capsule is fully ready. NOW freeze/dispose the old Capsule's
    // REAL Session (flushing pending writes) before the atomic activation.
    // review-pass-4 #2 / review-pass-5 #3: the ENTIRE post-construction
    // sequence (dispose old -> activate Epoch -> CAS swap) is wrapped so ANY
    // real exception — a dispose() that throws, activateRollover() that
    // throws, casSwap() returning false or throwing — deterministically flips
    // FAIL-STOP: the Host may have disposed the old Capsule or be left with a
    // DB/registry mismatch, so recover() is forbidden and only restart
    // recovery is allowed. The fault seam below only SIMULATES these real
    // failures; fail-stop is set by this catch, not by the test setter.
    try {
      if (this.faultPoint === "dispose_old") {
        throw new Error("fault-injected: old Capsule dispose failure");
      }
      const oldHandle = this.registry.getActiveOrNull();
      if (oldHandle !== null && oldHandle.runtime instanceof PiRuntimeAdapter) {
        await oldHandle.runtime.dispose();
      }

      // Atomic activation: Epoch CAS first, then the registry swap. A crash
      // between them leaves the DB new-active with a real Session row; the next
      // startup rebuilds the harness from the DB (never a stale registry).
      if (nextHandle === undefined) {
        throw new Error("rollover internal error: new Capsule was not constructed");
      }
      if (this.faultPoint === "activate_rollover") {
        throw new Error("fault-injected: epoch activation failure");
      }
      const nextEpoch = this.epochStore.activateRollover(now);
      if (this.faultPoint === "cas_swap") {
        throw new Error("fault-injected: registry swap failure");
      }
      const swapped = this.registry.casSwap(active.epochId, nextHandle);
      if (!swapped) {
        throw new Error(`rollover CAS lost race for epoch ${active.epochId}`);
      }
      this.currentEpoch = nextEpoch;
      this.emit({
        type: "rollover_completed",
        epochId: nextEpoch.epochId,
        runtimeSessionId: nextEpoch.runtimeSessionId,
        settledEpochId: active.epochId,
      });
      return true;
    } catch (error) {
      // REAL fail-stop (review-pass-5 #3 / review-pass-6 #5): any
      // post-construction rollover failure leaves the runtime
      // possibly-inconsistent — never allow recover() to resume it. Also
      // dispose the PROVISIONAL new Capsule (constructed but not yet
      // registered/activated) so its Session storage is released regardless
      // of which window faulted.
      this.failStop = true;
      if (nextHandle !== undefined && nextHandle.runtime instanceof PiRuntimeAdapter) {
        try {
          await nextHandle.runtime.dispose();
        } catch (cleanupError) {
          void cleanupError;
        }
      }
      throw error;
    }
  }

  /**
   * A4 (审查 #4): dispose the CURRENT active Capsule's Session on shutdown.
   */
  private async disposeActiveCapsule(): Promise<void> {
    const handle = this.registry.getActiveOrNull();
    if (handle !== null && handle.runtime instanceof PiRuntimeAdapter) {
      await handle.runtime.dispose();
    }
  }

  /**
   * Graceful shutdown (C1/M3): mark not-ready, reject new inputs, abort any
   * active invocation and WAIT for the Pi native settled boundary, then wait
   * for the pump to fully exit (so the last markSessionCommitted has flushed),
   * and only then close Session/Epoch DB/ledger and release the lock. Every
   * cleanup failure is collected; the lock is ALWAYS released last.
   */
  async shutdown(timeoutMs = 15000): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.readyFlag = false;
    this.wake.notify();

    let firstError: unknown;
    try {
      // A7 (审查 #7): stop accepting clients FIRST (reject new inputs and
      // close SSE connections) before draining the runtime, so no request can
      // be served once the lock is about to be released.
      if (this.transportClose !== null) {
        await this.transportClose();
      }
    } catch (error) {
      firstError ??= error;
    }
    try {
      // Abort the active invocation and wait for native settled, so the turn
      // completes BEFORE we close the ledger (C1: never close the DB under a
      // live invocation that still needs to mark session_committed).
      await this.coordinator.abortActive(timeoutMs);
    } catch (error) {
      firstError ??= error;
    }
    try {
      // Wait for the pump to exit: the current turn (if any) finishes, its
      // session_committed flush completes, and only then we close resources.
      if (this.pumpPromise !== null) {
        await withTimeoutHost(this.pumpPromise, timeoutMs);
      }
    } catch (error) {
      firstError ??= error;
    }
    try {
      // A4 (审查 #4): dispose the active Capsule's REAL Session (flush writes,
      // release Pi SQLite/storage) before closing the ledger/store.
      await this.disposeActiveCapsule();
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.ingress.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      // iris_agent#99: recovery state is durable — flush/close the SQLite
      // store after the pump drain so no transition is lost mid-write.
      this.recoveryStore.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.epochStore.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      await this.lock.release();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      const message = firstError instanceof Error ? firstError.message : JSON.stringify(firstError);
      throw new Error(message);
    }
  }

  /**
   * Startup composition + recovery. Returns a fully-constructed host that has
   * NOT yet reported ready (the caller starts the transport first).
   */
  static async open(options: IrisHostOptions): Promise<IrisHost> {
    const config = options.config ?? defaultAgentConfig();
    const paths = resolveDataRootPaths(options.dataRoot, config);
    const lock: DataRootLockHandle = await acquireDataRootLock(options.dataRoot, paths.lockFile);

    let epochStore: RuntimeEpochStore | undefined;
    let ingress: InputAcceptanceLedger | undefined;
    let recoveryStore: RecoveryStateStore | undefined;
    /** review-pass-2 #4: the Session opened before Capsule construction, so a
     * failed startup can dispose it (it is not yet owned by an adapter). */
    let openedRepo: SqliteSessionRepository | undefined;
    try {
      initializeDataRoot(options.dataRoot, config);
      epochStore = new RuntimeEpochStore(
        paths.epochRegistryDb,
        config.runtime_sessions.session_id_prefix,
        config.runtime_sessions.timezone,
      );

      // Re-entrant startup recovery (see openHost in composition.ts).
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

      // A5 / review-pass-2 #2: Session selection must be decided BEFORE any
      // reconciliation touches the Session store.
      //  - no active Epoch (fresh data root OR only archived epochs): create a
      //    new active Epoch + its fresh Session.
      //  - an active Epoch exists: open its EXACT Pi Session; a missing
      //    Session is not-ready/corrupt — never silently create an empty one
      //    that masquerades as the lost history.
      const hasActiveEpoch = epochStore.getActive() !== null;
      const epoch = epochStore.ensureActive(new Date().toISOString());
      const instanceEpoch = options.instanceEpoch ?? HOST_INSTANCE_EPOCH;
      const sessionHandle = hasActiveEpoch
        ? await openActiveSession(options.dataRoot, config, epoch.runtimeSessionId)
        : await openOrCreateSession(options.dataRoot, config, epoch.runtimeSessionId);
      const session = sessionHandle.session;
      openedRepo = sessionHandle.repo;
      // Narrowed local for closures (TS cannot narrow the outer let).
      const readyRepo = sessionHandle.repo;

      // Recover accepted-but-uncommitted inputs into the FIFO (durable
      // ingress), reconciled against the VERIFIED active Session.
      ingress = InputAcceptanceLedger.open(options.dataRoot, config, instanceEpoch);
      // A1 / review-pass-2 #1: classify each accepted record — verified full
      // pair -> session_committed (never re-prompt); no Pi append -> normal
      // delivery; partial/mismatched -> fail closed (rejected).
      const pending = ingress.recoverUncommitted();
      if (pending.length > 0) {
        const { ambiguous } = await reconcileUncommitted(
          pending,
          epoch.runtimeSessionId,
          session,
          ingress,
          instanceEpoch,
        );
        // review-pass-4 #1: ambiguous recovery means an orphan UserMessage is
        // claimed by multiple pending identities — the Host cannot uniquely
        // attribute it and must NOT guess or batch-reject. Fail closed into
        // not-ready/corrupt so an operator reviews the data root instead of
        // silently dropping or duplicating logical inputs.
        if (ambiguous.length > 0) {
          throw new Error(
            `ambiguous ingress recovery for inputs: ${ambiguous.join(", ")} — ` +
              "orphan UserMessage wire claimed by multiple pending identities (not-ready)",
          );
        }
      }

      const { models, model, providerProfileId } = await composeProvider(
        options.provider,
        undefined,
        options.mockProviderError,
      );

      const binding: InvocationBinding = {
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
        // instanceEpoch, not the session ordinal (rollover-safe).
        instanceEpoch: instanceEpoch,
        models,
        model,
        tools: [makeReadOnlyTestTool()],
        currentInvocation: binding,
        now: new Date().toISOString(),
        providerProfileId,
      });
      const adapter = new PiRuntimeAdapter({ harness, session, binding, repo: readyRepo });
      const registry = new ActiveRuntimeRegistry();
      registry.install(activeRuntimeHandle(epoch, adapter, binding));

      // A3 (审查 #3): the settled-authorization box is shared between the
      // Coordinator callback (writes) and the Host rollover (reads/consumes).
      const settledTokenBox: { value: { epochId: string; invocationId: string } | null } = {
        value: null,
      };
      // iris_agent#89: production model override port — lets the Recovery
      // Supervisor resolve and apply fallback models through the real
      // PiRuntimeAdapter (harness.setModel()), not a test-injected dispatcher.
      // Without this port, promptWithModel fails closed on every fallback.
      // iris_agent#107: production model override must use qualified
      // provider/model identity (resolveFallbackModel) — bare model.id +
      // .find() is ambiguous when duplicate IDs exist across providers.
      // applyModelOverride routes through the CURRENT active Capsule via the
      // ActiveRuntimeRegistry, not a stale startup adapter closure.
      const modelOverride: ModelOverridePort = {
        resolveModel(modelId: string) {
          // #107: use the qualified resolver that rejects duplicates
          return resolveFallbackModel(models.getModels() as Model<string>[], modelId);
        },
        async applyModelOverride(modelToApply) {
          // #107: route through the CURRENT active runtime, not the stale
          // startup adapter — after rollover, only the new Capsule should
          // receive model overrides.
          const activeHandle = registry.getActiveOrNull();
          if (activeHandle === null) {
            throw new Error("cannot apply model override: no active runtime capsule");
          }
          const activeAdapter = activeHandle.runtime as PiRuntimeAdapter;
          await activeAdapter.setModel(modelToApply as Model<string>);
        },
        getActiveModelId() {
          // #107: reflect the CURRENT active runtime's model, not a startup
          // constant — after fallback or rollover, this changes.
          const activeHandle = registry.getActiveOrNull();
          if (activeHandle === null) {
            return model?.id;
          }
          // The active adapter knows its current model
          const activeAdapter = activeHandle.runtime as PiRuntimeAdapter;
          return activeAdapter.getCurrentModelId?.() ?? model?.id;
        },
      };
      const coordinator = new RuntimeCoordinator({
        activeRuntime: registry,
        modelOverride,
        prepareInvocation: async (input: AgentInput, runtimeSessionId: string, epochId: string) =>
          prepareContextSources(input, runtimeSessionId, epochId, config, new Date().toISOString()),
        maxQueuedInputs: config.host.input_queue_max ?? 20,
        // A3: consume the ONE-TIME native-settled authorization. Every
        // invocation that observes Pi native settled on the active Epoch
        // records a token bound to (epochId, invocationId); rollover may only
        // fire when such a token exists for the CURRENT active Epoch and is
        // consumed exactly once.
        onSettledBoundary: (info) => {
          settledTokenBox.value = { epochId: info.epochId, invocationId: info.invocationId };
        },
        // review-pass-2 #3: a new invocation invalidates any stale token from
        // a previous invocation (e.g. a success followed by a failure).
        onInvocationStart: () => {
          settledTokenBox.value = null;
        },
      });

      const readyEpochStore = epochStore;
      const readyIngress = ingress;
      // iris_agent#99: the RecoverySupervisor owns the production dispatch
      // path — it wraps the Coordinator and enforces bounded retry, provider
      // fallback, watchdog and outcome_unknown reconciliation with DURABLE
      // state (recovery-state.db in the data root).
      recoveryStore = new RecoveryStateStore(join(paths.dataRoot, "recovery-state.db"));
      const readyRecoveryStore = recoveryStore;
      const resolutionStore = new DurableOutcomeResolutionStore(
        join(paths.dataRoot, "recovery-state.db"),
      );
      const supervisor = new RecoverySupervisor({
        runtime: coordinator,
        config: defaultFallbackConfig(models.getModels().map((m) => `${m.provider}/${m.id}`)),
        resolutionStore,
        // iris_agent#111: operation-specific reconciliation seam.
        // When the caller provides an outcomeReconciler, the supervisor
        // dispatches to it with the logical execution identity, input
        // identity, and dispatch identity from the pending outcome_unknown
        // record. The reconciler queries each affected subsystem's durable
        // authority (provider dispatch status, tool idempotency receipt,
        // Memory Publication acceptance, Body adapter receipt) and returns
        // confirmed_applied / replay_safe / ambiguous.
        //
        // iris_agent#107: ingress session_committed MUST NOT be accepted
        // as provider/effect outcome proof — it only proves user input
        // entered Pi Session.
        reconcileOutcomeUnknown: options.outcomeReconciler
          ? async (signal) => {
              return (
                options.outcomeReconciler as (s: {
                  logicalExecutionId: string;
                  inputId: string;
                  dispatchId: string;
                }) => Promise<"confirmed_applied" | "replay_safe" | "ambiguous">
              )({
                logicalExecutionId: signal.logicalExecutionId ?? "unknown",
                inputId: signal.inputId ?? "unknown",
                dispatchId: signal.dispatchId ?? "unknown",
              });
            }
          : async () => {
              // No operation-specific reconciler configured: always fail
              // closed (zero replay across restarts).
              return "ambiguous" as const;
            },
      });

      // Round 7 (#118/#125): reconcile durable pendingOutcomeUnknown that can
      // NEVER reach the dispatch path again. The crash window persists
      // pending FIRST, then appends the Pi pair; when a pending record's
      // input already has a verified Pi pair, ingress classification marks it
      // session_committed and the supervisor would never reconcile it. Those
      // are reconciled here, BEFORE the pump starts. Pending records WITHOUT
      // a session pair are left to the dispatch path (reconcile-before-dispatch
      // in the supervisor) so host open alone never consumes them.
      //   confirmed_applied → durable resolution + session_committed (zero
      //                       replay, zero re-query on later restarts)
      //   replay_safe      → pending cleared; normal dispatch replays with
      //                       the same logical execution identity
      //   ambiguous        → exhausted persisted (fail closed); the input is
      //                       session_committed so it never dispatches again
      const pendingExecutions = readyRecoveryStore.listWithPendingOutcomeUnknown();
      if (pendingExecutions.length > 0) {
        const entries = await session.getEntries();
        const projected = projectSessionMessages(entries);
        const pairs = findInputPairsByProjection(projected);
        const pairByInputId = new Map<string, string>();
        for (const pair of pairs) {
          const details = (pair.companion.message.details ?? {}) as {
            iris?: { inputId?: string };
          };
          const inputId = details.iris?.inputId;
          if (typeof inputId === "string" && inputId !== "") {
            pairByInputId.set(inputId, pair.user.entryId);
          }
        }
        for (const snapshot of pendingExecutions) {
          const pendingInputId = snapshot.pendingOutcomeUnknown?.inputId;
          if (pendingInputId === undefined) {
            continue;
          }
          if (!pairByInputId.has(pendingInputId)) {
            // No Pi pair yet — the dispatch path will reconcile before any
            // provider dispatch (supervisor prompt entry).
            continue;
          }
          const disposition = await supervisor.reconcilePendingOnStartup(snapshot);
          const updated = supervisor.getState();
          if (updated !== null) {
            readyRecoveryStore.save(updated);
          }
          if (disposition === "ambiguous") {
            // Fail closed: exhausted persisted, zero replay. The input is
            // session_committed below so it never dispatches again.
          }
          // Effects confirmed applied (or ambiguous): the input must never be
          // re-prompted — it is already bound to its Pi pair.
          const userEntryId = pairByInputId.get(pendingInputId);
          if (userEntryId !== undefined) {
            ingress.markSessionCommitted(
              pendingInputId,
              instanceEpoch,
              epoch.runtimeSessionId,
              userEntryId,
            );
          }
        }
      }

      return new IrisHost({
        dataRoot: options.dataRoot,
        config,
        provider: options.provider,
        lock,
        epochStore: readyEpochStore,
        ingress: readyIngress,
        registry,
        coordinator,
        supervisor,
        recoveryStore: readyRecoveryStore,
        currentEpoch: epoch,
        instanceEpoch,
        settledTokenBox,
        ...(options.mockProviderError === undefined
          ? {}
          : { mockProviderError: options.mockProviderError }),
      });
    } catch (error) {
      // Setup failed partway (review-pass-2 #4): release every acquired
      // resource — including a Session already opened but not yet wrapped in
      // a Capsule — preserving the original error and NEVER leaking the lock.
      let firstError: unknown = error;
      if (openedRepo !== undefined) {
        try {
          // 0.83.0+: release the opened Session's connection via repo dispose.
          await openedRepo[Symbol.asyncDispose]();
        } catch (cleanupError) {
          firstError ??= cleanupError;
        }
      }
      try {
        ingress?.close();
      } catch (cleanupError) {
        firstError ??= cleanupError;
      }
      try {
        recoveryStore?.close();
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
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }
}

/**
 * A1 / review-pass-2 #1: reconcile accepted-but-uncommitted ingress records
 * against the ACTIVE Pi Session on startup. Recovery is classified into
 * exactly three states:
 *
 *   verified full pair  -> the input's complete UserMessage + iris_input_meta
 *                          companion already exists -> promote to
 *                          session_committed (NEVER re-prompt);
 *   no Pi append        -> no matching UserMessage exists -> keep the input
 *                          durable-accepted for the normal single-writer
 *                          delivery path (safe re-prompt);
 *   partial/mismatched  -> a matching UserMessage exists WITHOUT a verified
 *                          companion, or the pair is corrupt/misaligned ->
 *                          fail closed (mark rejected, never re-prompt and
 *                          never synthesize a companion).
 */
/**
 * A1 / review-pass-2 #1 / review-pass-3 #1 / review-pass-4 #1 / review-pass-5:
 * reconcile accepted-but-uncommitted ingress records against the ACTIVE Pi
 * Session on startup, in an IDENTITY-SAFE way. Classification:
 *
 *   verified full pair  -> a companion whose inputId AND pairKey both equal
 *                          the pending identity (pairKey =
 *                          derivePairKey(inputId, envelopeFrames)) exists as
 *                          an adjacent pair AND its per-block metadata
 *                          (blockId/order/sourceOrigin/sourceContentHash/
 *                          wireContentHash/originalPayloadRef) EXACTLY match
 *                          the layout recomputed from the current pending
 *                          envelope, and the ingress blob bytes hash to the
 *                          ledger payload_hash. Promoted to
 *                          session_committed, NEVER re-prompted.
 *   no Pi append        -> no ORPHAN UserMessage carries this pending
 *                          identity's canonical wire -> keep durable-accepted
 *                          for normal single-writer delivery.
 *   ambiguous recovery  -> an orphan UserMessage carries this pending
 *                          identity's wire, OR a duplicate (inputId,pairKey)
 *                          verified pair exists (duplicate logical input /
 *                          local corruption). A wire match alone proves only
 *                          content equality, NEVER identity (an orphan has
 *                          no inputId); the Host fails closed into
 *                          not-ready for operator review instead of
 *                          permanently rejecting a 202-accepted input.
 *
 * Two inputs with the SAME body are never conflated: pairKey embeds inputId
 * and wire equality alone never decides identity.
 */
async function reconcileUncommitted(
  pending: Array<{ inputId: string; instanceEpoch: number }>,
  runtimeSessionId: string,
  session: Session,
  ingress: InputAcceptanceLedger,
  currentInstanceEpoch: number,
): Promise<{ ambiguous: string[] }> {
  // Separator for the (instanceEpoch, inputId, pairKey) composite identity.
  // review-pass-6 #4: ingress identity is (instanceEpoch, inputId) — the
  // composite is carried through every key so two instanceEpochs with the
  // same inputId can never collide.
  const D = String.fromCharCode(0);
  const entries = await session.getEntries();
  // iris_agent#6: build an identity-preserving projection DIRECTLY from the
  // raw entries. Never compress to AgentMessage[] and then map a filtered
  // index back into the raw array — Pi sessions contain many non-message
  // entry types (model_change, active_tools_change, compaction, label, ...)
  // so a compressed position is NOT a raw index.
  const projected = projectSessionMessages(entries);
  const pairs = findInputPairsByProjection(projected);

  // 1. Verified pairs indexed by (inputId, pairKey). A duplicate key means
  //    the same logical input was appended TWICE (duplicate logical input /
  //    local corruption) — never silently overwrite; flag it.
  const verifiedPairs = new Map<
    string,
    { userEntryId: string; userWire: string; details: IrisInputMetaDetails }
  >();
  const duplicateIdentities: string[] = [];
  for (const pair of pairs) {
    const details = (pair.companion.message.details ?? {}) as IrisInputMetaDetails;
    const iris = details.iris;
    const inputId = iris?.inputId;
    if (typeof inputId !== "string" || inputId === "" || iris === undefined) {
      continue;
    }
    let frames: InputFrame[];
    try {
      frames = decodeInputFrames(
        Array.isArray(pair.user.message.content)
          ? pair.user.message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n")
          : pair.user.message.content,
      );
    } catch {
      continue; // not an IRIS_INPUT frame — unverifiable
    }
    // review-pass-7 #2: the pair is durable-bound to the instanceEpoch it was
    // created under. A companion WITHOUT instanceEpoch (legacy data) or with a
    // DIFFERENT instanceEpoch cannot be verified for the current namespace —
    // it is not added, so it can never promote this epoch's accepted record.
    if (typeof iris.instanceEpoch !== "number" || iris.instanceEpoch !== currentInstanceEpoch) {
      continue;
    }
    const expectedPairKey = derivePairKey(inputId, frames, currentInstanceEpoch);
    if (typeof iris.pairKey !== "string" || iris.pairKey !== expectedPairKey) {
      continue; // pairKey mismatch — NOT a verified pair
    }
    if (!verifyCompanionLayoutHash(details)) {
      continue; // layout hash self-inconsistent — NOT a verified pair
    }
    // iris_agent#6: the REAL raw entry id comes from the projection (which
    // preserved entry.id from the raw SessionTreeEntry). It is never inferred
    // from a position in a compressed message array.
    const userEntryId = pair.user.entryId;
    if (userEntryId === "") {
      continue;
    }
    // review-pass-6 #4: composite (instanceEpoch, inputId, pairKey) key. The
    // Pi companion has no instanceEpoch, so the pair is bound to the CURRENT
    // Host instanceEpoch namespace (dedupe identity dimension).
    const key = `${currentInstanceEpoch}${D}${inputId}${D}${iris.pairKey}`;
    if (verifiedPairs.has(key)) {
      duplicateIdentities.push(inputId);
      continue; // duplicate logical input — never silently choose one
    }
    verifiedPairs.set(key, {
      userEntryId,
      userWire: encodeInputFramesFromFrames(frames),
      details,
    });
  }

  // 2. Per-pending identity from the VERIFIED envelope (blob bytes checked
  //    against the ledger payload_hash — never trust JSON.parse alone).
  const pendingIdentity = new Map<
    string,
    { wire: string; expectedPairKey: string; envelope: AgentInput }
  >();
  for (const entry of pending) {
    const envelope = ingress.loadEnvelopeVerified(entry.inputId, entry.instanceEpoch);
    if (envelope === undefined) {
      continue;
    }
    const validated = envelope as AgentInput;
    try {
      const wire = encodeInputFrames(validated.blocks);
      const frames = decodeInputFrames(wire);
      pendingIdentity.set(`${entry.instanceEpoch}${D}${entry.inputId}`, {
        wire,
        expectedPairKey: derivePairKey(entry.inputId, frames, entry.instanceEpoch),
        envelope: validated,
      });
    } catch {
      continue; // corrupt envelope — cannot derive identity
    }
  }

  // 3. Which UserMessages are consumed by a verified pair (NOT orphans)?
  const consumedUserEntries = new Set([...verifiedPairs.values()].map((v) => v.userEntryId));
  const orphanWires: Array<{ entryId: string; wire: string }> = [];
  for (const projectedUser of projected) {
    if (projectedUser.message.role !== "user") {
      continue;
    }
    if (consumedUserEntries.has(projectedUser.entryId)) {
      continue; // consumed by a verified pair — not an orphan
    }
    const raw = Array.isArray(projectedUser.message.content)
      ? projectedUser.message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
      : projectedUser.message.content;
    let frames: InputFrame[];
    try {
      frames = decodeInputFrames(raw);
    } catch {
      continue;
    }
    orphanWires.push({ entryId: projectedUser.entryId, wire: encodeInputFramesFromFrames(frames) });
  }

  // 4. Classify each pending input against ITS OWN identity. Records from a
  //    DIFFERENT instanceEpoch are explicitly archived (rejected) — they
  //    belong to a previous Host instance namespace and must not be conflated
  //    with the current one (review-pass-6 #4).
  const ambiguous = new Set<string>(duplicateIdentities);
  for (const entry of pending) {
    if (entry.instanceEpoch !== currentInstanceEpoch) {
      ingress.markRejected(entry.inputId, entry.instanceEpoch, "stale_instance_epoch");
      ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
      continue;
    }
    const identity = pendingIdentity.get(`${entry.instanceEpoch}${D}${entry.inputId}`);
    if (identity === undefined) {
      // Envelope unreadable/corrupt or blob hash mismatch — cannot prove
      // anything; keep accepted for the normal delivery path.
      ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
      continue;
    }
    // 4a. Verified full pair for THIS identity: companion inputId AND pairKey
    //     both match AND companion metadata EXACTLY matches the envelope
    //     layout (review-pass-5 #1 / review-pass-6 #3: full contract —
    //     top-level provenance + per-block fields + layout hash).
    const verified = verifiedPairs.get(
      `${currentInstanceEpoch}${D}${entry.inputId}${D}${identity.expectedPairKey}`,
    );
    if (verified?.userWire === identity.wire) {
      const frames = decodeInputFrames(identity.wire);
      if (companionMatchesEnvelope(verified.details, identity.envelope, frames, identity.wire)) {
        ingress.markSessionCommitted(
          entry.inputId,
          entry.instanceEpoch,
          runtimeSessionId,
          verified.userEntryId,
        );
        ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
        continue;
      }
      // review-pass-6 #1: a pair with THIS identity exists (same inputId +
      // pairKey + wire) but the companion does NOT match the current envelope
      // (provenance/block metadata drifted). The UserMessage is already in
      // the Session and was consumed by this verified pair, so it must NOT be
      // treated as "no Pi append" and re-prompted — that would append a
      // second logical input. Enter ambiguous/corrupt recovery.
      ambiguous.add(entry.inputId);
      ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
      continue;
    }
    // 4b. No verified pair. A matching ORPHAN wire proves only content
    //     equality — never identity (the orphan UserMessage carries no
    //     inputId). Enter ambiguous/manual recovery instead of permanently
    //     rejecting: a historical orphan from a different inputId with the
    //     same body must not deny delivery of a healthy pending input
    //     (review-pass-5 #2).
    const matchingOrphans = orphanWires.filter((u) => u.wire === identity.wire);
    ingress.dropInFlight(entry.inputId, entry.instanceEpoch);
    if (matchingOrphans.length > 0) {
      ambiguous.add(entry.inputId);
    }
  }
  return { ambiguous: [...ambiguous] };
}

/**
 * review-pass-5 #1 / review-pass-6 #3: exact companion <-> envelope
 * comparison. Recompute the expected per-block layout from the CURRENT
 * envelope and require EVERY companion field to match: top-level
 * schemaVersion/inputId/pairKey/triggerOrigin/entryOrigin/layoutVersion/
 * contentLayoutHash, and per-block blockId/order/contentKind/sourceOrigin/
 * sourceContentHash/wireContentHash/location(frameIndex/utf8ByteLength)/
 * originalPayloadRef. An inline block must NOT carry originalPayloadRef. A
 * companion that differs in ANY of these (same inputId+wire but different
 * provenance/trigger/layout metadata) is NOT a verified pair for the current
 * envelope.
 */
function companionMatchesEnvelope(
  details: IrisInputMetaDetails,
  envelope: AgentInput,
  frames: InputFrame[],
  wire: string,
): boolean {
  const iris = details.iris;
  if (iris === undefined || !Array.isArray(iris.blocks)) {
    return false;
  }
  // Top-level identity + provenance (review-pass-7 #3: triggerOrigin and
  // entryOrigin are MANDATORY full-contract fields — presence is checked
  // explicitly, never satisfied by a fallback origin).
  if (iris.schemaVersion !== 1) {
    return false;
  }
  if (iris.layoutVersion !== "iris_content_layout_v1") {
    return false;
  }
  if (iris.inputId !== envelope.inputId) {
    return false;
  }
  if (
    iris.triggerOrigin === undefined ||
    originHash(iris.triggerOrigin) !== originHash(envelope.triggerOrigin)
  ) {
    return false;
  }
  if (
    iris.entryOrigin === undefined ||
    originHash(iris.entryOrigin) !== originHash(envelope.triggerOrigin)
  ) {
    return false;
  }
  // 1. Layout hash must equal the hash recomputed from the CURRENT envelope.
  let expectedLayoutHash: string | undefined;
  try {
    expectedLayoutHash = computeContentLayoutHash(envelope, wire);
  } catch {
    return false;
  }
  if (typeof iris.contentLayoutHash !== "string" || iris.contentLayoutHash !== expectedLayoutHash) {
    return false;
  }
  // 2. Per-block exact match (blockId / order / kind / origins / hashes /
  //    location / ref; inline blocks must NOT carry a payload ref).
  if (iris.blocks.length !== envelope.blocks.length) {
    return false;
  }
  for (let i = 0; i < envelope.blocks.length; i += 1) {
    const companionBlock = iris.blocks[i];
    const envelopeBlock = envelope.blocks[i];
    const frame = frames[i];
    if (companionBlock === undefined || envelopeBlock === undefined || frame === undefined) {
      return false;
    }
    if (companionBlock.blockId !== envelopeBlock.blockId) {
      return false;
    }
    if (companionBlock.blockIndex !== i) {
      return false;
    }
    if (companionBlock.contentKind !== envelopeBlock.content.mode) {
      return false;
    }
    if (originHash(companionBlock.sourceOrigin) !== originHash(envelopeBlock.sourceOrigin)) {
      return false;
    }
    const expectedSourceContentHash =
      envelopeBlock.content.mode === "inline_text"
        ? envelopeBlock.contentHash
        : envelopeBlock.content.ref.hash;
    if (companionBlock.sourceContentHash !== expectedSourceContentHash) {
      return false;
    }
    const expectedWireHash = createHash("sha256").update(frame.payload, "utf8").digest("hex");
    if (companionBlock.wireContentHash !== expectedWireHash) {
      return false;
    }
    // location: text_frame with the block's own frame index + byte length.
    const location = companionBlock.location;
    if (location?.mode !== "text_frame") {
      return false;
    }
    if (location.frameIndex !== i) {
      return false;
    }
    if (location.utf8ByteLength !== frame.utf8ByteLength) {
      return false;
    }
    const mode = envelopeBlock.content.mode;
    if (mode === "external_ref" || mode === "image_ref") {
      const ref = envelopeBlock.content.ref;
      const original = companionBlock.originalPayloadRef;
      if (
        original?.schemaVersion !== ref.schemaVersion ||
        original.kind !== ref.kind ||
        original.hash !== ref.hash ||
        original.byteLength !== ref.byteLength ||
        original.uri !== ref.uri
      ) {
        return false;
      }
    } else if (companionBlock.originalPayloadRef !== undefined) {
      // inline block must not carry a payload ref (review-pass-6 #3).
      return false;
    }
  }
  return true;
}

async function openActiveSession(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<{ repo: SqliteSessionRepository; session: Session }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata === undefined) {
    throw new Error(
      `active epoch session is missing/corrupt: Pi Session '${runtimeSessionId}' not found (not-ready)`,
    );
  }
  return { repo, session: await repo.open(metadata) };
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

interface WakeSignal {
  notify(): void;
  wait(): Promise<void>;
}

function createWakeSignal(): WakeSignal {
  let resolveCurrent: (() => void) | undefined;
  return {
    notify() {
      const resolve = resolveCurrent;
      resolveCurrent = undefined;
      resolve?.();
    },
    wait() {
      if (resolveCurrent !== undefined) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
    },
  };
}

async function withTimeoutHost(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("host pump did not exit within timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
export type { ExternalizedPayloadRef, InputAcceptanceRecord };
