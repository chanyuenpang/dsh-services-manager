---
name: services-manager
description: 将本机任意可运行的 Web 产物或静态页面一站式挂到桌面端 DSH：自动识别真实入口、登记、启动、验证并给出 URL。优先使用 services_manager 原生工具，无需 token、浏览器认证或用户手动启停；保留既有服务和固定端口。
---

# 一站式挂到 DSH

用户调用本技能或要求“挂载/接入产物”时，默认目标是**已登记并运行可访问**，不是只写一条配置。由 agent 完成入口发现、配置、启动和验收，用户无需找 token、开认证页面、手动停进程或填 JSON。显式“只登记/不启动”才停在登记阶段。

## 桌面原生路线（默认且唯一）

1. 依据当前 DSH_PROFILE / DSH_PROFILE_DIR 确认本次宿主，不把桌面 DSH 当外部 Web 客户端。不另起 DSH、第二个 manager 或绕过现有管理器直接 shell 启停。
2. 原生 services_manager 的 action:list / get 取得既有 ids 和 configRevision。list 返回 capabilities；确认包含 attach/status。工具旧版或缺失是插件加载/版本/会话工具策略缺口，**不是用户缺 token**。不要切到浏览器或 token CLI，不索取或扫描凭据。
3. 检查产物目录、说明、构建结果和真实服务入口。自动准备一条 service：稳定 id、实际绝对 cwd、可持续运行的 command、固定 port/url 和可靠 match.commandLinePattern。跨项目允许；同 id patch，绝不生成 -2 或覆盖整份服务清单。
4. 告知本次默认“挂载并启用随 DSH 启动”，然后 action:attach + service + 最新 expectedRevision。attach 在同一 manager 内单服务排队完成登记、autostart:true、启动与身份/健康验证；已验证运行实例只确认，不为了 ownership 重启。
5. action:status,id 回读新鲜运行态；必要时 get/list 确认其他服务未丢失。成功要求 status=running、identityVerified=true；配置 probe 时 healthy 必须 true。仅有 registered、autostart:true 或 PID 不算完成。
6. 只交付服务名、可访问 URL、已运行与自启动策略。不要让用户再去面板点击启动或“全部刷新”才能完成。

原生 action:register 保持只登记、不启动的语义，适用于用户明确只登记；新条目默认 autostart:false。action:start/stop(id,expectedRevision) 分别持久化 true/false，restart 保持原策略；均不重启 DSH。明确一次性运行不自启时：attach 成功后，用最新 revision register autostart:false 并 status 验证，不能用 stop 代替取消自启。

## 产物与入口的真实定义

- 动态服务：读项目自己的脚本/入口，用绝对脚本路径与项目支持的 strict-port，不让开发服务器自动漂移。依赖缺失时由 agent 判断并按任务授权准备，不能将未经验证的安装命令冒充服务启动命令。
- 静态 HTML/前端构建产物：无需用户安装静态服务。运行本技能的离线发现脚本（只检查当前 profile）取得 staticServer 和 nodeExecutable：

  `node "<本技能目录>/scripts/resolve-cli.mjs"`

  确认 staticServer 已存在，用插件自带入口："<nodeExecutable>" "<staticServer>" --root "<绝对产物目录>" --port <固定端口> [--entry <目录内首页文件>]。默认首页 index.html；单页报告可指定其文件名。优先 dist/build 等产物目录，不把含凭据的项目根目录作为公共目录。该入口只监听127.0.0.1、不列目录、不接受越界路径，端口占用就失败，不改端口。
- 签名应锁定实际监听者的专用绝对入口和完整端口边界；静态服务还须包含专用 --root。不能使用裸 node/npm/vite/.*。Node 的相对脚本只有在宿主核实**真实进程工作目录**并规范到相同绝对入口后才可通过原有签名；不会降低签名标准。
- Windows 路径带空格需正确引号。命令禁止 shell 管道/连接符/重定向，多步用项目自有入口。工具参数会进入会话日志，不传 env、token 或凭据；已有 env 原样保留。
- 沿用已注册固定端口，不为绕开冲突改端口。新产物尚无端口时 agent 自行挑选并验证空闲端口后固定登记。默认 loopback，不擅自开放到局域网。
- probe 只配项目已知健康路径与预期状态；未知则不虚构。

## 权限、冲突与失败

- read-only 拒绝任何变更；workspace-write 必须使用宿主本次调用批准；danger-full-access 按用户意图执行。禁用/拒绝审批时不改会话权限、不切 shell/HTTP 绕过。无额外操作指不要求手工配置/认证，不代表取消宿主权限门禁。
- 配置唯一来源是 manager 的服务文件，只通过原生工具单条提交，不直接编辑、不覆盖其他服务、不保存运行态到配置。
- PORT_OWNED_BY_OTHER：不让端口、不强杀未知进程、不用 force、不放宽签名。自行只读核实具体监听PID、实际cwd/入口；来源不明时明确具体阻塞，而不是要求用户找token或手动处理。
- 错误可能在配置/策略提交后发生。检查 error.details 的 registered、policyCommitted、configRevision、phase、runtimeMayHaveChanged，报告实际阶段，不假称完成，不盲回滚。
- CONFIG_CONFLICT：重新 get/list/status，审阅变化后重提；丢响应/取消/超时先读回，restart 尤其不得盲重放。
- 端口与身份失败就是失败；健康失败不算挂载完成，不将任意200页面当作目标产物。
- 不自动重启 DSH、不执行 restart-supervisor、不更改用户 profile patch。

## 插件升级后的验收

插件管理器返回 `applied` 或磁盘版本更新，不等于当前 Host 已加载新能力。升级后必须调用 services_manager 的 list，核对 capabilities 包含 attach、status、start、stop、restart，再用 status 回读目标服务的身份与健康状态。若仍暴露旧工具，只报告“已安装、当前 Host 尚未确认生效”；不自动重启 DSH，不用 CLI/token 路线绕过。

本技能由插件包注册，scripts 与 references 均以本次加载返回的资源目录为准，不依赖作者的开发仓库或全局技能副本。

## 外部客户端（仅用户明确指定）

才使用已安装 CLI 与用户已有私密认证来源。参见 [外部CLI合同](references/cli.md)。桌面内原生接入不走该路线；凭据缺失不扫描日志/profile/cookie，也不让用户把 token 发进聊天。
