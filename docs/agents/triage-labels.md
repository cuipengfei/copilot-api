# 工单状态

本项目的工单在 `Status:` 字段中使用以下状态：

- `needs-triage`：等待维护者评估。
- `needs-info`：等待报告者补充信息。
- `ready-for-agent`：需求已明确，可以开始实施。
- `ready-for-human`：需要由人工执行。
- `wontfix`：不安排实施。

`/to-spec` 与 `/to-tickets` 发布可实施事项时使用 `ready-for-agent`。
