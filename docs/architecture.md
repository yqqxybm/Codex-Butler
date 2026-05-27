# Architecture

## 目标形态

```text
User
  -> Butler Codex Session
  -> codex-butler MCP tools
  -> codex-butlerd deterministic service
  -> selected Codex sessions / Codex worker sessions
  -> review / verifier / promotion gates
```

## 设计原则

1. Butler 是 controller，不是直接 executor。
2. worker 输出在 service 校验前一律不可信。
3. main workspace 只能由确定性的 promotion gate 修改。
4. `codex exec` 可以测试协议契约，但真实产品行为必须基于 app-server threads。
5. 证据等级必须显式区分：`declared`、`prompt-constrained`、
   `transcript-supported`、`externally-verified`。

## 组件

### App Server Client

使用 `codex app-server --listen stdio://` 和 newline-delimited JSON-RPC 消息通信。
wire format 不包含 `jsonrpc` 字段，和 Codex app-server 文档保持一致。

当前实现会验证：

- `initialize / initialized` handshake；
- ephemeral thread creation；
- 请求 `probe:turn` 时运行真实 `turn/start + outputSchema`；
- standalone command execution；
- read-only sandbox denial。

### Capability Probe

检查本机 Codex CLI、app-server daemon metadata、生成的 schema bundle、全局配置风险，
以及运行时 sandbox 行为。

### Butler Service

`ButlerService` 是确定性控制平面核心。它拥有 goal/task state、append-only ledger、
session registry、natural-language plan compilation、worker dispatch、worktree
allocation、verification、promotion、dashboard rendering、daemon status 和
operational status。
面向模型的 Butler session 应该通过 MCP tools 调用这个 service，而不是直接写项目文件。

`advanceGoal` 是产品主路径：它读取当前 goal 的 task 图，选择下一个依赖已满足的任务，
自动执行所需动作。实现类任务会先准备 worktree 再 dispatch；review/analysis 完成后
直接进入 verified；verifier 执行确定性命令；promoter 只提升 verified target。

### Session Registry

session registry 把已有本地 Codex thread/session 纳入 Butler 管理面。记录字段包括
thread id、role、label、source、cwd 和 managed 状态。`add-butler-session` 会把已有
session 登记为 `butler-controller`，`register-session` 可登记普通 worker session 或
具体 role session。

`add-current-butler-session` 是当前 Codex 会话的专用入口。它读取 `CODEX_THREAD_ID`，
登记 source 为 `current-session`，并把 health 标记为 `attached`。`attached` 只说明当前
会话可以作为人工操作中的 Butler controller；它不等同于 `reachable`，也不会被当作远程
worker dispatch 目标。

这个 registry 是确定性状态记录，不假装拥有未经验证的自动发现能力。如果 app-server
后续稳定提供 session enumeration API，可以在这里补 discovery adapter；当前边界是管理
用户或上游系统明确给出的 thread/session id。

session registry 还提供 probe gate。普通 session 的 probe 会向目标 session 发一个最小
schema turn；只有 probe 成功的普通 session 才能被当前 transport 视为可达。`current-session`
的 probe 是附着检查：只验证它确实匹配当前进程的 `CODEX_THREAD_ID`，并保持 `attached`
状态。单纯登记成功不等于 session 可用。

### Session Runs

`sessionRuns` 是面向用户的主产品路径。用户选择一个 Codex session 后，Butler 创建
`session-run-*` 记录，并通过 `codex exec resume <session-id>` 恢复该 session。每一轮
都会要求目标 session 继续推进当前任务，并返回结构化状态：

- `in_progress`：已经推进，Butler 可继续下一轮；
- `needs_user`：出现真实分叉，需要用户选择；
- `done`：目标完成；
- `blocked`：恢复 session、执行或验证失败。

这条路径不依赖 app-server thread reachability。app-server probe 仍用于 worker transport
诊断，但不能再作为“能否接管已有 Desktop session”的唯一判断。`codex-butlerd` 会自动推进
active session run，一直到完成、阻塞或需要用户决策。

### Daemon Management

`src/daemon.js` 管理本地 `codex-butlerd` 进程，支持 start/status/stop/run。
daemon 会在 `.codex-butler/daemon.json` 记录 PID 和 heartbeat；stale PID 检测是确定性
逻辑，并且有测试覆盖。daemon heartbeat 同时会尝试推进到期的 active session run，避免
网页点击后必须停留等待。

