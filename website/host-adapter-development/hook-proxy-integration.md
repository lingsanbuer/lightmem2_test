# Hook and Proxy Integration

::: danger 内容来源说明
此页面内容来自对 Codex proxy 和 Claude Code gateway 实现的观察，非 README 原文。
:::

## 当前实现

- **Codex**：本地 HTTP 代理 + hooks.json 注册
- **Claude Code**：本地 Anthropic 兼容网关 + SessionStart hook + MCP server

正式的 Hook 和 Proxy 集成规范尚未定义。
