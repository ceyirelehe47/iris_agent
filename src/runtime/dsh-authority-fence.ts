/**
 * DSH/Cordis conflict authority fence（iris_agent#128 Phase B B3）。
 *
 * 显式禁用 / fail-closed 阻止会与 Iris 冲突的默认 DSH/Cordis 功能：
 *   - DSH context compaction（不得产生第二套历史摘要 / provider-visible
 *     context 替代）；
 *   - semantic history 直拼 prompt（provider 调用只来自 Iris
 *     ContextGeneration → Provider Renderer）；
 *   - todo / planning authority、memory / recall authority（Iris 不把 DSH
 *     todo / recall 当作 Context authority）；
 *   - 动态 provider-turn context patch（provider hook 临时召回并 patch
 *     Context 被禁止）。
 *
 * DSH Session 继续承担（不冲突）：
 *   - raw runtime archive；recovery evidence；UI / audit source；commit
 *     ordering —— 但不是 Context authority。
 *
 * 本 fence 由两部分组成：
 *   1. 装配期静态检查（assertNoConflictingDshFeatures）：检测已挂载的冲突
 *      DSH 服务 / 插件（ReactLoopAgent 默认 loop、compaction、memory recall
 *      等已知冲突名），存在 → fail-closed；
 *   2. 运行时不变式（由 IrisLoopAgent 的构造保证）：provider 调用只接收
 *      rendered context；DSH Session 只被 append user/assistant/tool 事件
 *      （P0–P4 永不写入）。
 *
 * 结构性门（CI）：
 *   - src/runtime/iris-dsh-agent.ts 不得 `new ReactLoopAgent` / 导入
 *     `@deepseek-ai/dsh-agent-loop`；
 *   - 组合代码不得调用 `session.append` 写入 P0–P4 语义（system/persona/
 *     capability/compartment/recollection）。
 */

/** 与 Iris 冲突的 DSH 服务名（挂载即 fail-closed）。 */
const CONFLICTING_DSH_SERVICES: readonly string[] = [
  // 默认 agent loop（ReactLoopAgent 的具体实现包）。
  "agentLoop",
  // DSH compaction / semantic history（第二套历史摘要）。
  "compaction",
  "semanticHistory",
  // DSH todo / planning authority。
  "todo",
  "planning",
  // DSH memory / recall authority。
  "memory",
  "recall",
  // 动态 provider-turn context patch。
  "contextPatch",
];

/**
 * 装配期冲突检查：扫描 ctx 上已提供的服务名；命中冲突名单 → 抛错
 * （fail-closed）。只读；不修改 ctx。
 */
export function assertNoConflictingDshFeatures(ctx: {
  get(name: string, active?: boolean): unknown;
}): void {
  const present: string[] = [];
  for (const name of CONFLICTING_DSH_SERVICES) {
    if (ctx.get(name, false) !== undefined) {
      present.push(name);
    }
  }
  if (present.length > 0) {
    throw new Error(
      `iris dsh fence: conflicting DSH/Cordis services are mounted: ${present.join(", ")} — ` +
        "DSH context compaction / semantic history / todo / memory / dynamic context patch " +
        "must NOT be Context authorities (fail closed; #128 B3)",
    );
  }
}

/** 结构性检查对象（供 CI gate 引用常量，避免散落 magic string）。 */
export const DSH_FENCE = {
  conflictingServices: CONFLICTING_DSH_SERVICES,
} as const;
