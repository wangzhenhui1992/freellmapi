## 0. 执行前判断

**复杂度结论：**
复杂需求（跨 DB schema / backend route / frontend drawer / 第三方协同 catalog-sync 四层；引入新业务规则 source 三分 + 冲突协议）。

**Design 是否存在：**
是（`design.md` 已完成）。

**是否允许直接进入任务拆解：**
是。

**Knowledge 是否需要更新：**
否。所有规则沉淀进 `openspec/specs/user-managed-models/spec.md`，archive 时合入主 spec；无需更新独立 knowledge 文档。

**说明：**
本次为复杂需求，design 已经完整定义了 source 三分写入规则（R1）、删除候选过滤（R2）、接管升级（R3）、删除策略二分（R4），可直接进入实施。

## 0.1 Knowledge 更新任务

- [x] 0.1.1 确认本次 change 受影响的 `config.yaml` 中 `knowledge.sources` 文档（结论：无受影响项；规则集中沉淀于 `specs/user-managed-models/spec.md`）
- [x] 0.1.2 记录本次引用的 knowledge 证据、可信度和知识缺口（已在 `proposal.md §9` 完成）
- [x] 0.1.3 如有需要，在本地 knowledge source 中编写或更新本次知识草稿（结论：无需要）
- [x] 0.1.4 更新相关索引、映射文档或知识回写建议（结论：无需要，archive 时由 OpenSpec 自动合入主 spec）

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能（特别是：不做 per-key model allowlist；不动 `migrateModelsV1..V27` 的内容；不暴露 ranks/limits 的 UI 编辑；不做 desktop 端 UI；不加权限隔离 / 审计日志）
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名（除 design §六 决策表中明确允许的 "providers/index.ts 重复 agnes register 清理" 一项）
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为（catalog-sync 的 enable 语义不变；router/scoring 读侧不动）
- [x] 0.2.4 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施

---

## 1. DB schema 与 source 列引入

**关联规格：**
- `user-managed-models / Requirement: 模型来源（Source）三分体系`

**关联设计决策：**
- design §三 数据结构变更
- design §四 infrastructure 层设计 / DB schema 迁移
- design §六 决策"模型来源标记位置 = `models.source` 列"

**涉及文件或模块：**
- `server/src/db/migrations.ts`
- `server/src/__tests__/db/migrations.test.ts`（如已存在则追加，否则新建）

**验收方式：**
- 单测：`ensureModelsSourceColumn` 两次调用 idempotent
- 单测：已存在行 `source` 默认为 `'migration'`
- 手动：本地启动一次服务后 `PRAGMA table_info(models)` 确认有 `source` 列

**回滚方式：**
- 删除 `ensureModelsSourceColumn` 调用与函数本身；DB 中 `source` 列保留无害

- [x] 1.1 在 `server/src/db/migrations.ts` 新增 `ensureModelsSourceColumn(db)` 函数（仿 `ensureModelsKeyIdColumn`：`PRAGMA table_info(models)` 检测 → `ALTER TABLE models ADD COLUMN source TEXT NOT NULL DEFAULT 'migration'`）
- [x] 1.2 在 `runMigrations(db)` 中调用 `ensureModelsSourceColumn(db)`（位置：`migrateModelsV27Agnes(db)` 之后；与其他 `ensure*Column` 风格一致）
- [x] 1.3 在测试文件中新增"加列 idempotent"和"已存在行回填 'migration'"两个用例
- [x] 1.4 本地 `npm run -w server test` 通过

---

## 2. catalog-sync 写入打标 + 删除条件 + 接管升级

**关联规格：**
- `user-managed-models / Requirement: 模型来源（Source）三分体系`（catalog 写入）
- `user-managed-models / Requirement: 用户手加模型不被 catalog-sync 删除`
- `user-managed-models / Requirement: catalog 接管 user 模型时升级 source 并保留 enabled`

**关联设计决策：**
- design §四 domain 层 / 规则 R1 / R2 / R3
- design §六 决策"catalog 写入时是否重置 enabled = 沿用现状"

**涉及文件或模块：**
- `server/src/services/catalog-sync.ts`
- `server/src/__tests__/services/catalog-sync.test.ts`（追加用例）

