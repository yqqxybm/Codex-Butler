# Codex Butler 使用手册

Codex Butler 是一个本地网页管家台。它的主路径是：你给目标，Butler 负责拆分、推进、审查和验证；你只在目标卡片要求确认时介入。
正常使用只有三步：

```text
打开网页 -> 输入目标 -> 继续推进
```

网页地址：

```text
http://127.0.0.1:4177
```

## 1. 先看运行环境

打开网页后，先看左侧后台状态和上方“运行环境”卡片。

- 显示“后台运行中”：可以继续输入目标。
- 显示“后台已停止”或“后台状态待刷新”：点“启动后台”。

“已有会话复用”是高级选项，默认收起。检查失败只说明旧会话不可复用，
不等于网页不能推进新目标。

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

- `生成并自动推进`：推荐。生成任务，并推进到完成、明确阻塞或需要你确认的边界。
- `只生成计划`：只看任务拆分，不实际开始。

## 3. 继续推进

目标生成后，只看“当前目标”卡片。它会显示：

- 现在状态。
- 下一步该点什么。
- Butler 的处理链路：分析、实现、审查、验证、收尾。

- 点 `继续自动推进`：推荐。连续推进到完成、阻塞或需要人工介入。
- 点 `只推进一步`：只跑下一步，适合你想逐步观察。

点按钮后会先显示“正在推进”。如果后续停住，目标卡片会直接写明：

- 下一步可推进哪个任务。
- Butler 是否能自动修复。
- 真正需要你处理的原因。
- 错误原文在“技术细节”里，日常不用先看。

正常情况下，你不需要手动理解每个内部任务。“内部步骤”和“最近事件”默认收起，只用于排障。
普通推进优先用“当前目标”卡片。遇到可恢复的 worker 交付格式问题时，点 `自动修复并继续`；
Butler 会自动重新跑一次，不需要你到任务行里手动点重试。

## 4. 看结果

主要看三个地方：

- “当前目标”：目标是否还在推进，以及下一步该点什么。
- “内部步骤”：哪一步完成、哪一步阻塞，仅排障时展开。
- “最近事件”：Butler 实际做过什么动作，仅审计时展开。

如果出现阻塞，先看提示信息。常见情况：

- 会话不可达：回到“会话可用性”，重新检查或换一个 session。
- 工作区无法创建：确认当前项目是 Git 仓库，并且主工作区干净。
- 验证失败：查看任务里的验证结果，再让 Butler 修复或人工处理。

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
- `current-session / attached` 只能代表当前 Codex 会话已作为管家附着，不能代表它可以被远程 dispatch。
- 自动推进会真实运行 worker turn、验证命令和提升 gate；不要在未准备好的项目里随便点“自动推进”。
