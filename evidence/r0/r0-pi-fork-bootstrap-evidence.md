# R0 Pi Controlled Fork Bootstrap — Evidence

Round 5, R0-Pi（2026-08-12 验证）。本文件验证 Iris 对 Pi 的 controlled fork bootstrap：
upstream base、upstream sync、carried patch manifest、独立包身份、native Pi CI、精确 production lock。
仅验证与记录，无代码改动。本文件是 2026-08-12 快照（supersedes 以日期为准的旧证据需重跑）。

## 1. Fork 仓库拓扑

| 角色 | 仓库 | 说明 |
| --- | --- | --- |
| 原始 upstream | `earendil-works/pi` | Pi 项目本源；`docs/iris-fork/production-lock.json` 声明 `upstream.repository` |
| 受控 fork | `blueforst/pi` | Iris 受控 fork（`docs/iris-fork/` 治理 + gate 所在）；iris_agent production lock `pi.fork.repository` |
| 开发 fork | `ceyirelehe47/pi` | 贡献 PR 通道（blueforst/pi#21/#22 等均由此 fork 合入）；本地 origin |

本地 remote 实测（`/root/code/iris/repos/pi`）：
- `origin` = `https://github.com/ceyirelehe47/pi.git`
- `upstream` = `https://github.com/blueforst/pi.git`

## 2. Upstream baseline

| 字段（iris_agent lock / pi manifest） | 值 | 验证结果 |
| --- | --- | --- |
| fork baselineCommit | `ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1`（"fix(coding-agent): retain heterogeneous auth model types"） | 对象存在；是 seam `edd724be7` 的祖先 ✓；且是 seam 与 earendil-works base `e741cb05c` 的 merge-base（= 预期 divergence point）✓ |
| upstream baseCommit（earendil-works） | `e741cb05ca7c1c7bc5a9664c99697df32de9fac6`（2026-08-04T10:37:02Z） | GitHub API 确认存在于 `earendil-works/pi`；compare `e741cb05c...main(2e4d2395)` → behind 0 / ahead 253，即真 ancestor，无历史改写 ✓ |
| upstream audit baseline | `b4f293684bba718d59cc1157679bcf6157b3a7f5`（Release v0.82.1） | 对象存在；是 seam 的祖先 ✓ |

拓扑说明：`upstreamBaseCommit` 不是 seam 的祖先 — 按 fork lock 设计，它位于 divergence point `ab5f8d88e`（= baselineCommit）的 upstream 侧；`merge-base(upstreamBase, seam) == baselineCommit` 正是预期拓扑，非完整性缺陷。

## 3. Upstream sync（fork ↔ blueforst/pi）

2026-08-12 实测（fetch upstream 后）：
- `upstream/main` HEAD = `edd724be790ec3a73b3a85bb051882a45acc5c72`（Merge PR #22）
- `origin/main` HEAD = `edd724be790ec3a73b3a85bb051882a45acc5c72` — 与 upstream/main 完全一致
- `git diff upstream/main..origin/main --stat` → **空**（0 文件）
- 本地分支 `fix/round5-r0-pi` HEAD = `edd724be7`，`git diff upstream/main..HEAD` → **空**

结论：ceyirelehe47/pi fork main 与 blueforst/pi upstream main 完全同步，零漂移。
（注：本地 `fix/round5-r0-pi` 为仅本地分支，未推送 fork — 本验证无需推送，同步锚点是 fork main。）

## 4. Carried patch manifest

Pi 仓库 `docs/iris-fork/carried-patches.json`（schemaVersion 2）共 7 条：

| ID | 状态 | 受影响包 | first/latest fork commit 均为 seam 祖先 |
| --- | --- | --- | --- |
| PI-015-provider-context-controller | carried | pi-agent-core | ✓（310e7331 / e65e26bd） |
| PI-016-session-commit-receipt | carried | pi-agent-core | ✓（310e7331 / 66a3ea146） |
| PI-017-runtime-event-lifecycle | carried | pi-agent-core | ✓（310e7331 / e65e26bd） |
| PI-018-hermetic-model-catalog | carried | pi-ai | ✓（3d222542 / 97b37bbb） |
| PI-019-crash-consistent-commit-receipts | carried | pi-agent-core, pi-storage-sqlite-node | ✓（f5e434c9 / 18d059bf） |
| PI-019-jsonl-framed-journal | proposed | pi-agent-core | —（proposed，无 fork commit） |
| PI-020-receipt-replay-integrity | proposed | pi-agent-core, pi-storage-sqlite-node | —（proposed，无 fork commit） |

验证：7 个 first/latest fork commit 全部 `cat-file -e` 存在且 `merge-base --is-ancestor <commit> edd724be7` = YES。
每条 carried patch 均带 genericRuntimeRationale / affectedSurfaces / tests / upstream.status / removalCondition / compatibilityRisk / notes（完整字段，无 TBD/TODO/unknown）。

