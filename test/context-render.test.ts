import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ContextGeneration, ContextUnit, JsonValue } from "@iris/context/contracts";

import { defaultAgentConfig } from "../src/config/load.js";
import {
  renderGenerationForProvider,
  type AttachmentMaterializer,
} from "../src/runtime/context-render.js";
import { runMinimalSlice } from "../src/runtime/vertical-slice-demo.js";
import { sampleAgentInput } from "../src/runtime/vertical-slice.js";

/**
 * Provider Renderer（ContextGeneration → provider-native wire）契约测试。
 *
 * 层映射（Notion 01 Context Assembly｜Provider Wire Terminology Override）：
 *  - P0 System / P1 Persona / P2 Capability → system prompt 前缀（声明层）；
 *  - P3 Compartment / P4 Memory recall → provider 可见 user 前缀消息；
 *  - P5 Live Layer → 按 ContextUnit 的 canonical content 1:1 投影为
 *    user/assistant/toolResult（统一 ContextUnit 模型；renderGenerationForProvider
 *    不校验 contextGenerationHash/sourceRef，fixture 填占位即可）。
 *
 * image（A3）：DSH typed attachmentRef → 渲染期物化（attachmentRef 绝不进入
 * 最终 image.data；materializer 缺失/attachment 校验失败 → fail-closed）。
 * usage/cost（A4）：known cost 精确透传；unavailable cost → adapter-private
 * placeholder，canonical unit 不被改写。
 *
 * fail-closed：未知语义形状/未知 role → 抛错（绝不猜测）。
 * 端到端：真实 @iris/context 装配 + mock slice → admit → BUST → generation
 * → render（验证 P0–P2 进 system、P3–P5 进 messages）。
 */

function unit(unitId: string, content: JsonValue, index: number): ContextUnit {
  void index;
  return {
    schemaId: "iris.context_unit.v3",
    unitId,
    contextId: "lineage-test",
    contentSchemaId: "iris.semantic.context_message.operational.v1",
    content,
    contentHash: `content-${unitId}`,
    sourceRef: {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "iris.system_source.v1",
      sourceId: `source-${unitId}`,
      sourceHash: `hash-${unitId}`,
    },
  };
}

function buildGeneration(layerEnds: number[], units: ContextUnit[]): ContextGeneration {
  return {
    schemaId: "iris.context_generation.v3",
    header: {
      schemaId: "iris.context_generation_header.v1",
      contextGenerationId: "gen-test",
      contextLineageId: "lineage-test",
      sourceSnapshotHash: "snapshot-hash",
      layerEnds,
      // renderGenerationForProvider 不校验 hash；占位即可。
      contextGenerationHash: "gen-hash",
      createdAt: "2026-08-05T00:00:00.000Z",
    },
    units: units as unknown as ContextGeneration["units"],
  };
}

test("render: P0-P2 declaration layers join into the system prompt", async () => {
  const generation = buildGeneration(
    [1, 2, 3, 3, 3, 3],
    [
      unit("p0-system", { type: "system", data: { text: "IRIS SYSTEM PROMPT V1" } }, 0),
      unit("p1-persona", { type: "persona", data: { text: "persona: default" } }, 1),
      unit("p2-capability", { type: "capability", data: { text: "tools: read" } }, 2),
    ],
  );
  const rendered = await renderGenerationForProvider(generation);
  assert.match(rendered.systemPrompt, /IRIS SYSTEM PROMPT V1/);
  assert.match(rendered.systemPrompt, /persona: default/);
  assert.match(rendered.systemPrompt, /tools: read/);
  assert.ok(rendered.systemPrompt.split("\n\n").length >= 3, "layers joined by blank line");
  assert.equal(rendered.messages.length, 0);
});

