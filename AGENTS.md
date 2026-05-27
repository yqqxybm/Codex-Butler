# AGENTS.md

## 项目意图

本项目构建一个确定性控制平面，让一个 Butler Codex session 协调其他 Codex worker
sessions，同时避免 worker 直接写 main workspace、直接向用户提问，或声称未验证的完成。

## 本地规则

- 保持 Butler/service 边界清楚。模型可以判断和路由，但 ledger、state transitions、
  workspace allocation、verification、promotion 必须由 deterministic service code
  负责。
- app-server worker dispatch 和已有 session 接管是两条路径：worker-turn 能力必须用
  app-server probe 证明；用户显式选择已有 session 后，Web/CLI session autopilot 可以用
  `codex exec resume <session>` 恢复并推进该 session。
- 任何 app-server capability 声明都必须由 `npm run probe` 或更具体的命令支撑。
- 任何 worker-turn capability 声明都必须由 `npm run probe:turn` 支撑。
- 任何 MCP tool loading 声明都必须由 MCP protocol test 或真实 Codex MCP load 支撑。
- 任何 daemon、planning、transcript evidence、dashboard 行为声明，都必须由对应单测
  加 CLI 或 MCP smoke 命令支撑；只在不实际可行时说明原因。
- worker prompt 必须包含 role、required skill、owned scope、forbidden actions 和
  output schema。
- 已有本地 session 只能在拿到明确 thread/session id 后登记进 session registry；不要声称
  已自动枚举所有本地 session，除非有真实 app-server discovery 证据。
- 不要把 session registry 记录说成“可用 worker transport”；必须通过 `probe-session`
  或 Web“诊断连接”证明 app-server transport 可达。已有 session 能否被接管，以
  `codex exec resume` 的实际返回为准。
- 当前 Codex 会话可以通过 `add-current-butler-session` 登记为 `current-session` 管家；
  这类会话的健康状态是 `attached`，只能表示当前操作者会话已附着，不能说成
  app-server transport reachable 或 worker dispatch target。
- 用户产品路径优先走 Web 的“接管选中的 session”或 CLI `follow-session`；传统目标任务链
  仍可用 Web 的“按目标新建任务链”或 CLI `advance-goal`。
  不要把普通用户引导到 worktree/dispatch/verify/promote 四个手工按钮，除非是在排障。
- 修改 plan/state 相关逻辑时，必须验证 goal task 图不会在 implementation `validating`
  和 review prerequisite 之间形成死链。
- 不要增加依赖，除非它明确降低真实实现风险。

## 验证

- Syntax：`npm run check`
- Unit tests：`npm test`
- Local Codex capability probe：`npm run probe`
- Worker-turn probe：`npm run probe:turn`
- Full smoke：`npm run smoke`
- Daemon status smoke：`npm run daemon -- status`
- Dashboard smoke：`npm run butler -- dashboard`
- Web console smoke：`npm run web -- --port 4177`
- Persistent service smoke：`npm run launchd -- status`
