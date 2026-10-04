---
name: best-of-both-worlds
description: "This skill should be used when the user asks to sync upstream `caozhiyuan/dev` (previously `caozhiyuan/all`, now removed upstream) into the buffer branch `czy-all`, push `czy-all`, create/update a PR from `czy-all` to `dev`, or, if that PR conflicts, analyze conflicts only in a local `dev <- czy-all` integration merge, require explicit user approval for each conflict block before editing it, and never resolve conflicts on `czy-all`."
---

# Best of Both Worlds

把 `caozhiyuan/dev` 的最新内容带到本仓库的 `czy-all`，再向本仓库 `dev` 发起 PR；若 PR 出现冲突，只能在本地 `dev <- czy-all` 集成工作区逐个冲突块分析，逐块取得用户明确拍板后再编辑，尽量取两边之长，不得在 `czy-all` 上解决 PR 冲突。

> **上游分支变更说明（2026-05）**：上游仓库 `caozhiyuan` 已经删除 `all` 分支，唯一的活跃分支是 `caozhiyuan/dev`。本 skill 中所有原来写作 `caozhiyuan/all` 的位置一律改用 `caozhiyuan/dev`。本地遗留的 `remotes/caozhiyuan/all` ref 是历史残留，请勿再用。

## 适用场景

当用户提出类似下面这些请求时，使用此 skill：

- “merge caozhiyuan/dev to czy-all”
- “push czy-all”
- “raise pr from czy-all to dev”
- “merge PR from czy-all to dev”
- “resolve the pr conflicts one by one”
- “best of both worlds”
- “把 caozhiyuan/dev 同步到 czy-all 再 PR 到 dev”（注意：本仓库 `dev` 与上游 `caozhiyuan/dev` 是两个不同分支，分别属于不同 remote）

## 核心原则

### STOP：先挡住最高风险误操作

如果你打算在 `czy-all` 上做下面任何一件事，立即停止：

- 修测试 / 测试隔离 / mock 调整
- 修 lint / 修 typecheck / 修 build
- 修 skill / agent memory / config
- “顺手清理一下”的 cleanup commit
- `git commit --amend` / `git rebase` / 重写上游同步提交
- 任何不是来自 `caozhiyuan/dev` 的 commit

这些动作的正确发生地点是 **`dev` 分支**，且必须在用户明确授权启动的 `git merge --no-ff --no-commit czy-all` 之后的 `dev <- czy-all` 集成工作区里完成，不是在 `czy-all`。

### 分支职责（硬规则）

- `remotes/caozhiyuan/dev`：上游来源分支（对方仓库；曾经是 `caozhiyuan/all`，已被上游删除）。
- `czy-all`（tracking `origin/czy-all`）：本仓库的**镜像/承接分支**，用于保持与 `caozhiyuan/dev` 同步，并作为 PR 源头。
- `dev`：本仓库目标集成分支。

### `czy-all` 是只读式上游缓冲区（最高风险红线）

`czy-all` 的唯一职责是把 `caozhiyuan/dev` 搬进本仓库，作为 `czy-all -> dev` PR 的 head。它不是修复分支，不是验证修复分支，不是冲突解决分支。

**允许出现在 `czy-all` 的提交：**

- 从 `caozhiyuan/dev` fast-forward 得来的上游提交。
- 在 fast-forward 不可用时，把 `caozhiyuan/dev` 合入 `czy-all` 的纯同步 merge commit。

**禁止出现在 `czy-all` 的提交：**

- 测试修复、lint 修复、typecheck 修复、build 修复。
- 冲突解决提交。
- 本仓库 `dev` 侧的功能、文档、配置、skill、agent memory、cleanup。
- 为了让 `czy-all` 上的验证变绿而做的任何本地 patch。

如果在 `czy-all` 同步后运行验证发现失败，只能记录失败现象；不要在 `czy-all` 上修。正确动作是创建/更新 `czy-all -> dev` PR，然后切到 `dev`，在 `dev <- czy-all` 的本地 merge 过程中修复。

更严格地说：`czy-all` 同步阶段默认**不运行** `bun test`、`bun run lint:all`、`bun run build`、`bun run typecheck` 这类项目级验证。同步阶段只做 `git fetch` / `git status` / `git log` / 纯同步 merge / push / PR 状态检查。需要项目级验证时，先进入 `dev <- czy-all` 集成阶段。

**提交前强制自检：**如果当前分支是 `czy-all`，且待提交内容不是“来自 `caozhiyuan/dev` 的同步结果”，立即停止。除非用户明确要求清理/重写 `czy-all` 本身，否则不得在 `czy-all` 上创建本地修复提交。

固定目标是：

1. 先把 `caozhiyuan/dev` 同步到 `czy-all`（只在 `czy-all` 上操作）
2. 再把 `czy-all -> dev` 集成到 `dev`

