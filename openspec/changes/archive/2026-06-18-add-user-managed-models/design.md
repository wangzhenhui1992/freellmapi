# 一、背景知识

## 业务背景

freellmapi 聚合多家免费 / 部分付费 LLM provider 的接口，为 Claude Code / OpenAI 兼容客户端提供"统一 base URL + 智能路由"。上游 provider 的免费模型清单是**高频变化的资产**：每周都会有新模型上线、旧模型下线、限流额度调整。当前每加一个 modelId 都要走代码路径（写 migration → 发版 → 用户重启），把"配置"硬扛在"代码"轨道上。

业务目标见 proposal.md §1：把"加 modelId"从开发任务降级为配置任务。

## 技术背景

**模型清单的三条写入路径已经存在**：

1. `migrateModelsV1..V27`（`server/src/db/migrations.ts:319-1928`）—— 启动时硬编码 INSERT；
2. `applyCatalog`（`server/src/services/catalog-sync.ts:145-260`）—— 远程签名目录写入；
3. `POST /api/keys/custom`（`server/src/routes/keys.ts:180-280`）—— 仅限 `platform='custom'`，UI 加 model 的先例。

三者共享 `models` 表（`UNIQUE(platform, model_id)`），共同维护 `fallback_config` 不变量。

**关键现状（已正确，不动）**：`applyCatalog` 已实现"catalog enable=true 不能复活用户已禁用的模型"语义（`catalog-sync.ts:198`）。本次只需在它之上加 `source` 维度。

**关键缺陷**：`applyCatalog` 的删除候选 SQL（`catalog-sync.ts:226-237`）是 `WHERE platform != 'custom' AND key_id IS NULL`。一旦 user 通过新 `POST /api/models` 加了非 custom platform 的模型，下次 sync 就会把它当作"catalog 未列出"删掉。本次必须修。

## 现有知识沉淀

- `/Users/wangzhenhui/Desktop/tools/freellmapi/CLAUDE.md`（CodeGraph 与编码原则）
- `/Users/wangzhenhui/Desktop/tools/freellmapi/openspec/specs/provider-agnes/spec.md`、`openspec/specs/model-agnes-2.0-flash/spec.md`（既有 platform/model 级 spec 范式）
- `server/src/services/catalog-sync.ts:130-260`（`applyCatalog` 顶部的"Rules of engagement with user data"注释）
- `server/src/routes/keys.ts:180-280`（custom 平台 UI 加 model 的现成模板）
- 本 change 的 `explore.md`、`proposal.md`、`specs/user-managed-models/spec.md`

# 二、名词解释

| 业务语言 | 技术自然语言 | 技术代码语言 |
|---|---|---|
| 维护者 | 项目作者 / 部署者，目标用户 | 通过 dashboard auth（`requireAuth`）登录的 dashboard 用户 |
| 模型 | provider 提供的可调用 LLM | `models` 表一行；由 `(platform, model_id)` 唯一标识 |
| 模型来源 | 一条模型行从哪条写入路径来 | `models.source TEXT` 列；取值 `'migration' \| 'catalog' \| 'user'` |
| 出厂模型 | 项目代码内置的默认模型 | `migrateModelsVN(db)` 写入；`source='migration'` |
| 目录模型 | 远程 catalog-sync 拉来的模型 | `applyCatalog(db, catalog)` 写入；`source='catalog'` |
| 用户模型 | 维护者通过 UI 手加的模型 | `POST /api/models` 写入；`source='user'` |
| 启用 / 禁用 | 是否参与路由分发 | `models.enabled` 列（`0` / `1`） |
| 接管 | 用户模型被远程 catalog 收录后变为目录模型 | `applyCatalog` UPDATE 时把 `source='user'` 升级为 `'catalog'` |
| 模型管理入口 | KeysPage 上的"管理模型"按钮 | Provider section header + KeyCard 上的 `<Button>` |
| 模型管理面板 | 列表 + 增删改的弹层 | 新组件 `client/src/pages/components/ManageModelsDrawer.tsx` |

# 三、业务流程设计（纵向）

## 系统相关现状

### 领域划分

