/**
 * P0–P2 source contribution seam（@iris/context ContextSourceContributor）。
 *
 * iris_agent 是 Persona/System/Capability 权威 source 的 owner；BUST full
 * rebuild 时 @iris/context 的 BustCoordinator 调用 contributor.project() 冻结
 * 投影为 pre-projected ContextUnitV2（P0–P2）。本 seam 只提供 frozen
 * snapshot / identity / hash + invalidation，不允许直接 push/splice
 * generation（Notion Composition & Plugin Model v29）。
 *
 * 层定义（P0–P2）：
 *  - P0 System：canonical system prompt（不可变、确定性，同 invocation 内
 *    不重新渲染）；
 *  - P1 Persona：persona snapshot identity + 文本（当前最小 persona 声明）；
 *  - P2 Capability：tool/skill 稳定声明。
 *
 * 语义 schema：P0–P2 使用 generated registry 的
 * `iris.semantic.context_message.operational.v1`（已知 schema，非 escape
 * hatch）承载 `{ type, data }` 声明；Provider Renderer 按 type 提取渲染。
 * 不用 m0/m1/carrier/placeholder（已废止概念）。
 */
import { createHash } from "node:crypto";

import type { JsonValue } from "@iris/context/contracts";

/** 与 @iris/context bust-coordinator 的 ContextSourceContributor 结构兼容。 */
export interface IrisSourceContributor {
  readonly layer: "p0" | "p1" | "p2";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceHash: string;
  project(): readonly IrisProjectedUnit[];
  invalidate?(sourceId: string): boolean;
}

/** 与 @iris/context generation-builder 的 P0P1P2P3P4Unit 结构兼容。 */
export interface IrisProjectedUnit {
  readonly contextUnitId: string;
  readonly source: {
    readonly schemaId: "iris.context_unit_source_ref.v1";
    readonly sourceSchemaId: string;
    readonly sourceId: string;
    readonly sourceRevision?: string;
    readonly sourceHash: string;
  };
  readonly semanticSchemaId: string;
  readonly semanticContent: JsonValue;
}

/** P0–P2 语义 schema（generated registry 已知 schema）。 */
const OPERATIONAL_SCHEMA_ID = "iris.semantic.context_message.operational.v1";
const SOURCE_REF_SCHEMA_ID = "iris.context_unit_source_ref.v1";

/** BUST 时冻结的当前权威 source 快照。 */
export interface CurrentContextSource {
  canonicalSystemPrompt: string;
  personaSnapshotId: string;
  providerProfileId: string;
  toolDeclarations: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function staticUnit(input: {
  contextUnitId: string;
  sourceId: string;
  sourceHash: string;
  sourceRevision: string;
  type: string;
  text: string;
}): IrisProjectedUnit {
  return {
    contextUnitId: input.contextUnitId,
    source: {
      schemaId: SOURCE_REF_SCHEMA_ID,
      sourceSchemaId: "iris.system_source.v1",
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      sourceHash: input.sourceHash,
    },
    semanticSchemaId: OPERATIONAL_SCHEMA_ID,
    semanticContent: { type: input.type, data: { text: input.text } },
  };
}

/**
 * 创建 P0/P1/P2 三个 contributor（layer 各自独立；全部消费同一个
 * `getCurrent()` 权威快照 holder）。返回的数组按 [p0, p1, p2] 顺序。
 *
 * 确定性：unit identity / source hash 只依赖冻结的 source 内容；同一
 * canonicalSystemPrompt + persona + tool 声明必须产生同一投影。
 */
export function createIrisSourceContributors(
  getCurrent: () => CurrentContextSource,
): readonly IrisSourceContributor[] {
  const p0: IrisSourceContributor = {
    layer: "p0",
    sourceId: "iris-system-v1",
    sourceRevision: "v1",
    sourceHash: sha256("system"),
    project: () => {
      const current = getCurrent();
      const hash = sha256(current.canonicalSystemPrompt);
      return [
        staticUnit({
          contextUnitId: "p0-system",
          sourceId: "iris-system-v1",
          sourceHash: hash,
          sourceRevision: "v1",
          type: "system",
          text: current.canonicalSystemPrompt,
        }),
      ];
    },
    invalidate: (sourceId) => sourceId === "iris-system-v1",
  };
  const p1: IrisSourceContributor = {
    layer: "p1",
    sourceId: "iris-persona-v1",
    sourceRevision: "v1",
    sourceHash: sha256("persona"),
    project: () => {
      const current = getCurrent();
      const hash = sha256(`persona:${current.personaSnapshotId}`);
      return [
        staticUnit({
          contextUnitId: "p1-persona",
          sourceId: "iris-persona-v1",
          sourceHash: hash,
          sourceRevision: "v1",
          type: "persona",
          text: `persona snapshot: ${current.personaSnapshotId}`,
        }),
      ];
    },
    invalidate: (sourceId) => sourceId === "iris-persona-v1",
  };
  const p2: IrisSourceContributor = {
    layer: "p2",
    sourceId: "iris-capability-v1",
    sourceRevision: "v1",
    sourceHash: sha256("capability"),
    project: () => {
      const current = getCurrent();
      const text = current.toolDeclarations.join("\n");
      const hash = sha256(`capability:${text}`);
      return [
        staticUnit({
          contextUnitId: "p2-capability",
          sourceId: "iris-capability-v1",
          sourceHash: hash,
          sourceRevision: "v1",
          type: "capability",
          text,
        }),
      ];
    },
    invalidate: (sourceId) => sourceId === "iris-capability-v1",
  };
  return [p0, p1, p2];
}