### PR 是唯一集成入口（关键）

始终创建或使用 `czy-all -> dev` PR。这里的“merge PR”在本仓库按下面方式完成：

1. 先确保 `origin/czy-all` 已推送，且 PR 指向 `dev`。
2. 若 PR 可直接通过 GitHub merge，则按 PR 状态和用户授权执行。
3. 若 PR 有冲突，则在本地 `dev` 上取得用户授权后执行 `git merge --no-ff --no-commit czy-all` 创建冲突分析工作区，逐块分析并逐块取得用户明确授权后才落地；全部冲突按用户决定解决并完成验证、取得最终 push 授权后，才可 push `origin dev`。
4. GitHub 发现 `dev` 已包含 PR head 后，原 `czy-all -> dev` PR 会自动变为 merged/closed。

这仍然是通过 PR 完成 `czy-all -> dev`，不是绕过 PR，也不是反向污染 `czy-all`。

**禁止默认做法：**

- 未经用户明确要求，不得执行 `dev -> czy-all`（例如在 `czy-all` 上 merge `dev`）。
- 未经用户明确要求，不得把 `czy-all` 当作日常开发分支写入与同步目标无关的提交。
- 不得在 `czy-all` 上修测试、修 lint、修 build、修 typecheck；这些修复属于 `dev <- czy-all` 集成阶段。

> 解释：`czy-all` 的职责是保持“可从 `caozhiyuan/dev` 干净同步”的状态；反向混入本仓库 `dev` 会污染同步基线。

1. **保持 tracking 不乱改。** 除非用户明确要求，不要擅自把 `czy-all` 的 upstream 从 `origin/czy-all` 改到别的远端。
2. **把“拉内容”和“改 tracking”分开。** 需要同步 `caozhiyuan/dev` 时，优先 `git fetch caozhiyuan --prune` 后 `git merge --ff-only caozhiyuan/dev`；若 fast-forward 不可用，只能做明确的纯同步 merge commit。不要顺手重写 upstream，不要让 `git pull` 隐式 rebase 或生成含本地修复的 merge。注意 `caozhiyuan/dev` 指的是上游 remote 的分支名，与本仓库的 `dev` 同名但不是同一分支。
3. **合并方向固定。** 这条工作流里，PR 方向始终是 `czy-all -> dev`；PR 冲突时，本地解决方向是 `dev <- czy-all`。
4. **冲突逐个问，不批量糊。** 出现 PR conflict 后，不要直接全选 ours/theirs，不要一次性大面积接受某一边；也不要在用户未确认前先编辑“显然正确”的块。
5. **优先保留两边有效意图。** 目标不是“偏向哪边”，而是“best of both worlds”。
6. **冲突决定权在用户。** agent 负责把每个冲突拆成可理解的选项、说明影响、给出推荐，并执行用户决定；不要替用户拍板。即使 agent 认为没有歧义、sub-agent 也同意，也必须等用户对当前块明确说 yes / 执行 / 选 A 后才能改。
7. **先报数量，再解冲突。** agent 应先告诉用户一共有多少冲突文件、多少冲突块，再进入逐个处理。
8. **处理过程中持续播报。** 每解决一块或推进到下一文件时，都要让用户知道当前进度，不要闷头解到最后。
9. **先讲非冲突改动的价值。** 在进入冲突决策前，agent 应先告诉用户这批不冲突改动分别带来了什么功能变化、面向什么 use case。
10. **PR 创建不是完成。** 创建 PR 后，必须继续报告 `mergeable` / `mergeStateStatus` / checks / review / draft 等状态；未获用户对当前 PR 的明确最终授权，不得执行 merge。

## 标准流程

### 第零步：Preflight branch & pollution check

在任何 checkout、merge、push、PR 操作之前，先确认当前状态与 `czy-all` 是否已经被污染。