Gate 实测（worktree = seam edd724be7）：
- `node scripts/check-iris-fork-baseline.mjs` → exit 0，`OK: iris fork baseline manifests are valid`
- `node --test scripts/check-iris-fork-baseline.test.mjs scripts/check-iris-fork-baseline-manifest.test.mjs` → **60 pass / 0 fail**

## 5. CI 状态（native Pi CI）

`.github/workflows/` 原生工作流 10 个，核心为 `ci.yml`（CI: push main + PR main，node 22，build + check + test）+ `pr-gate.yml` + `issue-gate.yml` + `npm-audit.yml` + `publish-model-catalog.yml` 等。CI 内含独立且靠前的 Iris fork provenance gate 步骤。

GitHub Actions 实测（2026-08-12 查询）：
- fork `ceyirelehe47/pi` CI workflow @ `edd724be7`：**success**（2026-08-10T16:44:30Z）✓
- fork `ceyirelehe47/pi` Publish Model Catalog @ `edd724be7`：success（2026-08-12）✓
- fork `ceyirelehe47/pi` npm audit @ `edd724be7`：success ✓
- upstream `blueforst/pi` CI @ `edd724be7`：**success** ✓

## 6. Production lock 验证（iris_agent）

`src/contracts/pins/production-lock.json` pi 段逐字段核对（对象库 = /root/code/iris/repos/pi）：

| 字段 | 值 | 实测 |
| --- | --- | --- |
| fork.repository | blueforst/pi | 与 pi manifest `fork.repository` 一致 ✓ |
| fork.baselineCommit | ab5f8d88e… | 对象存在，seam 祖先 ✓ |
| seamCommit | edd724be7…（= fork/upstream main HEAD） | 与 `../pi` HEAD 完全一致 ✓ |
| seamTree | b0a87bec… | `git rev-parse edd724be7^{tree}` = `b0a87becb5add1f52c571e168918933b8cffe531` ✓ |
| acceptedRuntimeCommit | 66a3ea146… | 对象存在；seam 祖先 ✓；与 pi manifest `acceptedRuntime.commit` 逐字段相等 ✓ |
| acceptedRuntimeTree | a6bdb67a… | `git rev-parse 66a3ea146^{tree}` = `a6bdb67ab97a087e3e0285746462545780ea19b3` ✓ |
| upstreamBaseCommit | e741cb05c… | 见 §2（upstream 侧、divergence point 拓扑正确）✓ |
| upstreamAuditBaselineCommit | b4f29368… | 对象存在，seam 祖先 ✓ |
| packages | file:../pi/packages/{agent,ai,storage/sqlite-node} | `package.json` 完全一致；`npm ls` 实测三个包均解析到 `./../pi/packages/*`（0.83.0，fork checkout 而非 registry）✓ |

Gate 测试：`npx tsx --test test/production-lock.test.ts` → **19 pass / 0 fail**（含 seam 钉住相邻 pi checkout、acceptedRuntime 与 pi manifest 一致、TBD/TODO 占位符扫描等）。

## 7. iris_agent 对 fork 的构建验证

- `npm ci --ignore-scripts` → exit 0（无错误）
- `npx tsc --noEmit` → **exit 0**（类型检查全绿，依赖解析到 file:../pi 链接）

## 8. Exit Gate 逐条核对（R0）

| Gate | 状态 | 证据 |
| --- | --- | --- |
| upstream base | PASS | baseline `ab5f8d88e`（divergence point）+ earendil base `e741cb05c` 均经 git 对象与 GitHub API 双重验证 |
| upstream sync | PASS | `origin/main == upstream/main == edd724be7`，diff 为空；本地分支与 seam 零漂移 |
| carried patch manifest | PASS | `docs/iris-fork/carried-patches.json` 7 条（5 carried + 2 proposed），全部 commit 为 seam 祖先；gate + 60 测试通过 |
| 独立包身份 | PASS（如实记录） | `distribution.packageIdentityStatus = inherits_upstream_package_names`（schema 允许值）；依赖经 file: 链接钉到 fork checkout，无 registry 消费 |
| native Pi CI | PASS | 原生 `ci.yml` 等 10 工作流；fork 与 upstream 在 `edd724be7` 均 success |
| exact production lock | PASS | 所有 SHA/tree 与 git 对象一致；seam = 相邻 checkout HEAD；acceptedRuntime 与 pi manifest 逐字段相等；lock gate 19/19；npm ls 证明 file: 链接生效 |

## 9. 已知观察（不阻塞本轮）

- earendil-works/pi main 已推进到 `2e4d2395`（比记录 base `e741cb05c` 前移 253 commits）；pi manifest `sync.lastVerifiedUpstreamCommit` 仍为 2026-08-04 值 — 按 `manual_review_gate` 策略为已记录的时点同步，同步刷新属 follow-up。
- fork 包身份沿用 upstream 包名（`inherits_upstream_package_names`，2026-08-04 R0 已知缺口之一，发布前必须决策）。
- `fix/round5-r0-pi` 为本地分支，未推送开发 fork（fork main 已同步，无需推送）。
