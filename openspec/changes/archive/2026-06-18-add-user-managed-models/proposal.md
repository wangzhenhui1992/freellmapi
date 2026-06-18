## 1. 需求摘要

上游免费 LLM provider（Groq、Cerebras、Google、Agnes、OpenRouter、…）以高频节奏新增 / 替换 / 下线模型。本工程当前把"内置模型清单"硬编码在 `server/src/db/migrations.ts` 的 `migrateModelsV1..V27` 系列函数中，每次只是新增一个 `model_id` 也必须：写新 migration → 提交 → 构建 → 发版 → 用户重启。维护者本人是这套发版流程的瓶颈。

**机会**：现有 `applyCatalog`（远程目录同步）已经实现了"老模型保留用户禁用 / 新模型默认启用"的语义；现有 `POST /api/keys/custom` 已经实现了"UI 加 model + 自动加 fallback_config"的先例。本次只是把这两条既有路径的能力**提取并扩展到所有 provider**，让维护者直接在前端增删模型，绕开发版流程。

**为什么现在做**：模型迭代节奏越来越快，每周一次 migration 发版的成本已经显著高于功能本身；同时这个改动复杂度低（数据层只加一列、接口层照搬 custom 模式、UI 层挂两个按钮），适合一次性收敛。

## 2. 当前工程范围与边界

**纳入范围：**
- `models` 表新增"来源"维度（`source` 列），让 migration / catalog / user 三条写入路径互不踩踏；
- 新增 `POST/PATCH/DELETE /api/models` 接口，覆盖非 custom platform 的模型增删改；
- `GET /api/models` 响应新增 `source` 字段，前端据此区分删除策略；
- `applyCatalog` 调整删除候选条件 + 升级 user→catalog 的接管语义；
- KeysPage 在 Provider section header 与每张 KeyCard 上挂 `[⚙ 管理模型]` 入口；
- 新前端组件 `ManageModelsDrawer.tsx`；
- 顺手清理 `providers/index.ts` 中重复注册的 `agnes`。

**不纳入范围：**
- per-key model allowlist（不同 key 跑不同 model 子集）— 探索阶段已确认非真实需求；
- 把 `migrateModelsV1..V27` 全部搬走（保留作为出厂默认）；
- 远程 catalog 的发布工具链改造；
- desktop 客户端 UI 入口；
- 权限隔离 / 审计日志 / "重置出厂"按钮（目标用户即维护者本人，重启即可）；
- `intelligence_rank / speed_rank / size_label / 各 limits` 字段的 UI 编辑（本期 user 模型用固定默认值）。

## 3. 业务语义拆解

**业务对象**：模型（Model）。每个模型由 `(platform, modelId)` 唯一标识，附带 `displayName`、`enabled`、`contextWindow`、`supportsVision`、`supportsTools` 等元数据。

**业务规则**：

1. **来源（Source）三分**：
   - `migration`：项目代码内置，发版时通过 `migrateModelsVN(db)` 写入；
   - `catalog`：远程签名目录同步而来，由 `applyCatalog` 写入；
   - `user`：维护者通过 UI 手加，由 `POST /api/models` 写入。
2. **冲突协议**（沿用并明确化现有语义）：
   - 同 `(platform, modelId)` 的写入按"晚到者升级语义"：user 模型被 catalog 命中 → 升级为 catalog 接管，metadata 跟 catalog；user 的"启用/禁用"状态独立保留；
   - catalog 想 enable 一个用户已禁用的模型 → **不复活**（已是现状）；
   - catalog 想 disable 一个上游已死的模型 → **强制禁用**（已是现状）；
   - catalog 同步的"删除"动作仅作用于 `source != 'user'` 的行（user 模型不被代清理）。
3. **删除策略二分**：
   - `source = 'user'` 的模型 → 允许 UI 硬删（`DELETE FROM models` + cascade `fallback_config`）；
   - `source ∈ {'catalog', 'migration'}` 的模型 → UI 仅暴露"禁用"（`enabled=0` toggle），不允许硬删，避免与下次 sync / migration 的回插冲突。
4. **入口对等**：Provider section header 上的入口和每张 KeyCard 上的入口打开同一个 Drawer，列表 predicate 都是 `platform`（不是 `key_id`），因为 platform 下所有 key 共享同一个 model 池。

