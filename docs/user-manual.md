# 使用手册

这份手册说明两件事：

- 怎么判断一个 Butler / worker session 是否真的能被当前控制平面使用；
- 怎么操作 `http://127.0.0.1:4177` 这个 Web Console。

## 当前边界

Web Console 是本地控制台，不是聊天窗口。它直接调用 `ButlerService`，用于管理
goal、task、session registry、daemon、verification 和 promotion。

一个 session 出现在列表里，只代表它被登记进 `.codex-butler/state.json`。它是否真的
有用，必须通过 `Probe` 或 CLI probe 证明：

```sh
npm run butler -- probe-session <session-id-or-thread-id>
```

判定标准：

- `ok: true`：当前控制平面能向这个 session 发 turn，并收到符合 schema 的响应。
- `ok: false` 且 `thread not found`：这个 id 只是被登记了，当前 app-server transport
  找不到它，不能当可调度 session 使用。
- Web 上显示 `reachable`：上一次 probe 成功。
- Web 上显示 `unreachable`：上一次 probe 失败。

2026-05-20 的本机测试发现：用独立 `codex app-server --listen stdio://` 创建出的 thread
不能被后续新的 app-server 连接重新找到。因此长期可用的判据不是“创建成功”，而是
`probe-session` 成功。

## 启动 Web Console

长期服务方式：

```sh
cd /Users/wangzhiwen/Desktop/codex-butler
npm run launchd -- install
npm run launchd -- status
```

打开：

```text
http://127.0.0.1:4177
```

临时前台方式：

```sh
npm run web -- --host 127.0.0.1 --port 4177
```

## 页面区域

### 左侧导航

- `Overview`：回到顶部。
- `Goals`：查看已创建的目标。
- `Sessions`：查看和 probe 已登记的本地 session。
- `Tasks`：查看计划生成的任务图，并触发任务动作。
- `Events`：查看末尾一组 ledger events。

左下角 daemon 状态显示长期后台服务是否在运行。

### 顶部操作

- `Refresh`：刷新 dashboard、session、task、event 数据。
- `Start Daemon`：启动 Butler daemon。
- `Stop`：停止 Butler daemon。

### New Objective

输入一个目标后点击 `Plan Goal`。系统会调用：

```sh
npm run butler -- plan-goal "<objective>"
```

结果会生成一个 goal 和一组 role-owned tasks，例如 implementation、review、verifier、
promoter。

### Existing Session / Thread

输入已有 Codex thread/session id，再点 `Add Butler Session`。系统会把它登记为
`butler-controller`。

注意：登记不等于可用。登记后必须在 Sessions 区域点击 `Probe`。

### Metrics

- `Goals`：goal 总数和 active 数。
- `Tasks`：task 总数和 queued 数。
- `Blocked`：blocked goal/task 数。
- `Sessions`：已登记 session 数，以及 butler-controller 数。

### Sessions

每个 session 显示 role、source、thread id、cwd，以及上一次 probe 的 health。

按钮：

- `Probe`：向该 session 发一个最小 turn，验证当前控制平面能否真正使用它。

### Tasks

每个 task 有四个动作：

- `Worktree`：为该 task 分配隔离 git worktree。
- `Dispatch`：把 task 发给 worker session。
- `Verify`：运行 verifier。
- `Promote`：把 verified worktree diff 提升到 main workspace。

正常顺序是：

```text
Plan Goal -> Worktree -> Dispatch -> Verify -> Promote
```

如果前置条件不满足，API 会返回错误。例如 promotion 要求目标 task 已 verified，并且 main
workspace 干净。

### Events

显示末尾一组 ledger events，用于确认控制平面确实记录了动作，例如：

- `goal.submitted`
- `goal.planned`
- `session.registered`
- `session.probed`
- `task.dispatched`
- `task.verified`
- `task.promoted`

## 推荐的最小验收流程

1. 打开 Web Console。
2. 确认 daemon 是 `running`。
3. 在 Sessions 里确认已登记 worker sessions。
4. 登记或选择一个 `butler-controller`。
5. 点击该 session 的 `Probe`。
6. 只有显示 `reachable`，才把它视为真正可用。
7. 在 New Objective 输入一个小目标，点击 `Plan Goal`。
8. 查看 Goals、Tasks、Events 是否同步更新。

## 命令行等价操作

```sh
npm run butler -- sessions
npm run butler -- probe-session <session-id-or-thread-id>
npm run butler -- plan-goal "Build a tiny smoke task"
npm run butler -- dashboard
```

Web 页面只是这些 service/API 的可视化入口；如果网页表现异常，优先用这些命令确认底层
状态。
