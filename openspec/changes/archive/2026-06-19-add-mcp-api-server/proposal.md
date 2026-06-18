## 1. 需求摘要

在现有 Express server 进程内启动一个 MCP server（HTTP + Streamable HTTP transport），监听 `MCP_PORT`（默认 4001），对外暴露两个工具：

- **`add_provider_key`**：添加提供方 API key，等同于 `POST /api/keys`
- **`add_custom_model`**：添加自定义 OpenAI 兼容模型，等同于 `POST /api/keys/custom`

让 AI Agent 可以通过 MCP 协议自动创建和管理 key，无需手动打开 dashboard。

**为什么现在做**：当前只有 Web dashboard 和 REST API 两种管理 key 的方式，Agent 无法程序化地完成"加 key → 用 key 调模型"的闭环。MCP 是 Agent 生态的标准协议，加一个 transport 层成本很低——所有业务逻辑直接复用现有路由代码。

## 2. 当前工程范围与边界

**纳入范围：**
- `server/src/mcp/` 模块：MCP server 创建、tool 定义、handler
- `server/src/index.ts`：在 `main()` 中启动 MCP listener，共享 DB 连接
- `server/src/providers/index.ts`：新增 `getAvailablePlatforms()` 导出，供 tool schema 动态枚举
- `server/package.json`：新增 `@modelcontextprotocol/sdk` 依赖
- `docker-compose.yml`：映射 MCP 端口 + 环境变量
- `Dockerfile`：`EXPOSE 4001` + `ENV MCP_PORT=4001`

**不纳入范围：**
- dashboard UI 改动（MCP 是纯后端功能）
- MCP 认证以外的其他安全机制（本地单用户场景）
- `list_keys`、`delete_key`、`list_models` 等其他 MCP tool（按需再加）
- desktop 客户端内的 MCP server 入口
- MCP server 的独立进程部署方式

## 3. 业务语义拆解

**业务对象**：MCP Tool。每个 tool 对应一个 REST API 操作，参数和返回与现有 API 完全一致。

**业务规则**：
1. **认证**：MCP 请求必须带 `Authorization: Bearer <MCP_TOKEN>`。`MCP_TOKEN` 通过环境变量配置，服务端在 SSE 握手和 message 阶段校验。若未配置 `MCP_TOKEN` 则 MCP server 不启动。
2. **平台列表**：`add_provider_key` 的 `platform` 参数枚举值从 provider 注册表动态获取，新增 provider 时 tool schema 自动更新。
3. **复用现有逻辑**：tool handler 直接调用 `getDb()` 和 `encrypt()` 等现有函数，不重复实现业务逻辑。

**关键场景**：
- (S1) Agent 调用 `add_provider_key({ platform: "groq", key: "gsk_xxx", label: "my-groq" })` → key 写入 DB，返回 `{ id, platform, maskedKey, status: "unknown" }`
- (S2) Agent 调用 `add_custom_model({ baseUrl: "http://localhost:11434/v1", model: "qwen3:4b" })` → key + model 写入 DB，返回 `{ keyId, modelDbId, models: [...] }`
- (S3) MCP_TOKEN 未配置 → MCP server 不启动，主进程正常运行
- (S4) MCP 请求 token 不匹配 → 返回 401

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块 |
|---|---|---|
| MCP Server | `McpServer` 实例 + `StreamableHTTPServerTransport` | `server/src/mcp/index.ts` |
| Tool 定义 | `server.tool(name, description, schema, handler)` | `server/src/mcp/tools.ts` |
| Token 校验 | Express middleware on `/sse` + `/message` 路由 | `server/src/mcp/index.ts` |
| 平台枚举 | `getAvailablePlatforms()` 从 `providers` Map keys 导出 | `server/src/providers/index.ts` |
| 启动控制 | `MCP_TOKEN` 环境变量有值才启动 MCP listener | `server/src/index.ts` |

## 5. 变更清单

**新增：**
- `server/src/mcp/index.ts`：创建 Express app + MCP server + transport，注册 `/sse` 和 `/message` 路由
- `server/src/mcp/tools.ts`：两个 tool 的 schema 定义和 handler
- `server/src/providers/index.ts`：`getAvailablePlatforms()` 导出（返回 `providers` Map 的所有 key）
- `server/package.json`：`@modelcontextprotocol/sdk` 依赖