```
┌─────────────────────────────────────────────────────────────────┐
│  Domain: Models                                                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  models 表（核心实体）                                    │   │
│  │  PK: id   UNIQUE(platform, model_id)                    │   │
│  │  附属：fallback_config (1:1)                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                  ▲           ▲           ▲                      │
│                  │           │           │                      │
│         ┌────────┴───┐ ┌────┴────┐ ┌────┴───────────┐         │
│         │ migrations │ │ catalog │ │ user (UI)      │         │
│         │ 启动时写   │ │ sync 写 │ │ POST /api/...  │         │
│         └────────────┘ └─────────┘ └────────────────┘         │
│         源：代码        源：远程     源：维护者                 │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Domain: Routing (读侧，本次不动)                                 │
│  router.ts / scoring.ts / proxy.ts                              │
│  仅读 models 表（不读 source）                                   │
└─────────────────────────────────────────────────────────────────┘
```

读侧（router / scoring / proxy）**不感知 source**，照常按 `enabled = 1` 过滤。

### 数据结构设计

**当前 `models` 表**（节选自 `migrations.ts:59-77`）：

```sql
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intelligence_rank INTEGER NOT NULL,
  speed_rank INTEGER NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  rpm_limit INTEGER, rpd_limit INTEGER,
  tpm_limit INTEGER, tpd_limit INTEGER,
  monthly_token_budget TEXT NOT NULL DEFAULT '',
  context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  -- (后续 migration 加上的) supports_tools, key_id, ...
  UNIQUE(platform, model_id)
);
```

**附属表**：`fallback_config (id, model_db_id, priority, enabled)`，每个 `models.id` 必有一行。

### 主要业务流程

**Sync 主流程**（节选自 `catalog-sync.ts:170-240`）：

```
applyCatalog(db, catalog)
├── 遍历 catalog.models
│   ├── 跳过 platform='custom' 或未注册 platform
│   ├── selectModel: 查 (platform, modelId) 是否已存在
│   ├── 若已存在 → UPDATE metadata，enabled = catalog.enabled ? row.enabled : 0
│   └── 若不存在 → INSERT，enabled = catalog.enabled ? 1 : 0
├── 补齐 fallback_config（无对应行的补一行）
└── 删除 catalog 未列出的"catalog-managed"模型
    └── candidates = SELECT * FROM models WHERE platform != 'custom' AND key_id IS NULL
        └── 不在 inCatalog 集合 → DELETE fallback_config + DELETE models
```

**Custom 模型加流程**（节选自 `keys.ts:180-280`）：

```
POST /api/keys/custom
├── 解码 baseUrl, apiKey, [{modelId, displayName}]
├── 创建 api_keys 行（platform='custom', base_url=baseUrl）
├── 对每个 modelId
│   ├── INSERT/UPDATE models (platform='custom', model_id=`${keyId}-${modelId}`, key_id=keyId, ranks=50, size_label='Custom')
│   └── INSERT fallback_config 若未存在
└── 返回 { keyId, registered }
```

## 本次新增改动

### 领域划分变更（增）

新增子域：**用户模型管理**（user-managed-models）。
- 新接口域：`/api/models`（POST/PATCH/DELETE）；
- 新前端组件域：`ManageModelsDrawer`；
- 既有 catalog-sync 子域**不下放责任**，仅在写入侧 + 删除候选条件做最小调整。

### 数据结构变更

**新增列**：

```sql
-- 通过 idempotent ALTER 加列：
ALTER TABLE models ADD COLUMN source TEXT NOT NULL DEFAULT 'migration';
```

- 写法：在 `migrations.ts` 中新增一个 `ensureModelsSourceColumn(db)` 形如已有 `ensureModelsKeyIdColumn` 的 idempotent 函数（PRAGMA table_info 检测 + ALTER TABLE）。
- 默认值：`'migration'` —— 已存在的所有行回填该值。R1 已记录：catalog 已写入过的旧行也会被回填为 `'migration'`，**仅影响"接管 user→catalog"路径在历史行上不触发**，不影响 enable / 删除候选的正确性。

**索引**：暂不新增索引；查询模式仍以 `(platform, model_id)` 与 `id` 为主，`source` 仅作为过滤条件出现在删除候选中（数据量小，无性能问题）。

### 对外接口定义与每个接口对应的详细业务流程

#### 接口 A：`POST /api/models`（新增）

- **认证**：`requireAuth`（与既有 `/api/models` GET 同）。
- **请求 body**：
  ```ts
  {
    platform: string,      // 必填；非 'custom'；hasProvider(platform) === true
    modelId: string,       // 必填；非空
    displayName?: string,  // 可选；缺省 = modelId
    contextWindow?: number,
    supportsVision?: boolean,
    supportsTools?: boolean,
  }
  ```
