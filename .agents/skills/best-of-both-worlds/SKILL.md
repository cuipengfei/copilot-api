---
name: best-of-both-worlds
description: Use when syncing upstream `caozhiyuan/dev` into `czy-all`, pushing `czy-all`, creating or updating a `czy-all -> dev` PR, running a dry-run upstream diff and conflict check, or resolving `dev <- czy-all` merge conflicts while preserving local `dev` capabilities.
---

# Best of Both Worlds

将上游 `caozhiyuan/dev` 同步到本仓库缓冲区分支 `czy-all`，通过 `czy-all -> dev` PR 合入本仓库 `dev`；若 PR 存在冲突，在本地 `dev <- czy-all` 合并工作区按功能逻辑组分析冲突与伴随调用点，取得用户对逻辑组的决定后落地，兼顾上游新增能力与本仓库 `dev` 独有行为。

## 分支职责与红线

| 分支 | 职责 | 允许的提交 | 严禁的动作 |
|---|---|---|---|
| `remotes/caozhiyuan/dev` | 上游来源分支（已取代早期的 `caozhiyuan/all`） | 只读 fetch | 任何写入 |
| `czy-all`（跟踪 `origin/czy-all`） | 只读式上游缓冲区、PR head | 从 `caozhiyuan/dev` fast-forward 的提交，或无冲突的纯同步 merge commit | 修测试/lint/typecheck/build、解 `dev` 冲突、合入 `dev`、改 tracking |
| `dev`（跟踪 `origin/dev`） | 本仓库集成分支、PR base | 本地开发提交、`dev <- czy-all` 集成 merge commit 及配套修复 | 未经授权直接 commit 或 push |

`czy-all` 同步阶段不运行 `bun test`、`bun run lint:all`、`bun run build`、`bun run typecheck`。所有项目级验证与兼容性修复只在 `dev <- czy-all` 集成阶段执行。

---

## 步骤 0：前置检查与一次性盘点（Preflight & Inventory）

在任何 checkout、merge、push 或建 PR 之前，运行单次确定性检查：

```bash
git status --short --branch
git fetch caozhiyuan --prune
git fetch origin --prune
git rev-parse --abbrev-ref czy-all@{upstream}
git log --oneline caozhiyuan/dev..czy-all
```

**完成条件（满足全部才可继续）：**
1. 工作树干净。
2. `czy-all` 的 upstream 为 `origin/czy-all`。
3. `git log --oneline caozhiyuan/dev..czy-all` 为空，或仅含纯同步 merge commit。若出现本地测试/lint/配置等非同步提交，立即停止主流程，读取并执行 [`references/pollution-recovery.md`](references/pollution-recovery.md)。

### 上游变更盘点与冲突预测（Dry-run 亦执行此步）

用一条确定性命令盘点 `dev..caozhiyuan/dev` 的全部提交、实际触碰路径与冲突预测，避免分批调用导致截断或把含业务改动的提交误判为纯版本 bump：

```bash
git log --reverse --format='COMMIT %H %s' dev..caozhiyuan/dev
for c in $(git log --reverse --format='%H' dev..caozhiyuan/dev); do
  echo "=== $c $(git log -1 --format='%s' "$c") ==="
  git show --stat --format='' "$c"
done
if git merge-tree --write-tree dev caozhiyuan/dev > /tmp/merge-tree-czy.out 2>&1; then
  merge_tree_exit=0
else
  merge_tree_exit=$?
fi
printf 'MERGE_TREE_EXIT=%s\n' "$merge_tree_exit"
cat /tmp/merge-tree-czy.out
```

- 对 `dev..caozhiyuan/dev` 的每个提交读取完整 patch（`git show --format=fuller --find-renames --find-copies --patch --no-ext-diff <sha>`），覆盖代码、测试、CI、脚本、配置、plugin 与文档全部路径。按**用户可见的功能与行为变化**分组汇报，每个 SHA 都须有归属；不得仅凭 commit message 或 `--stat` 判断用途。明确标明尚未读取或仍需核查的提交。
- 识别成对的 commit + Revert（净变化为零直接合并说明）。
- 明确区分影响 GitHub Copilot 后端链路的改动与仅影响第三方 provider / Codex / Desktop 的改动。
- 若用户仅要求 dry-run，汇报完上游行为变化与 `merge-tree` 冲突预测后即停止。
- `merge-tree` 退出码为 `0` 时报告无内容冲突；退出码为 `1` 且输出包含 `CONFLICT` 时列出冲突路径；其他退出码、命令不可用或输出异常时，报告“冲突预测未验证”及错误，停止后续同步操作。使用 Git 的退出码和冲突消息判定，不以文件改动重叠或 conflict marker 数量代替。创建 PR 后再核对 GitHub 的合并状态。

---

## 步骤 1：同步 `czy-all`、推送并切回 `dev`

```bash
git checkout czy-all
git merge --ff-only caozhiyuan/dev
```

