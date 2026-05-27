# Runbook

这份 runbook 面向本机操作和故障处理。命令保持英文，说明和判断标准使用中文。

## 本地 Smoke

```sh
npm run smoke
```

期望结果：

- 语法检查通过；
- 单元测试通过；
- app-server probe 返回 `ok: true`。

## 只跑 Capability Probe

```sh
npm run probe
```

probe 是安全的：它只创建临时 app-server 状态，并尝试在临时路径做一次 read-only
sandbox 写入。期望结果是写入被拒绝。

## Worker Turn Probe

```sh
npm run probe:turn
```

这个命令会在普通 capability probe 之外，额外启动一次真实 `turn/start`，并使用
`outputSchema` 校验模型响应。它会消耗模型调用；只有 worker-session 路径变更时才需要
跑，不放入便宜的日常 smoke。

## Butler CLI

```sh
npm run butler -- submit-goal "ship a feature"
npm run butler -- plan-goal "ship a feature"
npm run butler -- replan-goal <goal-id>
npm run butler -- advance-goal <goal-id>
npm run butler -- advance-goal <goal-id> --max-steps 20
npm run butler -- create-task <goal-id> verifier "run smoke checks"
npm run butler -- add-current-butler-session --label "Current Codex Butler"
npm run butler -- add-butler-session <thread-id> --label "Existing Butler"
npm run butler -- sessions
npm run butler -- probe-sessions
npm run butler -- follow-session <session-id-or-thread-id> "继续推进直到完成"
npm run butler -- advance-session-run <run-id>
npm run butler -- resume-session-run <run-id> "我的选择是..."
npm run butler -- status
npm run butler -- dashboard
```

状态和 ledger 文件存放在 `.codex-butler/`，该目录故意被 git 忽略。

## 管理已有本地 Session

已有本地 Codex thread/session 可以手动登记进 Butler control plane：

```sh
npm run butler -- register-session <thread-id> worker-session --label "Existing worker"
npm run butler -- add-current-butler-session --label "Current Codex Butler"
npm run butler -- add-butler-session <thread-id> --label "Existing Butler"
npm run butler -- sessions
npm run butler -- probe-session <thread-id>
```

`register-session` 用于登记普通已有 session；`add-butler-session` 用于把某个已有 session
标记为 `butler-controller`。这些记录会进入 `.codex-butler/state.json`，并出现在 CLI
status、dashboard、MCP tools 和 Web Console 中。

`add-current-butler-session` 会读取当前进程的 `CODEX_THREAD_ID`，把正在对话的 Codex
会话登记为 `current-session` 管家，并标记为 `attached`。这个状态表示当前会话可以作为
人工操作中的 Butler controller；它不表示 app-server 可以在新连接里重新向该 thread 发
turn。

注意：当前 Codex app-server 路径没有被本项目验证过“枚举所有本地会话”的稳定 API。
因此这里不做假发现；只管理已经明确给出 thread/session id 的本地 session。

登记后的 session 必须通过 `probe-session` 或 Web Console 的“检查”才能视为可被当前
控制平面使用。如果 probe 返回 `thread not found`，该 session 只能算 registry 记录，不能
算可调度对象。

用户主路径是 session run：Web 里点 `接管选中的 session`，或 CLI 运行 `follow-session`。
这条路径会调用 `codex exec resume <session-id>` 恢复目标 session，并持续推进到完成、
阻塞或需要用户选择。app-server probe 失败不必然阻止 `follow-session`；真正的阻塞以
`codex exec resume` 的返回为准。

## Butler Daemon

```sh
npm run daemon -- start
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- run
```

`start` 会启动一个 detached 的本地 `codex-butlerd` worker。`run` 让 daemon 在前台
运行，适合交给进程管理器。daemon 的 PID 和 heartbeat 记录在
`.codex-butler/daemon.json`。

## MCP Server

```sh
npm run mcp
```

这个命令是 Butler session 使用的 stdio MCP server 入口。server 暴露 goal、task、
dispatch、worktree、verifier、promotion、status、ledger、planning、dashboard、
daemon 管理和 session registry/probe 工具。

## Web Console

```sh
npm run web -- --host 127.0.0.1 --port 4177
```

