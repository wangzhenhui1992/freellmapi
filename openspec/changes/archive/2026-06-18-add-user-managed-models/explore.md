## 1. 输入需求与原始上下文

**原始需求**：
> 能不能把某个 provider 支持的模型列表做成页面上可管理配置的，不要写死了，每次有更新我都要开发一下，只是加个 modelname。

**目标用户**：项目维护者本人（dev / ops 一体）。

**痛点**：上游 provider（Groq、Cerebras、Google、Agnes 等）频繁新增 / 替换免费模型；当前每次新增一个 `model_id` 都需要：
1. 在 `server/src/db/migrations.ts` 写一个新的 `migrateModelsVN(db)` 函数；
2. 提交 / 构建 / 发版；
3. 用户重启服务后才能用上。

期望：在前端 KeysPage 上直接增删模型，不再走代码发版。

## 2. 业务目标与成功标准

**业务目标**：让"加一个模型"这件事从"开发任务"变成"配置任务"。

**成功标准**：
- 维护者在 `KeysPage` 上点 `[⚙ 管理模型]` → 输入 `modelId`（必要时 `displayName`）→ 保存 → **无需重启、无需发版**，路由器即可使用该模型。
- 用户手加的模型在下次 `catalog-sync` 之后**不会丢失**。
- 用户对官方目录模型的"禁用"状态在下次 `catalog-sync` 之后**仍被保留**。
- 三种来源（migration / catalog / user）的模型在 UI 上能区分，删除策略不同：catalog/migration 模型只能"禁用"，user 模型可"硬删"。

## 3. 当前工程职责边界

**纳入范围：**
- 在 `models` 表上引入"来源"维度，让三条写入路径互不踩踏；
- 提供 `POST/PATCH/DELETE /api/models` 接口，支持非 custom platform 的模型增删改；
- 在 KeysPage 上挂载 UI 入口（Provider section 头 + 每张 KeyCard）；
- 调整 `applyCatalog` 的删除候选条件，让 user 模型免于被 sync 删除；
- 顺手清理 `providers/index.ts` 中重复注册的 `agnes`。

**不纳入范围：**
- per-key model allowlist（不同 key 跑不同 model 子集）— 探索阶段已确认非真实需求；
- 把现有 `migrateModelsV1..V27` 全部搬走（保留作为出厂默认）；
- 远程 catalog 的发布工具链改造（catalog 维护方还是项目作者发签名包）；
- desktop 客户端 UI 入口（共享 `/api/models` 即可，UI 入口本次不做）；
- 权限隔离 / 审计日志（目标用户即维护者本人）。

## 4. 现状调研与证据

### 4.1 现有模块与入口

| 角色 | 路径 | 关键符号 |
|---|---|---|
| 模型表定义 | `server/src/db/migrations.ts:59` | `CREATE TABLE IF NOT EXISTS models (...)` |
| 模型出厂种子 | `server/src/db/migrations.ts:319-1928` | `migrateModelsV1..V27` |
| 远程目录同步 | `server/src/services/catalog-sync.ts:145-260` | `applyCatalog(db, catalog)` |
| Custom 模型增删（既有的"UI 加模型"先例，仅限 platform='custom'） | `server/src/routes/keys.ts:180-280` | `POST /api/keys/custom`、`DELETE /api/keys/:id` |
| 模型只读列表接口 | `server/src/routes/models.ts:9-52` | `modelsRouter.get('/')` |
| Provider 注册表 | `server/src/providers/index.ts` | `register(...)`，重复 `agnes` 在第 17 / 212 行 |
| Keys 页面（拟挂入口） | `client/src/pages/KeysPage.tsx` | `PLATFORMS` 常量、provider 卡片、KeyCard |

### 4.2 上下游与依赖

