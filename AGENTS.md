# AGENTS.md — dsh-services-manager

本文件记录本仓库对**所有 agent** 的硬性约束与已踩过的坑。改动代码前先读完它。

## 当前版本补充（DSH 0.2.2-rc.1）

下文旧命令示例保留作历史诊断；当前版本以这些事实为准，**先沙箱、后正式、不自动重启的门禁不变**：

- 当前运行环境可能是 `desktop` profile，以 `DSH_PROFILE` / `DSH_PROFILE_DIR` 为准，不再固定是 `web`。
- 新版服务为 `webStartup`（启动参数）和 `webApp`（已启动页面）；旧 `webRuntime` 注入不可复用。包内 patch 已给 `connection` 注入 `[webStartup, webServer]`，保留模板 trustedHosts 表达式依赖；不要再手改用户 profile 的 patch。
- 正式安装使用 `plugin_manager install_bundle`，目标为已通过沙箱门禁的同一 tarball，不通过 CLI 绕过当前 profile 管理器。
- PATH 无 `dsh` 时可通过 `scripts/current-dsh.mjs` 启动应用自带同版本 CLI，须显式提供 `DSH_TEST_EXECUTABLE` / `DSH_TEST_CLI`。Electron ASAR 运行时不能用普通 Node 直接加载。
- 3099 被已有实例占用时先核实身份，不要杀未知实例；选择另一个空闲独立端口，四项门禁中的端口同步替换。本次使用 3109。
- `job_kill` 不保证外层 CLI 的 Electron 子进程已退出；结束沙箱后必须确认端口释放。若有残留，只在核对沙箱命令行签名后按精确 PID 停止。
- HTTP 门禁可用 `node scripts/verify-rpc-http.mjs --log <本次沙箱日志>`，不把 token 放 argv 或聊天；同时验证认证首页客户端清单。

## 硬性流程约束：必须先过沙箱，才允许挂载正式环境

**任何"把本插件挂进正式环境"的动作，都必须在隔离沙箱里完成一次真实启动测试并通过之后才允许执行。**

- **正式环境** = 本机真实 `DSH_HOME`（`C:\Users\chany\.dsh`）及其 `profiles\web`。用户正在使用它：
  插件加载失败会让**整个 profile 树起不来**（fail-loud），用户直接掉线。
- **沙箱** = 隔离 `DSH_HOME` + 从模板新建的 profile + 独立端口：

```powershell
$sandbox = "G:\Projects\dsh-plugins\dsh-services-manager\.sandbox\dsh-home"
$env:DSH_HOME = $sandbox
New-Item -ItemType Directory -Force $sandbox | Out-Null

# 1) 从随包模板新建沙箱 profile（不动正式 profile）
dsh --profile sandbox --from-default-profile web --dump-config

# 1.5) 补上 connection 行的注入（随包模板没有；漏了插件加载必失败）
#      在 $sandbox\profiles\sandbox\cordis.patch.yml 写入：
#        - id: connection
#          inject: [webRuntime, webServer]

# 2) 装进沙箱 profile（link: 形式，改源码后重启即生效）
dsh plugin --profile sandbox add G:/Projects/dsh-plugins/dsh-services-manager

# 3) 用独立端口启动，日志落文件
dsh --profile sandbox --port 3099 --no-open *> "$sandbox\..\logs\sandbox-web.log"
```

**通过标准（缺一不可）**：

1. 日志出现 `[dsh-services-manager] 已加载：config=… rpc=/dsh-services pid=…`；
2. 日志**没有** `plugin tree failed to load` / `cannot get property … without inject`；
3. `Get-NetTCPConnection -State Listen -LocalPort 3099` 有监听；
4. 客户端半边确实进了页面：用日志最后一行带 `token=` 的 URL 抓取首页，确认 `dsh-services-manager` 出现在客户端模块清单里。

只有以上全部通过，才允许执行 `dsh plugin --profile web add …`。
正式环境的**重启**另有约束：必须先用 `ask_user_question` 拿到用户对**这一次**重启的明确同意（见 `dsh-restart` skill）。

**边界**：

- 纯文档、纯客户端 `lib/client.js` 的小改动，可复用最近一次通过的沙箱结论；
  任何触及宿主半边（`src/`）、`cordis.patch.yml`、`package.json` 形状的改动，**必须重跑沙箱**。
- 沙箱实例用完停掉，不要长期占着 3099。
- 不要为了省事把沙箱 profile 指向正式 `DSH_HOME`；那等于没隔离。

