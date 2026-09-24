# AGENTS.md — dsh-services-manager

本文件记录本仓库对**所有 agent** 的硬性约束与已踩过的坑。改动代码前先读完它。

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

## 已踩过的坑（重跑沙箱的价值就在这里）

| 症状 | 根因 | 正确做法 |
| --- | --- | --- |
| `cannot get property "config" without inject`，整个 profile 起不来 | cordis 以 `(ctx, config)` 调用插件体，`ctx.config` 未声明 inject 时访问即抛 | `export function apply(ctx, config)`，用第二个参数读 loader 行的 config 段 |
| `cannot get property "webServer" without inject`，整个 profile 起不来 | `connection.rpc.handle` 需要 **`connection` 行**注入 `webServer`/`webRuntime`；随包模板里没有，正式 profile 靠 patch 补 | 在该 profile 的 `cordis.patch.yml` 加 `- id: connection` + `inject: [webRuntime, webServer]`。**沙箱 profile 也必须加**（新建 profile 最容易漏这一步）。注意不是给自己的插件行加 inject —— 实测给 `dsh-services-manager` 行加 `inject: [webServer]` 无效 |
| `Cannot find module '…\"…scratch-server.mjs\"'` | 把整条 shell 命令当成**单个** argv 元素交给 `cmd.exe`：Node 会给它整体加引号并把内部引号转义成 `\"`，cmd 不认 | 引用感知分词后把参数各自独立传：`cmd.exe /d /s /c <程序> <参数…>`（见 `src/command.mjs`） |
| 主动 `stop` 之后状态显示 `error` | 被 terminate 的进程退出码非零，被当成崩溃 | 记录 `lastStopAt`，只有「不是我们主动停止」造成的非零退出才算异常 |

## 其它约定

- 单测：`npm test`（netstat 解析、签名正反例、配置校验/原子写/冲突、命令分词）。
- 真机验证（不重启 dsh）：`node scripts/verify-host.mjs 4599`、`node scripts/verify-lifecycle.mjs 4598`。
- 活性判定只认端口 LISTENING；终止外部进程前必须过命令行签名校验（`match.commandLinePattern`）。
- 服务定义的唯一事实来源是 `<DSH_HOME>/.dsh-services-manager/services.json`，运行态绝不写回。