- **上游**：Provider 官方（Groq / Google / Cerebras / …）；远程 catalog 服务（签名 JSON）。
- **下游**：`services/router.ts` 选模型；`services/scoring.ts` 排序；`routes/proxy.ts` 实际转发；`fallback_config` 表保证 fallback 链。
- **数据依赖不变**：路由器读 `models` 表本身，不区分 source；本次只是给写入路径打标，读侧不动。

### 4.3 现有行为与约束

| 现有行为 | 引用 | 对本次的含义 |
|---|---|---|
| `applyCatalog` 已实现"catalog enable=true 不能复活用户禁用" | `catalog-sync.ts:198`（注释 + 代码） | sync 语义已对，**不动** |
| `applyCatalog` 删除候选 = `platform != 'custom' AND key_id IS NULL` | `catalog-sync.ts:226-237` | **冲突点**：用户手加的非 custom 模型在下次 sync 时会被删 → 必须修 |
| `models` 唯一约束 = `UNIQUE(platform, model_id)` | `migrations.ts:75` | 新增/编辑接口可直接复用 ON CONFLICT |
| `fallback_config` 必须有对应行 | `catalog-sync.ts:209-217` | POST /api/models 时必须同步插入 fallback 行 |
| `providers/index.ts` 第 17 行 与第 212 行 重复注册 `agnes` | `providers/index.ts` | 死代码，本次顺手清理 |

## 5. 改动点拆解

### 5.1 必做改动点

| # | 层 | 改动点 | 关键文件 |
|---|---|---|---|
| 1 | 数据 | `models` 表加 `source TEXT NOT NULL DEFAULT 'migration'` 列 | `server/src/db/migrations.ts` |
| 2 | 数据 | `applyCatalog` insert/update 时显式写入 `source='catalog'` | `server/src/services/catalog-sync.ts` |
| 3 | 数据 | `applyCatalog` 删除候选追加 `AND source != 'user'` | 同上 |
| 4 | 数据 | `applyCatalog` 命中已存在 `source='user'` 时升级为 `'catalog'` | 同上 |
| 5 | 接口 | 新增 `POST /api/models`（写入 `source='user'`，自动加 fallback） | `server/src/routes/models.ts` |
| 6 | 接口 | 新增 `PATCH /api/models/:id`（编辑 displayName / enabled / contextWindow / supportsVision / supportsTools） | 同上 |
| 7 | 接口 | 新增 `DELETE /api/models/:id`（仅 `source='user'`，cascade fallback） | 同上 |
| 8 | 接口 | `GET /api/models` 响应增加 `source` 字段 | 同上 |
| 9 | UI | 新组件 `ManageModelsDrawer.tsx`（按 platform 列表 + 增/删/编/toggle） | `client/src/pages/components/ManageModelsDrawer.tsx`（新文件） |
| 10 | UI | KeysPage Provider section 头部加 `[⚙ 管理模型]` 入口 | `client/src/pages/KeysPage.tsx` |
| 11 | UI | KeysPage 每张 KeyCard 加 `[⚙ 管理模型]` 入口（同 Drawer，预过滤 platform） | 同上 |
| 12 | 清理 | 删除 `providers/index.ts` 中重复的 `agnes` register | `server/src/providers/index.ts` |

### 5.2 可选 / 后续改动点

- desktop 端 UI 入口（与 web 共享 `/api/models`，但 desktop 是独立页面）
- 批量导入 / 导出 user-added 模型
- "重置出厂"按钮（目标用户是维护者本人，重启即可，本次不做）
- 编辑 `intelligence_rank / speed_rank / size_label`（当前 UI 不暴露，给固定默认值；后续视使用情况再加）
- 审计日志 / 操作记录

## 6. 追踪关系草案