- **流程**：
  1. 校验 `platform` 非 `'custom'`；
  2. 校验 `hasProvider(platform) === true`，否则 400；
  3. 校验 `modelId` 非空、长度 ≤ 200；
  4. 启事务：
     a. INSERT `models`（`source='user'`、未提供字段用默认值）；
     b. 若 `(platform, modelId)` 已存在（UNIQUE 冲突）→ 返回 409 `{error: 'Model already exists', existingId: <id>}`；
     c. 在 `fallback_config` 插入 `(model_db_id=<新id>, priority=MAX+1, enabled=1)`；
  5. 返回 201：
     ```ts
     {
       success: true,
       id: number,
       platform, modelId, displayName, source: 'user', enabled: true,
       contextWindow, supportsVision, supportsTools
     }
     ```
- **异常**：400（参数缺失/不合法）、401（未登录）、409（已存在）、500（DB 写失败）。

#### 接口 B：`PATCH /api/models/:id`（新增）

- **认证**：`requireAuth`。
- **请求 body**（任一字段可选，但至少给一个）：
  ```ts
  {
    displayName?: string,
    enabled?: boolean,
    contextWindow?: number | null,
    supportsVision?: boolean,
    supportsTools?: boolean,
  }
  ```
- **流程**：
  1. 校验 `:id` 是数字；查询行；不存在 → 404；
  2. 拒绝 body 中出现 `platform` / `modelId` / `source` / `intelligence_rank` / `speed_rank` / `size_label` / 任何 `*_limit` / `monthly_token_budget`：返回 400，列出非法字段；
  3. 仅对实际给出的字段做 UPDATE；
  4. 返回 200：更新后整行（同 `GET /api/models` 单元素结构）。
- **异常**：400（非法字段）、404（id 不存在）、500。

#### 接口 C：`DELETE /api/models/:id`（新增）

- **认证**：`requireAuth`。
- **流程**：
  1. 查询行；不存在 → 404；
  2. 若 `source !== 'user'` → 400 `{error: 'Cannot hard-delete catalog/migration models. Use PATCH {enabled:false} instead.'}`；
  3. 启事务：
     a. `DELETE FROM fallback_config WHERE model_db_id = ?`；
     b. `DELETE FROM models WHERE id = ?`；
  4. 返回 200 `{success: true}`。
- **异常**：400（非 user）、404、500。

#### 接口 D：`GET /api/models`（修改）

- 现状：返回 model 列表（`routes/models.ts:9-52`）。
- 改动：响应中每个元素新增 `source: 'migration' | 'catalog' | 'user'` 字段。
- 行为不变，**向后兼容**。

# 四、技术实现设计（横向）

## client 层设计

### 新组件 `ManageModelsDrawer.tsx`（绝对路径：`client/src/pages/components/ManageModelsDrawer.tsx`）

**职责**：按 `platform` 过滤展示模型列表，提供新增 / 编辑 / toggle / 删除操作。

**Props**：
```ts
{
  open: boolean;
  onClose: () => void;
  platform: Platform;       // 由调用方决定
  platformLabel: string;    // 用于标题展示，例如 "Groq"
}
```

**内部数据流**：
- 复用既有 `useQuery(['models'])`（KeysPage 中已经存在）；在 Drawer 中按 `platform` 过滤；
- 三个 mutation：`addModel` (POST)、`updateModel` (PATCH)、`deleteModel` (DELETE)；每个 mutation 成功后 `invalidateQueries(['models'])`。

**布局**（伪结构）：
```
Drawer
├── Header: "{platformLabel} 的模型 (n)"   [+ 新增]
├── 新增表单（可折叠）
│   ├── modelId (Input, 必填)
│   ├── displayName (Input, 可选)
│   ├── contextWindow (Input number, 可选)
│   ├── supportsVision (Switch)
│   ├── supportsTools (Switch)
│   └── [保存] [取消]
└── 列表
    └── ModelRow[]
        ├── 左：badge(source) + modelId + displayName
        ├── 中：Switch(enabled) — 调 PATCH
        └── 右：source==='user' ? [Edit][Delete] : [Edit]
```

**Source badge 颜色约定**：
- `user` → 主色（emerald 或 primary）+ 文字 "User"；
- `catalog` → 中性色（slate）+ 文字 "Catalog"；
- `migration` → 中性色（muted）+ 文字 "Built-in"。

