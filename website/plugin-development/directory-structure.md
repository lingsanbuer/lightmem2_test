# Plugin Directory Structure

::: danger 内容来源说明
此页面内容来自对仓库 `components/tokenpilot/` 实际目录结构的观察，非 README 原文。
:::

## 当前仓库结构

```text
components/tokenpilot/
├── adapters/               # Host-specific integration
│   ├── openclaw/
│   ├── codex/
│   └── claude-code/
├── products/
│   ├── cli/                # Shared CLI
│   └── mcp/                # Shared MCP server
└── packages/
    ├── host-adapter/       # Shared adapter contracts
    ├── runtime-core/       # Runtime engine
    ├── kernel/             # Shared types and interfaces
    └── layers/
        ├── history/
        ├── decision/
        └── memory/         # Experimental
```

正式的 Plugin Directory Structure 规范尚未定义。