**关键场景**：
- (S1) 维护者在 UI 加 `groq/qwen-3-coder-next-512b` → 立即可用，无需重启；
- (S2) 下次 `catalog-sync` 跑了，catalog 也收录了同名模型 → 该行 source 升为 'catalog'，metadata 跟 catalog，enabled 保留用户当前值；
- (S3) 维护者禁用 `google/gemini-2.5-pro` → 下次 sync 不复活；
- (S4) catalog 删掉一个旧模型 `cerebras/qwen3-235b` → 仅当其 `source != 'user'` 时被删；
- (S5) 维护者删一个 `source='catalog'` 模型 → 接口 400 拒绝，引导用户改用"禁用"。

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| 模型来源 | `models.source TEXT` 列 | `server/src/db/migrations.ts`（schema + migration） | 取值 `'migration' \| 'catalog' \| 'user'`，默认 `'migration'` |
| 维护者增模型 | `POST /api/models` | `server/src/routes/models.ts`（新增 handler） | body 必填 `platform`、`modelId`；`source='user'` 写入；自动加 fallback |
| 维护者改模型 | `PATCH /api/models/:id` | 同上 | body 可改 displayName/enabled/contextWindow/supportsVision/supportsTools |
| 维护者删模型 | `DELETE /api/models/:id` | 同上 | 仅 `source='user'` 允许；其余返回 400 |
| 区分来源的 UI | `GET /api/models` 响应增 `source` | `server/src/routes/models.ts:9-52` | 前端按 source 决定显示"禁用"还是"删除" |
| Sync 不删用户模型 | `applyCatalog` 删除候选追加 `AND source != 'user'` | `server/src/services/catalog-sync.ts:226-237` | 只改一句 SQL |
| Catalog 接管 user 模型 | `applyCatalog` 命中已存在 user 行时 UPDATE 把 source 升级为 catalog | `server/src/services/catalog-sync.ts:178-203` | 在已有 update 分支里加一个 source 写入 |
| Provider 入口 | KeysPage Provider section header 加按钮 | `client/src/pages/KeysPage.tsx` | 用 lucide `Settings2` 图标 |
| Key 入口 | KeysPage KeyCard 加按钮 | 同上 | 打开同一个 Drawer，预过滤 platform |
| 模型管理 UI | `ManageModelsDrawer.tsx` 新组件 | `client/src/pages/components/ManageModelsDrawer.tsx`（新文件） | 列表 + 新增表单 + 编辑表单 + toggle/delete |
| 重复注册清理 | 删除 `agnes` 的第二次 `register(...)` | `server/src/providers/index.ts:212` | 死代码清理，不影响行为 |

## 5. 变更清单

**新增**：
- `models.source` 列；
- `POST /api/models`、`PATCH /api/models/:id`、`DELETE /api/models/:id` 三个路由；
- `GET /api/models` 响应里的 `source` 字段；
- 前端 `ManageModelsDrawer` 组件；
- KeysPage 上两处 `[⚙ 管理模型]` 入口按钮；
- 提供本 capability 的英文 spec：`user-managed-models`。

**修改**：
- `applyCatalog`：UPDATE/INSERT 显式写 `source='catalog'`；删除候选 SQL 追加 `AND source != 'user'`；命中 user 模型时把 source 升级为 'catalog'。

**移除**：
- `providers/index.ts` 中重复的第二次 `register(new OpenAICompatProvider({ platform: 'agnes', ... }))`（死代码）。

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 影响对象 | 验收口径 |
|---|---|---|---|---|
| 加 modelId 不发版 | 新 `POST /api/models` + `ManageModelsDrawer` + KeysPage 入口 | `user-managed-models` | `routes/models.ts`、`KeysPage.tsx`、新组件 | UI 加完模型后，无需重启即可在 `/v1/chat/completions` 用该 model 路由成功 |
| user 模型不被 sync 删 | `applyCatalog` 删除候选追加 `source != 'user'` | `user-managed-models` | `services/catalog-sync.ts` | sync 一轮后 user 模型仍在 DB 中、`fallback_config` 中 |
| 用户禁用状态在 sync 后保留 | （现状已正确，仅在 spec 中固化）| `user-managed-models` | `services/catalog-sync.ts:198` | 用户 disable → 下次 sync → 模型仍 enabled=0 |
| catalog 接管 user 模型 | `applyCatalog` UPDATE 分支升级 source | `user-managed-models` | `services/catalog-sync.ts:178-203` | user 模型被 catalog 命中后，`source='catalog'`、enabled 保留用户值 |
| 删除策略按 source 分流 | 新 `DELETE /api/models/:id` + UI 按钮分支 | `user-managed-models` | `routes/models.ts`、`ManageModelsDrawer` | 对 `source != 'user'` 调 DELETE → 400；UI 上按钮文案分别为"禁用"/"删除" |
| 清理重复注册 | 删 `providers/index.ts` 第二次 `agnes` register | （非 capability，质量改动）| `providers/index.ts` | 启动后 `getAllProviders()` 数量不变，行为一致 |

## 7. Capabilities

### 新增 Capabilities
- `user-managed-models`: 维护者在前端 UI 上对任意 provider（包括 catalog/migration 来源）的模型清单做"增 / 改 / 启用-禁用 / 删除"，并保证此能力与远程 catalog 同步、出厂 migrations 互不踩踏。覆盖三种模型来源的写入打标、sync 时的保留 / 接管 / 强制禁用语义、以及 user 模型独有的硬删权限。

