# Codex Butler

Codex Butler 是一个本地管家会话工作台。它把“我要做什么”交给一个 Butler 管家会话，
再由管家调度执行会话、审查结果、运行验证，并在本机记录推进证据。

日常入口只有一个：

```text
http://127.0.0.1:4177
```

完整操作说明见 [docs/user-manual.md](docs/user-manual.md)。

## 快速开始

```sh
npm run launchd -- install
npm run launchd -- status
```

然后打开：

```text
http://127.0.0.1:4177
```

网页里的推荐流程：

```text
确认推荐 session -> 接管选中的 session -> 等完成或提交选择
```

日常只看主控台。它只会告诉你三类状态：自动推进中、需要你选择、已完成。
如果需要选择，直接在主控台写一句决策再继续；排障记录和日志只在失败时展开。

如果你要把正在对话的这个 Codex 会话作为管家，先运行：

```sh
npm run butler -- add-current-butler-session --label "Current Codex Butler"
```

这会读取 `CODEX_THREAD_ID` 并登记为 `current-session`。它表示“当前会话已附着为管家”，
不表示它可以被新的 app-server 连接重新发 turn。

## 怎么判断 session 有用

session 出现在列表里只代表“已登记”。网页会把它们整理成推荐卡片：

- `推荐`：普通工作 session，优先接管。
- `需确认`：重复 id 或边界不清，确认后再接管。
- `不推荐`：当前管家控制台或控制会话，容易和当前对话并行。

卡片会从 `~/.codex/session_index.jsonl` 和最近 transcript 抽取标题、最后用户目标、
最近助手回应、目录和更新时间；原始 transcript 不直接铺在页面上。

接管主路径是 `codex exec resume <session>`：管家会恢复选中的 Codex session，
连续发送推进 turn，直到完成、阻塞或需要你选择。

必须检查成功才算可用：

```sh
npm run butler -- probe-sessions
npm run butler -- probe-session <session-id-or-thread-id>
```

如果 app-server probe 返回 `thread not found`，说明它不能走 app-server worker 复用；
但只要 `codex exec resume <session>` 能恢复，仍可走网页里的“接管选中的 session”。

## 常用命令

```sh
npm run launchd -- status
npm run butler -- sessions
npm run butler -- add-current-butler-session --label "Current Codex Butler"
npm run butler -- probe-sessions
npm run butler -- follow-session <session-id-or-thread-id> "继续推进直到完成"
npm run butler -- advance-session-run <run-id>
npm run butler -- resume-session-run <run-id> "我的选择是..."
npm run butler -- plan-goal "你的目标"
npm run butler -- replan-goal <goal-id>
npm run butler -- retry-task <task-id>
npm run butler -- advance-goal <goal-id>
npm run butler -- advance-goal <goal-id> --max-steps 20
npm run butler -- dashboard
```

高级调试命令仍然保留：

```sh
npm run butler -- allocate-worktree <task-id>
npm run butler -- dispatch-task <task-id>
npm run butler -- verify-task <task-id>
npm run butler -- promote-task <task-id>
```

普通使用优先走网页或 `advance-goal`，不要手动拆四步。

## 已实现

- 本地 Web 管家会话工作台。
- macOS `launchd` 长期后台服务。
- Session 追踪：选择一个 Codex session 后，管家用 `codex exec resume` 自动推进。
- 目标规划：自然语言目标生成任务链。
- 一键推进：按任务依赖自动选择下一步，支持推进到阻塞或完成。
- 阻塞诊断：主控台显示用户动作，不暴露底层协议错误；卡住时可一键重跑并继续。
- 会话检查：批量检查 session 是否真实可达。
- 工作区隔离：实现类任务使用 Git worktree。
- 验证和提升 gate：验证通过后才允许 promotion。
- CLI 和 MCP 暴露同一套能力。

## 运行要求

- Node.js 22 或更新版本。
- 当前目录是 Git 仓库。
- 本机 Codex CLI 支持 `app-server`。
- 本机 Codex 账号可以正常启动 app-server。

## 验证

```sh
npm run check
npm test
npm run smoke
```

`npm run smoke` 会检查语法、测试和 app-server 基础能力。真实执行会话探针会消耗模型调用，需要时手动运行：

```sh
npm run probe:turn
```

## 文档

- [docs/user-manual.md](docs/user-manual.md)：用户操作手册。
- [docs/runbook.md](docs/runbook.md)：运维和排障。
- [docs/architecture.md](docs/architecture.md)：架构和状态流。
