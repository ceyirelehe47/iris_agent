#!/usr/bin/env python3
"""Split vertical-slice.ts into production helpers + NOT PRODUCTION demo slice.

Round 7 (#123): the architecture gate must be based on real production
reachability. runMinimalSlice (test/dev vertical slice) imports
ContextRenderer (m0/m1, MIGRATION ONLY per Notion v27), which made the whole
file reachable from production Host through value imports of composeProvider
etc. Split: production helpers stay in vertical-slice.ts; the demo slice
moves to vertical-slice-demo.ts (NOT PRODUCTION, imported by tests only).
"""
import re

SRC = "src/runtime/vertical-slice.ts"
lines = open(SRC).read().split("\n")

# Line ranges (1-indexed, inclusive) of functions to KEEP in vertical-slice.ts
keep_ranges = [(2, 163), (199, 245), (246, 388), (524, 722)]
# 1-1 is the NOT PRODUCTION banner (removed), 164-198 ensureLineage,
# 389-523 runMinimalSlice move to demo.

kept = []
for start, end in keep_ranges:
    kept.extend(lines[start - 1 : end])

# Clean the import block: drop context-renderer import lines
out = []
skip_until = None
for i, line in enumerate(kept):
    if "from \"../context/context-renderer.js\"" in line:
        # skip the whole import specifier block (CONTEXT_* and ContextRenderer)
        continue
    out.append(line)

open(SRC, "w").write("\n".join(out).rstrip() + "\n")
print("vertical-slice.ts rewritten")

# --- Build vertical-slice-demo.ts ---
moved = lines[163:198] + lines[388:523]  # ensureLineage + runMinimalSlice
moved_text = "\n".join(moved)

# Imports needed by the moved functions (deduplicated with existing symbols)
demo = f"""// NOT PRODUCTION — Test/dev vertical slice. Imports context-renderer
// (MIGRATION ONLY per Notion v27). NOT imported by any production root; the
// architecture gate proves this file is unreachable from src/host + src/bin.
import {{ ContextRenderer }} from "../context/context-renderer.js";
import {{ ContextStore }} from "../context/context-store.js";
import {{ ContextIngest }} from "../context/context-ingest.js";
import {{ createContextHistoryReadPort }} from "../context/history-read-port.js";
import {{ RuntimeEventLedger }} from "./runtime-event-ledger.js";
import {{ attachRuntimeEventSeam }} from "./runtime-event-seam.js";
import {{ encodeInputFrames }} from "./companion.js";
import {{ createIrisHarness, type HarnessObservers, type IrisHarnessCallbacks }} from "./harness-factory.js";
import type {{ HistorianManager }} from "../historian/historian-manager.js";
import type {{ AgentInput }} from "../contracts/origin.js";
import type {{ AgentConfigV3 }} from "../config/schema.js";
import {{ defaultAgentConfig }} from "../config/load.js";
import {{ acquireDataRootLock }} from "../host/lock.js";
import {{ initializeDataRoot, resolveDataRootPaths }} from "../host/data-root.js";
import {{ RuntimeEpochStore }} from "./epoch-manager.js";
import {{
  composeProvider,
  deriveLineageId,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  sampleAgentInput,
  type SliceProviderMode,
  type VerticalSliceResult,
}} from "./vertical-slice.js";

{moved_text}
"""
open("src/runtime/vertical-slice-demo.ts", "w").write(demo)
print("vertical-slice-demo.ts written")
