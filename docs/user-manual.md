# Codex Butler 使用手册

Codex Butler 是一个本地管家会话工作台。正常使用时，你不用理解任务链、会话、验证或排障细节。
只做三步：

```text
打开网页 -> 输入目标 -> 点主控台给出的按钮
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

## 2. 交给管家目标

在“你想让管家完成什么”里写一句目标，例如：

```text
把项目手册改成用户能直接照着操作的版本
```

然后点 `交给管家推进`。

## 3. 只看主控台

目标生成后，只看“管家现在在做什么”。页面会给你一个主按钮。

你只会遇到几种情况：

- `继续推进`：点它，管家继续往下做。
- `刷新状态`：说明管家正在等结果，点它或等页面自动刷新。
- `重新跑这一步并继续`：说明某一步没交付合格结果，点它重新跑。
- `查看最新状态`：说明目标已经完成；继续工作要输入新目标。

不要先展开排障信息。只有连续重跑仍失败时，再看“排障信息”。

注意：当前这个 Codex 聊天窗口只是管家控制台。网页里的推进动作会创建或调度执行会话，
不会把执行过程消息推回当前聊天窗口；网页状态变了才代表 Butler 有动作。

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
- `current-session / attached` 只代表当前 Codex 会话已作为管家控制台附着；网页推进不会让当前聊天窗口自动冒出执行消息。
- `交给管家推进` 会真实运行执行会话、验证命令和提升 gate；不要在未准备好的项目里随便启动推进。
