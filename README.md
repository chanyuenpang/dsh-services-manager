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

| 位置 | 内容 |
| --- | --- |
| 顶部 | 总数 / 运行 / 异常汇总，「全部刷新」，「重启 DSH」 |
| 每行 | 状态点、名称、端口、所有权标记（`spawned` 本插件启动 / `discovered` 外部进程）、PID、可点击的 URL、最近退出码或错误；行内 启动 / 停止 / 重启 / 日志 |
| 底部 | 「配置 (JSON)」折叠区：直接编辑配置文件，保存时带 revision 校验 |

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
npm test                          # 15 个单测：netstat 解析、签名正反例、配置校验/原子写/冲突、命令分词
node scripts/verify-host.mjs 4599 # 真机验证：不重启 dsh，用最小 seam 替身驱动真实 RPC 面
```

`scripts/verify-host.mjs` 会核对：`snapshot` 与本机 `netstat` 逐行一致、配置冲突/非法被拒、
真实启动一个临时 HTTP 服务（端口真的起来、PID 可读、日志可取）、停止后端口真的释放、
以及**签名不匹配时拒绝终止且该进程仍存活**。

## 架构（三句话）

- 宿主半边 `src/index.mjs` 提供 `ctx.subprocess` + `connection` 依赖，注册一条 RPC 通道 `/dsh-services`。
- 浏览器半边 `lib/client.js` 是手写的 `window.__ModuleLoader__.load({...})` 单文件 bundle，注册 `settings.section`，只通过 `ctx.connection.rpc.call` 与宿主通信。
- 监管核心 `src/supervisor.mjs`：活性以端口为准，所有权分 `spawned` / `discovered`，终止外部进程前必须通过命令行签名校验。

RPC 端点：`snapshot`、`start`、`stop`、`restart`、`restart-dsh`、`config.get`、`config.set`、`logs`；
返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, details? } }`；
错误码：`SERVICE_NOT_FOUND`、`PORT_OWNED_BY_OTHER`、`CONFIG_CONFLICT`、`CONFIG_INVALID`、`ALREADY_SCHEDULED`、`TIMEOUT`、`OPERATION_FAILED`。

## 已知限制

- 分区图标固定为齿轮（DSH 设置 shell 的 `navIcon` 是硬编码 if 链，没有第三方扩展点）。
- 服务日志来自托管进程的 collected 输出（内存 tail 64KB + 落盘 spill）；`dsh` 重启后旧日志不再可得。
- 不支持管道/重定向类命令；需要的话请自己写一个脚本，把脚本路径填进 `command`。
- 只支持 Windows（`netstat` / `taskkill` / `cmd.exe` 路径）；POSIX 上还有 `launchArgv` 的 sh 分支未经真机验证。

## 来源与致谢

- 重启机制来自 `dsh-restart` skill 的 `restart-dsh.mjs`（`src/restart-supervisor.mjs` 是其原样副本），
  其原理记录在 `G:\Projects\DSH-cindy-host\.claw\adr\0009-restarting-the-instance-that-hosts-the-session.md`。
- 领域与合同设计：`.claw/tasks/2026-09-24/dsh-services-manager-插件/feature-architecture/2026-09-24-1429-宿主后台服务管理插件设计.md`。