> **危险：绝不要在沙箱里真的触发重启。** `restart-supervisor` 的清扫名单是按「**本次 DSH 安装**」识别的
> （命令行里含 `@deepseek-ai/dsh/` 路径标记），不是按实例识别。对沙箱实例执行重启，会连带杀掉**正式实例的整棵进程树**
> ——包括承载你当前对话的那一个。要验证重启链路，请用「长 grace 调度 + 立刻杀掉看守」，或至少加 `--keep-sandboxes`。

## 已踩过的坑（重跑沙箱的价值就在这里）

| 症状 | 根因 | 正确做法 |
| --- | --- | --- |
| `cannot get property "config" without inject`，整个 profile 起不来 | cordis 以 `(ctx, config)` 调用插件体，`ctx.config` 未声明 inject 时访问即抛 | `export function apply(ctx, config)`，用第二个参数读 loader 行的 config 段 |
| `cannot get property "webServer" without inject`，整个 profile 起不来 | `connection.rpc.handle` 需要 **`connection` 行**注入 `webServer`/`webRuntime`；随包模板里没有，正式 profile 靠 patch 补 | 在该 profile 的 `cordis.patch.yml` 加 `- id: connection` + `inject: [webRuntime, webServer]`。**沙箱 profile 也必须加**（新建 profile 最容易漏这一步）。注意不是给自己的插件行加 inject —— 实测给 `dsh-services-manager` 行加 `inject: [webServer]` 无效 |
| `Cannot find module '…\"…scratch-server.mjs\"'` | 把整条 shell 命令当成**单个** argv 元素交给 `cmd.exe`：Node 会给它整体加引号并把内部引号转义成 `\"`，cmd 不认 | 引用感知分词后把参数各自独立传：`cmd.exe /d /s /c <程序> <参数…>`（见 `src/command.mjs`） |
| 主动 `stop` 之后状态显示 `error` | 被 terminate 的进程退出码非零，被当成崩溃 | 记录 `lastStopAt`，只有「不是我们主动停止」造成的非零退出才算异常 |
| 用 CIM 过滤器批量杀进程时**把自己的命令树也杀了**（job runner exit 1）；排查时还会看到「多出来一个看守进程」 | 过滤器的关键字出现在执行它的 runner/pwsh 自己的命令行里（命令行 = 脚本正文），于是自我匹配。**只按 `Name='node.exe'` 过滤不够** —— 承载这条命令的 runner 也是 node.exe | 拼接避开连续关键字（例如 `'--' + 'supervise'`），或先查出 PID 再按 PID 精确杀；结果里若出现「刚好在本命令启动时刻创建」的进程，先怀疑是自己 |
| 面板每个操作都报 `Cannot read properties of undefined (reading 'raw')` | 宿主 RPC 信封字段写成了 `data`；传输层按 schema 校验会**剥掉未知键**，浏览器只收到 `{ok:true}` | 信封必须是 `{ok:true, value}` / `{ok:false, error:{code,message,details}}`（`details` 必填对象）。这条只有真正跑 HTTP 层才暴露 —— 见下条验证方式 |

## 其它约定

- 单测：`npm test`（netstat 解析、签名正反例、配置校验/原子写/冲突、命令分词、浏览器半边无浏览器冒烟）。
- 真机验证（不重启 dsh）：`node scripts/verify-host.mjs 4599`、`node scripts/verify-lifecycle.mjs 4598`、
  `node scripts/verify-form-api.mjs 4597`（表单写入路径）、`node scripts/bench-snapshot.mjs 5`（耗时与心跳最坏间隔）。
- **HTTP 层验证（信封/真实传输，唯一能抓到字段错误的一层）**：`node scripts/verify-rpc-http.mjs "<token url>"`；
  token 在 `<DSH_HOME>/.dsh-services-manager/logs/dsh-web.log` 最后一行，或浏览器地址栏。只读端点，不碰重启。
- 预览沙箱：`pwsh -File scripts/preview-sandbox.ps1`（打印预览地址）／`-Stop` 停止。
  客户端改动**硬刷新**即可（bundle 走 immutable 长缓存）；**宿主改动必须重启沙箱实例**，否则新端点不存在。
- 活性判定只认端口 LISTENING；终止外部进程前必须过命令行签名校验（`match.commandLinePattern`）。
- 服务定义的唯一事实来源是 `<DSH_HOME>/.dsh-services-manager/services.json`，运行态绝不写回。