仅在 fast-forward 成功后继续推送。若 `--ff-only` 失败，检查原因：只有分支分叉、`czy-all` 不含本地修复提交，且 `git merge-tree --write-tree czy-all caozhiyuan/dev` 退出码为 `0` 时，才允许执行 `git merge --no-ff caozhiyuan/dev` 创建纯同步 merge commit。同步预测或实际合并出现内容冲突、命令异常时，立即停止并报告，不在 `czy-all` 解决冲突，也不继续 push；不使用 rebase 或 amend 重写同步历史。

同步成功后，重新检查下列提交清单为空或仅含纯同步 merge commit，再推送并切回 `dev`：

```bash
git log --oneline caozhiyuan/dev..czy-all
git push origin czy-all
git checkout dev
```

**完成条件：**
- `origin/czy-all` 与本地 `czy-all` SHA 一致，且 `git merge-base --is-ancestor caozhiyuan/dev origin/czy-all` 退出码为 `0`；fast-forward 时 head 等于上游最新 SHA，纯同步 merge 时 head 为包含该上游 SHA 的 merge commit。
- `git log --oneline caozhiyuan/dev..czy-all` 无任何本地修复提交。
- 当前分支已切回 `dev`。

---

## 步骤 2：创建或更新 `czy-all -> dev` PR 并校验 Base

创建 PR 时必须显式指定 `--base dev --head czy-all`，并在同一命令链立即校验 `baseRefName`（防止仓库默认分支指向 `master` 导致建错目标分支）：

```bash
gh pr create --base dev --head czy-all --title "<围绕本次真实变更的标题>" --body "<真实变更与冲突预测摘要>"
gh pr view czy-all --json number,url,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,isDraft,reviewDecision,statusCheckRollup
```

**完成条件：**
- 返回的 `baseRefName` 严格等于 `"dev"`（若误建到其他分支，立即修改 base 或关闭后按 `--base dev` 重建）。
- 向用户报告 PR 编号、URL、`mergeable`、`mergeStateStatus`、checks、review、draft 与 merge queue 阻塞状态。合并状态为 `UNKNOWN`、空值或仍在计算时，等待后重新查询；仍未知则报告待确认状态并停止最终合并。检查失败、未完成或存在其他阻塞时，明确报告对应项目。

---

## 步骤 3A：PR 无冲突时的合并流程

仅在 `mergeable === "MERGEABLE"`、checks 已通过、review/draft/merge queue 均无阻塞且 `mergeStateStatus` 明确允许继续时进入：
1. 向用户展示 PR 编号、URL、当前 `headRefOid` 与检查状态，取得对此 PR 和 head 的明确合并授权。
2. 执行前重新查询步骤 2 的全部 PR 字段，并核查 merge queue 状态。确认授权对应的 `headRefOid` 未变，checks、review、draft、`mergeable`、`mergeStateStatus` 与 queue 均仍允许合并；任一条件变化或未知时，停止并报告。head 变化后须重新展示变更并取得授权。
3. 通过 head SHA 保护执行合并：
   ```bash
   gh pr merge <number> --merge --match-head-commit "<approved-head-sha>"
   gh pr view <number> --json state,mergedAt,headRefOid,url
   ```
   只有 PR 状态为 `MERGED` 才继续；若进入 merge queue，等待队列处理并确认最终合并状态，队列阻塞或失败时报告原因，不使用 `--admin` 绕过。
4. 确认远端合并后，同步本地 `dev` 并进入步骤 4：
   ```bash
   git fetch origin dev
   git merge --ff-only origin/dev
   ```

---

## 步骤 3B：PR 有冲突时的本地 `dev <- czy-all` 集成流程

当 PR 为 `CONFLICTING` / `dirty` 时，所有冲突分析、编辑与验证均在本地 `dev` 分支完成。

### 3B.1 建立本地合并工作区

取得用户对“在本地 `dev` 启动合并分析工作区”的授权后，执行：

```bash
git checkout dev
git merge --no-ff --no-commit czy-all
git status --short
```

*(此授权仅用于生成冲突工作区，不包含编辑冲突文件、`git add`、commit 或 push。)*

### 3B.2 冲突块与无冲突伴随文件核对（Logical Groups + Companion Check）

在向用户提请决策前，完成以下两项核对：

1. **冲突块盘点**：读取所有 unmerged 文件中的每个冲突 hunk，梳理 `dev` 侧保留的功能意图、`czy-all` 侧引入的新能力或重构，以及两边如何组合（Best of Both Worlds）。
2. **无冲突伴随文件核对（Companion Check，必做）**：Git 自动合并成功的文件仍可能因跨文件契约变化而断裂。必须检查：
   - `git diff dev...czy-all -- src/` 中被上游修改函数签名、移动或删除的导出符号，用 `lsp references` 或 `grep` 检查本仓库 `dev` 独有模块与测试（如 `auto-session*`、`smart-agent*`、`subagent-marker*`、`decisions*`、`responses-local-*`）中的所有调用点；
   - 上游在 handler 中替换辅助函数时，是否顺带删掉了 `dev` 原有的调用入口（如子 agent marker 解析、流式收尾记账、上游响应头转发）；
   - 流式生成器和延迟回调中新增的上下文读取，是否在创建流时捕获了快照（避免在 `requestContext.run` 外部消费时丢失 `AsyncLocalStorage`）。

