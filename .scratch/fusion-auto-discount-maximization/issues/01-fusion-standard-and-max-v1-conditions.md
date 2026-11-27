# 01: 扩展 Fusion Standard 与 Max v1 探测条件及历史存储

Status: ready-for-human
Blocked by: None

**What to build:** 让探测条件生成、上游选模请求与 `probe-history` 持久化支持两类新增的 30% 折扣来源：一是向 `POST /auto` 发送 `fusion: true` 的 Fusion Standard（支持 `balance`、`intelligence`、`fast` 三档），二是向 `POST /model/fusion` 发送 `fusion_mode: "hydrafusion-max"` 且 `plan_version: "1"`。凭据按同一账户、同一选模通路已核实的计费结果登记：本次实测 30% 使用模型的 `fusion` 槽位；若未来某账户实测 10%，使用 `auto` 槽位并保留该通路的覆盖。历史记录文件须正常读写与重放。

## Acceptance criteria

- [x] `createProbeCondition` 与 `auto-probe-history` schema 支持 Fusion Standard（`/auto` + `fusion: true`，限 `balance`、`intelligence`、`fast` 三档，不生成 `efficiency`）与 `hydrafusion-max`（`plan_version: "1"`），并对已有 `conditions.json` 保持向后兼容。
- [x] `getAutoSelection` 支持可选的 Fusion Standard 参数（附带 `has_image: false, fusion: true, hydra_rl_multi_turn: {}`）；`getFusionSelection` 支持传入 `fusionMode: "hydrafusion" | "hydrafusion-max"`。
- [x] Fusion Standard 与 `hydrafusion-max` 选模成功时，按实际返回的模型 ID 和该账户、该通路已核实的计费结果登记凭据：30% 使用 `fusion` 槽位，10% 使用 `auto` 槽位；本次新增通路按已核实的 30% 登记；当 `hydrafusion-max` 返回 `403` 或 `model_pool_not_eligible` 时，只暂停当前凭据下的 `hydrafusion-max` 条件，不中断 `hydrafusion`（High）或 Fusion Standard 的探测。
- [x] 单元与集成测试覆盖新条件的 hash 唯一性、历史读写、请求体格式、实测 30% 登记 `fusion`、实测 10% 登记 `auto`以及 `hydrafusion-max` 403 隔离。

**规格：** [Copilot Fusion 与 Auto 折扣覆盖最大化规格](../spec.md)
