# Codex Butler 使用手册

Codex Butler 是一个本地管家会话工作台。正常使用时，你不用理解任务链、验证或排障细节。
只做三步：

```text
打开网页 -> 选择 session -> 接管并自动推进
```

网页地址：

```text
http://127.0.0.1:4177
```

## 1. 打开网页

打开网页后，先看“系统状态”。

- 显示“后台运行中”：可以继续输入目标。
- 显示“后台已停止”或“后台状态待刷新”：点“启动后台”。

旧会话、日志和排障记录都不用先看。

## 2. 选择一个 session

在“选择 Session”里选一个已有 Codex session。

如果列表里没有，就粘贴 session/thread id，点 `添加 session`。

可以在“跟踪目标”里补一句目标，例如：

```text
继续推进这个项目，直到完成或需要我做选择
```

然后在目标 session 上点 `接管并自动推进`。

## 3. 只看主控台

接管后，只看“管家正在跟踪什么”。页面会给你一个主按钮。

你只会遇到几种情况：

- `继续自动推进`：管家继续恢复这个 session 并推进。
- `提交选择并继续`：说明它真的需要你做选择；写一句决策再点。
- `重试推进`：说明本轮执行失败，可以重新跑。
- `已达成目标`：说明这个 session 已经完成。

不要先展开排障信息。只有连续重跑仍失败时，再看“排障信息”。

注意：session 接管使用 `codex exec resume <session>`。如果这个 session 能被 Codex CLI
恢复，管家就能推进它；如果恢复失败，主控台会停在阻塞状态并显示原因。

## 4. 排障时再看

下面这些区域默认不用看：

- “状态数字”：看总数。
- “会话复用”：检查旧会话是否还能复用。
- “排障记录”：看是哪一步失败。
- “最近事件”：看 Butler 实际做过什么。

常见处理：

- 会话不可达：普通新目标仍可推进；旧会话只影响复用。
- 工作区无法创建：确认当前项目是 Git 仓库，并且主工作区干净。
- 连续重跑失败：展开“排障信息”，再决定换目标、重写要求或人工处理。

## 添加已有 session

如果你有一个现成的 Codex session/thread id：

1. 展开“已有会话复用”，粘贴 id。
2. 点“添加管家会话”。
3. 点“检查”或“检查全部会话”。

检查成功后，它才算可以参与调度。

## 命令行等价操作

网页按钮背后对应这些命令：

```sh
npm run launchd -- status
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
```

排障时优先运行：

```sh
npm run butler -- dashboard
```

## 当前限制

- app-server 检查返回 `thread not found` 只说明不能走 app-server worker 复用；session 接管主路径是 `codex exec resume`。
- `current-session / attached` 代表当前 Codex 会话已作为管家控制台附着；接管它本身可能和当前聊天窗口并行，不建议作为默认目标。
- `接管并自动推进` 会真实恢复并推进选中的 Codex session；不要在未准备好的 session 上随便启动。
