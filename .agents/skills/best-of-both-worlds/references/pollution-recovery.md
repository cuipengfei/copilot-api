# 污染排查与处理：如果本地修复误入 `czy-all`

当 `git log --oneline caozhiyuan/dev..czy-all` 输出包含测试、lint、build、typecheck、skill 或 config 等本仓库本地修复提交时，`czy-all` 缓冲区已被污染。停止向 `dev` 发起或合并 PR，按以下只读核对与备份步骤处理（严禁使用 `git reset`、`git checkout`、`git restore`、`git revert` 等任何 Git 命令回滚代码）。

## 1. 只读定位最后一个干净同步点

候选点必须是“上游某个 commit 的 fast-forward 落点”或“只把 `caozhiyuan/dev` 合入 `czy-all` 的纯同步 merge commit”，不得选普通本地修复提交。

```bash
git log --first-parent --oneline czy-all -n 20
git show --stat <candidate-sha>
git show --no-patch --pretty=%P <candidate-sha>
```

按以下两类之一验证候选点：

- **Fast-forward 落点**：`git merge-base --is-ancestor <candidate-sha> caozhiyuan/dev` 退出码为 `0`。
- **纯同步 merge commit**：`git show --no-patch --pretty=%P <candidate-sha>` 显示一个 parent 来自 `czy-all` 旧 first-parent，另一个 parent 是对应的 `caozhiyuan/dev` 同步点；且 `git log --oneline <candidate-sha>..czy-all` 列出的提交全部是误入 `czy-all` 的非同步提交。

无法用上述证据确认候选点时，停止并向用户报告。

## 2. 备份污染现场并列出污染提交

只读检查当前状态并创建备份分支，不改动工作树或现有分支指针：

```bash
git fetch origin --prune
git rev-parse origin/czy-all
git rev-parse czy-all
git log --oneline <clean-sync-commit>..czy-all
git branch backup/czy-all-polluted-$(date +%Y%m%d-%H%M%S) czy-all
```

## 3. 停在待批准状态并交由用户决定后续处理

向用户完整报告：
1. 当前 `czy-all` 与 `origin/czy-all` 的 SHA；
2. 定位到的干净同步点 `<clean-sync-commit>` SHA 及验证依据；
3. 误入 `czy-all` 的非同步提交清单；
4. 已创建的备份分支名称 `backup/czy-all-polluted-...`。

遵守用户级规则（严禁使用 Git 回滚任何代码）：停在当前只读核对与备份完成状态，不执行任何分支回退或重写命令，等待用户明确指示如何处理。