推荐命令：

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD
git rev-parse --abbrev-ref czy-all@{upstream}
git fetch caozhiyuan --prune
git fetch origin --prune
git log --oneline caozhiyuan/dev..czy-all
git rev-list --left-right --count origin/czy-all...czy-all
```

判定规则：

| 检查项 | 期望 | 不符合时 |
|---|---|---|
| 工作树 | clean，或只有用户明确允许保留的 unrelated untracked 文件 | 停止，先说明脏状态 |
| `czy-all` upstream | `origin/czy-all` | 停止，不擅自改 upstream |
| `git log caozhiyuan/dev..czy-all` | 空，或只有纯同步 merge commit | 若出现测试/lint/build/typecheck/skill/config 修复提交，进入污染恢复流程 |
| `origin/czy-all...czy-all` | 明确知道本地/远端差异 | 不清楚时停止说明 |

注意：`git log caozhiyuan/dev..czy-all` 有输出不必然等于污染；纯同步 merge commit 可以存在。污染的判断标准是：输出里是否出现本仓库本地修复、配置、skill、测试、lint、cleanup 等非上游同步提交。

若第零步检测到 `czy-all` 已被污染（`git log caozhiyuan/dev..czy-all` 含非同步提交），不要继续第一步到第七步，直接跳转到本文末“污染恢复流程”。恢复完成、`czy-all` 重新干净后再回到第一步。

#### Dry-run 冲突预测

用户只要求 dry run 时，不 checkout、不 merge、不 push、不创建 PR。刷新 refs 后，必须先报告上游变更，再用 Git 的合并判定结果预测 `dev <- caozhiyuan/dev`：

1. 列出 `dev..caozhiyuan/dev` 的全部 commit hash 与原始 message。
2. 对每个 commit 读取实际 patch（`git show --patch`）；不能只依据 message、`--stat` 或 commit 数推断。
3. 面向用户按功能/行为说明每个 commit 带来的变化、受影响 use case，以及纯版本或测试配套项；不需要讲代码实现细节，除非用户要求。
4. 明确区分“已从 patch 验证”和“未能从 patch 确认”。若 commits 很多，可合并说明同一功能的连续提交，但不得遗漏任一 commit。

推荐命令：

```bash
git log --reverse --format='COMMIT %H%nSUBJECT %s%nBODY%n%b%n---' dev..caozhiyuan/dev
git show --format=fuller --find-renames --find-copies --patch --no-ext-diff <commit>
```

完成上游变更报告后，再运行：

```bash
git merge-tree --write-tree dev caozhiyuan/dev
```

判定必须同时记录命令退出码与 `CONFLICT` 行：

- 退出码 `0`：Git 未检测到冲突。
- 非 `0` 且输出含 `CONFLICT`：报告冲突，并列出对应路径。
- 命令不可用、异常退出或输出无法解析：结论写“未验证”，不得猜测。

不得通过搜索 `<<<<<<<` / `=======` / `>>>>>>>` marker、统计 `changed in both`、或仅看 diff 重叠来判定是否冲突；`merge-tree` 输出格式不保证出现工作树 conflict marker。dry-run 只是预测，创建 PR 后仍以 GitHub `mergeable` / `mergeStateStatus` 为准。

### 第一步：确认当前状态

先确认：

- 当前分支是否是 `dev`
- 工作树是否干净
- `czy-all` 当前是否继续跟踪 `origin/czy-all`
- `caozhiyuan/dev` 是否可 `git fetch caozhiyuan --prune`（若本地仍残留 `remotes/caozhiyuan/all`，可用 `git fetch caozhiyuan --prune` 清理；不要使用 `git pull`）

### 依赖目录卫生：跨分支后先重建当前分支的本地依赖状态

`node_modules` 是工作区级目录，不随 Git 分支自动切换。若你刚在 `czy-all` 或其他分支运行过 `bun install`，再切回 `dev` 后，当前 `node_modules` / ESLint project service / TypeScript 类型状态可能仍反映上一分支或旧安装状态。

因此，在 `dev <- czy-all` 集成阶段运行 lint/typecheck/test/build 前，若出现“代码未改但类型型 lint 突然报错”、`@types/bun` / `bun:test` 类型异常、或分支切换后首次验证失败，先在当前分支运行：

```bash
git status --short
bun install
git status --short
```

判定规则：

- 若 `bun install` 后 `package.json` / `bun.lock` 没变，且同一条验证命令从失败变为通过，优先判定为本地依赖目录/类型状态陈旧；不要为此提交无关代码修复。
- 若 `bun install` 后同一错误仍存在，按真实代码或类型问题处理；不要继续把它归因于依赖目录卫生问题。
- 若 `bun install` 修改了 `package.json` 或 `bun.lock`，先检查这些变更是否来自当前分支真实依赖更新；不要把上一分支的 lockfile 状态混进 `dev`。
- `bun install` 只能用于恢复当前分支的本地依赖状态，不是让 `czy-all` 接受修复提交的理由；依赖相关修复提交仍只允许发生在 `dev <- czy-all` 集成阶段。

再做一次方向检查（必须明确回答）：

- 本次是否在执行 `czy-all -> dev`？
- 当前是否已创建或确认存在 `czy-all -> dev` PR？
- 当前操作是否只会临时切到 `czy-all` 做同步，然后回到 `dev`；若要解决 PR 冲突，是否是在 `dev` 上按第七步 B 执行用户授权的 `git merge --no-ff --no-commit czy-all`？
- 当前操作是否会把 `dev` 反向写入 `czy-all`？

若最后一问答案是“会”，立即停止；这不是本 skill 的流程。解决 PR 冲突时允许 `dev <- czy-all`，禁止 `czy-all <- dev`。

推荐命令：

```bash
git status --short
git branch -vv
git remote -v
git fetch caozhiyuan
```

### 第二步：临时切到 `czy-all`，把 `caozhiyuan/dev` 带进 `czy-all`

在 `czy-all` 上执行同步，但**不要改变 `czy-all` 的 tracking**。`czy-all` 只是同步落点，不是默认停留分支；完成这一段后应回到 `dev`。

同步阶段只允许处理“如何把上游提交带进 `czy-all`”这个问题。若同步后测试、lint、build、typecheck 失败，不要在 `czy-all` 上修；把失败作为 PR 集成阶段需要处理的问题记录下来。

在 `czy-all` 上只允许这些动作：

- `git fetch`
- `git status`
- `git log`
- `git merge --ff-only caozhiyuan/dev`，或明确的纯同步 merge commit
- `git push origin czy-all`
- PR 状态检查

在 `czy-all` 上不允许运行后再修复：

- `bun test`
- `bun run lint:all`
- `bun run build`
- `bun run typecheck`
- 任何会导致本地修复 commit 的命令链

推荐做法：

```bash
git checkout czy-all
git fetch caozhiyuan --prune
git merge --ff-only caozhiyuan/dev
```

若不是 fast-forward，且合并不产生内容冲突，只允许创建“纯同步 merge commit”把 `caozhiyuan/dev` 合入 `czy-all`。一旦有内容冲突，立即停止，不在 `czy-all` 上解；不要在 `czy-all` 上 rebase，不要 amend，不要重写已同步的上游提交。

如果把 `caozhiyuan/dev` 合入 `czy-all` 时出现内容冲突，这不是常规的 PR 冲突处理场景；立即停止并报告“buffer 分支同步本身发生冲突”。不要在 `czy-all` 上解冲突，除非用户明确授权你修复/重建 `czy-all` buffer。

### 第三步：推送 `origin/czy-all`

推送前确认 `czy-all` 没有本地修复提交：

```bash
git log --oneline caozhiyuan/dev..czy-all
```

若输出包含测试/lint/build/typecheck/skill/config 等本仓库修复提交，说明 `czy-all` 已被污染；停止并进入“污染恢复流程”，不要继续创建误导性 PR。

确认无污染后，再把本地 `czy-all` 推到当前仓库 fork：

```bash
git push origin czy-all
```

push `origin/czy-all` 只表示 PR head 已更新，**不是工作完成**，也不表示 `dev` 已同步上游。

### 第四步：切回 `dev`

完成 `czy-all` 同步与推送后，默认应切回 `dev`，不要停留在 `czy-all`：

```bash
git checkout dev
```

从这一步开始，冲突解决、测试修复、lint 修复、build 修复、typecheck 修复都应落在 `dev`。这正是 “best of both worlds” 的工作区：保留 `dev` 的本地意图，同时吸收 `czy-all` 带来的上游能力。

### 第五步：创建或确认 PR（`czy-all -> dev`）

使用 `gh` 创建 PR：

```bash
gh pr create --base dev --head czy-all
```

PR 标题和摘要要围绕**这次从 `caozhiyuan/dev` 带来的真实变更**，不要只写一句泛泛的 sync branch。

生成 PR 摘要时，先看：

```bash
git log --oneline dev..czy-all
git diff --stat dev...czy-all
```

### 第六步：PR 创建后必须继续检查 merge 状态，而不是到此为止

创建 PR 后，必须立即检查：

- 是否存在 merge conflict
- CI checks 是否通过
- review / draft / merge queue 等状态是否仍阻塞 merge
- 是否还需要用户确认执行最终 merge

推荐命令：

```bash
gh pr view <number> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,url
```

这里的分支处理规则是：

- **有冲突**：进入后文的逐块冲突流程，并由用户逐块拍板。
- **merge 状态未知 / 仍在计算**：若 `mergeable` 或 `mergeStateStatus` 为 `UNKNOWN`、空值或 GitHub 仍在计算，先等待片刻后重查；若重查后仍未知，明确告诉用户“GitHub 尚未给出可合并状态”，停止，不进入最终 merge。
- **无冲突但仍有阻塞项**：若 checks 失败/未完成，或 `reviewDecision` 仍阻塞，或 PR 仍是 draft，或还有其他 merge queue / review 阻塞项，把这些失败项或等待项明确告诉用户，不要把“已开 PR”误报成“已完成”。
- **无冲突且已具备 merge 条件**：只有在 checks 已通过、review 不阻塞、PR 不是 draft，且 `mergeable` / `mergeStateStatus` 已明确表明可继续时，才明确告诉用户“现在已可执行最终 merge”，并询问是否继续。

### 第七步 A：PR 无冲突时通过 GitHub merge 到 `dev`

仅当 PR 无冲突、checks/review/draft/merge queue 均不阻塞，且 `mergeable` / `mergeStateStatus` 明确可继续时，才进入本步骤。除非用户已明确授权，否则不要擅自完成最终 merge。

在执行最终 merge 之前，必须先说出这句话（verbatim preflight）：

```text
确认：你已明确授权 merge PR #X 到 dev（URL：...，head SHA：...，原话：”...”），现在才执行。
```

若无法填入用户的授权原话、PR 编号、URL 或当前 `headRefOid`，则还没有最终授权，禁止执行 merge。

拿到授权后，再次检查一次当前 PR 状态，确认 `headRefOid` 没有变化、merge 状态不再是 `UNKNOWN`、checks / review / draft 都没有重新变成阻塞项；只有满足这些条件，再执行：

```bash
gh pr merge <number> --merge
```

merge 完成后，还要再次确认：

- PR 已处于 merged 状态
- 当前分支仍是 `dev`
- 工作树仍干净

补充说明：若 PR 无冲突且通过 `gh pr merge` 完成远端 merge，应再执行一次 `git pull --ff-only origin dev`（或等价的 fetch + fast-forward 验证），不要把“远端已 merge”误报成“本地 dev 已同步”。

### 第七步 B：PR 有冲突时本地 `dev <- czy-all` 合并

仅当 PR 状态明确为 conflict / dirty，且用户明确授权“开始本地 `dev <- czy-all` 冲突分析 merge”时，才进入本步骤。本步骤不是在 `czy-all` 上修 PR，而是在 `dev` 上创建本地 merge/conflict 工作区，统计并分析冲突。

进入本地 merge 前，必须先说出：

```text
确认：你已明确授权我在本地 dev 上执行 `git merge --no-ff --no-commit czy-all` 以生成冲突分析工作区（原话：“...”）。这不包含任何冲突块编辑、删除 marker、git add、验证、commit 或 push 授权。
```

若无法填入用户授权原话，则禁止执行本地 merge。

```bash
git checkout dev
git merge --no-ff --no-commit czy-all
```

若没有产生冲突且 Git 提示可提交，仍然不要提交；先重新检查 PR 状态，报告“本地 merge 未产生冲突”，然后默认 `git merge --abort` 退出工作区。后续走 GitHub merge 或其他路径，必须由用户明示决定。

若产生冲突，必须先**完整分析所有冲突块**，再一次性向用户报告；不得逐块提问、不得边分析边编辑、不得先处理“显然正确”的块。每个块至少包含：

1. 文件与 hunk 范围。
2. `dev` 侧意图和 `czy-all` 侧意图，以功能/行为说明，不只复述代码。
3. 交集、冲突点及对用户/兼容性的影响。
4. 推荐方案与理由；若有可行替代方案，也要列出。
5. 该推荐是否依赖未验证假设或外部行为。

报告末尾必须给出完整“冲突方案清单”，让用户对所有块**一次性**拍板：可逐项接受/改写，也可明确接受某些项、拒绝另一些项。没有覆盖全部冲突块的授权，不得编辑、删除 marker、`git add`、运行项目级验证、commit 或 push。

一次性授权的 preflight 必须逐项可追溯：

```text
确认：本次 merge 共 Y 个冲突块。我已完整展示每块的双方意图、推荐方案和理由；你的最终决定如下：
- 第 1 块（<file>:<hunk>）：<接受/改用方案/...>；原话“...”
- 第 2 块（<file>:<hunk>）：<接受/改用方案/...>；原话“...”
- ...
现在才开始编辑冲突文件。此授权不包含 lint 自动改动、项目级验证、commit 或 push。
```

确认全部冲突块的一次性决定后，才按清单落地；仍不得在 `czy-all` 上解。运行项目级验证前，必须确认当前分支是 `dev`、冲突 marker 全部消除，且用户决定已覆盖全部冲突块。

### 项目级验证：默认自动执行

所有冲突块落地后，agent **必须自动**执行项目 `AGENTS.md` 规定的完整验证；不需要因 `--fix` 会写盘而额外向用户要授权。验证是本地、可逆的质量检查，不是 commit / push 授权。

按项目规定顺序运行：

```bash
bun run lint:all --fix
bun run build
bun test
bun run typecheck
```

- `lint:all --fix` 若改动文件：检查 diff；仅格式/lint 修复可继续。若出现超出本次合并范围的语义改动，停止并报告，等待用户决定。
- 任一步失败：停止，报告失败命令、关键输出与当前 diff；不得提交或推送。是否继续修复，按用户后续指示执行。
- 四步均通过后：报告验证证据，并等待用户**单独明确授权**创建 merge commit 与 push `origin/dev`。

commit / push 前置确认：

```text
确认：本次本地 `dev <- czy-all` merge 共 Y 个冲突块，用户的一次性决定已逐项列出；项目级验证已全绿（lint/build/test/typecheck）；你已明确授权创建 merge commit 并 push `origin/dev`（原话：“...”），现在才执行 commit/push。
```

若无法填入全部冲突块授权摘要、验证结果和用户最终 commit/push 授权原话，则禁止 commit / push。

```bash
git commit
git push origin dev
```

推送后立即检查原 `czy-all -> dev` PR：

```bash
gh pr view <number> --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,url
```

若 GitHub 显示 PR `MERGED` 或 base 已包含 head，则本地解决 PR 冲突流程完成；若状态仍为 `UNKNOWN`，等待后重查；若仍 `CONFLICTING`，停止并报告实际状态。

### 第八步：合并后核对 `dev` 的 CI

无论第七步通过 GitHub merge 还是本地 `dev <- czy-all` 推送完成，都要确认远端 `dev` 的实际 head SHA，再检查该 SHA 对应的 GitHub Actions CI 运行；PR 合并状态与合并前的 checks 不代替这项检查。

```bash
git fetch origin dev
git rev-parse origin/dev
gh run list --branch dev --commit <dev-head-sha> --workflow CI --json databaseId,headSha,status,conclusion,url
gh run watch <run-id> --exit-status
```

- 若运行尚未创建或仍在运行，等待并重新检查；确认 `headSha` 与远端 `dev` 一致后才判定结果。找不到对应运行时说明未验证，不得宣称 CI 通过。
- 若失败，读取失败作业日志，定位原因；在 `dev` 修复并运行项目规定的完整检查。只在明确授权提交及推送后更新 `origin/dev`，再检查新提交对应的 CI，直到通过或明确报告阻塞。不得把修复写入 `czy-all`，也不得把已合并的 PR 当作修复提交的 CI 结果。
- 若通过，报告远端 `dev` SHA、运行链接、结论与本地工作区状态。

## 污染恢复流程：如果本地修复误入 `czy-all`

若发现 `czy-all` 上出现了测试/lint/build/typecheck/skill/config 等本仓库修复提交，不要把污染状态继续合入 `dev`。先恢复 `czy-all` 的 buffer 语义。

1. 找到最后一个干净同步点：通常是最近一次“只把 `caozhiyuan/dev` 合入 `czy-all`”的 merge commit，或与 `caozhiyuan/dev` 对应的同步点。候选点必须是“纯同步 merge commit”或“上游某个 commit 的 fast-forward 落点”，不允许选普通本地修复 commit 作为干净点。推荐命令：

```bash
git log --first-parent --oneline czy-all -n 20
git show --stat <candidate-sha>
git show --no-patch --pretty=%P <candidate-sha>
```

候选点分两类验证：

- fast-forward 落点：`git merge-base --is-ancestor <candidate-sha> caozhiyuan/dev` 必须为真。
- 纯同步 merge commit：`git show --no-patch --pretty=%P <candidate-sha>` 必须显示一个 parent 来自 `czy-all` 旧 first-parent，另一个 parent 是/包含对应的 `caozhiyuan/dev` 同步点；且 `git log --oneline <candidate-sha>..czy-all` 中列出的后续提交必须正是要移除的污染提交。

如果无法用上述证据说明候选点是干净同步点，停止并向用户报告，不要猜。

2. 明确列出污染提交，并保存污染现场备份，例如：

```bash
git fetch origin --prune
git rev-parse origin/czy-all
git rev-parse czy-all
git log --oneline <clean-sync-commit>..czy-all
git branch backup/czy-all-polluted-$(date +%Y%m%d-%H%M%S) czy-all
```

3. 因为 `origin/czy-all` 可能已经被 push，重写远端前必须取得用户明确授权。没有授权，禁止执行 force push。
4. 执行 force-with-lease 前，必须先说出这句话（verbatim preflight）：

```text
确认：你已明确授权将 origin/czy-all 从 <current-remote-sha> 回退/重写到 <clean-sync-sha>，目的是移除污染提交 <bad-sha-list>；授权原话：“...”。现在才执行 --force-with-lease。
```

若无法填入用户授权原话、当前远端 SHA、目标干净 SHA 或污染提交列表，禁止执行 force push。

5. 获得授权后使用 safer force：

```bash
git checkout czy-all
git reset --hard <clean-sync-commit>
git push --force-with-lease origin czy-all
```

6. 重新检查 `czy-all -> dev` PR 是否更新到干净 head；若原 PR 已存在，确认它不再包含污染提交；若无 PR，再创建 PR。
7. 切回 `dev` 后，不得直接执行旧式 merge 命令；必须重新回到“第七步 B：PR 有冲突时本地 `dev <- czy-all` 合并”，重新取得进入本地 merge 的用户授权，并使用 `git merge --no-ff --no-commit czy-all`。所有冲突、验证修复、commit/push 仍受第七步 B 与逐块冲突门禁约束。

## 冲突处理：逐块走 “best of both worlds”

如果 PR 出现冲突，按**文件 → 冲突块**逐个处理。

如果 PR **没有**冲突，也不能直接收工。此时仍必须向用户明确汇报：

- 当前 PR 没有冲突
- 当前 checks / review 状态如何
- 是否已经具备最终 merge 条件
- 接下来是“等 checks / 处理阻塞项”还是“请用户确认现在就 merge”

### 每个冲突块都必须回答这 4 个问题

1. `dev` 这一边保留了什么意图？
2. `czy-all` 这一边带来了什么新能力或修复？
3. 两边是否能组合，而不是二选一？
4. 我推荐哪一种，风险是什么，需要用户明确选哪一项？（固定需要用户拍板，不存在“agent 可自动判断所以直接执行”的情况）

### 决策权限规则

面对冲突时，agent 应遵守以下规则：

- **用户决定，agent 执行**
- agent 可以整理 `dev` 侧与 `czy-all` 侧的意图、风险与推荐组合方案
- agent 可以指出哪种组合更像 “best of both worlds”
- **但最终保留哪边、怎么拼，必须由用户拍板**
- 如果用户还没拍板，agent 不要擅自完成该冲突块的最终取舍
- **无歧义也要问。** “我能判断”“显然该组合”“只是 lockfile/文档/小块”都不是例外；每个冲突块都需要用户对当前块编号确认。
- **不能先改后问。** 在用户确认前，不得把冲突文件改成推荐方案、不得删除 conflict marker、不得 `git add`、不得把该块标记 resolved、不得继续下一块。

### 执行门禁（强制，不可绕过）

本节只规定**块级门禁**：写文件、删除 conflict marker、标记 resolved、`git add -- <具体文件>`、进入下一块，必须等用户对当前块编号确认。

验证和收尾另有独立门禁：所有块级授权完成后，必须先做冲突块授权汇总 preflight，才能进入项目级验证；commit / push 必须在验证通过后另行取得用户最终授权。任何单个块确认或全部块确认都不自动授权验证、commit 或 push。

在对每个冲突块落地块级操作之前，必须同时满足以下全部条件：

1. 主 agent 已给出本块的对比分析与推荐方案；
2. sub-agent 已返回独立意见（若本轮启用了 sub-agent）；
3. 用户对**当前块编号**给出明确确认（如”yes / agree / 执行方案 A”），且确认发生在本块分析之后。

**三方对齐 = 信息齐全。用户拍板 = 唯一执行许可。两者不能混用。**

> 看到”三方意见一致”或”两边建议相同”，**不构成执行授权**。必须等用户说话。

执行前，agent 必须先说出这句话（verbatim preflight）：

```text
确认：你已对第 X 块给出明确拍板（原话：”...”），现在才执行。
```

若无法填入用户的原话，则还没有授权，禁止执行。

**反例（明确违规）：**

- 只说“我会合并两边意图”，然后直接编辑冲突文件。
- 报告“3 个冲突文件”，但没有逐块等待用户选择就 `git add` / commit / push。
- 认为 `bun.lock`、`package-lock.json`、文档冲突是机械冲突，所以自行取一边或重新生成。
- 认为 “best of both worlds” 有明显答案，所以省略用户确认。

**正确做法：**即使推荐方案明显，也要停在该块，等待用户确认后才执行。

**`git add` 颗粒度规则：**

- 每块拍板后，只允许标记该块所在的具体文件路径：`git add -- <该块所在文件>`。
- 禁止使用 `git add .`、`git add -u`、`git add -A`、`git add <目录>`。
- 全部冲突块解决完毕、进入第七步 B 验证阶段前，必须运行 `git status --short` 给用户看：“还剩 0 个 unmerged 路径，已 staged 的文件清单如下：...”。
- 任何 staged 文件不在用户拍板清单内，立即停止；不能继续验证、commit 或 push。

### Sub-Agent 独立意见格式

每次调用 sub-agent 时，要求它按以下结构输出（在 prompt 中明确要求）：

```text
[Sub-agent 独立意见 | Block X/Y]
dev 意图：
czy-all 意图：
推荐组合：
风险/不确定点：
是否需要用户拍板：是（固定）
```

最后一行必须固定为”是（固定）”，防止主 agent 误读为”已可执行”。

### 冲突数量与进度播报规则

在开始逐块处理前，agent 应先向用户明确：

- 当前一共有多少个冲突文件
- 当前一共有多少个冲突块
- 每个文件各有多少块冲突

推荐话术：

```text
当前共有 X 个冲突文件、Y 个冲突块。
我会一次只带你看一个冲突块，并在每推进一块后告诉你还剩多少。
```

在处理过程中，agent 应持续播报类似下面的信息：

```text
第 1 块已按你的决定落下，当前还剩 2 个文件、2 个冲突块。
现在进入下一个冲突。
```

不要等全部冲突都处理完才一次性汇报结果。

### 非冲突改动说明规则

在开始逐块处理冲突前，agent 还应先整理：

- 哪些文件改动是**不冲突**的
- 这些不冲突改动分别带来了什么功能变化
- 这些变化分别服务于什么 use case / 用户场景

推荐话术：

```text
先说不冲突的部分：这批改动里，已有 A 个文件不涉及冲突块，无需逐块拍板；但它们仍受 PR 状态、项目级验证、lint 自动改动复核、最终 commit/push 授权门禁约束。
它们带来的变化主要是：
1. <功能变化> —— 对应 <use case>
2. <功能变化> —— 对应 <use case>

