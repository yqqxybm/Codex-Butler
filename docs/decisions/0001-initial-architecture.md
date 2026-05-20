# 0001 初始架构

## 状态

Accepted。

## 背景

目标产品是一个 Codex session orchestration system。用户只需要和一个 Butler Codex
session 交流；Butler 负责协调专门的 worker sessions、校验结果、路由 review，并且只
promote 已验证的工作。

纯 prompt orchestration 不够可靠，因为本机默认 Codex 配置可能允许很宽的文件系统访问。
系统需要确定性的 service boundary，不能只依赖 worker 自报和 prompt 约束。

## 决策

把 `codex-butler` 做成确定性控制平面：

- 使用 app-server threads 作为真实 session transport；
- 把 `codex exec` 限制为协议 harness；
- 每个 goal 和 task 都有显式 state；
- 所有 side-effect decisions 写入 append-only ledger；
- 要求 role contracts 和 structured worker outputs；
- verification 和 promotion 在 worker self-reporting 之外完成。

## 结果

这会在全自动化之前增加一些实现工作，但它能避免核心失败模式：worker 在没有外部证据的
情况下声称完成、声称 deep review，或直接污染 main workspace。
