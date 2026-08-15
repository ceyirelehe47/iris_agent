# Production Lock（v13 R0 / iris_agent#131 clean-checkout）

本仓库的 production lock 权威来源是 `src/contracts/pins/production-lock.json`，
由 `src/contracts/production-lock.ts` 类型化读取，
并由 `test/production-lock.test.ts` 作为 gate 验证（R0 Exit Gate：production lock 无 TBD）。

锁定的版本面（对应 Roadmap v13 R0 deliverables）：

| 面                        | 锁定值                                                                                                                                                                                                                                                                      | 状态                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Node                      | `>=22.19.0`（CI 精确 `22.19.0`），npm + package-lock.json                                                                                                                                                                                                                   | 已锁定                                                           |
| `@iris/context`           | `ceyirelehe47/iris-context` commit `323c6634…`（tree `c4622a1b…`；已审 iris-context#2/#4/#5 head）；经 `file:../.iris-vendor/iris-context` 精确 pin 消费                                                                                                                    | 已锁定（vendored exact pin；merge 后更新为 blueforst merge SHA） |
| Pi packages（当前消费源） | `file:../.iris-vendor/pi/packages/{agent,ai,sqlite-node}`（bootstrap 物化的精确 pin 检出；未发布 npm）                                                                                                                                                                      | 已锁定                                                           |
| Pi 受控 fork              | `ceyirelehe47/pi`（真实可访问 fork；`blueforst/pi` 在 GitHub 不存在）baseline `ab5f8d88…`；seam commit `edd724be…`（tree `b0a87bec…`）；acceptedRuntime `66a3ea14…`（tree `a6bdb67b…`，与 Pi 权威 lock 一致）；upstream base `581d75a8…`；audit baseline `6f707eb3…/0.82.1` | 已锁定（vendored exact pin，未来多机部署切换 tarball/npm 发布）  |
| Magic Context             | `cortexkit/magic-context` `v0.33.0` @ `48ab531d…`，authoritative path `packages/plugin/src/hooks/magic-context`                                                                                                                                                             | 已锁定                                                           |
| Memory contracts          | `iris-memory-contracts@0.3.0`，manifestSha256 `b55b5e1c…`，owner `blueforst/iris_memory`                                                                                                                                                                                    | 已锁定（与 `src/contracts/pins/memory-contracts.json` 交叉一致） |
| Graphiti / Neo4j          | `graphiti-core@0.29.2`、neo4j driver min `5.26.0`（候选锁，owner `blueforst/iris_memory`；agent 无直接依赖）                                                                                                                                                                | 候选锁定                                                         |

## clean-checkout 依赖模型（iris_agent#131）

`@iris/context` 与 `@iris/pi-*` **不再**依赖「开发者/CI 预先放好的 sibling 项目
checkout」（旧 `file:../iris-context`、`file:../pi/...` 的 `Repository not found`
与 fresh-checkout 缺失问题）。替代：

- `scripts/bootstrap-vendor-deps.mjs` 在 `npm ci` 的 `preinstall` 阶段，按
  production lock 的**精确 commit/tree pin** 物化：
  - `<repo>/../.iris-vendor/iris-context` ← `ceyirelehe47/iris-context@323c6634…`
  - `<repo>/../.iris-vendor/pi` ← `ceyirelehe47/pi@edd724be…`
  - 并构建（iris-context `npm ci + build`；pi `npm ci + 三包 build`）。
- `package.json` 用 `file:../.iris-vendor/...` 引用（npm 按外部 link 处理：
  不解析目标包 devDeps/peerDeps，安装面精简）。
- fresh checkout 只需 `npm ci` → `npm run check`，无需预置 sibling 仓库。
- `scripts/check-clean-layout.mjs`（`npm run check:clean-layout`）禁止任何
  unmanaged `file:../` 依赖（`file:../iris-context`、`file:../pi` 等回归会被 CI
  拒绝），只允许受管前缀 `file:../.iris-vendor/`。

## 单一权威 Pi 身份（iris_agent#41）

Pi 的 accepted runtime 身份只有一个权威来源：Pi fork 的
`docs/iris-fork/production-lock.json` → `acceptedRuntime`（immutable commit + tree）。
本仓库的 pin 是**消费方视图**，必须与 Pi 权威 lock 交叉一致：

- `pi.fork.seamCommit` / `seamTree`：CI 与本地实际物化的 Pi commit/tree
  （指向包含 iris_agent#41 修复链的 fork HEAD）；
- `pi.fork.acceptedRuntimeCommit` / `acceptedRuntimeTree`：Pi 权威 lock 声明的
  accepted runtime 身份，`test/production-lock.test.ts` 会读取 `../.iris-vendor/pi`
  的 lock 并断言两者完全一致；
- `pi.fork.repository` 是真实可访问的 fork（`ceyirelehe47/pi`；`blueforst/pi`
  在 GitHub 不存在 —— 这正是 #131 的 checkout 失败根因）。

## 跨仓库 gate（fail-closed）

`test/production-lock.test.ts` 现在验证：

1. `scripts/bootstrap-vendor-deps.mjs --check` 通过：`../.iris-vendor/{pi,iris-context}`
   的 HEAD/HEAD-tree 与 pin 完全一致（拒绝缺失/漂移/篡改）；
2. `../.iris-vendor/pi` 是真实 git 仓库（拒绝任意同名目录）；
3. `../.iris-vendor/pi` HEAD 等于 `seamCommit` 且 HEAD tree 等于 `seamTree`；
4. `../.iris-vendor/pi/docs/iris-fork/production-lock.json` 的 `acceptedRuntime`
   与 pin 的 `acceptedRuntimeCommit/Tree` 一致，且该 commit 在 vendored pi 中
   存在、其 tree 与 Pi lock 记录一致；
5. `@iris/context` 与 `@iris/pi-*` 的 package.json spec 与 pin 完全一致，
   且 `@iris/context` 不是 `file:../iris-context`；
6. `.github/workflows/ci.yml` 依赖 pin 驱动的 vendor bootstrap（`npm ci`
   preinstall），不 checkout `blueforst/pi`、不包含任何硬编码 SHA；
7. 篡改 pin（stale/非法 SHA）时 pin reader fail-closed 退出非零。

## 本地 bootstrap（不触碰已有分支）

`node scripts/bootstrap-vendor-deps.mjs --check` 验证 `../.iris-vendor` 是否匹配 pin。

本地开发快速通道（不重新 fetch）：把 `../.iris-vendor/{pi,iris-context}` 链接到
已有 checkout（位于精确 pin 时 `--check` 通过）；或直接运行 bootstrap 完整
物化（shallow fetch 精确 commit + 构建）。

## 跨仓库一致性

- Pi fork 的值与 Pi 权威 lock 交叉验证（`test/production-lock.test.ts` 实际读取并断言）；
- memory contracts 的值与 `blueforst/iris_memory` 发布的契约 artifact
  `manifest.json` 对齐（重算 SHA-256 验证）；
- CI 的 vendor 物化 ref 与 pin 派生一致（无第二份 SHA）。

历史说明：旧 `candidate_selected_pending_contract_tests` 版本（earendil-works/pi
`b4f2936` / 0.82.1）已被 v13 fork 语义取代；该 commit 作为 upstream audit
baseline 保留在 lock 中，不再直接等同最终 production artifact。`blueforst/pi`
仓库在 GitHub 上不存在（HTTP 404），真实 fork 为 `ceyirelehe47/pi`。