在这个背景上，我们再进入冲突块决策。
```

不要一上来只报冲突，不解释“这批 PR 整体想带来什么能力变化”。

### 建议输出模板

面对每一个冲突文件，先整理成：

```text
文件：<path>

dev 侧：
- 保留了什么
- 解决了什么问题

czy-all 侧：
- 引入了什么
- 修复了什么问题

推荐解法：
- 保留 dev 的哪些部分
- 合并 czy-all 的哪些部分
- 为什么这样是 best of both worlds

需要用户确认：
- 固定列出当前块编号、推荐方案、风险
- 即使无歧义，也必须请用户明确确认“按方案 A 执行”
- 不得写“无需确认”，不得只列有歧义点
```

### 用户 brainstorming 规则

如果冲突带有明显产品/行为取舍，不要直接拍板。要先和用户 brainstorm，再改代码。

适合先问用户的问题包括：

- 两边行为是否都必须保留？
- 哪一边是近期修复，哪一边是老分支特性？
- 用户更在意兼容性、行为稳定，还是新功能？

默认话术应接近下面这种风格：

```text
这个冲突我不替你决定。
我先把 dev 侧、czy-all 侧、以及可组合方案拆开；你拍板选哪一种，我再按你的决定去改。
```

## 明确禁止的做法

- 不看 diff 就直接 `ours` / `theirs`
- 因为冲突多就一次性全文件接受单边
- 把”跟踪谁”与”拉谁的内容”混为一谈
- 未经用户明确要求，在 `czy-all` 上执行 `merge dev` / `rebase dev` 之类反向写入
- 在 `czy-all` 上执行 `git pull`，或让 pull 隐式产生 merge/rebase
- 把 PR 冲突当作 `czy-all` 同步冲突处理，并在 `czy-all` 上提交冲突解决
- 在 `czy-all` 上跑过 `bun run lint:all --fix` / `bun test -u` / 任何会写盘的修复命令，并把结果 commit
- 在错分支上 commit 后用 `git push -u origin czy-all` 强行落地
- 把 `dev` 上 cherry-pick 的修复提交带到 `czy-all`，哪怕只是“小补丁”
- PR 有冲突时，仍误以为只能在 GitHub 页面解决，而拒绝在本地 `dev <- czy-all` 后 push `dev` 让 PR 自动 merged
- 把 `czy-all` 当作长期开发分支，写入与”同步 caozhiyuan/dev + 提 PR 到 dev”无关的改动
- 没有先 push `origin/czy-all` 就开 PR
- PR 摘要不看实际提交和 diff，胡乱概括
- **看到 sub-agent 意见与自身建议相同，就以”三方对齐”为由直接执行** — 这是最常见的违规，必须明确禁止
- **用户在 sub-agent 未返回前说了”yes”，就以此为授权执行** — 必须等 sub-agent 返回后让用户做最终确认

## 快速检查清单

在结束前，确认：

- 当前本地分支是 `dev`，而不是停留在 `czy-all`
- `czy-all` 仍然跟踪 `origin/czy-all`
- 在 push `czy-all` 之前以及结束前，运行 `git log --oneline caozhiyuan/dev..czy-all`，输出必须为空或仅包含纯同步 merge commit；任何非同步 commit 出现 = 立即进入污染恢复流程，不得继续 PR / merge
- `caozhiyuan/dev` 的最新内容已经带进本地 `czy-all`
- `origin/czy-all` 已推送
- PR 已从 `czy-all` 指向 `dev`
- 若通过本地解决 PR 冲突，已记录用户对进入本地 merge、每个冲突块、lint 自动改动、验证后 commit/push 的明确授权原话；若验证一度失败，已记录用户对每次修复方案的明确授权原话，且修复后已重跑全部验证至全绿；`dev` 已包含 `czy-all` head，已推送 `origin/dev`，且 PR 已自动变为 merged/closed
- 若有冲突，已逐块分析，而不是整边覆盖
- 若无冲突，已向用户明确汇报 checks / merge 状态，并处理到“等待项已说明”或“最终 merge 已完成”这两个收尾之一
- PR 合并后，已核对远端 `dev` head SHA 对应的 CI 运行及最终结论；失败修复与新提交的 CI 已按第八步继续验证。

## 一句话目标

这条 skill 的目标不是“把分支硬合上”，而是**把 `dev` 的有效修复与 `czy-all` 的有效增量一块保住，逐个冲突点取两边之长**。