### 修改 Capabilities
- 无（既有 capability 的对外行为不变；catalog-sync 的对外语义保持不变，仅写入侧打 `source` 标签 + 删除候选条件加一句过滤）。

### 移除 Capabilities
- 无。

## 8. 复杂度判定

**复杂度结论**：复杂需求

**判定依据**：
- [x] 涉及两个及以上模块、服务或分层（数据层 schema、后端路由、前端组件、catalog-sync 服务）
- [x] 涉及接口协议、数据结构、存储模型变化（新增 3 个路由 + `models` 表加列）
- [x] 涉及迁移、灰度、回滚、兼容处理（schema 加列要兼容已存在的旧行）
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡（接口本身简单，幂等性靠 `UNIQUE(platform, model_id)` 的 ON CONFLICT 兜住）
- [ ] 仅依靠 proposal + specs 无法稳定拆出 tasks（其实可以，但跨层多）

**Design 是否必需**：必需

**说明**：虽然每一处单独的改动都不复杂，但本次跨"DB schema → backend route → frontend drawer → 第三方协同（catalog-sync）"四层；同时引入了新业务规则（source 三分 + 冲突协议）。值得用 design.md 把"三种 source 的写入/读出/冲突表"集中讲清，避免 tasks 阶段每一步都要重新推导规则。

## 9. Knowledge 使用与影响

**本次使用的 Knowledge：**
- 项目根 `CLAUDE.md`
- `openspec/specs/provider-agnes/spec.md`、`openspec/specs/model-agnes-2.0-flash/spec.md`
- 仓库内既有代码注释（`catalog-sync.ts`、`keys.ts` 的 inline rationale）

**Knowledge 证据：**
- Source: `server/src/services/catalog-sync.ts:130-260`
- Evidence: `applyCatalog` 函数顶部的 "Rules of engagement with user data" 注释块明确了 user 数据保留语义。
- 可信度: high
- 未证实推断: 无

- Source: `server/src/routes/keys.ts:180-280`
- Evidence: `POST /api/keys/custom` 已实现"UI 加 model + 自动加 fallback_config + UNIQUE 冲突合并"，本次按同模板扩展。
- 可信度: high
- 未证实推断: 无

**本次受影响的 Knowledge：**
- 无既有 knowledge 文档需要因本次变更而失效或更新。

**是否需要新增 Knowledge 文档**：否

**说明**：本次的所有约束和规则都会沉淀进 `openspec/specs/user-managed-models/spec.md` 与代码注释，无需在 `CLAUDE.md` 或外部 knowledge 中额外建档。

## 10. 影响评估

**受影响代码**：
- `server/src/db/migrations.ts`（加列 + 新 migration 函数）
- `server/src/services/catalog-sync.ts`（写入打标 + 删除条件 + 接管语义）
- `server/src/routes/models.ts`（新增 3 个 handler + GET 响应加字段）
- `server/src/providers/index.ts`（删重复行）
- `server/src/__tests__/services/catalog-sync.test.ts` 等相关测试（新增 user 保留语义的用例）
- `client/src/pages/KeysPage.tsx`（挂入口按钮）
- `client/src/pages/components/ManageModelsDrawer.tsx`（新文件）
- `shared/types.ts`（如有 Model 类型，加 `source` 字段）

**受影响接口**：
- `GET /api/models`：响应新增 `source` 字段（向后兼容，旧客户端忽略即可）；
- `POST/PATCH/DELETE /api/models`：全新增。

**受影响数据**：
- `models` 表加列；现有所有行 `source` 默认为 `'migration'`（即使曾来自 catalog 也会被回填为 migration，不影响后续行为）。

**受影响系统/链路**：
- 路由器 `services/router.ts`、`scoring.ts` 等读路径**不受影响**（不读 `source`）；
- catalog-sync 行为对外可见的语义不变。

**回滚预案**：
- DB 加列是 idempotent ALTER，无破坏性；
- 三个新接口未被旧客户端使用，回滚只需删 handler；
- 前端按钮可独立 feature flag 隐藏。

## 11. 非目标与后续议题

**本期不做**：
- per-key model allowlist；
- desktop 端 UI 入口；
- user 模型暴露 ranks / limits / monthly_token_budget 编辑能力；
- 批量导入 / 导出 user-added 模型；
- "重置出厂"按钮；
- 操作审计日志。

**后续可议**：
- 如果维护者发现 user 模型默认 rank=50 排序不合适，再加一个 rank 编辑 UI；
- 如果出现"同一 platform 多 baseUrl"的非 custom 场景（目前不存在），再考虑 per-key allowlist。

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界，且不是简单模块名
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需
- [x] 未写入具体实现代码或过细任务
- [x] 已列出仍需确认的问题，且不阻塞 specs 的事项已标明