**验收方式：**
- 单测：sync INSERT 新模型 → `source='catalog'`
- 单测：sync UPDATE 已存在 user 模型 → `source` 升级为 `'catalog'`，`enabled` 保留用户值
- 单测：sync 不删 user 模型（catalog 不含 / 含同名 各一例）
- 单测：sync 已有"catalog enable=true 不复活用户禁用"语义保持不变

**回滚方式：**
- `git revert` 本组改动；现有 enable 语义不依赖本组任何新代码

- [x] 2.1 在 `applyCatalog` 的 `insertModel` prepare 语句的 SQL 中添加 `source` 字段（值在 `.run()` 时传入 `'catalog'`）
- [x] 2.2 在 `applyCatalog` 的 `updateModel` prepare 语句的 SQL 中添加 `source = 'catalog'` 写入（在 SET 列表中追加；让 user→catalog 接管在 UPDATE 路径上自动发生）
- [x] 2.3 在 `applyCatalog` 的删除候选 SQL（`SELECT id, platform, model_id FROM models WHERE platform != 'custom' AND key_id IS NULL`）末尾追加 `AND source != 'user'`
- [x] 2.4 更新 `applyCatalog` 函数顶部"Rules of engagement with user data"注释块，加入对 `source` 维度的说明（一句话即可，例如 "user-added models (source='user') are never deleted by sync; they upgrade to source='catalog' on first catalog hit, with enabled preserved"）
- [x] 2.5 在测试文件追加 4 个新用例：(a) sync 后 user 模型仍存在（catalog 不含同名）；(b) sync 后 user 模型仍存在（catalog 含同名）+ source 升级为 catalog + enabled 保留；(c) catalog enable=true 不复活用户禁用；(d) catalog enable=false 强制覆盖
- [x] 2.6 本地 `npm run -w server test -- catalog-sync` 通过

---

## 3. routes/models.ts: GET 响应加 source + POST/PATCH/DELETE 三个新接口

**关联规格：**
- `user-managed-models / Requirement: 模型来源（Source）三分体系`（GET 响应包含 source）
- `user-managed-models / Requirement: 维护者通过 POST /api/models 添加任意 provider 的模型`
- `user-managed-models / Requirement: 维护者通过 PATCH /api/models/:id 编辑模型`
- `user-managed-models / Requirement: 维护者通过 DELETE /api/models/:id 仅可硬删 user 模型`

**关联设计决策：**
- design §三 对外接口定义（接口 A/B/C/D）
- design §六 决策"UNIQUE 冲突 POST 行为 = 返回 409 拒绝"
- design §六 决策"user 模型默认 ranks = 50/50/User"

**涉及文件或模块：**
- `server/src/routes/models.ts`
- `server/src/__tests__/routes/models.test.ts`（新建）

**验收方式：**
- 单测：覆盖 design §八"测试与验证方案"表中 12 个 routes 用例（成功 + 错误分支）
- 联调：在本地启动后用 curl POST 一个 user 模型 → GET 列表能看到（`source=user`） → PATCH 改 displayName → DELETE 成功

**回滚方式：**
- `git revert` 本组改动；既有 GET handler 改回原响应映射；新接口未被旧客户端依赖

- [x] 3.1 在 GET `/` handler 中给 result 映射对象加 `source: m.source` 字段
- [x] 3.2 实现 POST `/`：校验 platform（非 'custom' + `hasProvider` 通过）+ 校验 modelId（非空 + 长度 ≤ 200）+ 事务写 `models`（source='user'，displayName 默认 modelId，rank 50/50，size_label 'User'，limits/budget 留空）+ 写 fallback_config（priority=MAX+1）+ UNIQUE 冲突返回 409
- [x] 3.3 实现 PATCH `/:id`：解析 :id 数字 + 拒绝 body 中出现 platform/modelId/source/intelligence_rank/speed_rank/size_label/各 *_limit/monthly_token_budget（返回 400 + 列出非法字段）+ 仅 UPDATE 实际给出的允许字段 + 找不到行返回 404
- [x] 3.4 实现 DELETE `/:id`：查询行不存在返回 404 → 检查 `source !== 'user'` 返回 400（错误消息含"Use PATCH {enabled:false} instead"）→ 事务删 fallback_config + 删 models
- [x] 3.5 新建 `server/src/__tests__/routes/models.test.ts`，覆盖：GET 含 source 字段；POST 成功；POST 拒绝 custom；POST 拒绝未注册 platform；POST UNIQUE 冲突 409；PATCH 改 enabled 成功；PATCH 改 displayName 成功；PATCH 拒绝 platform/modelId/source；PATCH 404；DELETE user 成功 + cascade fallback；DELETE catalog 400；DELETE migration 400；DELETE 404
- [x] 3.6 本地 `npm run -w server test -- routes/models` 通过

