# dsh-memory-panel

DeepSeek Harness 插件：把 `~/.dsh/memory` 的长期记忆做成可视面板，并在宿主 HTTP 服务器上认领 `/memory-panel` 前缀。

一般不需要单独安装这个目录——用套件根目录的 `install.ps1` / `install.sh` 即可，它会负责挂进 profile。

## 两个半边

| 文件 | 角色 |
|---|---|
| `index.js` | Host 插件。`ctx.webServer.register({ kind: 'prefix', path: '/memory-panel' })`，提供 JSON API + 整页 HTML。用 `inject = ['webServer']`。 |
| `client.js` | 客户端插件。手写 `window.__ModuleLoader__.load`，往 `settings.section` 注册「记忆」一节，内容是同源 iframe。**factory 必须 `return { inject, apply }`**——在 factory 里用 `exports` / `module.exports` 会让 web boot 失败、整个应用起不来。 |
| `api.js` | 数据层：解析 `MEMORY.md`、读档案（含 `.gz`）、bigram 分词检索、重复/冲突检测、`MEMORY.md` 读写与快照、页面模板。 |
| `schedule.mjs` | 调度层：Windows 计划任务 / macOS launchd / Linux cron（无 crontab 时退 systemd）。配置文本生成是纯函数，可跨平台单测。 |

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/memory-panel/` | 面板页面 |
| GET | `/memory-panel/api/state` | 统计 + 记忆分节 + 会话列表 + 健康度 + 冲突检测 |
| GET | `/memory-panel/api/search?q=&limit=` | 分词检索 |
| GET | `/memory-panel/api/file?name=` | 取某份档案（自动解压） |
| GET | `/memory-panel/api/memory` | 读 `MEMORY.md` + 快照列表 |
| POST | `/memory-panel/api/memory` | 写 `MEMORY.md`（校验 + 快照 + 重建注入区） |
| POST | `/memory-panel/api/memory/restore` | 回滚到某份快照 |
| GET/POST | `/memory-panel/api/schedule` | 读 / 改归档频率（`?minutes=N`） |
| POST | `/memory-panel/api/sync` \| `render` \| `ingest` \| `compact` | 跑对应 memctl 子命令 |
| GET | `/memory-panel/api/paths` | 各目录路径 |

写操作只做两件事：写 `MEMORY.md`（带快照）和调用 `memctl.mjs` 子进程。面板本身不改档案。

## 依赖约定

- 不注册 Typert Remote，客户端直接同源 `fetch` —— 少一层编解码
- 不引入任何第三方运行依赖；Node 内置 `fs` / `path` / `zlib` / `child_process` 足够
- `zstdDecompressSync` 需要 Node ≥ 22.15（DSH 内置运行时要满足；否则归档层不可用）

MIT.
