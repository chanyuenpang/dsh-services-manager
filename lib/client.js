// dsh-services-manager 的浏览器半边：手写的 lazy-CJS bundle，无构建链、无运行时依赖。
// 只注册一个设置分区（settings.section）；一切数据来自宿主 RPC 通道 /dsh-services，
// 组件只从 props 取 call，不访问任何其它宿主对象。样式全部内联 + dsw-alias CSS 变量。
window.__ModuleLoader__.load({
  id: "dsh-services-manager",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots", "connection"];

    const CHANNEL = "/dsh-services";
    const POLL_MS = 4000;              // 可见时的快照轮询间隔
    const LOG_LINES = 400;             // 每次读取的日志行数
    const RESTART_GRACE_SECONDS = 60;  // 「重启 DSH」的默认宽限时间
    const COLUMN_COUNT = 8;

    const STATUS_LABELS = { running: "运行中", stopped: "已停止", starting: "启动中", stopping: "停止中", error: "异常", unknown: "未知" };
    const STATUS_COLORS = {
      running: "var(--dsw-alias-state-success-primary, #16a34a)",
      stopped: "var(--dsw-alias-label-tertiary, #9ca3af)",
      error: "var(--dsw-alias-state-error-primary, #dc2626)",
      starting: "var(--dsw-alias-state-warning-primary, #d97706)",
      stopping: "var(--dsw-alias-state-warning-primary, #d97706)",
      unknown: "var(--dsw-alias-state-warning-primary, #d97706)",
    };
    const OWNERSHIP_LABELS = { spawned: "本插件启动", discovered: "外部进程", none: "—" };

    // 宿主错误码 → 可操作提示（不只复述 error.message）。
    const ERROR_HINTS = {
      SERVICE_NOT_FOUND: "配置里已经没有这个服务，点「全部刷新」重新读取。",
      PORT_OWNED_BY_OTHER: "端口被命令行签名不匹配的进程占用，宿主拒绝终止它；确认后可强制重试。",
      CONFIG_CONFLICT: "配置文件已被外部修改，请重新载入后再保存。",
      CONFIG_INVALID: "配置内容未通过校验，请按下面的校验错误修正后重试。",
      ALREADY_SCHEDULED: "宿主已经安排过重启，无需重复提交。",
      OPERATION_FAILED: "宿主执行操作失败，可展开该行日志查看原因。",
      TIMEOUT: "宿主等待超时，服务状态可能仍在变化，请稍后刷新。",
    };

    const MONO = "var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
    const BORDER_L1 = "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))";
    const CODE_BG = "var(--dsw-alias-markdown-code-block, rgba(128,128,128,.1))";

    const STYLE = {
      section: { display: "grid", gap: 14, padding: 12, maxWidth: 1180, color: "var(--dsw-alias-label-primary, inherit)" },
      header: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      muted: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
      summary: { fontSize: 12, color: "var(--dsw-alias-label-secondary, inherit)" },
      button: { border: BORDER_L1, background: "var(--dsw-alias-bg-elevated, transparent)", borderRadius: 6, color: "inherit", cursor: "pointer", fontSize: 12, padding: "4px 10px" },
      error: { border: "1px solid var(--dsw-alias-state-error-primary, #dc2626)", borderRadius: 8, color: "var(--dsw-alias-state-error-primary, #dc2626)", fontSize: 12, padding: "8px 10px", whiteSpace: "pre-wrap" },
      note: { border: BORDER_L1, borderRadius: 8, fontSize: 12, padding: "8px 10px", whiteSpace: "pre-wrap" },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
      th: { textAlign: "left", borderBottom: BORDER_L1, color: "var(--dsw-alias-label-tertiary, inherit)", fontWeight: 500, padding: "6px 8px" },
      td: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))", padding: "6px 8px", verticalAlign: "top" },
      dot: { borderRadius: 5, display: "inline-block", height: 9, marginRight: 6, width: 9 },
      chip: { background: CODE_BG, borderRadius: 6, color: "var(--dsw-alias-label-tertiary, inherit)", fontSize: 11, padding: "1px 6px" },
      link: { color: "inherit", textDecoration: "underline" },
      log: { background: CODE_BG, borderRadius: 8, fontFamily: MONO, fontSize: 11, lineHeight: 1.6, margin: 0, maxHeight: 260, overflow: "auto", padding: "8px 10px", whiteSpace: "pre-wrap" },
      config: { border: BORDER_L1, borderRadius: 9, padding: "10px 12px" },
      textarea: { background: CODE_BG, border: BORDER_L1, borderRadius: 8, color: "inherit", fontFamily: MONO, fontSize: 12, lineHeight: 1.6, minHeight: "13em", padding: "8px 10px", resize: "vertical", width: "100%" },
      actions: { display: "flex", gap: 6, flexWrap: "wrap" },
    };

    const truncate = (value, limit) => { const text = String(value); return text.length > limit ? text.slice(0, limit) + "…" : text; };
    const formatTime = (value) => { if (typeof value !== "string" || value.length === 0) return "—"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(); };
    const buttonStyle = (disabled) => (disabled === true ? { ...STYLE.button, cursor: "not-allowed", opacity: 0.45 } : STYLE.button);

    /** details 展开：CONFIG_INVALID 的校验错误、PORT_OWNED_BY_OTHER 的 pid/命令行都在这里。 */
    const detailText = (details) => {
      if (details === undefined || details === null) return "";
      if (typeof details === "string") return details;
      if (Array.isArray(details.errors)) return details.errors.map((item) => (typeof item === "string" ? item : (item && item.message) || JSON.stringify(item))).join("\n");
      if (typeof details.message === "string") return details.message;
      try { return JSON.stringify(details, null, 2); } catch (error) { return String(details); }
    };

    /** RPC 失败 →「[错误码] 原文 + 提示 + details」。 */
    const describeError = (failure) => {
      const code = failure && typeof failure.code === "string" ? failure.code : "OPERATION_FAILED";
      const message = failure && typeof failure.message === "string" && failure.message.length > 0 ? failure.message : "请求失败。";
      const hint = ERROR_HINTS[code];
      const detail = detailText(failure ? failure.details : undefined);
      return "[" + code + "] " + message + (hint === undefined ? "" : "\n" + hint) + (detail.length === 0 ? "" : "\n" + detail);
    };

    /**
     * 解包 RPC 信封 { ok, value } / { ok, error }；宿主错误与通道错误都归一化成带 code 的 Error。
     * 注意字段是 **value**（client-connection 的 rpcResultSchema），不是 data ——
     * 读错字段会让每个端点都返回 undefined（表现为 `Cannot read properties of undefined`）。
     */
    const unwrap = (result) => {
      if (result !== null && typeof result === "object" && result.ok === true) {
        // 宿主信封字段是 value；data 只是对旧宿主的兜底。
        const value = result.value === undefined ? result.data : result.value;
        if (value === undefined) {
          // 旧宿主发的是 { ok, data }，而传输层按 schema 校验响应时会剥掉未知键 ——
          // 于是浏览器只收到 { ok: true }。这里给出可行动的报错，而不是 TypeError。
          const failure = new Error("宿主响应缺少 value：宿主半边的信封字段不匹配（或仍在运行旧代码），需要重启 dsh 加载修复后的宿主代码。");
          failure.code = "OPERATION_FAILED";
          throw failure;
        }
        return value;
      }
      const error = result !== null && typeof result === "object" && result.error ? result.error : {};
      const failure = new Error(typeof error.message === "string" && error.message.length > 0 ? error.message : "宿主返回了无法识别的响应。");
      failure.code = typeof error.code === "string" ? error.code : "OPERATION_FAILED";
      failure.details = error.details;
      throw failure;
    };

    /** ServiceRuntimeState → 一行摘要：优先 lastError，其次 lastExit。 */
    const tailText = (service) => {
      if (typeof service.lastError === "string" && service.lastError.length > 0) return "错误：" + truncate(service.lastError, 140);
      if (service.lastExit) {
        const code = service.lastExit.code === null || service.lastExit.code === undefined ? "未知" : String(service.lastExit.code);
        return "上次退出：code " + code + " · " + formatTime(service.lastExit.at);
      }
      if (typeof service.lastOperation === "string" && service.lastOperation.length > 0) return "最近操作：" + service.lastOperation;
      return "—";
    };

    function ServicesSection(props) {
      const call = props.call;
      const [snapshot, setSnapshot] = React.useState(null);
      const [actionError, setActionError] = React.useState("");
      const [pollError, setPollError] = React.useState("");
      const [pending, setPending] = React.useState(null);      // 服务 id / "dsh" / "refresh"
      const [scheduled, setScheduled] = React.useState(null);  // 已安排的重启信息
      const [logId, setLogId] = React.useState(null);
      const [logs, setLogs] = React.useState({});
      const [configOpen, setConfigOpen] = React.useState(false);
      const [configLoaded, setConfigLoaded] = React.useState(false);
      const [configText, setConfigText] = React.useState("");
      const [configRevision, setConfigRevision] = React.useState("");
      const [configPath, setConfigPath] = React.useState("");
      const [configError, setConfigError] = React.useState("");
      const [configConflict, setConfigConflict] = React.useState(false);
      const [configBusy, setConfigBusy] = React.useState(false);
      const appliedRevision = React.useRef(-1);                // 单调 revision：只前进
      const appliedTier = React.useRef(0);                     // 同 revision 下，只接受不更差的层
      const [timing, setTiming] = React.useState(null);        // 宿主演算的新鲜度（客户端只投影）

      /**
       * 应用新快照。两条规则：
       * - revision 更旧 → 丢弃（刷新竞态）；
       * - 同 revision 但层更低 → 丢弃（tier 1 覆盖 tier 2 会把已到手的 pid 变回「读取中」）。
       */
      const applySnapshot = (data) => {
        if (data === null || typeof data !== "object") return false;
        const revision = typeof data.revision === "number" ? data.revision : null;
        const info = data.timing !== null && typeof data.timing === "object" ? data.timing : {};
        const tier = typeof info.tier === "number" ? info.tier : 0;
        if (revision !== null && revision < appliedRevision.current) return false;
        if (revision !== null && revision === appliedRevision.current && tier < appliedTier.current) return false;
        if (revision !== null) appliedRevision.current = revision;
        appliedTier.current = tier;
        setSnapshot(data);
        setTiming(info);
        return true;
      };

      /**
       * 拉一次快照。`snapshot.fast` 是首屏路径（命中快照缓存即 0ms 返回），
       * `snapshot.full` 会等详层刷新完成（显式刷新/补齐时用）。
       */
      const loadSnapshot = async (endpoint) => {
        const data = unwrap(await call(endpoint, {}));
        applySnapshot(data);
        return data;
      };

      /** 显式刷新：走 full，失败只写顶部错误，不清空已显示数据。 */
      const refresh = async () => {
        try {
          await loadSnapshot("snapshot.full");
          setActionError("");
          setPollError("");
        } catch (failure) {
          setActionError(describeError(failure));
        }
      };

      // 挂载：先 fast 上屏，再补一次 full；之后每 POLL_MS 轮询 fast，过期/缺详情时追一次 full。
      React.useEffect(() => {
        const visibleNow = () => (typeof document === "undefined" ? true : document.visibilityState !== "hidden");
        let timer = null;
        const poll = async () => {
          if (visibleNow() !== true) return;
          try {
            const data = await loadSnapshot("snapshot.fast");
            setPollError("");
            const info = data !== null && typeof data === "object" && data.timing !== null && typeof data.timing === "object" ? data.timing : {};
            if (info.degraded === true || info.refreshing === true || info.cacheMiss === true) {
              await loadSnapshot("snapshot.full");   // 慢层补齐：用户已经看到东西了，这次等待不阻塞首屏
            }
          } catch (failure) {
            setPollError(describeError(failure));   // 轮询失败保留旧数据
          }
        };
        const start = () => { if (timer === null) timer = setInterval(() => { void poll(); }, POLL_MS); };
        const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
        const onVisibilityChange = () => { if (visibleNow() === true) { void poll(); start(); } else { stop(); } };
        void poll();
        if (visibleNow() === true) start();
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
        return () => { stop(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange); };
      }, [call]);

      const confirmForce = (failure) => {
        const details = (failure && failure.details) || {};
        const pid = details.pid === undefined || details.pid === null ? "未知" : String(details.pid);
        const commandLine = typeof details.commandLine === "string" && details.commandLine.length > 0 ? truncate(details.commandLine, 160) : "（宿主未提供命令行）";
        return window.confirm(
          "端口被另一个进程占用（pid " + pid + "）。\n" +
          "命令行：" + commandLine + "\n\n" +
          "该进程的命令行与本服务的配置签名不匹配，宿主拒绝自动终止它。\n" +
          "确认后将带 force 重试，并强制终止这个进程。是否继续？");
      };

      /** 启动 / 停止 / 重启：返回的 data 直接当作新快照应用，不再额外拉一次。 */
      const operate = async (endpoint, service) => {
        setPending(service.id);
        setActionError("");
        let force = false;
        try {
          for (;;) {
            let data;
            let failure;
            try {
              data = unwrap(await call(endpoint, force === true ? { id: service.id, force: true } : { id: service.id }));
            } catch (error) {
              failure = error;
            }
            if (failure === undefined) {
              if (data !== null && typeof data === "object" && data.accepted === true) setScheduled(data);   // restart: dsh
              else applySnapshot(data);
              return;
            }
            if (failure.code === "PORT_OWNED_BY_OTHER" && force !== true) {
              if (confirmForce(failure) === true) { force = true; continue; }   // 用户确认 → 带 force 重试
              return;                                                          // 用户取消 → 不改任何状态
            }
            setActionError(describeError(failure));
            return;
          }
        } finally {
          setPending(null);
        }
      };

      /** 重启 DSH：确认后调 restart-dsh，成功显示倒计时/日志路径提示。 */
      const restartDsh = async () => {
        if (scheduled !== null) return;
        const confirmed = window.confirm(
          "即将重启 DSH 宿主。\n\n" +
          "当前页面会断开，需要重新连接（刷新页面）。\n" +
          "默认 " + RESTART_GRACE_SECONDS + " 秒后执行。\n\n" +
          "确认现在安排重启吗？");
        if (confirmed !== true) return;
        setPending("dsh");
        setActionError("");
        try {
          setScheduled(unwrap(await call("restart-dsh", { graceSeconds: RESTART_GRACE_SECONDS })));
        } catch (failure) {
          if (failure.code === "ALREADY_SCHEDULED") setScheduled({ already: true });
          else setActionError(describeError(failure));
        } finally {
          setPending(null);
        }
      };

      /** 日志：点开则拉取并展开该行下方区域，再点收起。 */
      const toggleLogs = async (service) => {
        if (logId === service.id) { setLogId(null); return; }
        setLogId(service.id);
        try {
          const data = unwrap(await call("logs", { id: service.id, lines: LOG_LINES }));
          const text = data !== null && typeof data.text === "string" && data.text.length > 0 ? data.text : "（日志为空）";
          const path = data !== null && typeof data.path === "string" ? data.path : "";
          setLogs((previous) => ({ ...previous, [service.id]: { text, path } }));
        } catch (failure) {
          setLogs((previous) => ({ ...previous, [service.id]: { text: "读取日志失败：\n" + describeError(failure), path: "" } }));
        }
      };

      const loadConfig = async () => {
        setConfigBusy(true);
        setConfigError("");
        setConfigConflict(false);
        try {
          const data = unwrap(await call("config.get", {}));
          setConfigText(data !== null && typeof data.raw === "string" ? data.raw : "");
          setConfigRevision(data !== null && data.revision !== undefined && data.revision !== null ? String(data.revision) : "");
          setConfigPath(data !== null && typeof data.path === "string" ? data.path : "");
          setConfigLoaded(true);
        } catch (failure) {
          setConfigError(describeError(failure));
        } finally {
          setConfigBusy(false);
        }
      };

      const toggleConfig = () => {
        const next = configOpen !== true;
        setConfigOpen(next);
        if (next === true && configLoaded !== true) void loadConfig();
      };

      /** 保存配置：先本地 JSON.parse，再带 expectedRevision 提交；失败绝不清空用户输入。 */
      const saveConfig = async () => {
        setConfigError("");
        setConfigConflict(false);
        try {
          JSON.parse(configText);
        } catch (error) {
          setConfigError("JSON 解析失败：" + (error && error.message ? error.message : String(error)));
          return;
        }
        setConfigBusy(true);
        try {
          const data = unwrap(await call("config.set", { raw: configText, expectedRevision: configRevision }));
          setConfigText(data !== null && typeof data.raw === "string" ? data.raw : configText);
          setConfigRevision(data !== null && data.revision !== undefined && data.revision !== null ? String(data.revision) : configRevision);
          setConfigLoaded(true);
          await refresh();   // 保存成功后重新读取服务快照
        } catch (failure) {
          if (failure.code === "CONFIG_CONFLICT") {
            setConfigConflict(true);
            setConfigError("文件已被外部修改，请重新载入。");
          } else {
            setConfigError(describeError(failure));
          }
        } finally {
          setConfigBusy(false);
        }
      };

      const summary = snapshot && snapshot.summary ? snapshot.summary : null;
      const services = snapshot && Array.isArray(snapshot.services) ? snapshot.services : [];
      const anyBusy = pending !== null;

      const summaryText = summary === null
        ? "正在读取服务状态…"
        : "总数 " + summary.total + " · 运行 " + summary.running + " · 异常 " + summary.error + " · 已停止 " + summary.stopped + " · 未知 " + summary.unknown;

      // 新鲜度：宿主算、客户端只投影。tier 1 表示详情（PID/命令行）还没到。
      const timingInfo = timing !== null && typeof timing === "object" ? timing : null;
      const detailPending = (service) => timingInfo !== null && timingInfo.tier === 1
        && service.status === "running" && (service.pid === null || service.pid === undefined);
      const pidText = (service) => {
        if (detailPending(service)) return "读取中…";    // 不能显示「未知」：那是另一个含义
        return service.pid === null || service.pid === undefined ? "—" : String(service.pid);
      };
      const freshnessText = timingInfo === null ? "" : [
        timingInfo.returnedFromCache === true ? "快照缓存命中" : "刚刚采集",
        typeof timingInfo.ageMs === "number" ? "数据年龄 " + timingInfo.ageMs + "ms" : null,
        timingInfo.tier === 1 ? "详情读取中（PID/命令行稍后补齐）" : null,
        timingInfo.degraded === true ? "详情可能已过期" : null,
        timingInfo.refreshing === true ? "后台补齐中" : null,
      ].filter((part) => part !== null).join(" · ");

      /** 首帧骨架：宿主手上还没有任何观测（timing.cacheMiss）时不要显示「0 个服务」。 */
      const skeletonBlock = () => h("div", { style: { display: "grid", gap: 6 } },
        [0, 1, 2].map((index) => h("div", {
          key: index,
          style: { background: CODE_BG, borderRadius: 8, height: 30, opacity: 1 - index * 0.25 },
        })));

      const metaText = snapshot === null
        ? ""
        : "配置：" + snapshot.configPath + " · 状态目录：" + snapshot.stateDir + " · 配置修订 " + snapshot.configRevision + " · 快照 revision " + snapshot.revision;

      const scheduledText = scheduled === null ? "" : (() => {
        const seconds = typeof scheduled.graceMs === "number" ? Math.round(scheduled.graceMs / 1000) : RESTART_GRACE_SECONDS;
        const lines = [scheduled.already === true ? "已安排重启（ALREADY_SCHEDULED）。" : "已安排重启：约 " + seconds + " 秒后执行。"];
        if (typeof scheduled.scheduledAt === "string" && scheduled.scheduledAt.length > 0) lines.push("执行时刻：" + formatTime(scheduled.scheduledAt));
        if (typeof scheduled.logPath === "string" && scheduled.logPath.length > 0) lines.push("重启日志：" + scheduled.logPath);
        lines.push("当前页面会断开，请稍后刷新页面重新连接。");
        return lines.join("\n");
      })();

      const actionCell = (service) => {
        const canStart = service.status !== "running";      // running 时禁用「启动」
        const canStop = service.status !== "stopped";       // stopped 时禁用「停止」「重启」
        return h("div", { style: STYLE.actions },
          h("button", { key: "start", disabled: anyBusy || canStart !== true, style: buttonStyle(anyBusy || canStart !== true), onClick: () => { void operate("start", service); } }, "启动"),
          h("button", { key: "stop", disabled: anyBusy || canStop !== true, style: buttonStyle(anyBusy || canStop !== true), onClick: () => { void operate("stop", service); } }, "停止"),
          h("button", { key: "restart", disabled: anyBusy || canStop !== true, style: buttonStyle(anyBusy || canStop !== true), onClick: () => { void operate("restart", service); } }, "重启"),
          h("button", { key: "logs", disabled: anyBusy, style: buttonStyle(anyBusy), onClick: () => { void toggleLogs(service); } }, logId === service.id ? "收起日志" : "日志"));
      };

      const serviceRow = (service) => {
        const color = STATUS_COLORS[service.status] || STATUS_COLORS.unknown;
        const busy = pending === service.id;
        const main = h("tr", { key: service.id },
          h("td", { style: STYLE.td },
            h("span", { style: { ...STYLE.dot, background: color } }),
            h("span", null, STATUS_LABELS[service.status] || service.status)),
          h("td", { style: STYLE.td },
            h("div", null, service.title || service.id),
            h("div", { style: STYLE.muted }, service.id, " ", busy ? h("span", { style: STYLE.chip }, "处理中…") : null)),
          h("td", { style: STYLE.td }, service.port === null || service.port === undefined ? "—" : String(service.port)),
          h("td", { style: STYLE.td }, h("span", { style: STYLE.chip }, OWNERSHIP_LABELS[service.ownership] || service.ownership || "—")),
          h("td", { style: STYLE.td }, pidText(service)),
          h("td", { style: STYLE.td }, service.url === null || service.url === undefined || service.url.length === 0
            ? "—"
            : h("a", { href: service.url, target: "_blank", rel: "noreferrer", style: STYLE.link }, service.url)),
          h("td", { style: STYLE.td }, tailText(service)),
          h("td", { style: STYLE.td }, actionCell(service)));
        if (logId !== service.id) return main;
        // 展开的日志：紧贴在服务行下方。
        const entry = logs[service.id];
        const logRow = h("tr", { key: service.id + "-log" },
          h("td", { colSpan: COLUMN_COUNT, style: STYLE.td },
            h("div", { style: STYLE.muted }, "日志文件：" + (entry && entry.path ? entry.path : "—")),
            h("pre", { style: STYLE.log }, entry === undefined ? "读取中…" : entry.text)));
        return h(React.Fragment, { key: service.id + "-group" }, main, logRow);
      };

      return h("section", { style: STYLE.section },
        h("div", { style: STYLE.header },
          h("h2", { style: STYLE.title }, "服务管理"),
          h("span", { style: STYLE.summary }, summaryText),
          freshnessText.length === 0 ? null : h("span", { style: STYLE.muted }, freshnessText),
          h("button", { disabled: anyBusy, style: buttonStyle(anyBusy), onClick: () => { setPending("refresh"); void refresh().finally(() => setPending(null)); } }, pending === "refresh" ? "刷新中…" : "全部刷新"),
          h("button", { disabled: anyBusy || scheduled !== null, style: buttonStyle(anyBusy || scheduled !== null), onClick: () => { void restartDsh(); } }, scheduled === null ? "重启 DSH" : "已安排重启")),
        metaText.length === 0 ? null : h("div", { style: STYLE.muted }, metaText),
        actionError.length === 0 ? null : h("div", { style: STYLE.error }, actionError),
        pollError.length === 0 ? null : h("div", { style: STYLE.error }, pollError),
        scheduledText.length === 0 ? null : h("div", { style: STYLE.note }, scheduledText),
        services.length === 0
          ? (snapshot === null || (timingInfo !== null && timingInfo.cacheMiss === true)
            ? skeletonBlock()
            : h("div", { style: STYLE.muted }, "配置里还没有服务。"))
          : h("table", { style: STYLE.table },
            h("thead", null, h("tr", null,
              h("th", { style: STYLE.th }, "状态"),
              h("th", { style: STYLE.th }, "名称"),
              h("th", { style: STYLE.th }, "端口"),
              h("th", { style: STYLE.th }, "来源"),
              h("th", { style: STYLE.th }, "PID"),
              h("th", { style: STYLE.th }, "地址"),
              h("th", { style: STYLE.th }, "最近事件"),
              h("th", { style: STYLE.th }, "操作"))),
            h("tbody", null, services.map(serviceRow))),
        h("section", { style: STYLE.config },
          h("div", { style: STYLE.header },
            h("button", { style: buttonStyle(false), onClick: toggleConfig }, (configOpen === true ? "▾ " : "▸ ") + "配置 (JSON)"),
            configPath.length === 0 ? null : h("span", { style: STYLE.muted }, configPath)),
          configOpen !== true ? null : h("div", { style: { display: "grid", gap: 8, marginTop: 8 } },
            h("div", { style: STYLE.muted }, "当前修订：" + (configRevision.length === 0 ? "—" : configRevision) + "（保存时作为 expectedRevision 提交）"),
            h("textarea", { value: configText, rows: 14, spellCheck: false, style: STYLE.textarea, onChange: (event) => setConfigText(event.target.value) }),
            h("div", { style: STYLE.actions },
              h("button", { disabled: configBusy, style: buttonStyle(configBusy), onClick: () => { void saveConfig(); } }, configBusy ? "处理中…" : "保存"),
              h("button", { disabled: configBusy, style: buttonStyle(configBusy), onClick: () => { void loadConfig(); } }, "重新载入")),
            configError.length === 0 ? null : h("div", { style: STYLE.error }, (configConflict === true ? "文件已被外部修改，请重新载入。\n" : "") + configError))));
    }

    /** 注册设置分区；call 是这一份注册唯一的宿主出口。 */
    function apply(ctx) {
      const call = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload);
      ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "services", order: 50, label: () => "服务管理", inject: () => ({ call }) }, ServicesSection));
    }

    return { inject, apply };
  },
});
