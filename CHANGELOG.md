# CHANGELOG

## 1.0.0 — 2026-11-19

首个公开版本。给 DeepSeek Harness 加一套本地长期记忆：归档历史会话、提炼成一份可复用的记忆库，并在每个新会话开头自动注入。

### 采集
- 解压 DSH 的 `session.v4.jsonl.zstd`（**多帧拼接**，按 zstd magic 逐帧解，直接整文件解只出第一帧）
- 每场会话生成一份可读档案：人类原话、每轮结论、触及文件、工具用量
- 增量控制：按「人类输入条数」去重，同一场会话不会重复灌入
- 子代理会话（`delegationDepth > 0`）自动跳过，不污染记忆

### 记忆
- `MEMORY.md` 为唯一真源，8 个固定分节，条目带日期
- 会话内可编辑：保存前自动快照（保留 20 份），支持一键回滚
- 冲突检测：完全重复 / 高度相似（trigram Jaccard ≥ 0.82）/ 状态打架（完成 vs 未做）
- 健康条：注入占比、待办数、档案均体积、最近归档、积压告警

### 注入
- 渲染进 `~/.dsh/AGENTS.md` 的托管区，由 DSH 在每个新会话首轮自动加载
- 24KB 预算保护，超了截断并留指针
- 托管区之外的内容不会被覆盖

### 检索
- 中文 bigram 分词：`控件` 能命中 `控件版`
- 英文按词；原文精确命中额外加权
- 跨 `.md` 与压缩归档 `.md.gz` 检索

### 归档压缩
- 非当月档案合并为 `archive-YYYY-MM.md.gz`，每场会话用 `<!-- mc:session x.md -->` 分块，可原样取回
- 实测压缩率约 45%；同时生成 `monthly/YYYY-MM.md` 摘要

### 调度（跨平台）
- Windows：计划任务 `DSH-Memory-Sync`（PowerShell `Register-ScheduledTask`）
- macOS：`~/Library/LaunchAgents/com.dsh.memory-sync.plist`（launchd `StartInterval`）
- Linux：用户 `crontab` 标记块；没有 crontab 时退回 `systemd --user` timer
- 配置文本生成全部是纯函数，可跨平台单测

### 面板
- 宿主侧认领 `/memory-panel` 前缀：JSON API + 自包含页面，不注册 Typert Remote
- 客户端在「设置」里加「记忆」一节，同源 iframe
- 五个标签页：记忆条目 / 会话档案 / 全文检索 / 自动化 / 系统与路径

### 已知限制
- 归档依赖调度器，DSH 关闭后仍会执行（这是有意的）
- 面板只绑 `127.0.0.1`，同机程序理论上可读（本机信任模型）
- `zstdDecompressSync` 需要 Node ≥ 22.15
- 记忆质量取决于提炼质量，AI 判断失误会写进 `MEMORY.md`（有快照可回滚）