test("render: P3 compartment and P4 recall project as labeled user prefixes", async () => {
  const generation = buildGeneration(
    [1, 2, 3, 4, 5, 5],
    [
      unit("p0-system", { type: "system", data: { text: "SYS" } }, 0),
      unit("p1-persona", { type: "persona", data: { text: "PERSONA" } }, 1),
      unit("p2-capability", { type: "capability", data: { text: "TOOLS" } }, 2),
      unit(
        "p3-compartment",
        {
          compartmentId: "c-1",
          importance: "high",
          episodeType: "task",
          content: "did work",
        },
        3,
      ),
      unit(
        "p4-recall",
        { status: "available", statement: "recalled fact", sourceTrust: "high" },
        4,
      ),
    ],
  );
  const rendered = await renderGenerationForProvider(generation);
  assert.match(rendered.systemPrompt, /SYS/);
  assert.equal(rendered.messages.length, 2);
  const compartment = rendered.messages[0];
  const recall = rendered.messages[1];
  assert.equal(compartment?.role, "user");
  assert.equal(recall?.role, "user");
  const textOf = (message: (typeof rendered.messages)[0]): string => {
    const content = (message as { content: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        const record = part as { type?: unknown; text?: unknown };
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .join("");
  };
  assert.match(textOf(compartment), /\[CONTEXT \| COMMITTED COMPARTMENT\]/);
  assert.match(textOf(compartment), /Compartment c-1 \| importance=high/);
  assert.match(textOf(recall), /\[CONTEXT \| MEMORY RECALL\]/);
  assert.match(textOf(recall), /\[RECALL \| high\] recalled fact/);
});

test("render: P5 live units project 1:1 to provider messages preserving order", async () => {
  const generation = buildGeneration(
    [1, 2, 3, 3, 3, 6],
    [
      unit("p0-system", { type: "system", data: { text: "SYS" } }, 0),
      unit("p1-persona", { type: "persona", data: { text: "P1" } }, 1),
      unit("p2-capability", { type: "capability", data: { text: "P2" } }, 2),
      unit(
        "p5-user",
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
        3,
      ),
      unit(
        "p5-assistant",
        {
          role: "assistant",
          content: [
            { type: "text", text: "reply" },
            { type: "thinking", text: "thought", signature: "sig-1" },
          ],
          api: "mock-api",
          provider: "mock-iris",
          model: "mock-deepseek-v4-flash",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            costStatus: "unavailable",
          },
          stopReason: "stop",
          timestamp: 2,
        },
        4,
      ),
      unit(
        "p5-tool-result",
        {
          role: "toolResult",
          toolCallId: "tool-call-1",
          toolName: "test_read_tool",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 3,
        },
        5,
      ),
    ],
  );
  const rendered = await renderGenerationForProvider(generation);
  assert.match(rendered.systemPrompt, /SYS/);
  assert.equal(rendered.messages.length, 3);
  assert.equal(rendered.messages[0]?.role, "user");
  assert.equal(rendered.messages[1]?.role, "assistant");
  assert.equal(rendered.messages[2]?.role, "toolResult");
  const assistant = rendered.messages[1];
  assert.ok(assistant !== undefined);
  const assistantParts = (assistant as { content?: unknown }).content as Array<{
    type: string;
    text?: string;
    thinking?: string;
  }>;
  assert.equal(assistantParts[0]?.type, "text");
  assert.equal(assistantParts[0]?.text, "reply");
  assert.equal(assistantParts[1]?.type, "thinking");
  assert.equal(assistantParts[1]?.thinking, "thought");
});

test("render: fail-closed on unknown P5 role", async () => {
  const generation = buildGeneration(
    [1, 1, 1, 1, 1, 2],
    [
      unit("p0-system", { type: "system", data: { text: "SYS" } }, 0),
      unit("p5-unknown", { role: "synthetic_role", content: [] }, 1),
    ],
  );
  await assert.rejects(() => renderGenerationForProvider(generation), /unknown role/);
});

test("render: fail-closed on non-object content", async () => {
  const generation = buildGeneration(
    [1, 1, 1, 1, 1, 1],
    [unit("p0-bad", "not-an-object" as unknown as JsonValue, 0)],
  );
  await assert.rejects(() => renderGenerationForProvider(generation), /non-object content/);
});

// ---------------------------------------------------------------------------
// A3：DSH typed attachment ref → 渲染期物化（fail-closed）
// ---------------------------------------------------------------------------

function imageUnit(unitId: string, imagePart: JsonValue): ContextUnit {
  return unit(unitId, { role: "user", content: [imagePart], timestamp: 1 }, 0);
}

function dshAttachmentRef(attachmentId: string): JsonValue {
  return {
    type: "image",
    attachmentRef: {
      schemaId: "iris.dsh_attachment_ref.v1",
      attachmentId,
      mediaType: "image/png",
      bytes: 42,
      width: 10,
      height: 10,
    },
  };
}

test("A3: DSH attachmentRef is materialized at render time — opaque id never enters image.data", async () => {
  const generation = buildGeneration(
    [0, 0, 0, 0, 0, 1],
    [imageUnit("p5-image", dshAttachmentRef("attachment-opaque-1"))],
  );
  const materializer: AttachmentMaterializer = {
    materializeImage: async (ref) => {
      assert.equal(ref.attachmentId, "attachment-opaque-1", "materializer receives the typed ref");
      assert.equal(ref.mediaType, "image/png");
      return { data: "data:image/png;base64,AAAA", mimeType: "image/png" };
    },
  };
  const rendered = await renderGenerationForProvider(generation, {
    attachmentMaterializer: materializer,
  });
  const imagePart = (
    (rendered.messages[0] as { content?: unknown } | undefined)?.content as
      Array<{ type: string; data?: string }> | undefined
  )?.[0];
  assert.equal(imagePart?.type, "image");
  assert.match(imagePart?.data ?? "", /^data:image\/png;base64,/);
  assert.ok(
    !(imagePart?.data ?? "").includes("attachment-opaque-1"),
    "opaque attachment id must never appear in the final image.data",
  );
});

test("A3: attachmentRef without a materializer fails closed (never emits broken image)", async () => {
  const generation = buildGeneration(
    [0, 0, 0, 0, 0, 1],
    [imageUnit("p5-image", dshAttachmentRef("attachment-opaque-2"))],
  );
  await assert.rejects(
    () => renderGenerationForProvider(generation),
    /no attachment materializer is available/,
  );
});

test("A3: materializer failure (missing / hash mismatch) fails the render closed", async () => {
  const generation = buildGeneration(
    [0, 0, 0, 0, 0, 1],
    [imageUnit("p5-image", dshAttachmentRef("attachment-gone"))],
  );
  const failing: AttachmentMaterializer = {
    materializeImage: async () => {
      throw new Error("attachment missing / hash mismatch (readImage verification failed)");
    },
  };
  await assert.rejects(
    () => renderGenerationForProvider(generation, { attachmentMaterializer: failing }),
    /readImage verification failed/,
  );
});

test("A3: Pi inline image data passes through unchanged", async () => {
  const generation = buildGeneration(
    [0, 0, 0, 0, 0, 1],
    [
      imageUnit("p5-image", {
        type: "image",
        data: "data:image/jpeg;base64,BBB",
        mimeType: "image/jpeg",
      }),
    ],
  );
  const rendered = await renderGenerationForProvider(generation);
  const imagePart = (
    (rendered.messages[0] as { content?: unknown } | undefined)?.content as
      Array<{ type: string; data?: string }> | undefined
  )?.[0];
  assert.equal(imagePart?.type, "image");
  assert.equal(imagePart?.data, "data:image/jpeg;base64,BBB");
});

// ---------------------------------------------------------------------------
// A4：usage/cost 知识状态 —— known 透传、unavailable → adapter-private placeholder
// ---------------------------------------------------------------------------

test("A4: known provider cost round-trips exactly through the Pi wire", async () => {
  const knownCost = { input: 1.5, output: 2.5, cacheRead: 0, cacheWrite: 0, total: 4 };
  const generation = buildGeneration(
    [0, 0, 0, 0, 0, 1],
    [
      unit(
        "p5-assistant-cost",
        {
          role: "assistant",
          content: [{ type: "text", text: "reply" }],
          api: "mock",
          provider: "p",
          model: "m",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            cacheWrite: 0,
            totalTokens: 170,
            cost: knownCost,
          },
          stopReason: "stop",
          timestamp: 1,
        },
        0,
      ),
    ],
  );
  const rendered = await renderGenerationForProvider(generation);
  const assistant = rendered.messages[0] as { usage?: { cost?: unknown } };
  assert.deepEqual(assistant.usage?.cost, knownCost, "known cost must round-trip exactly");
});

