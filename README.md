# dsh-services-manager

面向 DSH 0.2 Desktop 与 Web 的服务管理插件：在**设置页**里增加「服务管理」分区，用来查看和操作宿主上的后台网络服务
（当前 DSH Desktop/Web、mechanics web、tiny-world Web 原型，以及你自己加进来的任何服务）。

- 看状态：端口是否在监听、占用者 PID、是**本插件启动的**还是**外部已存在的**、最近退出码 / 错误、可选 HTTP 健康探测。
- 一键操作：启动 / 停止 / 重启 / 刷新 / 看日志。
- 配置驱动：服务定义都在一个 JSON 文件里，面板内可直接编辑并写回（文件是唯一事实来源）。
- 持久启停：手动启动先保存 `autostart=true`，手动停止先保存 `false`；重启服务保持原策略。插件加载只恢复 true，退出清理本插件实例不改策略。
- 一键重启当前 DSH：Desktop 会只重启当前 Electron 应用树并重新打开应用；Web 保留原宿主重启语义。两者都需面板单次确认，约 3 秒后执行。

> 非目标：不做通用进程编排/容器平台，不做跨机器管理。

## 安装

### 公开分发（无需克隆源码）

适配基线为 DSH Desktop/Web **0.2.2-rc.1**。公开安装包包含宿主、界面和 CLI，不需要安装期构建脚本。

在 DSH Desktop 的插件管理器中选择「安装」，输入此预构建包地址：

```text
https://github.com/chanyuenpang/dsh-services-manager/releases/download/v0.2.2/dsh-services-manager-0.2.2.tgz
```

普通 Web profile 可使用：

```powershell
dsh plugin --profile web add https://github.com/chanyuenpang/dsh-services-manager/releases/download/v0.2.2/dsh-services-manager-0.2.2.tgz
```

插件市场条目正在提交；收录后可直接搜索 `dsh-services-manager`。是否需要重启以插件管理器的安装结果为准；安装不授权自动重启。

首次安装不会导入作者的服务列表。所有路径、命令和自动启动策略都由使用者自己登记。插件能启动和停止宿主进程；「重启 DSH」必须单独明确确认，请只登记可信命令。

### 本地包与开发验证

```powershell
# 1) 先在隔离沙箱验证，再安装目标 profile；路径换成你持有的离线包
# DSH 0.2 Desktop
dsh plugin --profile desktop add C:/Packages/dsh-services-manager-0.2.2.tgz
# 独立 Web profile 仍可使用：dsh plugin --profile web add ...
# 上面这条会同时做两件事：加依赖，并把包名加进 profile 的 dsh.profile.bundles

# 2) 用户明确授权本次正式重启后再执行（新进程才加载宿主/bundle）
```

重启后打开 **设置 → 服务管理**。导航项用的是通用齿轮图标（DSH 的设置 shell 不支持第三方分区自定义图标）。

**前置要求**：DSH >=0.2.2-rc.1（当前适配基线为 Desktop 0.2.2-rc.1）、Cordis >=4.1。
插件自行声明 `subprocess`、`connection`、`webServer` 依赖；包内 patch 为 `connection` 补充 `webServer` 并保留当前模板的 `webStartup` 注入，**不需要用户手改 profile**。旧版 `webRuntime` 注入已不适用于此版本；真实沙箱会检查这条兼容链路。

GUI 中通过插件管理器安装本地包；安装结果决定是否即时生效或等待重启。安装并不授权重启，用户可自行重启。插件管理器中提供中英文名称、说明及原创服务图标。

> 开发流程约束：**任何挂进正式 profile 的动作，都必须先在隔离沙箱里通过一次真实启动测试**。
> 完整做法与踩坑清单见 [`AGENTS.md`](AGENTS.md)。

回滚见 [`docs/安装与回滚.md`](docs/安装与回滚.md)。

## 无源码 CLI（agent 的主要自足入口）

包内自带 `dsh-services`，不注入 skill、不需要开发仓库。完整合同在 **`--help`**，离线也可读；帮助会打印已解析的安装位置：

```powershell
# profile 安装不保证 PATH 有 bin；以下两种入口等价
& "<profile>/node_modules/.bin/dsh-services.cmd" --help
node "<profile>/node_modules/dsh-services-manager/src/cli.mjs" --help
# 仅安装 CLI 的离线独立目录（Cordis peer 由实际 DSH 宿主提供）
npm install --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund C:/Packages/dsh-services-manager-0.2.2.tgz
```

显式设置 `DSH_SERVICES_URL=http://127.0.0.1:<port>`，token 由用户从授权的 DSH 访问 URL 私下提供，放 `DSH_SERVICES_TOKEN` 或受保护 stdin（`--token-stdin` 第一行）。不把 token 放命令参数/聊天/日志；不扫描其他 profile、猜测 token。仅支持 loopback，localhost 固定为 127.0.0.1；认证沿用 token→cookie→原有 /dsh-services RPC，禁止跟随重定向。该凭据是现有宿主权限，**不是 agent 权限沙箱**。

常用命令：`register --file service.json`（或 `--file -` 读 stdin）、`list`、`get`、`start ID`、`stop ID`。登记要求显式稳定合法 id；新条目须含 command/cwd/port/非空安全签名。已有 id 只合并显式字段及嵌套键，未知字段拒绝，不自动截断/改名、不启动进程。UI 表单仍支持自动 id 与端口推断。

register/remove 先读当前 revision，由宿主在同步提交内以 expectedRevision 原子保存（单宿主写者，不是跨进程事务）。冲突退出 5：`get` 读回、核对后以 `--revision 新值` 重提相同 id，不盲重试。坏条目拒绝修改，不丢弃。启停执行失败可能已经保存策略，应看 error.details.policyCommitted/autostart/configRevision；断线后先 get/list。CLI 不直接改配置、不启动第二个 manager、不提供宿主重启入口。

