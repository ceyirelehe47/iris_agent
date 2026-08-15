# A3/A4/A5 设计决策记录（iris_agent#132）

> 对应任务阶段 A：A3（DSH attachment/image 路径）、A4（usage/cost 知识状态）、
> A5（DSH source snapshot hash）。本文件记录权威选择与理由，供独立复审对照。

## A3 — DSH attachment/image：选择 typed attachment ref + render-time materialization

**选择**：canonical image part 保存 **typed attachment ref**
（`iris.dsh_attachment_ref.v1`：attachmentId/mediaType/bytes/width/height），
由 Provider Renderer 在渲染时经 `AttachmentMaterializer`（生产实现映射到 DSH
`AttachmentStore.readImage`）物化为 provider 可消费的 base64 data URL。

**理由**（对照锁定版本 `@deepseek-ai/dsh-attachment` 0.1.0-rc.6 真实 API）：

- `AttachmentStore.readImage(ref)` 先校验 bytes 与 recorded reference 匹配再返回
  bytes —— attachment 缺失 / hash 校验失败 → throw → 渲染 fail-closed
  （绝不静默输出损坏图片）；
- `attachmentId` 是 content-addressed 不可变存储的**稳定标识**（不是文件路径、
  bearer URL、图片字节）—— 可安全进入 canonical Unit 且跨 restart 可解析；
- 不把大图片 base64 塞进 context.db（有界存储），archive retention 由 DSH
  attachment 的 durable content-addressed 语义保证（Unit 存活期间引用不失效）；
- DSH provider 原生接受 `ImageBlock.attachment: ImageAttachmentRef`，typed ref
  是 DSH-native 形状；Pi wire 才需要 base64（渲染期转换）。

**不变量**：

- opaque `attachmentId` 绝不进入最终 image.data（测试断言）；
- 语义 image part 的 `attachmentRef` 遇到无 materializer → fail-closed；
- `sourceHash`/source snapshot（A5）覆盖 content blocks（含 attachment
  identity/hash）。

## A4 — usage/cost 知识状态：known vs unavailable（estimated 预留）

**选择**：canonical usage 区分：

- **known cost**：`cost` 对象存在（`{input,output,cacheRead,cacheWrite,total}`）；
- **unavailable cost**：`costStatus: "unavailable"` 且**无 cost 字段**；
- **estimated cost**：未来需要时增加 `costStatus: "estimated"`（本轮不启用）。

DSH 不携带 provider cost → `dshUsageToIris` 输出 `costStatus: "unavailable"`，
**绝不把未知 cost 写成真实 0**（旧实现写 `cost: {…0}` —— A4 修复对象）。
`totalTokens` = input + output + cacheRead + cacheWrite（reasoning 是 output
子集，不重复加）。

**Pi wire 兼容**：Pi `Usage` 要求完整 cost —— 当 canonical cost 不可用时，
renderer 构造 **adapter-private placeholder**（模块级常量
`PI_WIRE_USAGE_PLACEHOLDER`）：

- 只存在于本次 provider-call 视图（不写回 Context）；
- 不进入真实费用 telemetry（无任何 telemetry 路径消费它）；
- canonical 侧保持 cost 不可用 → 读 canonical 的 benchmark 永远不会看到零成本。

## A5 — DSH source snapshot hash：版本化 canonical snapshot

**选择**：`DSH_SOURCE_SNAPSHOT_BASIS_VERSION = "iris.dsh_source_snapshot.v1"`，
按 user / assistant / tool result 分别定义版本化 canonical snapshot
（canonical JSON，键序无关），覆盖影响 accepted canonical semantics 的
immutable source 字段：

| 字段                                    | user | assistant   | tool result |
| --------------------------------------- | ---- | ----------- | ----------- |
| messageId                               | ✓    | ✓           | ✓           |
| source kind                             | ✓    | ✓           | ✓           |
| provider / model                        | —    | ✓           | —           |
| content blocks（含 attachment ref）     | ✓    | ✓           | ✓           |
| callId                                  | —    | —           | ✓           |
| resolved toolName（来自匹配 tool/call） | —    | —           | ✓           |
| isError                                 | —    | —           | ✓           |
| usage token 计数                        | —    | ✓（若存在） | ✓（若存在） |
| event time（进入 content.timestamp）    | ✓    | ✓           | ✓           |

**明确排除**：`eventSeq` 是 Session-local locator —— 不进入 semantic identity，
因此不进入 source snapshot（同一消息无论 eventSeq 定位值如何产生同一 hash，
与 unitId 派生一致）。旧实现只 hash `JSON.stringify(message.content)`（未声明
为协议、键序不稳定、漏掉 provider/model/toolName/callId/isError/usage）——
A5 修复对象。