### 3B.3 按功能逻辑组向用户汇报并一次性拍板

禁止当冲突块较多时逐块单问刷屏。将全部冲突块及伴随适配项收敛为 **3–6 个功能逻辑组**（例如：会话与子 agent 识别、Responses 流式与续传、依赖与 lockfile、文档与配置、测试与配套调用），一次性向用户展示：

- 每个逻辑组的**合并后行为**、保留的本地 `dev` 独有能力、以及任何兼容性变化；
- 一张紧凑的 **Hunk 映射表**（`编号 | 文件:行范围 | 所属逻辑组 | 处理方式`），确保全部冲突块无遗漏；
- 请用户按逻辑组（或一次性对全部组）拍板。用户对逻辑组给出批准（如“五组全部接受”或 `agreed, go`），即视为授权按映射表编辑对应范围内的全部冲突块与伴随适配文件。

若已安排 sub-agent 独立审查，必须等待所需审查结果返回，纳入逻辑组方案后再取得用户最终决定。审查返回前的同意不作为编辑许可；审查导致方案变化时，更新 Hunk 映射表并重新请用户确认受影响的逻辑组。未安排独立审查时，不额外强制启动。

### 3B.4 落地编辑与项目级全量检查

获得用户对全部逻辑组的批准后：
1. 编辑解决全部冲突块与伴随适配文件，确认工作区不再残留任何 `<<<<<<<`、`=======`、`>>>>>>>` 标记。
2. 显式按文件路径暂存本次合并涉及的文件（禁止使用 `git add .` / `git add -A` 盲目暂存无关未跟踪文件），确认 `git ls-files --unmerged` 为空。
   **跨分支依赖检查**：`node_modules` 不随分支切换。若此前在其他分支安装过依赖，或切换分支后首次检查出现类型、`bun:test`、`@types/bun` 或 type-aware lint 异常，先记录 `package.json`、`bun.lock` 及 desktop 对应文件的当前改动，再在当前 `dev` 运行 `bun install --frozen-lockfile` 和 `bun install --cwd desktop --frozen-lockfile`，按当前分支 lockfile 恢复依赖。安装后核对依赖文件改动未增加，并重新运行原失败命令；问题仍在时按真实源码或依赖问题处理。若冻结安装报告 manifest/lockfile 不一致，核查本次合并的依赖变更，不用其他分支的 lockfile 覆盖当前内容，也不为陈旧依赖目录修改源码。
3. 运行仓库一键全量门禁检查：
   ```bash
   bun run check:all
   ```
   若需要运行自定义本地 HTTP 冒烟脚本，必须使用 `bun run test:isolated-env <script.ts>`，严禁连接 `~/.local/share/copilot-api/` 真实数据库。
4. 若检查发现格式或代码问题，修复后重新跑通受影响检查及最终 `lint:all`，并更新对应文件的暂存状态。
5. 向用户报告验证结果与当前暂存状态，等待用户下达 `commit` / `push` 指令。

### 3B.5 提交 Merge Commit 并推送 `origin/dev`

取得用户明确的 `commit` / `push` 指令后，核对 `git status --short` 无遗漏未暂存改动与未跟踪临时文件，执行：

```bash
git commit --no-edit
git push origin dev
gh pr view <number> --json state,mergedAt,headRefOid,url
```

确认 GitHub 已识别 `dev` 包含 `czy-all` head 并将原 PR 自动标记为 `MERGED`。

---

## 步骤 4：核对远端 `dev` 的 GitHub Actions CI

无论通过步骤 3A 还是 3B 完成合并，推送后都必须核对远端 `dev` 最新 SHA 对应的 GitHub Actions `CI` workflow 运行直至完成：

```bash
git fetch origin dev
dev_sha=$(git rev-parse origin/dev)
gh run list --branch dev --commit "$dev_sha" --workflow CI --json databaseId,headSha,status,conclusion,url
```

- 只选择 `headSha === dev_sha` 的 `CI` run。运行尚未创建时等待后重新查询；持续找不到时报告该 SHA 的 CI 尚未验证，不宣称通过。
- 对已找到的运行等待完成，再读取最终状态：
  ```bash
  gh run watch <run-id> --exit-status
  gh run view <run-id> --json headSha,status,conclusion,url
  ```
  确认 `headSha` 对应目标 SHA、`status === "completed"` 且 `conclusion === "success"`。再次刷新 `origin/dev`；若远端 head 已变化，改为核对新 head 对应的 CI。
- 若 CI 失败，使用 `gh run view <run-id> --log-failed` 读取失败作业日志，在 `dev` 定位并修复，运行项目完整检查；取得用户对修复提交与推送的明确授权后更新远端，再从刷新 SHA 开始核查新提交的 CI。不得向 `czy-all` 写入修复；取消、跳过或仍在运行的结果均按其实际状态报告，外部阻塞须点明原因。
- 最终报告远端 `dev` SHA、PR 状态、对应 CI 链接与结论，以及本地分支和工作树状态。