**修改：**
- `server/src/index.ts`：`main()` 中在 `initDb()` 之后调用 `startMcpServer()`
- `docker-compose.yml`：新增 4001 端口映射 + `MCP_PORT` / `MCP_TOKEN` 环境变量
- `Dockerfile`：`EXPOSE 3001 4001` + `ENV MCP_PORT=4001`

## 6. 追踪关系

| 业务目标 | 变更点 | 影响对象 | 验收口径 |
|---|---|---|---|
| Agent 能加 provider key | `add_provider_key` tool 复用 `POST /api/keys` 逻辑 | `mcp/tools.ts` | MCP client 调 tool → DB 出现新 api_key 行 |
| Agent 能加自定义模型 | `add_custom_model` tool 复用 `POST /api/keys/custom` 逻辑 | `mcp/tools.ts` | MCP client 调 tool → DB 出现新 key + model 行 |
| platform 列表自动更新 | `getAvailablePlatforms()` | `mcp/tools.ts`, `providers/index.ts` | 新增 provider 注册后，tool schema 的 platform enum 自动包含 |
| token 保护 | middleware 校验 `Authorization` header | `mcp/index.ts` | 无 token / 错 token → 401；正确 token → 200 |
| Docker 部署可用 | port 映射 + env 注入 | `docker-compose.yml`, `Dockerfile` | `docker compose up` 后 `curl localhost:4001/sse` 可达 |

## 7. Capabilities

### 新增 Capabilities
- `mcp-api`：通过 MCP Streamable HTTP 协议在独立端口暴露 `add_provider_key` 和 `add_custom_model` 两个工具，支持 AI Agent 程序化管理 freellmapi 的 key 和模型。

### 修改 Capabilities
- 无

### 移除 Capabilities
- 无

## 8. 复杂度判定

**复杂度结论**：简单需求

**判定依据**：
- [ ] 涉及两个及以上模块、服务或分层（仅 server 侧新增一个子模块）
- [ ] 涉及接口协议、数据结构、存储模型变化（MCP 是新接口但数据层零改动）
- [ ] 涉及迁移、灰度、回滚、兼容处理（纯新增，无破坏性变更）
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡（MCP_TOKEN 校验足够简单）

**Design 是否必需**：不需要独立 design.md（本 proposal 已覆盖所有技术决策；实现复杂度低）

## 9. Knowledge 使用与影响

**本次使用的 Knowledge：**
- `server/src/routes/keys.ts`：现有 key 创建逻辑（用作 handler 模板）
- `server/src/providers/index.ts`：provider 注册表
- `server/src/db/index.ts`：DB 初始化
- `server/src/index.ts`：主进程启动流程

**本次受影响的 Knowledge：**
- 无

## 10. 影响评估

**受影响代码：**
- `server/src/mcp/`（新建 2 文件，预计共 ~100 行）
- `server/src/index.ts`（加 ~5 行调用）
- `server/src/providers/index.ts`（加 4 行导出函数）
- `server/package.json`（加 1 个依赖）
- `docker-compose.yml`（加端口 + 2 个 env）
- `Dockerfile`（`EXPOSE 3001 4001` + 1 行 `ENV`）

**受影响接口：**
- 新增 MCP Streamable HTTP 接口（`GET /sse`, `POST /message`），不影响现有 REST API

**受影响数据：**
- 无 schema 变更；MCP handler 通过现有 `getDb()` 读写同一数据库

**回滚预案：**
- 不配置 `MCP_TOKEN` 则 MCP server 不启动
- 删除 `server/src/mcp/` 目录 + 回滚 `index.ts` 调用、恢复 docker-compose 和 Dockerfile 即可

## 11. 非目标与后续议题

**本期不做：**
- MCP list_keys / delete_key / list_models 等其他管理操作
- dashboard 内的 MCP 状态展示
- MCP 请求速率限制
- MCP 操作审计日志

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需（不需，proposal 足以表达所有技术决策）
- [x] 未写入具体实现代码或过细任务
- [x] 无阻塞性问题
