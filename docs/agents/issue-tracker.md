# 本地任务跟踪

本项目的规格与工单保存在 `.scratch/<feature-slug>/`。

- 规格使用 `.scratch/<feature-slug>/spec.md`，发布时记录 `Status: ready-for-agent`。
- 每张工单使用独立文件 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始依照依赖顺序编号。
- 工单顶部记录 `Status: <状态>` 和 `Blocked by: <编号>`；无阻塞关系时填写 `Blocked by: None`。状态名称参见 `docs/agents/triage-labels.md`。
- 评论与后续讨论记录在对应文件末尾的 `## Comments` 节。按用户提供的文件路径或编号查找工单。

## Wayfinder

- 地图文件为 `.scratch/<effort>/map.md`，保存笔记、已有决定与待解决问题。
- 子工单使用 `.scratch/<effort>/issues/<NN>-<slug>.md`；`Type:` 填写 `research`、`prototype`、`grilling` 或 `task`，`Status:` 填写 `claimed` 或 `resolved`。
- 从编号最小的未认领、无阻塞的子工单开始；认领时记录 `claimed`，解决后记录 `resolved`，在 `## Answer` 节写明结果，并在地图中引用该工单。
