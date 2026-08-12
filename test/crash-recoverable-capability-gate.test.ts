import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { Session } from "@iris/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";

/**
 * iris_agent#51 production capability gate: the Iris harness requires a
 * session storage with crash-recoverable commit receipts (the production lock
 * mandates the SQLite session repository). A session without the durability
 * capability must fail closed at harness construction.
 */

test("capability gate: the production SQLite session satisfies crash-recoverable receipts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-gate-ok-"));
  initializeDataRoot(dataRoot, defaultAgentConfig());
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive("2026-08-05T00:00:00.000Z");
  const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  try {
    const { models, model, providerProfileId } = await composeProvider("mock");
    const prepared = prepareContextSources(
      sampleAgentInput(),
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      "2026-08-05T00:00:00.000Z",
    );
    // Must NOT throw: SQLite journal is crash-recoverable.
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: { input: sampleAgentInput(), prepared, invocationId: "gate-test" },
      now: "2026-08-05T00:00:00.000Z",
      providerProfileId,
    });
    assert.ok(harness);
  } finally {
    epochStore.close();
    await closeSessionStorage(repo);
  }
});

test("capability gate: a session without the durability capability fails closed", () => {
  const withoutCapability = {
    supportsCrashRecoverableReceipts: () => false,
  } as unknown as Session;
  assert.throws(
    () =>
      createIrisHarness({
        session: withoutCapability,
        instanceEpoch: 1,
        models: undefined as never,
        model: undefined as never,
        tools: [],
        currentInvocation: undefined as never,
        now: "2026-08-05T00:00:00.000Z",
        providerProfileId: "test",
      }),
    /crash-recoverable commit receipts/,
  );
});
