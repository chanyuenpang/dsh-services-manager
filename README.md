# dsh-services-manager

DSH Web 的一个小插件：在**设置页**里加一个「服务管理」分区，用来查看和操作宿主上的后台网络服务
（`dsh web` 自己、mechanics web、tiny-world Web 原型，以及你自己加进来的任何服务）。

- 看状态：端口是否在监听、占用者 PID、是**本插件启动的**还是**外部已存在的**、最近退出码 / 错误、可选 HTTP 健康探测。
- 一键操作：启动 / 停止 / 重启 / 刷新 / 看日志。
- 配置驱动：服务定义都在一个 JSON 文件里，面板内可直接编辑并写回（文件是唯一事实来源）。
- 生命周期：标了 `autostart` 的服务随 `dsh web` 启动自动拉起；`dsh` 退出时停止**由本插件启动的**实例。
- 一键重启 dsh 自己：面板里点一下，默认 60 秒后重启（页面会断开，需要重新连接）。

> 非目标：不做通用进程编排/容器平台，不做跨机器管理。

## 安装

```powershell
# 1) 装进 web profile（本机装成 link:，改源码后重启即生效）
dsh plugin --profile web add G:/Projects/dsh-plugins/dsh-services-manager
# 上面这条会同时做两件事：加依赖，并把包名加进 profile 的 dsh.profile.bundles

# 2) 重启 dsh（composition / bundle patch / 客户端 bundle 只在进程启动时加载）
```

重启后打开 **设置 → 服务管理**。导航项用的是通用齿轮图标（DSH 的设置 shell 不支持第三方分区自定义图标）。

**前置要求**：本插件走 `connection.rpc.handle` 注册 RPC 面，因此该 profile 的 `cordis.patch.yml` 必须给 `connection` 行注入 `webServer`：

```yaml
- id: connection
  inject:
    - webRuntime
    - webServer
```

本机正式的 web profile 早已有这一段；**新建 profile（例如沙箱）必须自己补**，否则插件加载即失败，
`cannot get property "webServer" without inject` 会让整个 profile 树起不来（已实测）。

> 开发流程约束：**任何挂进正式 profile 的动作，都必须先在隔离沙箱里通过一次真实启动测试**。
> 完整做法与踩坑清单见 [`AGENTS.md`](AGENTS.md)。

回滚见 [`docs/安装与回滚.md`](docs/安装与回滚.md)。

## 配置

配置文件：`<DSH_HOME>/.dsh-services-manager/services.json`（`DSH_HOME` 缺省为 `~/.dsh`）。
首次运行会自动写入一份包含本机两条真实服务的默认配置（mechanics web、tiny-world Web 原型）。

```jsonc
{
  "version": 1,
  "services": [
    {
      "id": "mechanics-web",              // 稳定键，必填，唯一；'dsh' 是保留值
      "title": "Mechanics Web",           // 面板显示名，缺省用 id
      "port": 4319,                       // 有端口 = 网络服务，活性以「端口是否 LISTENING」判定
      "host": "127.0.0.1",                // 探测地址，缺省 127.0.0.1
      "url": "http://127.0.0.1:4319/",    // 面板上的「打开」链接，缺省由 host+port 推导
      "command": "node \"C:\\...\\cli.mjs\" web --port 4319",  // 必填，启动命令
      "cwd": "G:\\Projects\\mechanics",    // 必填，工作目录
      "autostart": false,                  // dsh 启动时是否自动拉起
      "autoStopOnExit": true,              // dsh 退出时是否停止「本插件启动的」实例
      "takeover": "match",                 // match（默认，要求签名匹配）| force（允许无条件接管）
      "match": { "commandLinePattern": "@veewo[\\\\/]mechanics..." },  // 端口占用者的身份校验（RegExp 源串，大小写不敏感）
      "probe": { "path": "/health", "expectStatus": 200 },             // 可选 HTTP 健康探测
      "env": { "NODE_ENV": "development" }                             // 可选，显式注入的环境变量
    }
  ]
}
```

语义要点：

- **唯一事实来源是文件。** 面板里的增删改会写回它；运行态（谁在跑、PID、退出码）绝不写回。
- **无效条目被隔离**：某一条写错只影响它自己，面板会把它作为配置问题列出，其它服务照常工作。保存时校验失败会直接拒绝，不会把坏配置写进文件。
- **并发写保护**：写入带 `expectedRevision`；文件被外部改过就返回 `CONFIG_CONFLICT`，面板提示重新载入，绝不覆盖。
- **命令不支持管道/重定向/`&&`**（Windows 上会显式拒绝，而不是按字面量执行）：参数会被引用感知地分词后交给 `cmd.exe /d /s /c <程序> <参数…>`，所以带空格的路径用双引号包起来是安全的。

