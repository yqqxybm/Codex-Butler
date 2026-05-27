# Codex Butler 使用手册

Codex Butler 是一个本地管家托管台。正常使用时，你不用理解任务链、验证或排障细节。
只做三步：

```text
打开网页 -> 确认推荐 session -> 启动管家托管
```

网页地址：

```text
http://127.0.0.1:4177
```

## 1. 打开网页

打开网页后，先看“系统状态”和“选择 Session”。

- 显示“后台运行中”：可以选择 session 并启动托管。
- 显示“后台已停止”或“后台状态待刷新”：点“启动后台”。

旧会话、日志和排障记录都不用先看。

## 2. 选择一个 session

在“选择 Session”里看推荐卡片。页面会自动选中最适合托管的工作 session。
每张卡片会显示 session 标题、最后用户目标、最近助手回应、目录和更新时间，用来判断它到底是哪段工作。

- `推荐`：优先选这个，通常就是你要交给管家的工作 session。
- `需确认`：这个 thread id 有重复登记，确认后再选。
- `不推荐`：通常是当前管家控制台，不适合作为默认目标。

如果列表里没有，就粘贴 session/thread id，点 `添加 session`。

可以在“托管目标”里补一句目标，例如：

```text
继续推进这个项目，直到完成或需要我做选择
```

确认“当前选择”正确后，点 `启动管家托管`。

## 3. 只看主控台

启动后，只看“管家托管状态”。页面会给你一个主按钮。

你只会遇到几种情况：

- `等待第一轮执行证据`：已经创建托管记录，但还没有任何推进 turn，不能算已经接管成功。
- `继续自动推进`：管家继续恢复这个 session 并推进。
- `提交选择并继续`：说明它真的需要你做选择；写一句决策再点。
- `重试推进`：说明本轮执行失败，可以重新跑。
- `已达成目标`：说明这个 session 已经完成。

不要先展开排障信息。只有连续重跑仍失败时，再看“排障信息”。

注意：session 托管使用 `codex exec resume <session>`。如果这个 session 能被 Codex CLI
恢复，后台就能推进它；如果恢复失败，主控台会停在阻塞状态并显示原因。没有 `turn`
记录或输出文件时，页面不会把它说成“已接管”。

## 4. 排障时再看

下面这些区域默认不用看：

- “状态数字”：看总数。
- “选择 Session”：检查或更换要托管的 session。
- “排障记录”：看是哪一步失败。
- “最近事件”：看 Butler 实际做过什么。

常见处理：

- 连接诊断不可达：仍可尝试启动托管；第一轮 `codex exec resume` 失败会直接阻塞并显示原因。
- 工作区无法创建：确认当前项目是 Git 仓库，并且主工作区干净。
- 连续重跑失败：展开“排障信息”，再决定换目标、重写要求或人工处理。

## 添加已有 session

如果你有一个现成的 Codex session/thread id：

1. 在“选择 Session”里粘贴 id。
2. 点“添加 session”。
3. 看它是否出现在推荐卡片里；需要排障时再点“诊断连接”。

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

- app-server 检查返回 `thread not found` 只说明不能走 app-server worker 复用；session 托管主路径是 `codex exec resume`。
- `current-session / attached` 代表当前 Codex 会话是控制台，不能作为被托管目标。
- 当前控制台、管家会话、重复 thread、与当前控制台同 thread 的登记项都会被禁用。
- `启动管家托管` 会创建托管记录并尝试恢复选中的 Codex session；必须出现推进 turn 才算真实推进过。