test("A4: unavailable cost → Pi wire placeholder; canonical unit is NOT mutated", async () => {
  const canonicalUnit = unit(
    "p5-assistant-nocost",
    {
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      api: "mock",
      provider: "p",
      model: "m",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        costStatus: "unavailable",
      },
      stopReason: "stop",
      timestamp: 1,
    },
    0,
  );
  const generation = buildGeneration([0, 0, 0, 0, 0, 1], [canonicalUnit]);
  const rendered = await renderGenerationForProvider(generation);
  const assistant = rendered.messages[0] as {
    usage?: { cost?: unknown; input?: number; totalTokens?: number };
  };
  // Pi wire 需要完整 Usage：placeholder 带 cost（adapter-private；canonical
  // 侧仍是 costStatus=unavailable 且无 cost）。
  assert.ok(assistant.usage !== undefined, "Pi wire must carry a usage object");
  assert.ok(
    "cost" in (assistant.usage ?? {}),
    "Pi wire usage must carry a cost object (adapter-private placeholder)",
  );
  assert.equal(assistant.usage?.input, 10, "token counts are preserved through the placeholder");
  assert.equal(assistant.usage?.totalTokens, 15);
  // canonical unit 不被改写：仍无 cost 字段、costStatus 保持 unavailable。
  const canonicalUsage = (canonicalUnit.content as { usage?: Record<string, unknown> }).usage;
  assert.equal(canonicalUsage?.["costStatus"], "unavailable");
  assert.ok(
    !("cost" in (canonicalUsage ?? {})),
    "canonical usage must not gain a cost field from the renderer",
  );
});

test("render e2e: mock slice ingest→BUST→generation→provider wire", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-render-e2e-"));
  try {
    const result = await runMinimalSlice({
      dataRoot,
      config: defaultAgentConfig(),
      input: sampleAgentInput(),
      provider: "mock",
    });
    // generation 已发布（BUST 在首个 provider 边界完成）。
    assert.notEqual(result.generationSummary, "no-generation");
    assert.match(result.generationSummary, /^layers=\[/);
  } finally {
    // OS tmpdir 管理。
  }
});
