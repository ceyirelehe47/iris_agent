import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";
import {
  deriveLineageId,
  rolloverActiveSession,
  
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";
import { ContextStore } from "../src/context/context-store.js";

/**
 * R2 (iris_agent#9) Exit Gate: rollover must NOT change Context.
 *
 * one Iris identity/data root → one durable Context lineage → many bounded
 * Pi Runtime Sessions. Normal rollover rotates only the Pi Session/Harness
 * archive segment; the same lineage (m0/m1/watermarks/replay state) survives.
 */

test("r2: rollover keeps the SAME context lineage and its materialized state", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-r2-rollover-lineage-"));
  const config = defaultAgentConfig();
  const now = "2026-08-05T00:00:00.000Z";

  const first = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  const paths = resolveDataRootPaths(dataRoot, config);

  // First session materializes m0 (HARD fold) through the slice. The lineage
  // id is derived from the data root (identity-level).
  const lineageId = deriveLineageId(dataRoot);
  const store = ContextStore.open(paths.contextDb, { lineageId });
  const lineageBefore = store.getLineageByLineageId(lineageId);
  assert.ok(lineageBefore !== undefined, "slice must create the identity lineage");
  assert.equal(lineageBefore.currentRuntimeSessionId, first.runtimeSessionId);
  const beforeUnits = store.listUnits(first.runtimeSessionId, { disposition: "all" }).length;
  assert.ok(beforeUnits >= 3, "slice must ingest semantic units");

  // Rollover: rotate only the Pi session.
  const rolled = await rolloverActiveSession({
    dataRoot,
    config,
    now,
    settledEpochId: first.epochId,
  });
  assert.notEqual(rolled.newSessionId, first.runtimeSessionId);

  // The SAME lineage row must survive rollover (no fresh lineage, no reset).
  const lineageAfter = store.getLineageByLineageId(lineageId);
  assert.ok(lineageAfter !== undefined, "lineage must survive rollover");
  assert.equal(
    lineageAfter.currentRuntimeSessionId,
    rolled.newSessionId,
    "rollover rebinds the lineage to the new session",
  );
  assert.equal(lineageAfter.m0Body, lineageBefore.m0Body, "rollover must preserve m0");
  assert.equal(
    lineageAfter.representedThroughContextSeq,
    lineageBefore.representedThroughContextSeq,
    "rollover must preserve the context watermark",
  );

  // Units continue in the SAME lineage with a global monotonic sequence.
  const afterUnits = store.listUnits(rolled.newSessionId, { disposition: "all" }).length;
  assert.ok(
    afterUnits >= beforeUnits,
    `units must not shrink across rollover (before=${beforeUnits}, after=${afterUnits})`,
  );
  const seqs = store
    .listUnits(rolled.newSessionId, { disposition: "all" })
    .map((unit) => unit.contextSeq);
  assert.equal(
    new Set(seqs).size,
    seqs.length,
    "contextSeq must remain globally monotonic across sessions (no reset)",
  );
  store.close();
});
