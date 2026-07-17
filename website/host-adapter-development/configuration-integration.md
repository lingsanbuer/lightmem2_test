# Configuration Integration

::: danger 内容来源说明
此页面内容来自对三个 adapter 安装脚本行为的观察，非 README 原文。
:::

## 当前实现

| Host | 配置方式 |
| :-- | :-- |
| OpenClaw | 修改 `openclaw.json` |
| Codex | 创建 `tokenpilot.json` + 修改 `hooks.json` |
| Claude Code | 创建 `tokenpilot.json` + 修改 `settings.json` 和 `.claude.json` |

正式的配置集成规范尚未定义。
