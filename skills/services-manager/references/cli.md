# dsh-services CLI 接入参考

按需读取：首次操作、准备单条 JSON、处理认证或失败时使用。实际合同以当前 profile 中 `node "<cli>" --help` 为准；此参考对应 services manager 0.2.2。

## 发现 CLI（PowerShell）

`<skill-dir>` 是本次加载 skill 返回的目录，不是项目开发仓库。

```powershell
$resolved = node "<skill-dir>/scripts/resolve-cli.mjs"
if ($LASTEXITCODE -ne 0) { throw '当前 profile 未找到 services manager；不要继续登记' }
$info = $resolved | ConvertFrom-Json
$cli = $info.cli
node $cli --help
```

没有 runtime profile 环境时，只有用户已明确指定目标 profile 才可传 `--profile-dir <绝对目录>`。脚本不联网、不启动任何服务、不访问凭据；它返回 origin 不代表已经认证或目标已上线。

## 认证

- 目标地址来自用户选择或当前 `DSH_WEB_URL`，使用 origin，不带路径、query、fragment 或凭据。不要复制本文示例端口当真实端口。
- 凭据优先使用已受保护地注入的 `DSH_SERVICES_TOKEN`；不能打印其值或整个环境变量列表。
- 缺失时请用户在工具执行环境里安全设置，或明确提供**已有、访问受限**的 token 文件路径。不要要求在聊天发送 token，不自行遍历日志/其他 profile/凭据库/浏览器寻找。
- CLI 通过 token→cookie→宿主 RPC 认证，权限等同现有宿主授权，不是更低权限的沙箱。发生 401/403 不绕过认证，不关闭保护，不跟随跳转。

已有安全环境变量时：

```powershell
# $info.origin 仍需核对是用户要管理的本机实例；它不是固定 3080。
$env:DSH_SERVICES_URL = $info.origin
node $cli get
node $cli list
# DSH_SERVICES_TOKEN 已由用户安全提供，此处不读取/打印它。
```

用户明确提供了访问受限的 token 文件时（每条命令重新供 stdin，文件路径不含 token 本体）：

```powershell
# $tokenFile 是用户指定的已有秘密文件，第一行只有当前目标实例的 token。
# 绝不能把此变量替换为从其他 profile 扫描得到的文件。
Get-Content -Raw -LiteralPath $tokenFile | node $cli get --token-stdin
Get-Content -Raw -LiteralPath $tokenFile | node $cli list --token-stdin
Get-Content -Raw -LiteralPath $tokenFile | node $cli register --file $definitionFile --revision $reviewedRevision --token-stdin
```

`--token-stdin` 第一行是 token；同时用 `--file -` 时，剩余 stdin 才是单条 JSON。避免复杂拼接，通常更容易用单独的定义文件。不要把 token 放 `--url` 或其他 argv 中；本 skill 不创建长期 token 副本。

## 一条定义，不是完整 services.json

以下是**替换后才可使用的示例**。仅当项目真实入口支持这些参数时沿用；不要给任意 server 强加不存在的 flags。JSON 内用 `/` 可避免 Windows 反斜杠转义错误。

```json
{
  "id": "example-web",
  "title": "Example Web",
  "command": "node \"C:/Projects/example-web/server.mjs\" --host 127.0.0.1 --port 4590",
  "cwd": "C:/Projects/example-web",
  "port": 4590,
  "host": "127.0.0.1",
  "url": "http://127.0.0.1:4590/",
  "autostart": false,
  "autoStopOnExit": true,
  "takeover": "match",
  "restartMode": "inline",
  "match": {
    "commandLinePattern": "C:[\\\\/]Projects[\\\\/]example-web[\\\\/]server[.]mjs.*--port[=\\s]+4590\\b"
  }
}
```