### KeysPage.tsx 改动

- 在每个 Provider section header（既有的 `Globe` 图标 + label 区域）旁加一个 `Button variant="ghost" size="sm"` + `Settings2` 图标 + 文案 `t('models.manage')`；点击 setState 打开 Drawer，传入该 platform。
- 在每张 KeyCard（既有的 status dot + label + edit 按钮区域）末尾加同样的按钮；点击同样打开 Drawer，传入该 KeyCard 对应的 platform。
- 单页保持单一 Drawer 实例（用 `[drawerPlatform, setDrawerPlatform] = useState<Platform | null>(null)`）。

### shared/types.ts 改动

- 若 `Model` 类型已存在 → 添加 `source: 'migration' | 'catalog' | 'user'`；
- 若不存在 → 不强制改 shared/types（后端响应直接 typed inline 即可）。

### i18n

- `client/src/i18n/*.ts` 添加文案：`models.manage`、`models.add`、`models.delete`、`models.disable`、`models.cannotDeleteCatalog`、source badge 三键（`models.sourceUser` = "User"、`models.sourceCatalog` = "Catalog"、`models.sourceBuiltin` = "Built-in"，覆盖 `user` / `catalog` / `migration` 三种来源）。

## app 层设计

### `server/src/routes/models.ts`

**现有导出**：`modelsRouter`（GET '/'）。**改动**：
- 给现有 GET handler 加 `source: m.source` 到响应映射；
- 新增 3 个 handler：

```ts
modelsRouter.post('/', (req, res) => { /* 接口 A */ });
modelsRouter.patch('/:id', (req, res) => { /* 接口 B */ });
modelsRouter.delete('/:id', (req, res) => { /* 接口 C */ });
```

**校验**：手写 schema 即可（项目当前未引入 zod 类常用 validator，遵循既有风格）。

**事务**：用 `db.transaction(() => { ... })` 包裹 INSERT models + INSERT fallback_config，与 `keys.ts` 风格一致。

### `server/src/app.ts`

- 既有 `app.use('/api/models', requireAuth, modelsRouter)` 路由不变（因为新 handler 都在同一个 router 下）；无需改 app.ts。

## domain 层设计

本项目不是经典分层架构，没有独立 domain 层；规则集中在 routes + services。规则定义如下：

**规则 R1（写入打标）**：
- migrations 写入：依赖 `source` 列默认值 `'migration'`，无需显式写；
- `applyCatalog` 写入：INSERT/UPDATE 时显式 `source = 'catalog'`；
- `POST /api/models` 写入：显式 `source = 'user'`。

**规则 R2（删除候选过滤）**：
- `applyCatalog` 删除候选 SQL：
  ```sql
  -- 改前
  SELECT id, platform, model_id FROM models 
   WHERE platform != 'custom' AND key_id IS NULL
  -- 改后
  SELECT id, platform, model_id FROM models 
   WHERE platform != 'custom' AND key_id IS NULL AND source != 'user'
  ```

**规则 R3（接管升级）**：
- `applyCatalog` 的 UPDATE SQL 加 `source = 'catalog'`：
  ```sql
  UPDATE models SET
    display_name=@displayName, ..., enabled=@enabled,
    source='catalog'    -- 新增
  WHERE id=@id
  ```
- INSERT SQL 同样加 `source='catalog'`。

**规则 R4（删除策略）**：
- 仅 `source='user'` 行允许 `DELETE /api/models/:id`；
- 其他 source 的销毁动作仅通过 `PATCH {enabled:false}` 实现。

## infrastructure 层设计

### DB schema 迁移

新增 `ensureModelsSourceColumn(db)`（仿 `ensureModelsKeyIdColumn`）：

```ts
function ensureModelsSourceColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'source')) {
    db.prepare(`ALTER TABLE models ADD COLUMN source TEXT NOT NULL DEFAULT 'migration'`).run();
    // 现有行的 source 默认填 'migration'。已知偏差：catalog 已写入过的旧行也会被填为
    // 'migration'，仅影响"接管 user→catalog"路径在历史行上不触发；enable 语义和删
    // 除候选条件均不受影响。
  }
}
```

挂在 `runMigrations(db)` 里 `migrateModelsV27Agnes(db)` 之后、新引入的 `migrateModelsV28UserManaged`（占位，可省）之前。