打开 `http://127.0.0.1:4177`。Web Console 是本地用户工作台，用于检查会话、输入目标、
一键推进、查看任务状态和最近事件。默认只绑定 localhost。

完整操作说明见 [user-manual.md](user-manual.md)。

## macOS 长期服务

长期运行时使用 `launchd`。这是让 Butler daemon 和 Web Console 脱离当前 shell /
当前 Codex turn 持续运行的推荐方式。

安装并启动两个服务：

```sh
npm run launchd -- install
```

默认服务：

- `com.codex-butler.daemon` 运行 `node src/cli.js daemon run`。
- `com.codex-butler.web` 运行 `node src/cli.js web --host 127.0.0.1 --port 4177`。

状态和健康检查：

```sh
npm run launchd -- status
npm run daemon -- status
curl -fsS http://127.0.0.1:4177/api/dashboard
```

日志：

```sh
npm run launchd -- logs
tail -f .codex-butler/logs/codex-butler-web.out.log
tail -f .codex-butler/logs/codex-butler-web.err.log
tail -f .codex-butler/logs/codex-butler-daemon.out.log
tail -f .codex-butler/logs/codex-butler-daemon.err.log
```

重启、改端口、卸载：

```sh
npm run launchd -- restart
npm run launchd -- install --target web --host 127.0.0.1 --port 4178
npm run launchd -- uninstall
```

LaunchAgent plist 文件存放在 `~/Library/LaunchAgents/`。卸载服务不会删除
`.codex-butler/` 里的状态、ledger、worktrees 或 logs。

## Planning 和 Dashboard

```sh
npm run butler -- plan-goal "Build a CLI dashboard and tests"
npm run butler -- replan-goal <goal-id>
npm run butler -- advance-goal <goal-id>
npm run butler -- advance-goal <goal-id> --max-steps 20
npm run butler -- dashboard
```

`plan-goal` 会创建一个 goal 和一组有顺序、带 role ownership 的 tasks。
`replan-goal` 只允许替换尚未开始执行、所有 task 仍是 `queued` 的目标任务图。
implementation goal 会生成 iteration、review、verifier、promoter tasks。
review-only goal 只生成 review 和 verifier tasks。后续 gate task 会携带
`targetTaskId`，让 Butler session 明确知道它正在 review、verify 或 promote 哪个上游
task。

普通使用优先用网页里的 `接管选中的 session` 或 CLI `follow-session`。`advance-goal`
保留给传统目标任务链。手动运行
`allocate-worktree`、`dispatch-task`、`verify-task`、`promote-task` 只适合排障。

## Transcript Evidence

worker handoff validation 会读取 app-server turn notifications。只有 transcript 中存在
成功的 command/tool record，并且该 record 指向所需 skill 的 `SKILL.md`，required
skill 才会被接受为 `externally-verified`。模型自己说“我读了 skill”不算外部验证。

## 常见故障

### 找不到 `codex`

安装 Codex CLI，或把 Codex CLI 所在目录加入 `PATH`。

### `initialize` Timeout

使用 stdio app-server 模式，不要使用 unix socket proxy：

```sh
codex app-server --listen stdio://
```

当前项目使用的 client path 是 stdio。unix socket proxy 会携带 websocket frames，不是
这里的默认通信路径。

### Read-only Write 没有被拒绝

这是 release blocker。Butler 设计依赖 sandbox policy 能在 worker 执行前被强制执行。

### Worker Turn Probe 失败

这是 transport blocker。产品需要真实 app-server turns，不只是 thread creation 或
standalone command execution。

### Promotion 被 Dirty Main Workspace 阻塞

在 promotion 之前提交、stash 或有意识地清理 main workspace 中的无关改动。promotion
gate 会拒绝把 worker diff 应用到 dirty main workspace。

### Daemon Status 是 `stale`

记录的 PID 已经不存在。普通 daemon 模式下运行：

```sh
npm run daemon -- stop
npm run daemon -- start
```

如果 daemon 由 `launchd` 管理，重启 managed service：

```sh
npm run launchd -- restart --target daemon
```

## Evidence Rules

- `declared`：模型声称自己做了。
- `prompt-constrained`：prompt 要求它这样做。
- `transcript-supported`：transcript 显示相关行为。
- `externally-verified`：service 或命令证据确认行为成立。

只有 `externally-verified` 可以被报告为 verified。
