# Adapter Architecture

::: danger 内容来源说明
此页面内容来自对仓库中三个 adapter（openclaw/codex/claude-code）代码结构的观察，非 README 原文。
:::

## 当前实现

三个 adapter 的源码位置：

| Host | 路径 | 集成方式 |
| :-- | :-- | :-- |
| OpenClaw | `components/tokenpilot/adapters/openclaw/` | 原生插件槽 |
| Codex | `components/tokenpilot/adapters/codex/` | 本地代理 + Hooks |
| Claude Code | `components/tokenpilot/adapters/claude-code/` | 本地网关 + MCP |

## 共享模块

`components/tokenpilot/packages/host-adapter/` 提供了三个 adapter 共用的接口和工具。

正式的 Adapter Architecture 规范尚未定义。
