# Host-Independent Design

::: danger 内容来源说明
此页面内容来自对仓库分层结构的观察：`packages/`（共享）与 `adapters/`（Host 专属）的分离，非 README 原文。
:::

当前仓库通过目录划分实现了 Host 无关设计：共享逻辑在 `components/tokenpilot/packages/`，Host 相关代码在 `components/tokenpilot/adapters/`。正式的设计指南尚未定义。
