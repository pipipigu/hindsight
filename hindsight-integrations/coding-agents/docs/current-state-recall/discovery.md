# 现状查询：现场核验

2026-10-14 核验，采用执行计划 v4。

- 源码：本包 TypeScript；`src/core/recall-query.ts` 解析请求，`knowledge-tools.ts` 注册工具，`recall-guidance.ts` 提供 compact 响应及会话的共享说明，`conclusions.ts` 提供保存描述。
- 线上：NAS `/home/pipipig/docker/hindsight-agent-mcp`，Compose 服务 `memory-mcp`、容器 `hindsight-agent-mcp`，入口 `/app/mcp-http-server.js`。旧本地/NAS/容器 bundle 哈希均为 `d1a91944…`，线上目录 schema 与旧源码一致；新 bundle 为 `16eed244…`，协议版本 0.8.1。核心 Hindsight 0.10.3 未改。
- `prefer_observations` 由封装透传，不做本地重排。R1/R5 分离变量：显式 raw 类型加 prefer 不补入观察；全部类型加 prefer 的结果只有观察；全部类型不设 prefer 返回两类，采用后一种默认。R5 首位仍可能是局部过时观察，须核对其他证据。
- 两开关在进程启动时读取，Compose 传入；`legacy/v1` 联合恢复旧请求与说明，需重建容器。NAS Compose 使用部署根的 `.docker-cli`；`.env` 固化既有 `MCP_BIND_ADDRESS=172.17.0.1`，避免重建退回 localhost 而使反代 502。
- 私有回归原文位于 `tests/fixtures/baseline/`、`tests/fixtures/current-state/`，已 Git 忽略、权限 600。结果见 [验证报告](validation.md)。