### Provider 注册表清理

`server/src/providers/index.ts` 第 17 行（首次 `register agnes`）保留；第 212 行（重复 `register agnes`）删除。两次 baseUrl 相同，行为一致，删第二次。

### 测试文件

- `server/src/__tests__/routes/models.test.ts`（新建）：覆盖接口 A/B/C 的成功 + 错误分支；
- `server/src/__tests__/services/catalog-sync.test.ts`（追加）：验证 user 模型不被删 + user→catalog 接管 + enabled 保留；
- `server/src/__tests__/db/migrations.test.ts`（追加，若有）：验证 `ensureModelsSourceColumn` 的 idempotent。

# 五、风险与权衡

| 风险 | 级别 | 说明 | 缓解策略 |
|---|---|---|---|
| R1：现有 catalog 写入过的旧行被回填为 `'migration'` | 低 | 历史 catalog 行在加列时被默认归类为 migration | 不影响 enable/删除候选；下次 `applyCatalog` 命中这些行时会被 UPDATE 为 `'catalog'`，自然修复 |
| R2：user 模型用固定 ranks=50 排序 | 低 | UI 不暴露 ranks 编辑 | 后续视使用情况再加 ranks 编辑 UI；不阻塞本期 |
| R3：维护者误删 catalog 模型 | 低 | DELETE 接口对非 user 直接返回 400 | 接口级硬保护 + UI 不显示硬删按钮（双重） |
| R4：UNIQUE 冲突合并策略 | 低 | POST 时若已存在 user 模型 → 409 拒绝 | 让 UI 引导用户走 PATCH；避免静默覆盖既有 enabled |
| R5：前后端 source 字段类型不一致 | 低 | TS 字符串字面量类型 | 在 shared/types 或后端常量中定义 union 类型 |
| R6：`agnes` 重复注册行为已是覆盖式无害 | 极低 | Map 同 key 后写胜出 | 删除重复行，单测验证 `getAllProviders()` 返回数量与现状一致 |

# 六、技术决策记录

| 决策 | 选择 | 备选方案 | 取舍依据 | 关联 Requirement / Task |
|---|---|---|---|---|
| 模型来源标记位置 | `models.source` 列 | 启发式（`key_id != NULL` ⇒ user / 其他全为 catalog） | 启发式无法区分 catalog vs migration；显式列简单可靠 | Req1 模型来源三分体系 |
| 用户禁用持久化 | 依赖现有 `enabled` 列 | 引入新列 `user_disabled` | 现有 `applyCatalog` 已有正确语义，复用即可 | Req3 接管时保留 enabled |
| 删除策略 | source='user' 才能硬删；其余仅可 toggle disable | 全部允许硬删 / 全部仅可 disable | 防止与 catalog/migration 回插冲突；同时给 user 模型一个干净的清理路径 | Req6 删除接口 |
| 入口数量 | Provider 卡片 + 每张 KeyCard 各一个 | 仅 Provider 卡片一个 | 用户明确要求"在 provider 旁边和 key 旁边都加" | Req7 两处入口 |
| 入口范围 | platform-级（α 方案） | per-key allowlist（β 方案） | 探索阶段确认非真实需求；β 需要新表和 router 改动 | Req7 两处入口 |
| user 模型默认 ranks | 固定 `intelligence_rank=50`、`speed_rank=50`、`size_label='User'` | 暴露 UI 编辑 | "只是加个 modelname"，最小字段集匹配真实痛点 | Req4 POST 接口 |
| UNIQUE 冲突 POST 行为 | 返回 409 拒绝 | ON CONFLICT 合并 | 避免静默覆盖既有 user/catalog 的 enabled / displayName | Req4 POST 接口 |
| catalog 写入时是否重置 enabled | 沿用现状（catalog enable=true 不复活用户禁用） | 让 catalog 完全主导 | 现状已正确，且符合需求"老模型用原来的标记" | Req3 接管 |
| 是否清理 providers/index.ts 重复注册 | 顺手清理 | 留给后续 | 死代码、无副作用、修改触手可及 | Task 12 |

# 七、迁移 / 灰度 / 回滚方案

**迁移**：
- DB 加列是 idempotent ALTER（先 PRAGMA 检查），重启时自动执行，**对用户无感**。
- 已有 `models` 行通过 DEFAULT `'migration'` 静默回填。

