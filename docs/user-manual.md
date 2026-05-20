# Codex Butler 使用手册

Codex Butler 是一个本地网页管家台。你的正常使用方式只有三步：

```text
打开网页 -> 输入目标 -> 继续推进
```

网页地址：

```text
http://127.0.0.1:4177
```

## 1. 先看后台

打开网页后，先看左侧“后台”状态。

- 显示 `running`：可以继续输入目标。
- 显示 `stopped` 或 `stale`：点“启动后台”。

页面里的“会话”区域用于管理已有 session。检查成功表示该 session 当前可复用；
检查失败只说明这个已登记 session 不可复用，不等于网页不能推进新目标。

如果你希望当前正在对话的 Codex 会话当管家，在终端运行：

```sh
npm run butler -- add-current-butler-session --label "Current Codex Butler"
```

这类会话会显示为 `attached`。含义是：当前会话可以作为你正在使用的管家来操作 Butler；
但它不是可被 app-server 重新发消息的 worker 会话。

## 2. 输入目标

在“输入这轮要完成的目标”里写你要 Butler 推进的事，例如：

```text
把项目手册改成用户能直接照着操作的版本
```

然后点：

- `生成并推进`：推荐。生成任务，并立刻推进第一个可执行步骤。
- `只生成计划`：只看任务拆分，不实际开始。

## 3. 继续推进

目标生成后，看“目标”区域。

- 点 `继续推进`：只推进下一步，适合你想逐步观察。
- 点 `自动推进`：连续推进到完成、阻塞或需要人工介入。

点按钮后会先显示“正在推进”。如果后续停住，目标卡片会直接写明：

- 下一步可推进哪个任务。
- 自动推进停在了哪个任务。
- 停住原因，例如 `rework`、验证失败、前置任务未满足。

正常情况下，你不需要手动理解每个内部任务。下面的“任务”区域只是给你看细节和排障。
任务行只显示当前真正可用的手动操作。普通推进优先用目标卡片；如果任务显示 `rework` 或 `blocked`，
先读任务里的错误；确认要重新跑这一任务时，点该任务右侧的 `重试`，再回到目标卡片点 `继续推进` 或 `自动推进`。

## 4. 看结果

主要看三个地方：

- “目标”：当前目标是否还在推进。
- “任务”：哪一步完成、哪一步阻塞。
- “最近事件”：Butler 实际做过什么动作。

如果出现阻塞，先看提示信息。常见情况：

- 会话不可达：回到“会话可用性”，重新检查或换一个 session。
- 工作区无法创建：确认当前项目是 Git 仓库，并且主工作区干净。
- 验证失败：查看任务里的验证结果，再让 Butler 修复或人工处理。

## 添加已有 session

如果你有一个现成的 Codex session/thread id：

1. 在“会话”区域粘贴 id。
2. 点“添加管家会话”。
3. 点“检查”或“检查全部会话”。

检查成功后，它才算可以参与调度。

## 命令行等价操作

网页按钮背后对应这些命令：

```sh
npm run launchd -- status
npm run butler -- add-current-butler-session --label "Current Codex Butler"
npm run butler -- probe-sessions
npm run butler -- plan-goal "你的目标"
npm run butler -- replan-goal <goal-id>
npm run butler -- retry-task <task-id>
npm run butler -- advance-goal <goal-id>
npm run butler -- advance-goal <goal-id> --max-steps 20
```

排障时优先运行：

```sh
npm run butler -- dashboard
```

## 当前限制

- Butler 只能控制当前 app-server transport 能找到的 session。
- 如果检查返回 `thread not found`，说明这个 id 当前不可达。
- `current-session / attached` 只能代表当前 Codex 会话已作为管家附着，不能代表它可以被远程 dispatch。
- 自动推进会真实运行 worker turn、验证命令和提升 gate；不要在未准备好的项目里随便点“自动推进”。
