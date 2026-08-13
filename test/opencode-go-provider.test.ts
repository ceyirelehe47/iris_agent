import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import {
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_MODEL_ID,
  OPENCODE_GO_PROVIDER_ID,
  createOpenCodeGoProvider,
  openCodeGoApiKey,
} from "../src/runtime/opencode-go-provider.js";
import {
  reopenActiveSession,
  
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";

const ORIGINAL_KEY = process.env[OPENCODE_GO_API_KEY_ENV];

function clearApiKeyEnv(): void {
  if (process.env[OPENCODE_GO_API_KEY_ENV] !== undefined) {
    Reflect.deleteProperty(process.env, OPENCODE_GO_API_KEY_ENV);
  }
}

beforeEach(() => {
  if (ORIGINAL_KEY === undefined) {
    clearApiKeyEnv();
  } else {
    process.env[OPENCODE_GO_API_KEY_ENV] = ORIGINAL_KEY;
  }
});

test("provider seam resolves the pinned opencode-go deepseek-v4-flash model", async () => {
  process.env[OPENCODE_GO_API_KEY_ENV] = "sk-test-not-a-real-key";
  const { models, model } = await createOpenCodeGoProvider();
  assert.equal(model.provider, OPENCODE_GO_PROVIDER_ID);
  assert.equal(model.id, OPENCODE_GO_MODEL_ID);
  const resolved = await models.getAuth(OPENCODE_GO_PROVIDER_ID);
  assert.ok(resolved !== undefined);
});

test("provider seam reports missing api key as undefined", () => {
  clearApiKeyEnv();
  assert.equal(openCodeGoApiKey(), undefined);
});

test(
  "R1-P1 live vertical slice runs a real provider request",
  {
    skip:
      ORIGINAL_KEY === undefined
        ? "OPENCODE_GO_API_KEY not set; skipping live provider test"
        : false,
  },
  async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "iris-live-slice-"));
    const config = defaultAgentConfig();
    const input = sampleAgentInput();

    const result = await runMinimalSlice({ dataRoot, config, input, provider: "live" });

    assert.equal(result.observers.settled, true);
    assert.ok(result.observers.contextPasses >= 1);
    assert.equal(result.assistantMessage.role, "assistant");
    assert.equal(result.epochId.length > 0, true);
    assert.equal(result.runtimeSessionId.length > 0, true);
    assert.ok(result.entries.length >= 3);

    const text = result.assistantMessage.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    assert.ok(text.length > 0, "live assistant reply must contain text");
  },
);

test(
  "R1-P1 live vertical slice restarts into the same session",
  {
    skip:
      ORIGINAL_KEY === undefined
        ? "OPENCODE_GO_API_KEY not set; skipping live provider test"
        : false,
  },
  async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "iris-live-restart-"));
    const config = defaultAgentConfig();
    const input = sampleAgentInput();

    const first = await runMinimalSlice({ dataRoot, config, input, provider: "live" });
    const reopened = await reopenActiveSession({ dataRoot, config, input, provider: "live" });

    assert.equal(reopened.runtimeSessionId, first.runtimeSessionId);
    assert.equal(reopened.entries.length, first.entries.length);
  },
);
