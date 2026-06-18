## 0. 执行前判断

**复杂度结论：** 简单需求（proposal.md §8）

**Design 是否存在：** 否（proposal 已覆盖所有技术决策）

**是否允许直接进入任务拆解：** 是

**Knowledge 是否需要更新：** 否

**说明：** MCP server 是纯新增模块，零 schema 变更，所有业务逻辑复用 `routes/keys.ts` 现有代码。proposal + specs 足以驱动实现。

## 0.1 Knowledge 更新任务

无需更新。本次为纯新增功能，不影响既有 knowledge 文档。

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 `list_keys`、`delete_key`、`list_models` 等未声明的 MCP tool
- [x] 0.2.2 不修改 `routes/keys.ts` 现有 handler 行为
- [x] 0.2.3 不添加 MCP 请求速率限制
- [x] 0.2.4 不在 dashboard UI 添加 MCP 相关展示
- [x] 0.2.5 不做无关重构、格式化、import 排序

## 1. 依赖安装

**关联规格：** 无（基础设施）

**涉及文件或模块：** `server/package.json`, `package-lock.json`

**验收方式：** `npm ls @modelcontextprotocol/sdk` 返回版本号

**回滚方式：** `npm uninstall @modelcontextprotocol/sdk`

- [x] 1.1 在 `server/` workspace 安装 `@modelcontextprotocol/sdk` 依赖

## 2. provider 注册表导出

**关联规格：** `mcp-api` / `add_provider_key 工具`（platform 参数动态枚举）

**涉及文件或模块：** `server/src/providers/index.ts`

**验收方式：** import `getAvailablePlatforms()` 返回非空 platform 数组，且包含 `groq`、`google`、`custom` 等

**回滚方式：** 删除导出函数即可

- [x] 2.1 在 `server/src/providers/index.ts` 新增并导出 `getAvailablePlatforms(): Platform[]`，返回 `providers` Map 的所有 key

## 3. MCP Tool 定义和 Handler

**关联规格：**
- `mcp-api` / `add_provider_key 工具`
- `mcp-api` / `add_custom_model 工具`

**涉及文件或模块：** `server/src/mcp/tools.ts`（新文件）

**验收方式：** 导入 `registerMcpTools()` 函数，传入 `McpServer` 实例后 tool 注册成功

**回滚方式：** 删除 `server/src/mcp/` 目录

- [x] 3.1 创建 `server/src/mcp/tools.ts`，定义 `registerMcpTools(server: McpServer)` 函数
- [x] 3.2 实现 `add_provider_key` tool：schema（platform 枚举从 `getAvailablePlatforms()` 取，key 必填[非 keyless 时]）+ handler（调用 `getDb()` + `encrypt()` 写入 api_keys，与 `POST /api/keys` 逻辑一致）
- [x] 3.3 实现 `add_custom_model` tool：schema（baseUrl + model 必填，apiKey/label/displayName 可选）+ handler（调用 `getDb()` + `encrypt()` 写入 api_keys + models + fallback_config，与 `POST /api/keys/custom` 逻辑一致）

## 4. MCP HTTP Server

**关联规格：**
- `mcp-api` / `MCP Server 启动与认证`（token 校验、无 token 不启动）

**涉及文件或模块：** `server/src/mcp/index.ts`（新文件）

**验收方式：** 设置 `MCP_TOKEN` 后启动进程，`curl -H "Authorization: Bearer <token>" localhost:4001/sse` 返回 200

**回滚方式：** 删除 `server/src/mcp/` 目录，回滚 `index.ts` 调用

- [x] 4.1 创建 `server/src/mcp/index.ts`，实现 `startMcpServer()` 函数
- [x] 4.2 创建独立 Express app，添加 Bearer token 校验 middleware（匹配 `MCP_TOKEN` 环境变量）
- [x] 4.3 创建 `McpServer` 实例 + `StreamableHTTPServerTransport`，注册 `/sse`（GET）和 `/messages`（POST）路由
- [x] 4.4 调用 `registerMcpTools()` 注册工具
- [x] 4.5 启动 listener 在 `MCP_PORT`（默认 4001）端口
- [x] 4.6 `MCP_TOKEN` 未配置时函数直接 return，不启动 listener

## 5. 主进程集成

**关联规格：** `mcp-api` / `MCP Server 启动与认证`（与主进程共存）

**涉及文件或模块：** `server/src/index.ts`

**验收方式：** `npm run dev` 后两个端口（3001 + 4001）同时有响应

**回滚方式：** 删除 `startMcpServer()` 调用行

- [x] 5.1 在 `server/src/index.ts` 的 `main()` 函数中，`initDb()` 之后、`app.listen()` 之前，调用 `startMcpServer()`
- [x] 5.2 在 `server/src/mcp/index.ts` 中导入 `../env.js`（确保 `.env` 已加载），使得 `MCP_TOKEN` 可以从环境变量读取

## 6. Docker 配置

**关联规格：** 无（部署基础设施）

**涉及文件或模块：** `docker-compose.yml`, `Dockerfile`

**验收方式：** `docker compose up` 后 4001 端口可达（设置了 `MCP_TOKEN` 的前提下）

**回滚方式：** 回滚两个文件的改动

- [x] 6.1 `docker-compose.yml`：在 `ports` 下新增 `"${HOST_BIND:-127.0.0.1}:${MCP_PORT:-4001}:4001"`，在 `environment` 下新增 `MCP_PORT` 和 `MCP_TOKEN`
- [x] 6.2 `Dockerfile`：`EXPOSE 3001` 改为 `EXPOSE 3001 4001`，新增 `ENV MCP_PORT=4001`

## 7. 手工验证

**关联规格：** 所有 `mcp-api` requirements

**涉及文件或模块：** 无（纯手工）

**验收方式：** 见各子任务

**回滚方式：** 无

- [x] 7.1 启动 dev server → 确认 3001（REST API）和 4001（MCP）同时响应
- [x] 7.2 用 curl 模拟 agent 调用 MCP `add_provider_key`，验证 key 写入 DB
- [x] 7.3 用 curl 模拟 agent 调用 MCP `add_custom_model`，验证 key + model + fallback_config 写入 DB
- [x] 7.4 确认未配置 `MCP_TOKEN` 时 MCP server 不启动，主进程正常
- [x] 7.5 确认错误 token 返回 401

## 99. 最终自检

- [x] 所有任务都能追溯到 requirement、design decision 或 knowledge 更新项
- [x] 每个任务都有明确验收方式
- [x] 未包含无关重构、顺手优化或未授权范围
- [x] 已列出必要测试、验证和回滚任务
- [x] 无开放问题
