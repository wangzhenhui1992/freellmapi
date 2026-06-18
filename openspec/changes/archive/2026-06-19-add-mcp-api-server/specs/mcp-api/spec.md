<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## ADDED Requirements

### Requirement: MCP Server 启动与认证
<!-- Trace: proposal.md#mcp-api / token 保护、启动控制 -->

系统 SHALL 在配置了 `MCP_TOKEN` 环境变量的前提下，在主进程中启动一个 MCP Streamable HTTP server，监听 `MCP_PORT` 端口（默认 4001）。

系统 SHALL 对所有 MCP 请求（`/mcp` 路由）校验 `Authorization: Bearer <token>` header，仅接受与 `MCP_TOKEN` 环境变量值匹配的 token。

系统 SHALL 在 `MCP_TOKEN` 未配置时跳过 MCP server 启动，不阻塞主进程正常运行。

#### Scenario: token 正确则允许连接
- **WHEN** 客户端向 `/mcp` 发送请求，携带 `Authorization: Bearer <正确的 MCP_TOKEN>`
- **THEN** 服务端返回 200，建立连接

#### Scenario: token 错误则拒绝
- **WHEN** 客户端向 `/mcp` 发送请求，携带的 token 与 `MCP_TOKEN` 不匹配
- **THEN** 服务端返回 401，不处理请求

#### Scenario: 未配置 token 则不启动 MCP
- **WHEN** `MCP_TOKEN` 环境变量为空或未设置
- **THEN** 系统跳过 MCP server 启动，主进程的其他功能（REST API、proxy）正常运行

### Requirement: add_provider_key 工具
<!-- Trace: proposal.md#mcp-api / Agent 能加 provider key -->

系统 SHALL 通过 MCP tool `add_provider_key` 接受 provider API key 的添加请求，将 key 加密后存入 `api_keys` 表，并返回创建结果。

该 tool 的 `platform` 参数 SHALL 以 `z.enum()` 动态枚举当前已注册的所有 provider platform（从 providers 注册表获取），使新增 provider 后 tool schema 自动更新。

对于 keyless provider（如 Kilo），`key` 参数 SHALL 为可选；对于其他 provider，`key` 参数 SHALL 为必填且非空。

#### Scenario: 成功添加 provider key
- **WHEN** Agent 调用 `add_provider_key`，参数为 `{ platform: "groq", key: "gsk_abc123", label: "my-groq" }`
- **THEN** 系统将 key 加密后写入 `api_keys` 表，返回 `{ id: <number>, platform: "groq", maskedKey: "gsk_***c123", status: "unknown", enabled: true }`

#### Scenario: 缺少必填 key 时拒绝
- **WHEN** Agent 调用 `add_provider_key`，参数为 `{ platform: "groq" }`（未提供 key）
- **THEN** 系统返回错误，说明 `key` 为必填

#### Scenario: keyless provider 不需要 key
- **WHEN** Agent 调用 `add_provider_key`，参数为 `{ platform: "kilo" }`（未提供 key）
- **THEN** 系统在 `api_keys` 表中创建 sentinel 行，返回成功

#### Scenario: platform 不在枚举中时拒绝
- **WHEN** Agent 调用 `add_provider_key`，参数为 `{ platform: "unknown-provider", key: "xyz" }`
- **THEN** 系统返回错误，说明 platform 不在支持的列表中

### Requirement: add_custom_model 工具
<!-- Trace: proposal.md#mcp-api / Agent 能加自定义模型 -->

系统 SHALL 通过 MCP tool `add_custom_model` 接受自定义 OpenAI 兼容模型的添加请求，在 `api_keys` 表中创建 `platform='custom'` 的 key 行，并在 `models` 表中注册对应模型，同时在 `fallback_config` 中补齐条目。

该 tool 的 `apiKey` 参数 SHALL 为可选，缺省时使用 `"no-key"` 作为 sentinel 值，适配本地无认证的 server（llama.cpp、Ollama 等）。

#### Scenario: 成功添加自定义模型
- **WHEN** Agent 调用 `add_custom_model`，参数为 `{ baseUrl: "http://localhost:11434/v1", model: "qwen3:4b", label: "Local Ollama" }`
- **THEN** 系统创建 `api_keys` 行（platform=custom, base_url=http://localhost:11434/v1），创建 `models` 行（platform=custom, model_id=`<keyId>-qwen3:4b`, source='user'），并补齐 `fallback_config` 条目，返回 `{ keyId, modelDbId, platform: "custom", baseUrl, models: [...] }`

#### Scenario: baseUrl 格式无效时拒绝
- **WHEN** Agent 调用 `add_custom_model`，参数为 `{ baseUrl: "not-a-url", model: "test" }`
- **THEN** 系统返回错误，说明 `baseUrl` 必须为有效 URL

#### Scenario: model 为空时拒绝
- **WHEN** Agent 调用 `add_custom_model`，参数为 `{ baseUrl: "http://localhost:11434/v1", model: "" }`
- **THEN** 系统返回错误，说明 `model` 为必填

#### Scenario: 带 apiKey 添加自定义模型
- **WHEN** Agent 调用 `add_custom_model`，参数为 `{ baseUrl: "https://my-api.example.com/v1", model: "gpt-4", apiKey: "sk-secret123" }`
- **THEN** 系统以 `"sk-secret123"` 作为 key 加密存储，模型正常注册

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 不适用（纯新增 capability）
- [x] 未把纯实现重构写成对外行为变化