## 面板

**日常操作全部走表单，不需要写 JSON。**

| 位置 | 内容 |
| --- | --- |
| 顶部 | 「＋ 添加服务」「全部刷新」「重启 DSH」 |
| 汇总行 | 共 / 运行 / 已停止 / 异常，以及数据新鲜度（快照缓存命中 · 数据年龄 Nms · 后台补齐中） |
| 每行服务 | 状态徽标（颜色 + 形状 + 文案三重信号）、名称（有 URL 时即链接）、`:端口`、`pid N`、来源符号（`◆` 本插件启动 / `◇` 外部进程，悬停看解释）、**图标按钮**（启动 / 停止 / 重启 / 日志 / 编辑，文字只在悬停提示与 `aria-label` 里）。**“最近事件”只在真有问题时（错误或非零退出）才占一行** |
| 添加 / 编辑表单 | 名称、端口、启动命令、工作目录 + 两个开关（dsh 启动时自动拉起 / dsh 退出时停止）；「高级选项」里才是 id、接管签名、健康检查路径；编辑态多一个「删除」 |
| 底部（高级） | 「高级：直接编辑 JSON」——用于批量修改或表单未覆盖的字段（`env`、`probe.expectStatus` 等）。保存同样受 `expectedRevision` 保护 |

表单只写**定义类**字段，写入路径是宿主的 `config.upsert` / `config.remove`（校验 + 原子写 + 并发保护），
绝不触碰运行态；删除一条配置**不会**停止任何正在运行的进程。

- 轮询：分区打开时每 4 秒刷新一次，页面不可见时暂停，关闭设置即停止。
- 状态是宿主的快照投影，`revision` 单调递增，过期响应会被丢弃（避免刷新竞态把新状态覆盖回旧状态）。
- 面板本身不持久化任何运行态。

## 一键重启 dsh

点「重启 DSH」会先确认，然后由一个**分离的看守进程**执行（与 `dsh-restart` skill 同源、已在本机反复验证的形态）：

1. 记录 `requested:` 到 `<stateDir>/logs/host-restart.log`；
2. 等待 grace（默认 60 秒，面板里可看到倒计时；下限 15 秒，不允许静默为 0）；
3. 停掉 3080 上的目标进程，并清扫这次 DSH 安装留下的进程树（含孤儿的命令子进程）；
4. 等端口释放后，按旧进程的命令行 detached 启动新实例，输出落到 `logs/dsh-web.log`；
5. 新实例的 token URL 在它自己日志的最后一行。

**页面会断开，需要重新连接。** 一次确认只对这一次重启有效。

## 开发与验证

```powershell
npm test                            # 15 个单测：netstat 解析、签名正反例、配置校验/原子写/冲突、命令分词
node scripts/verify-host.mjs 4599   # 真机验证：不重启 dsh，用最小 seam 替身驱动真实 RPC 面
node scripts/verify-lifecycle.mjs 4598  # autostart 拉起 → restart 换 PID → dispose 释放端口
node scripts/verify-rpc-http.mjs "<token url>"  # 真实 HTTP 层：信封字段 + 快层首屏耗时
node scripts/verify-form-api.mjs 4597      # 表单写入路径：upsert/remove 真的改到文件、并发冲突被拒、建出来的服务真能启停
node scripts/bench-snapshot.mjs 5   # 快照耗时基线 + 「事件循环是否被阻塞」的客观测法
pwsh -File scripts/preview-sandbox.ps1        # 起隔离沙箱并在终端打印预览地址（只碰 3099 / .sandbox）
pwsh -File scripts/preview-sandbox.ps1 -Stop  # 看完停掉
```

> 改**客户端**（`lib/client.js`）后刷新预览页即可生效；改**宿主**（`src/**`）必须重启实例，且按
> `AGENTS.md` 先过沙箱门禁 4 项才允许挂正式 profile。

`scripts/verify-host.mjs` 会核对：`snapshot` 与本机 `netstat` 逐行一致、配置冲突/非法被拒、
真实启动一个临时 HTTP 服务（端口真的起来、PID 可读、日志可取）、停止后端口真的释放、
以及**签名不匹配时拒绝终止且该进程仍存活**。

## 快照的两层与新鲜度（v2）

读取分两层，客户端**先上屏再补齐**：

