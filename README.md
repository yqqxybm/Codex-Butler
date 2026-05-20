# codex-butler

`codex-butler` 是一个本地确定性控制平面，用来让一个 Butler Codex 会话规划任务、
调度其他 Codex worker 会话、校验交付、路由 review，并且只把验证通过的改动提升到
主工作区。

这个项目的目标不是写一段很长的 prompt，而是把多会话协作拆成可验证、可恢复、可审计
的流程：

```text
user -> Butler Codex session -> codex-butler control plane
     -> worker sessions / review sessions / verifier / promoter
```

Butler 会话负责判断和调度；确定性的 service 负责状态、ledger、证据、worktree、
验证和 promotion。

## 运行要求

- Node.js 22 或更新版本。
- Codex CLI 支持 `app-server`。
- 本机 Codex 账号和配置可以启动 `app-server`。

## 常用命令

```sh
npm run check
npm test
npm run probe
npm run probe:turn
npm run smoke
npm run daemon -- status
npm run launchd -- install
npm run launchd -- status
npm run butler -- add-butler-session <thread-id> --label "Desktop Butler"
npm run butler -- sessions
npm run butler -- plan-goal "ship a feature"
npm run butler -- status
npm run butler -- dashboard
npm run web
npm run mcp
```

`npm run probe` 会启动本地 `codex app-server --listen stdio://` 子进程，初始化
JSON-RPC，创建临时 read-only thread，运行安全命令，并验证 read-only sandbox 会阻止
文件写入。

`npm run probe:turn` 会额外启动一次真实的 app-server `turn/start`，带
`outputSchema` 校验最终模型响应。它会消耗模型调用，所以没有放进便宜的默认
`npm run smoke`。

## 当前已实现范围

- M0 app-server transport 与权限探针。
- `turn/start + outputSchema` 的真实 worker-turn 探针。
- M1 ledger、state machine、role handoff 的确定性契约。
- M2 通过 CLI/service API 暴露的 `codex-butlerd` service core。
- M3 stdio MCP server 与 Butler tools。
- M4 基于 app-server `turn/start` 的 worker dispatch。
- M5 为任务分配隔离 git worktree。
- M6 verifier / rework 状态流转。
- M7 对 verified worktree diff 的确定性 promotion gate。
- M8 CLI 和 MCP 的 status surface。
- M9 长期运行 daemon process 管理。
- M10 从自然语言 goal 自动生成多任务计划。
- M11 从 transcript 中提取 skill-read 证据。
- M12 人类可读 dashboard。
- 本地 Web Console，用于查看 goal/task/event 并触发 daemon、dispatch、verify、
  promote 等操作。
- macOS `launchd` 长期服务，让 daemon 和 Web Console 在当前终端退出后继续运行。
- 本地 session registry：可以把已有 Codex thread/session id 登记到 Butler 管理面，
  包括把某个已有 session 标记为 `butler-controller`。

这是本地确定性控制平面。它目前不声称已经实现远端集群部署、原生桌面 GUI 或正式托管
发布包。

## Butler 控制平面

```sh
npm run butler -- submit-goal "ship a feature"
npm run butler -- plan-goal "ship a feature"
npm run butler -- create-task <goal-id> verifier "run smoke checks"
npm run butler -- dispatch-task <task-id>
npm run butler -- verify-task <task-id>
npm run butler -- verify-task <task-id> -- npm test
npm run butler -- promote-task <task-id>
npm run butler -- register-session <thread-id> worker-session --label "Existing worker"
npm run butler -- add-butler-session <thread-id> --label "Existing Butler"
npm run butler -- sessions
npm run butler -- status
npm run butler -- dashboard
npm run daemon -- start
npm run daemon -- status
npm run daemon -- stop
npm run web -- --port 4177
npm run launchd -- install
```

MCP server 暴露同一套控制平面能力：

- `butler_submit_goal`
- `butler_plan_goal`
- `butler_create_task`
- `butler_dispatch_task`
- `butler_allocate_worktree`
- `butler_run_verifier`
- `butler_promote_task`
- `butler_register_session`
- `butler_add_butler_session`
- `butler_sessions`
- `butler_status`
- `butler_dashboard`
- `butler_daemon_status`
- `butler_daemon_start`
- `butler_daemon_stop`
- `butler_read_ledger`

## Web Console

```sh
npm run web -- --host 127.0.0.1 --port 4177
```

打开 `http://127.0.0.1:4177` 使用本地 Web Console。默认只绑定
`127.0.0.1`，提供和 CLI 相同的本地控制平面操作：规划 goal、查看 task/event、
登记已有本地 session、管理 daemon、分配 worktree、dispatch task、运行 verification、
promotion verified work。

## 管理已有本地 Session

如果本地已经有可识别的 Codex thread/session id，可以把它登记进 Butler 状态，而不是
只能让 Butler 新建 worker session：

```sh
npm run butler -- register-session <thread-id> worker-session --label "Existing worker"
npm run butler -- add-butler-session <thread-id> --label "Existing Butler"
npm run butler -- sessions
```

`add-butler-session` 是 `register-session` 的快捷形式，会把该已有 session 标记为
`butler-controller`。当前实现负责把已有 session 纳入 Butler 的状态、dashboard、MCP 和
Web Console；它不会伪造 app-server 不提供的“自动枚举所有本地会话”能力。

## 长期本地服务

需要让 Butler 在当前终端或当前 Codex turn 结束后继续可用时，使用 macOS `launchd`
服务：

```sh
npm run launchd -- install
npm run launchd -- status
```

这会安装并启动两个用户级 LaunchAgent：

- `com.codex-butler.daemon`：由 `launchd` 监督的 Butler daemon。
- `com.codex-butler.web`：本地 Web Console，默认地址 `http://127.0.0.1:4177`。

常用运维命令：

```sh
npm run launchd -- restart
npm run launchd -- logs
npm run launchd -- uninstall
npm run launchd -- install --target web --host 127.0.0.1 --port 4178
```

plist 文件位于 `~/Library/LaunchAgents/`。日志写入 `.codex-butler/logs/`。