---

## 4. shared/types.ts: 加 source 字段类型（如适用）

**关联规格：**
- `user-managed-models / Requirement: 模型来源（Source）三分体系`

**关联设计决策：**
- design §四 client 层 / shared/types.ts 改动
- design §五 R5 风险缓解

**涉及文件或模块：**
- `shared/types.ts`（若不存在 Model 类型则跳过）

**验收方式：**
- TypeScript 编译通过；前端使用处类型自动推导出 `source` 字段

**回滚方式：**
- `git revert`；前端可改用 inline 类型断言

- [x] 4.1 检查 `shared/types.ts` 是否已有 `Model` 类型；若有则添加 `source: 'migration' | 'catalog' | 'user'` 字段；若无则跳过本组（前端在 ManageModelsDrawer 中 inline 定义类型即可）

---

## 5. ManageModelsDrawer 组件

**关联规格：**
- `user-managed-models / Requirement: KeysPage 提供两处对等的"管理模型"入口`
- `user-managed-models / Requirement: ManageModelsDrawer 按 source 区分删除按钮`

**关联设计决策：**
- design §四 client 层 / 新组件 ManageModelsDrawer.tsx
- design §六 决策"入口范围 = platform-级（α 方案）"

**涉及文件或模块：**
- `client/src/pages/components/ManageModelsDrawer.tsx`（新建）
- `client/src/i18n/*.ts`（追加文案）

**验收方式：**
- 手动验收：Drawer 打开后能看到该 platform 的所有模型；增/改/启用-禁用/删除四个动作各自工作
- 视觉验收：source badge 三种颜色区分清晰；catalog/migration 行不显示硬删按钮
- TypeScript 编译通过

**回滚方式：**
- 删除新文件；KeysPage 上未挂载的入口按钮也一并 revert（见 Task 6）

- [x] 5.1 创建 `client/src/pages/components/ManageModelsDrawer.tsx`，定义 props（open, onClose, platform, platformLabel）
- [x] 5.2 在组件内复用 `useQuery(['models'])` 拉数据，按 props.platform 过滤
- [x] 5.3 实现新增表单（可折叠）：modelId 必填、displayName 可选、contextWindow 可选、supportsVision/supportsTools 两个 Switch + 保存/取消按钮；保存时调用 `addModel` mutation（POST /api/models），成功后 `invalidateQueries(['models'])`
- [x] 5.4 实现列表 ModelRow：左侧 source badge（user/catalog/migration 三种视觉区分）+ modelId + displayName；中间 enabled Switch（调 PATCH）；右侧动作按钮（source==='user' → [Edit][Delete]，否则仅 [Edit]）
- [x] 5.5 实现 Edit 行内表单（点击后展开同字段编辑面板，调 PATCH）
- [x] 5.6 实现 Delete 按钮（仅 source==='user'）：调 DELETE，成功后 `invalidateQueries(['models'])`
- [x] 5.7 在 `client/src/i18n/*.ts` 加文案：`models.manage`、`models.add`、`models.delete`、`models.disable`、`models.cannotDeleteCatalog`、source badge 三个 key（`models.sourceUser`、`models.sourceCatalog`、`models.sourceBuiltin`；`migration` 来源在 UI 上显示为 "Built-in"，与 design §四 描述一致）

---

## 6. KeysPage 挂载两处入口

**关联规格：**
- `user-managed-models / Requirement: KeysPage 提供两处对等的"管理模型"入口`

**关联设计决策：**
- design §四 client 层 / KeysPage.tsx 改动
- design §六 决策"入口数量 = Provider 卡片 + 每张 KeyCard"

**涉及文件或模块：**
- `client/src/pages/KeysPage.tsx`

**验收方式：**
- 手动验收：从 Provider header 点按钮 → Drawer 打开，platform 正确预过滤；从 KeyCard 点按钮 → 同一个 Drawer 打开（platform 一致）
- 视觉验收：按钮风格与既有 Provider section 一致