### Persistent Service

`src/launchd.js` 管理 macOS 用户级 LaunchAgent。默认安装两个长期服务：

- `com.codex-butler.daemon`：前台运行 `node src/cli.js daemon run`，由 `launchd`
  监督和重启。
- `com.codex-butler.web`：运行本地 Web Console，默认绑定 `127.0.0.1:4177`。

这些服务使用固定 plist 路径、项目内日志路径和稳定 PATH，避免把一次性 shell 环境变成
长期配置。

### Plan Compiler

`src/planCompiler.js` 把自然语言 goal 转成有顺序、带 role ownership 的 tasks。它会把
review-only 请求排除在 implementation roles 之外，为 implementation work 添加
review、verifier 和 promoter tasks，并记录 prerequisites，让 Butler session 拥有明确的
执行图。review task 可以在 implementation task 完成 dispatch 并进入 `validating` 后运行；
verifier 和 promoter 仍要求上游 gate verified。gate tasks 会带 `targetTaskId`，指向它正在
review、verify 或 promote 的上游 task。

产品成熟度、生产可用性、架构迁移、重构和策略类目标会先生成 analysis task，再进入
implementation/review/verification/promotion，避免把产品级目标压扁成普通代码修改。
`replanGoal` 可在所有旧 task 仍是 `queued` 时替换任务图，用于修正分类器升级或目标理解
变化；一旦任何任务开始执行，就拒绝重排，避免丢失执行证据。

### Transcript Evidence

`src/evidence.js` 扫描 app-server turn notifications，寻找成功读取 required skill
`SKILL.md` 的 command 或 tool records。worker 自报可以保持 `declared` 或
`transcript-supported`，但只有外部 transcript 证据可以把 required skill read 升级为
`externally-verified`。

### MCP Server

`src/mcpServer.js` 使用官方 Model Context Protocol SDK，通过 stdio 暴露 Butler tools。
这是 Butler Codex session 接入控制平面的主要接口。

### Dashboard

`src/dashboard.js` 渲染人类可读 operational dashboard，包含 goal counts、task states、
active work 和 recent ledger events。CLI 和 MCP 暴露同一套 status surface。

### Web Console

`src/webServer.js` 使用 Node 内置 HTTP server 提供 localhost-only Web Console 和 JSON
API。UI 是 `web/` 下的静态 HTML/CSS/JavaScript，调用的仍然是和 CLI/MCP 相同的
`ButlerService` 方法。Web layer 是本地用户工作台，主路径是检查会话、输入目标和继续推进；
高级 task 动作只用于排障。它不会绕过 service-side state transitions、worktree
allocation、verifier gates 或 promotion rules。

### Ledger

ledger 是 append-only JSONL events。每个 event 都包含稳定 event id、timestamp、type
和 payload。ledger 是 Butler control plane 的恢复和审计来源。

### State Machine

Goal states：

```text
intake -> planned -> running -> reviewing -> promoting -> done
```

blocked 和 failed states 是 terminal，直到新 event 重新打开工作。

Task states：

```text
queued -> leased -> dispatched -> awaiting_result -> validating
        -> review -> verified -> promoted
```

rework loop 会从 `review` 或 `validating` 回到 `queued`。

### Worktrees And Promotion

implementation tasks 可以在 `.codex-butler/worktrees/` 下获得隔离 git worktree。
promotion 需要 task 已 verified，并且 main workspace 干净。gate 会用 `git apply`
确定性应用 task worktree diff，包括 staged 和 untracked files；模型不能直接写 main
workspace。

### Role Contracts

每个 worker 都会收到 role contract：

- role；
- required skill；
- owned scope；
- forbidden actions；
- expected output schema；
- evidence requirements。

worker 不能直接问用户、不能写 main workspace、不能 promote changes，也不能声称未验证的
成功。

worker turns 默认 read-only。如果 task 已分配 worktree，turn 会以 `workspaceWrite`
sandbox mode 运行，并把 `writableRoots` 限制到该 worktree。

## 完成边界

当前仓库实现的是本地确定性 Butler control plane：transport probes、daemon
management、planning、MCP tools、dispatch、transcript evidence extraction、worktree
allocation、verification、promotion、session registry、dashboard、本地 Web Console、
macOS launchd 长期服务、测试和 runbook。远端部署、原生桌面 GUI、托管发布包不在当前
本地控制平面边界内。