`private:true` 保留以避免误发 npm；公开交付使用 GitHub Release 的预构建 `npm pack` tarball，插件市场可直接指向该包。`npm run verify-cli-package` 从全新含空格目录离线安装包，并从非仓库 cwd 验证直接入口与 .bin；隔离 HTTP 客户端测试不等于真实 DSH 沙箱上线门禁（另见安装文档）。

## 配置

配置文件：`<DSH_HOME>/.dsh-services-manager/services.json`（`DSH_HOME` 缺省为 `~/.dsh`）。
首次运行仅在文件不存在时写入 `{"version":1,"services":[]}`。没有本机路径或预置服务；升级绝不覆盖已有 `services.json`。下面只是示例，请替换成你自己的路径。

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
      "cwd": "C:/Services/My API",        // 必填，替换为宿主上的工作目录
      "autostart": false,                  // dsh 启动时是否自动拉起
      "autoStopOnExit": true,              // dsh 退出时是否停止「本插件启动的」实例
      "takeover": "match",                 // 必须签名匹配；旧 force 不再绕过校验
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
| 添加 / 编辑表单 | 名称、启动命令、工作目录 + 两个开关（dsh 启动时自动拉起 / dsh 退出时停止）；**端口可以留空**——会从启动命令里识别 `--port 5173` / `-p` / `PORT=` / `:5173`（识别到会提示「已从命令识别」，也可手动覆盖）；**命令在 shell 里执行**，所以 PATH 里的命令直接写即可（`mech web`、`npm run dev`），路径带空格用双引号；「高级选项」里才是 id、接管签名、健康检查路径；编辑态多一个「删除」 |
| 底部（高级） | 「高级：直接编辑 JSON」——用于批量修改或表单未覆盖的字段（`env`、`probe.expectStatus` 等）。保存同样受 `expectedRevision` 保护 |

表单只写**定义类**字段，写入路径是宿主的 `config.upsert` / `config.remove`（校验 + 原子写 + 并发保护），
绝不触碰运行态；删除一条配置**不会**停止任何正在运行的进程。

- 轮询：分区打开时每 4 秒刷新一次，页面不可见时暂停，关闭设置即停止。
- 状态是宿主的快照投影，`revision` 单调递增，过期响应会被丢弃（避免刷新竞态把新状态覆盖回旧状态）。
- 面板本身不持久化任何运行态。

## 一键重启 dsh

点「重启 DSH」会先确认，然后由一个**分离的看守进程**执行（与 `dsh-restart` skill 同源、已在本机反复验证的形态）：

1. 记录 `requested:` 到 `<stateDir>/logs/host-restart.log`；
2. 面板确认后由看守等待 grace 3 秒再开始停旧进程（下限 3 秒；未指定的宿主 RPC 仍默认 60 秒）。`dsh-restart` skill 也默认 3 秒，但每次必须单独明确同意并事先告知当前回复可能中断；
3. 停掉 3080 上的目标进程，并清扫这次 DSH 安装留下的进程树（含孤儿的命令子进程）；
4. 等端口释放后，按旧进程的命令行 detached 启动新实例，输出落到 `logs/dsh-web.log`；
5. 新实例的 token URL 在它自己日志的最后一行。

**页面会断开，需要重新连接。** 一次确认只对这一次重启有效。

## 开发与验证

```powershell
npm test                            # 配置/持久启停/登记/CLI HTTP/客户端回归
npm run verify-cli-package           # 离线 tarball、新目录安装、任意 cwd 的 bin/help 与隔离认证 HTTP
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
> 预览时请用**硬刷新**（Ctrl+Shift+R）：客户端 bundle 走的是 `immutable` 长缓存，普通刷新可能仍用旧 bundle。

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
`config.get`、`config.set`（整份 JSON）、`config.upsert`（表单；`registration:true` 为 CLI 严格登记）、`config.remove`、`logs`；
信封是 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`
（字段名是 **`value`**，且 `details` 是必填对象 —— 传输层按 schema 会剥掉未知键，写错字段名会让浏览器只收到 `{ ok: true }`）；
错误码：`SERVICE_NOT_FOUND`、`PORT_OWNED_BY_OTHER`、`CONFIG_CONFLICT`、`CONFIG_INVALID`、`ALREADY_SCHEDULED`、`UNSUPPORTED_RUNTIME`、`UNKNOWN_ENDPOINT`、`TIMEOUT`、`OPERATION_FAILED`。

## 已知限制

- 分区图标固定为齿轮（DSH 设置 shell 的 `navIcon` 是硬编码 if 链，没有第三方扩展点）。
- 服务日志来自托管进程的 collected 输出（内存 tail 64KB + 落盘 spill）；`dsh` 重启后旧日志不再可得。
- 不支持管道/重定向类命令；需要的话请自己写一个脚本，把脚本路径填进 `command`。
- 自重启只支持 Windows（`netstat` / `taskkill` / WMI）；Desktop 0.2 当前没有公开的应用重启 IPC，插件通过脱离应用树的看守强制停止当前 Electron 树并重新启动同一 exe，因此正在执行的任务会中断。
- POSIX 上 `launchArgv` 的 sh 分支未经真机验证，且不提供自重启。

## 来源与致谢

- Web 重启机制最初来自 `dsh-restart` skill；`src/restart-supervisor.mjs` 已扩展为 DSH 0.2 Desktop/Web 双运行时实现，不再是原样副本。
- 领域与合同设计：`.claw/tasks/2026-09-24/dsh-services-manager-插件/feature-architecture/2026-09-24-1429-宿主后台服务管理插件设计.md`。