| 层 | 内容 | 实测（本机 3 条服务） |
| --- | --- | --- |
| 快层 | 快照缓存命中（1.5s TTL）或并行本机 TCP 探测（250ms 超时）→ status / ownership | **0 ms**（命中）/ 2–5 ms（未命中） |
| 详层 | `netstat` 取 PID + 按 PID **永久缓存**取命令行 → pid / commandLine | 热 290–514 ms，冷 ~2.5 s；**不阻塞用户可见路径** |

**端点**：`snapshot.fast`（首屏，永远不等详层）、`snapshot.full`（显式刷新/需要 pid 时用，等详层刷新完成）。
`snapshot` 旧调用等价于 `snapshot.full`（`{mode:'fast'|'full'}` 也仍兼容）。

**新鲜度由宿主计算、客户端只投影**，都在 `value.timing` 里：

| 字段 | 含义 |
| --- | --- |
| `collectedAt` / `servedAt` / `ageMs` | 这份观测何时采到、何时发出、现在多大年纪 |
| `tier` | `1` = 只有端口层（pid/命令行可能是空的）；`2` = 含详层 |
| `returnedFromCache` | 本次是否直接命中快照缓存（0 ms 路径） |
| `refreshing` | 后台正在补齐详层 |
| `degraded` | 详层已偏旧（>5s），显示的值可能过期 |
| `cacheMiss` | 宿主手上**没有任何**观测（首帧）：界面必须显示骨架，而不是「0 个服务」 |
| `revision` | 运行态版本，只增 |

客户端约定：只把快照当投影，任何决策都不依赖它；`tier:1` 时 `pid`/`commandLine` 显示「读取中」而不是
「未知」；`degraded` 必须让用户看得出来这份数据不是刚刚采到的。

> **诚实的残留**：Windows 上异步 spawn 一个进程本身仍会让事件循环停 ~0.1–0.25 s（实测心跳最坏间隔
> 111–227 ms）。所以本插件不声称「零阻塞」，而是把这段成本**从用户可见路径与重复路径里移走**：
> 首屏 0 ms，且稳态下每 30s 才可能触发一次详层刷新（旧实现是每 4s 阻塞 1.8s）。
> 想彻底消除需要常驻探测助手进程 —— 那是后续项，不在本版范围。

## 架构（三句话）

- 宿主半边 `src/index.mjs` 提供 `ctx.subprocess` + `connection` 依赖，注册一条 RPC 通道 `/dsh-services`。
- 浏览器半边 `lib/client.js` 是手写的 `window.__ModuleLoader__.load({...})` 单文件 bundle，注册 `settings.section`，只通过 `ctx.connection.rpc.call` 与宿主通信。
- 监管核心 `src/supervisor.mjs`：活性以端口为准，所有权分 `spawned` / `discovered`，终止外部进程前必须通过命令行签名校验。

RPC 端点：`snapshot`（入参见上节 `mode`）、`snapshot.fast`、`snapshot.full`、`start`、`stop`、`restart`、`restart-dsh`、
`config.get`、`config.set`（整份 JSON）、`config.upsert`（表单：按 id 新增/更新一条）、`config.remove`、`logs`；
信封是 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`
（字段名是 **`value`**，且 `details` 是必填对象 —— 传输层按 schema 会剥掉未知键，写错字段名会让浏览器只收到 `{ ok: true }`）；
错误码：`SERVICE_NOT_FOUND`、`PORT_OWNED_BY_OTHER`、`CONFIG_CONFLICT`、`CONFIG_INVALID`、`ALREADY_SCHEDULED`、`UNKNOWN_ENDPOINT`、`TIMEOUT`、`OPERATION_FAILED`。

## 已知限制

- 分区图标固定为齿轮（DSH 设置 shell 的 `navIcon` 是硬编码 if 链，没有第三方扩展点）。
- 服务日志来自托管进程的 collected 输出（内存 tail 64KB + 落盘 spill）；`dsh` 重启后旧日志不再可得。
- 不支持管道/重定向类命令；需要的话请自己写一个脚本，把脚本路径填进 `command`。
- 只支持 Windows（`netstat` / `taskkill` / `cmd.exe` 路径）；POSIX 上还有 `launchArgv` 的 sh 分支未经真机验证。

## 来源与致谢

- 重启机制来自 `dsh-restart` skill 的 `restart-dsh.mjs`（`src/restart-supervisor.mjs` 是其原样副本），
  其原理记录在 `G:\Projects\DSH-cindy-host\.claw\adr\0009-restarting-the-instance-that-hosts-the-session.md`。
- 领域与合同设计：`.claw/tasks/2026-09-24/dsh-services-manager-插件/feature-architecture/2026-09-24-1429-宿主后台服务管理插件设计.md`。