**灰度**：
- 后端接口（POST/PATCH/DELETE）默认开启，无 feature flag 必要；
- 前端按钮依赖既有 `useQuery(['models'])` 的 `source` 字段，旧版后端响应缺 `source` 时按钮可隐藏。可选：在 `ManageModelsDrawer` 内做防御性 fallback —— `source` 缺失时按 `'migration'` 处理。

**回滚**：
- 回滚到旧后端：`source` 列保留无害（旧代码不读它）；新接口未被旧客户端依赖；
- 回滚到旧前端：新接口仍可用但无 UI 入口；
- 回滚到加列前的版本：极端情况下需 `ALTER TABLE models DROP COLUMN source`（SQLite 3.35+ 支持），但通常不需要 —— 列保留即可。

# 八、测试与验证方案

**单测**（vitest）：

| 测试文件 | 用例 | 对应 Scenario |
|---|---|---|
| `routes/models.test.ts`（新） | POST 成功创建 user 模型 + fallback 行 | Req4 #成功添加 |
| 同上 | POST 拒绝 platform='custom' | Req4 #拒绝 custom |
| 同上 | POST 拒绝未注册 platform | Req4 #拒绝未注册 |
| 同上 | POST 已存在 → 409 | Req4 |
| 同上 | PATCH 改 enabled / displayName 成功 | Req5 |
| 同上 | PATCH 拒绝改 platform/modelId/source | Req5 #拒绝修改 |
| 同上 | PATCH 404 | Req5 |
| 同上 | DELETE source='user' 成功 + cascade fallback | Req6 #删除成功 |
| 同上 | DELETE source='catalog' → 400 | Req6 #拒绝 catalog |
| 同上 | DELETE source='migration' → 400 | Req6 #拒绝 migration |
| 同上 | DELETE 404 | Req6 |
| 同上 | GET 响应包含 source 字段 | Req1 #GET 响应 |
| `services/catalog-sync.test.ts`（追加） | sync 不删 user 模型（catalog 不含） | Req2 |
| 同上 | sync 不删 user 模型（catalog 含同名） | Req2 |
| 同上 | sync 命中 user 模型 → 升级 source='catalog'，enabled 保留 | Req3 #升级 |
| 同上 | sync enable=true 不复活用户禁用 | Req3 #不复活 |
| 同上 | sync enable=false 强制覆盖 | Req3 #强制禁用 |
| `db/migrations.test.ts`（追加 / 新建） | `ensureModelsSourceColumn` idempotent 两次调用安全 | Req1 #migration 默认值 |
| 同上 | 已存在行的 `source` 回填为 `'migration'` | Req1 |

**集成测试**：
- 启动服务 → POST 一个新 user 模型 → `/v1/chat/completions` 用该 model 路由成功（用 mock provider 或对 OVH/Pollinations 等 keyless provider 实测）。

**前端测试**：
- 暂不强制（项目当前前端测试覆盖度低）；至少需要手动验收：Drawer 增 / 改 / 启用-禁用 / 删除四个动作。

**验收口径**：
- 维护者本人在本地 dev server 上：从 KeysPage 点 `[⚙ 管理模型]` → 添加 `groq/qwen-3-coder-next-512b` → 在 PlaygroundPage 选该模型发送一条消息 → 收到响应。整个流程不重启、不改代码。

# 九、Knowledge 回写计划

**需要新增的 Knowledge**：
- 无独立 knowledge 文档新增。

**需要更新的 Knowledge**：
- 无既有 knowledge 文档需要更新。

**建议更新内容**：
- 本次的所有规则（source 三分、冲突协议、删除策略）通过 `openspec/specs/user-managed-models/spec.md` 永久沉淀；archive 后会合入主 spec。
- 在 `applyCatalog` 函数顶部的 "Rules of engagement with user data" 注释块同步追加一行说明 `source` 维度的引入（实施时由 coding agent 处理）。

# 十、开放问题

无。所有关键决策已在 explore / proposal / design 中收敛完毕。

# 十一、阶段自检

- [x] 设计没有引入 proposal/specs 未声明的新需求
- [x] 每个关键设计决策都有依据和备选方案说明
- [x] 涉及接口、数据结构、依赖、迁移和回滚的内容已写清
- [x] 测试与验证方案能覆盖 specs 中的关键 Scenario
- [x] 设计足以拆分为原子任务
- [x] 未写入具体实现代码