- 新建必需：稳定合法 `id`、非空 `command`、绝对 `cwd`、整数 `port`（1–65535）、非空可编译签名。id 只含字母数字/`.`/`_`/`-`，首字符字母数字，禁止保留 id `dsh`。
- 不支持通过 CLI 自动推断端口或 id，不可把 UI 表单的宽松行为套到 CLI。
- 更新只发显式要改的字段，例如 `{"id":"example-web","autostart":true}`。`env`/`match`/`probe` 按键合并，省略字段不会清空旧值；不假定 `{}` 能清除它们。`probe.path:null` 可清健康路径。
- 其他可选字段：`env`（字符串映射）、`probe:{path,expectStatus,intervalMs}`。不要把秘密写入会提交到仓库的定义文件；额外字段拒绝，不要写 `pid`、`status` 等运行态字段。
- Vite：固定 `--host 127.0.0.1 --port <port> --strictPort`；实际监听进程可能只有 vite 入口和端口，没有项目绝对路径。需结合实际 commandLine 验证签名的唯一性，不能默认 npm 的 cwd 会出现在子进程命令行。若无法在目标进程命令行中建立可靠唯一标记，报告限制，先不要授权控制未知监听者。
- 可用 `new RegExp(pattern, 'i')` 验证语法，并针对已核实的实际命令行做命中测试；语法合法不等于身份安全。

## 带 revision 的登记与回读

以下命令假定已安全提供 `DSH_SERVICES_URL` / `DSH_SERVICES_TOKEN`；stdin 凭据方式见上。

```powershell
$beforeText = node $cli get
if ($LASTEXITCODE -ne 0) { throw '读取配置失败，停止写操作' }
$before = $beforeText | ConvertFrom-Json
$beforeDocument = $before.value.raw | ConvertFrom-Json
$beforeIds = @($beforeDocument.services | ForEach-Object { $_.id })
$reviewedRevision = $before.value.revision
# 此时核对同名 id、待更新字段、其他现有服务；definitionFile 是单条 UTF-8 JSON。
node $cli register --file $definitionFile --revision $reviewedRevision
if ($LASTEXITCODE -ne 0) { throw '登记未确认成功，按错误码先回读再处理' }
$afterText = node $cli get
if ($LASTEXITCODE -ne 0) { throw '登记后回读失败，结果待核实，不能盲目重试' }
$after = $afterText | ConvertFrom-Json
$afterDocument = $after.value.raw | ConvertFrom-Json
# 断言原有 ids 全部保留，目标 id 仅出现一次，目标字段符合要求。
node $cli list
```

本 skill 不直接编辑插件真相文件。确需恢复历史配置是另一个明确授权的备份恢复任务，不能伪装成日常登记的回退途径。

## 运行策略与失败

| 操作 | 实际影响 |
| --- | --- |
| `register --file ...` | 只新建/合并定义，不启动、不停止 |
| `start ID` | **先保存 autostart=true**，再尝试启动；已在运行也会保存策略 |
| `stop ID` | **先保存 autostart=false**，再尝试停止；停止失败也可能已禁用自启 |
| `restart ID` | 仅普通服务重启，保留原自启策略，不是重启 DSH |
| `remove ID` | 只删定义，不会停止正在运行的进程；需要用户明确要求移除 |

登记为 `autostart:true` 不会立即运行，只在后续插件加载时触发恢复。不得为了让它生效而重启 DSH；用户要求立即运行时用 start。

错误信封 `error.details.policyCommitted/autostart/configRevision` 表示策略可能已经保存。启动失败不能声称“没有改配置”；也不要自行回滚用户刚要求的持久意图。超时、断线后先 `get/list` 核实，禁止自动重复启动/重启。

| 退出码/错误 | 处理 |
| --- | --- |
| 2 / CONFIG_INVALID | 修正输入；既有坏条目不得被自动过滤丢弃 |
| 3 / AUTH | 请用户核对该实例凭据；不扫描或绕过 |
| 4 / HTTP、协议、连接、超时 | 核实所选宿主和插件加载状态；写结果可能已提交，先回读 |
| 5 / CONFIG_CONFLICT | get 新 revision，审阅变更，合并意图后重提；不无条件重试 |
| 6 / PORT_OWNED_BY_OTHER、TIMEOUT 等宿主失败 | 检查策略提交情况、端口与身份；不 force 终止未知进程 |

## 完成报告

“已登记 `<id>`，URL `<url>`，自启 `<true/false>`，当前 `<未启动/已运行/待验证>`；原有条目保持不变。设置 → 服务管理 → 全部刷新。”

若执行了启动，追加端口/PID/命令行签名及健康检查的实际证据。未实测的内容明确标注，不把定义保存成功冒充运行验证。