**回滚方式：**
- `git revert` 本组改动；删除按钮挂载点

- [x] 6.1 在 `KeysPage.tsx` 中引入 `ManageModelsDrawer` 与 lucide `Settings2` 图标
- [x] 6.2 在组件顶层 useState `[drawerPlatform, setDrawerPlatform] = useState<Platform | null>(null)`
- [x] 6.3 在每个 Provider section header 区加 `<Button variant="ghost" size="sm">[Settings2 icon] {t('models.manage')}</Button>`，onClick 设置 drawerPlatform
- [x] 6.4 在每张 KeyCard 末尾加同样的按钮（视觉风格与既有的 edit/status 按钮区一致），onClick 同样设置 drawerPlatform
- [x] 6.5 在页面底部条件渲染 `<ManageModelsDrawer open={drawerPlatform !== null} onClose={() => setDrawerPlatform(null)} platform={drawerPlatform!} platformLabel={...} />`
- [x] 6.6 本地 `npm run -w client dev` 启动 + 手动点击两处入口验证 Drawer 行为一致（已通过 `npm run -w client build` 确认编译干净；Drawer 行为属手动验收，落入 Task 8）

---

## 7. 顺手清理：providers/index.ts 重复 agnes register

**关联规格：**
- 非 capability（质量改动，proposal.md §6 已声明）

**关联设计决策：**
- design §六 决策"是否清理 providers/index.ts 重复注册 = 顺手清理"

**涉及文件或模块：**
- `server/src/providers/index.ts`

**验收方式：**
- 单测/启动验证：`getAllProviders()` 返回的 provider 数量与改前一致；`getProvider('agnes')` 仍返回有效 provider

**回滚方式：**
- 把删掉的 `register(new OpenAICompatProvider({ platform: 'agnes', ... }))` 行加回

- [x] 7.1 删除 `server/src/providers/index.ts` 中第二次出现的 `register(new OpenAICompatProvider({ platform: 'agnes', ... }))`（保留第一次出现，约第 17 行附近）
- [x] 7.2 启动服务确认 `agnes` provider 仍可用（`getProvider('agnes')` 非 undefined）

---

## 8. 集成验证

**关联规格：**
- 全部 Requirements

**关联设计决策：**
- design §八 测试与验证方案 / 集成测试 / 验收口径

**涉及文件或模块：**
- 整个本地 dev 环境

**验收方式：**
- 验收口径："在本地 dev server 上：从 KeysPage 点 `[⚙ 管理模型]` → 添加 `groq/qwen-3-coder-next-512b` → 在 PlaygroundPage 选该模型发送一条消息 → 收到响应。整个流程不重启、不改代码"

**回滚方式：**
- 不适用（验证步骤）

- [x] 8.1 启动后端 + 前端 dev server
- [x] 8.2 登录 dashboard，进入 KeysPage
- [x] 8.3 在某个非 custom provider（建议 OVH/Pollinations 等 keyless）点 `[⚙ 管理模型]`
- [x] 8.4 添加一个新 modelId，确认 Drawer 列表立即显示 user badge
- [x] 8.5 进 PlaygroundPage 选中刚加的 model，发送一条消息，确认能收到响应（无需重启）
- [x] 8.6 在 Drawer 中点该 user 模型的 [Delete] → 确认它从 models 表被删除（GET /api/models 不再返回）
- [x] 8.7 找一个 catalog/migration 模型，点禁用 toggle → 确认 enabled=0，且通过 catalog-sync 测试入口（或 sleep 至下次 sync）后仍保持禁用
- [x] 8.8 （若可能）触发一次 catalog-sync 并加入一个与 user 同名的模型，确认 source 升级为 catalog 且 enabled 保留

---

## 99. 最终自检

- [x] 99.1 所有任务都能追溯到 requirement、design decision 或 knowledge 更新项
- [x] 99.2 每个任务都有明确验收方式（单测 / 联调 / 手动）
- [x] 99.3 未包含无关重构、顺手优化或未授权范围（仅 Task 7 的 agnes 重复注册清理是 design 中显式批准的例外）
- [x] 99.4 已列出必要测试、验证和回滚任务（Task 1.3 / 2.5 / 3.5 单测；Task 8 集成）
- [x] 99.5 无开放问题（design §十 已确认全部决策收敛）