| 业务目标 | 改动点 | 候选 Capability | 证据 | 状态 |
|---|---|---|---|---|
| 加 modelId 不发版 | #1, #5, #9, #10, #11 | `user-managed-models` | `keys.ts:180-280` 已有 custom 先例 | 已确认 |
| user 模型不被 sync 删 | #1, #2, #3 | `user-managed-models` | `catalog-sync.ts:226-237` | 已确认 |
| catalog 接管 user 模型时 metadata 跟 catalog | #4 | `user-managed-models` | `catalog-sync.ts:178-203` | 已确认 |
| user/catalog/migration 区分删除策略 | #1, #7, #9 | `user-managed-models` | 探索阶段共识 | 已确认 |
| 清理重复注册 | #12 | （非 capability，质量改动） | `providers/index.ts:17,212` | 已确认 |

## 7. 风险、未知项与待确认问题

**风险**：

- **R1（小）**：现有 `models` 表无 `source` 列，给已存在的行回填 `'migration'` 是安全的（默认值即可），但 catalog 已经写入过的旧行会被错误归类为 `migration`。后果：catalog 重新 push 时不会触发"接管 user→catalog"路径，但 enable 语义和删除候选条件均不受影响 → **可接受**。
- **R2（小）**：UI 暴露的字段集（modelId / displayName / contextWindow / supportsVision / supportsTools）省略了 `ranks/limits`，路由器排序时 user 模型会用固定默认 `intelligence_rank=50`、`speed_rank=50` → 排序靠后但不影响可用性。后续视需要再扩字段。
- **R3（小）**：`fallback_config` 自增 `priority = MAX+1`，user 模型默认排在所有内置模型之后 → 默认行为合理，不需要 UI 调整。

**未知项**：无。

**待确认问题**：探索阶段已收敛完毕，进入 proposal 阶段无阻塞问题。

## 8. Knowledge 使用情况

**已参考的 Knowledge 文档**：
- 项目根 `CLAUDE.md`（CodeGraph 使用规则、行为准则）
- `openspec/specs/provider-agnes/spec.md`、`openspec/specs/model-agnes-2.0-flash/spec.md`（作为现有模型注册形态的参考样本）
- 仓库内代码（`server/src/db/migrations.ts`、`server/src/services/catalog-sync.ts`、`server/src/routes/keys.ts`、`server/src/providers/index.ts`、`client/src/pages/KeysPage.tsx`）

**Knowledge 证据记录**：
- Source: `server/src/services/catalog-sync.ts:130-260`
- Evidence: `applyCatalog` 注释明确"catalog enable=true 不能复活用户禁用"+ 删除候选 `WHERE platform != 'custom' AND key_id IS NULL`。
- 结论属性: 知识证据支持

- Source: `server/src/routes/keys.ts:180-280`
- Evidence: 现有 custom platform 已实现"UI 加 model + 自动加 fallback_config + UNIQUE 冲突合并"，本次按同样模板扩展到所有 platform。
- 结论属性: 知识证据支持

**当前是否足够支撑后续阶段**：是

**说明**：核心三个写入路径（migration / catalog / user）的语义边界、UNIQUE 约束、fallback_config 不变量都已在代码中明确，无需额外外部知识。

## 9. Knowledge 缺口与回写预估

**疑似缺失或过期的 Knowledge**：无。

**本次预计需要新增或更新的 Knowledge**：无新增 knowledge 必要——本次改动属于工程内能力扩展，相关约束已沉淀在代码注释和 spec 中。

**Knowledge 写回建议**：无。

## 10. Capability 候选草案

### 新增 Capabilities
- `user-managed-models`: 通过前端 UI 增删改任意 provider 下的模型清单，并与 catalog-sync 协同工作。

### 修改 Capabilities
- 无（`provider-agnes` 等 platform 级 capability 不受本次影响；catalog-sync 的语义保持不变，仅写入侧打 `source` 标签）。

## 11. 阶段自检

- [x] 已明确本工程纳入范围和不纳入范围
- [x] 每个关键结论都有证据或标记为推断
- [x] 已列出进入 proposal 前必须确认的问题
- [x] 已给出业务目标到 capability 候选的追踪关系
- [x] 未写入具体实现方案或代码级任务
