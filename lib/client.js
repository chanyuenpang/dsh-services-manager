// dsh-services-manager 的浏览器半边：手写的 lazy-CJS bundle，无构建链、无运行时依赖。
// 只注册一个设置分区（settings.section）；一切数据来自宿主 RPC 通道 /dsh-services，
// 组件只从 props 取 call，不访问任何其它宿主对象。
//
// v2 三点变化（实现 `.claw/.../ui-design/2026-09-24-1659-服务管理分区视觉设计.md`）：
// 1) 8 列宽表 → 一张服务一张卡（设置模态内容宽仅 ~680px）；
// 2) 样式从内联对象改为注入 `<style data-plugin-css>` + `svc-` 类名，状态用 data-* 驱动；
// 3) 只使用真实存在的 --dsw-alias-* token（修掉 state-warning-primary / bg-elevated / font-mono 三个假名）。
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
    const STYLE_ID = "dsh-services-manager";

    // 状态：文案 + 徽标前缀（第二信号，不只靠颜色）。
    const STATUS_META = {
      running: { label: "运行中", prefix: "" },
      stopped: { label: "已停止", prefix: "" },
      starting: { label: "启动中", prefix: "" },
      stopping: { label: "停止中", prefix: "" },
      error: { label: "异常", prefix: "⚠ " },
      unknown: { label: "未知", prefix: "? " },
    };
    const OWNERSHIP_LABELS = { spawned: "本插件启动", discovered: "外部进程", none: "" };

    // 宿主错误码 → 可操作提示（不只复述 error.message）。
    const ERROR_HINTS = {
      SERVICE_NOT_FOUND: "配置里已经没有这个服务，点「全部刷新」重新读取。",
      PORT_OWNED_BY_OTHER: "端口被命令行签名不匹配的进程占用，宿主拒绝终止它；确认后可强制重试。",
      CONFIG_CONFLICT: "配置文件已被外部修改，请重新载入后再保存。",
      CONFIG_INVALID: "配置内容未通过校验，请按下面的校验错误修正后重试。",
      ALREADY_SCHEDULED: "宿主已经安排过重启，无需重复提交。",
      OPERATION_FAILED: "宿主执行操作失败，可展开该行日志查看原因。",
      TIMEOUT: "宿主等待超时，服务状态可能仍在变化，请稍后刷新。",
      UNKNOWN_ENDPOINT: "宿主版本与界面不匹配（端点不存在），请重启 dsh 后重试。",
    };

    // 只用真实存在的 token（名称已按设计规范 §0 核对），并给每个兜底色，主题缺变量也不至于不可读。
    const CSS = `
.svc-section { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 680px; color: var(--dsw-alias-label-primary, inherit); font-size: 13px; line-height: 1.5; }
.svc-heading { display: flex; align-items: center; gap: 8px; margin: 0; }
.svc-title { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 600; }
.svc-desc { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #8b8b8b); }
.svc-toolbar { display: flex; gap: 6px; margin-left: auto; }
.svc-summary { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #8b8b8b); font-variant-numeric: tabular-nums; }
.svc-freshness { margin: 0; font-size: 12px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); }
.svc-freshness[data-stale="true"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #b45309)); }
.svc-list { display: flex; flex-direction: column; gap: 6px; }
.svc-card { --svc-bar: var(--dsw-alias-border-l3, rgba(128,128,128,.24)); position: relative; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px 6px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24)); border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 10%, transparent); }
.svc-card[data-status="running"] { --svc-bar: var(--dsw-alias-state-success-primary, #16a34a); }
.svc-card[data-status="error"] { --svc-bar: var(--dsw-alias-state-error-primary, #dc2626); }
.svc-card[data-status="starting"], .svc-card[data-status="stopping"] { --svc-bar: var(--dsw-alias-state-warn-primary, #d97706); }
.svc-card[data-status="unknown"] { --svc-bar: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, #b0b0b0)); }
.svc-card::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--svc-bar); }
.svc-card__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.svc-name { font-size: 13px; font-weight: 600; color: inherit; text-decoration: none; }
a.svc-name { border-bottom: 1px dotted var(--dsw-alias-border-l2, rgba(128,128,128,.45)); }
a.svc-name:hover { border-bottom-color: var(--dsw-alias-state-business-primary, #2563eb); color: var(--dsw-alias-state-business-primary, #2563eb); }
.svc-meta { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary, #8b8b8b); font-size: 12px; font-variant-numeric: tabular-nums; }
.svc-own { font-size: 11px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); cursor: help; }
.svc-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 1.5; font-weight: 500; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); color: var(--dsw-alias-label-secondary, inherit); }
.svc-badge[data-status="running"] { color: var(--dsw-alias-state-success-primary, #16a34a); }
.svc-badge[data-status="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.svc-badge[data-status="starting"], .svc-badge[data-status="stopping"] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.svc-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; box-sizing: border-box; display: inline-block; }
.svc-dot[data-status="running"] { background: var(--dsw-alias-state-success-primary, #16a34a); }
.svc-dot[data-status="stopped"] { border: 1.5px solid var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, #9ca3af)); }
.svc-dot[data-status="error"] { background: var(--dsw-alias-state-error-primary, #dc2626); }
.svc-dot[data-status="starting"], .svc-dot[data-status="stopping"] { background: var(--dsw-alias-state-warn-primary, #d97706); animation: svc-pulse 1s ease-in-out infinite; }
.svc-dot[data-status="unknown"] { border: 1.5px dashed var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, #9ca3af)); }
@keyframes svc-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
.svc-tail { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.svc-tail[data-error="true"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.svc-actions { display: flex; gap: 4px; margin-left: auto; }
.svc-card__row .svc-btn { height: 26px; padding: 0 8px; gap: 4px; }
.svc-btn { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12px; line-height: 1; font-weight: 500; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.svc-btn svg { display: block; }
.svc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.svc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.svc-btn:disabled { opacity: .45; cursor: not-allowed; }
.svc-btn--primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b82f6)); color: var(--dsw-alias-label-primary-foreground, #fff); }
.svc-btn--secondary { border-color: var(--dsw-alias-border-l4, rgba(128,128,128,.34)); }
.svc-btn--ghost { color: var(--dsw-alias-label-secondary, #8b8b8b); }
/* 按钮只留图标：文字进 hover（title）与 aria-label，宽度固定成方块，保证一排按钮对齐。 */
.svc-btn--icon { width: 28px; padding: 0; justify-content: center; }
.svc-card__row .svc-btn--icon { width: 26px; padding: 0; }
.svc-log { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.1)); color: var(--dsw-alias-label-secondary, inherit); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.svc-log__path { margin: 0 0 4px; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); word-break: break-all; }
.svc-form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); border: 1px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2, rgba(128,128,128,.3))); }
.svc-form__title { margin: 0; font-size: 13px; font-weight: 600; }
.svc-form__grid { display: grid; grid-template-columns: 76px 1fr; gap: 6px 8px; align-items: center; }
.svc-form__grid label { font-size: 12px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); }
.svc-input { width: 100%; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.34)); background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.08)); color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12px; box-sizing: border-box; }
.svc-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, #2563eb); }
.svc-form__check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.svc-form__hint { font-size: 11px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); }
.svc-form__actions { display: flex; gap: 6px; margin-left: auto; }
.svc-config { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24)); }
.svc-config__bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.svc-config__path { font-size: 11px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #9a9a9a)); word-break: break-all; }
.svc-textarea { width: 100%; min-height: 10em; padding: 8px 10px; resize: vertical; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.34)); background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.1)); color: var(--dsw-alias-label-primary, inherit); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 1.6; }
.svc-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, #2563eb); }
.svc-alert { padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.svc-alert--error { border: 1px solid var(--dsw-alias-state-error-primary, #dc2626); color: var(--dsw-alias-state-error-primary, #dc2626); }
.svc-alert--note { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); color: var(--dsw-alias-label-secondary, inherit); }
.svc-empty { display: flex; flex-direction: column; gap: 4px; align-items: center; padding: 16px; border: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 12px; text-align: center; }
.svc-skeleton { display: flex; flex-direction: column; gap: 8px; }
.svc-skeleton__line { height: 34px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); animation: svc-shimmer 1.4s ease-in-out infinite; }
.svc-skeleton__line:nth-child(2) { animation-delay: .15s; opacity: .8; }
.svc-skeleton__line:nth-child(3) { animation-delay: .3s; opacity: .6; }
@keyframes svc-shimmer { 0%, 100% { opacity: .7 } 50% { opacity: .3 } }
.svc-chip { padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.12)); color: var(--dsw-alias-label-tertiary, #8b8b8b); font-size: 11px; }
@media (prefers-reduced-motion: reduce) { .svc-skeleton__line, .svc-dot { animation: none } }
`.trim();

    /** 注入一次样式表；重复挂载复用同一份，卸载时移除自己创建的那一个。 */
    function installStyles() {
      if (typeof document === "undefined") return () => {};
      const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (existing !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = STYLE_ID;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    const truncate = (value, limit) => { const text = String(value); return text.length > limit ? text.slice(0, limit) + "…" : text; };

    /**
     * 内联 SVG 图标（不引外部字体/图标库）：16×16 视框、跟随 currentColor、只做装饰。
     * 用 `fill: currentColor` 的路径做实心图形，其余用描边，保证在明暗主题下都清晰。
     */
    const ICON_PATHS = {
      play: { fill: "currentColor", stroke: "none", d: "M5 3.4v9.2l7.6-4.6L5 3.4z" },
      stop: { fill: "currentColor", stroke: "none", d: "M5 4.6c0-.6.4-1 1-1h4c.6 0 1 .4 1 1v4.8c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1V4.6z" },
      restart: { fill: "none", stroke: "currentColor", d: "M12.9 8A4.9 4.9 0 1 1 11.2 4.2M13 2.3v3.4h-3.4" },
      logs: { fill: "none", stroke: "currentColor", d: "M4 4.4h8M4 7.4h8M4 10.4h4.6" },
      refresh: { fill: "none", stroke: "currentColor", d: "M3.6 8A4.4 4.4 0 0 1 11 6M12.4 8A4.4 4.4 0 0 1 5 10M9.9 2.6v3.2H6.7M6.1 13.4v-3.2h3.2" },
      power: { fill: "none", stroke: "currentColor", d: "M8 2.6v4.6M12.2 4.6a4.9 4.9 0 1 1-8.4 0" },
      plus: { fill: "none", stroke: "currentColor", d: "M8 3.4v9.2M3.4 8h9.2" },
      edit: { fill: "none", stroke: "currentColor", d: "M10.7 2.9l2.4 2.4-7.1 7.1H3.6V9.9l7.1-7z" },
      trash: { fill: "none", stroke: "currentColor", d: "M4 5.4h8M6.4 5.4V3.9h3.2v1.5M5.3 5.4l.5 7.1h4.4l.5-7.1" },
      check: { fill: "none", stroke: "currentColor", d: "M3.6 8.5l2.7 2.7 6.1-6.5" },
      close: { fill: "none", stroke: "currentColor", d: "M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" },
    };

    const icon = (name) => {
      const shape = ICON_PATHS[name];
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false",
        fill: shape.fill, stroke: shape.stroke === "none" ? undefined : shape.stroke,
        strokeWidth: shape.stroke === "none" ? undefined : 1.5,
        strokeLinecap: "round", strokeLinejoin: "round",
      }, h("path", { d: shape.d }));
    };
    const formatTime = (value) => {
      if (typeof value !== "string" || value.length === 0) return "—";
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
    };

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
        const value = result.value === undefined ? result.data : result.value;
        if (value === undefined) {
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

    /** ServiceRuntimeState → 最近事件：优先 lastError，其次 lastExit。 */
    const tailText = (service) => {
      if (typeof service.lastError === "string" && service.lastError.length > 0) return { text: "错误：" + truncate(service.lastError, 160), error: true };
      if (service.lastExit) {
        const code = service.lastExit.code === null || service.lastExit.code === undefined ? "未知" : String(service.lastExit.code);
        return { text: "上次退出：code " + code + " · " + formatTime(service.lastExit.at), error: code !== "0" };
      }
      if (typeof service.lastOperation === "string" && service.lastOperation.length > 0) return { text: "最近操作：" + service.lastOperation, error: false };
      return { text: "—", error: false };
    };

    function ServicesSection(props) {
      const call = props.call;
      const [snapshot, setSnapshot] = React.useState(null);
      const [timing, setTiming] = React.useState(null);
      const [actionError, setActionError] = React.useState("");
      const [pollError, setPollError] = React.useState("");
      const [pending, setPending] = React.useState(null);      // 服务 id / "refresh"
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
      const [configRaw, setConfigRaw] = React.useState("");      // 高级 JSON 编辑器用
      const [editing, setEditing] = React.useState(null);        // 表单：{ mode:'add'|'edit', draft, error }
      const appliedRevision = React.useRef(-1);                // 单调 revision：只前进
      const appliedTier = React.useRef(0);                     // 同 revision 下，只接受不更差的层

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

      // 注入样式表（与组件同生命周期）。
      React.useEffect(() => installStyles(), []);

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
        void refreshConfig();   // 表单需要 expectedRevision，先取一次配置（只读）
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
        try {
          const data = unwrap(await call(endpoint, { id: service.id }));
          // id === "dsh" 的 restart 会返回「已安排重启」而不是快照。
          if (data !== null && typeof data === "object" && data.accepted === true) {
            setScheduled(data);
          } else {
            applySnapshot(data);
          }
        } catch (failure) {
          if (failure.code === "PORT_OWNED_BY_OTHER" && confirmForce(failure) === true) {
            try {
              applySnapshot(unwrap(await call(endpoint, { id: service.id, force: true })));
            } catch (retryFailure) {
              setActionError(describeError(retryFailure));
            }
          } else {
            setActionError(describeError(failure));
          }
        } finally {
          setPending(null);
        }
      };

      const toggleLogs = async (service) => {
        if (logId === service.id) { setLogId(null); return; }
        setLogId(service.id);
        try {
          const data = unwrap(await call("logs", { id: service.id, lines: LOG_LINES }));
          const text = data !== null && data !== undefined && typeof data.text === "string" && data.text.length > 0 ? data.text : "（日志为空）";
          const path = data !== null && data !== undefined && typeof data.path === "string" ? data.path : "";
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
          setConfigText(data !== null && data !== undefined && typeof data.raw === "string" ? data.raw : "");
          setConfigRevision(data !== null && data !== undefined && data.revision !== undefined && data.revision !== null ? String(data.revision) : "");
          setConfigPath(data !== null && data !== undefined && typeof data.path === "string" ? data.path : "");
          setConfigRaw(data !== null && data !== undefined && typeof data.raw === "string" ? data.raw : "");
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
          setConfigText(data !== null && data !== undefined && typeof data.raw === "string" ? data.raw : configText);
          setConfigRevision(data !== null && data !== undefined && data.revision !== undefined && data.revision !== null ? String(data.revision) : configRevision);
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

      /** 解析配置原文里的服务数组；返回 null 表示原文不是合法 JSON。 */
      const parseServices = (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.services) ? parsed.services : [];
        } catch {
          return null;
        }
      };

      const emptyDraft = () => ({ id: "", title: "", port: "", command: "", cwd: "", signature: "", probePath: "", autostart: false, autoStopOnExit: true });

      const startAdd = () => {
        setActionError("");
        setEditing({ mode: "add", draft: emptyDraft(), error: "", advanced: false });
      };

      /**
       * 打开编辑表单。定义字段（command/cwd/签名）不在运行态快照里，只能来自配置文件原文；
       * 因此这里**不依赖挂载时是否取过**：缓存里没有就当场再取一次。
       */
      const startEdit = async (service) => {
        setActionError("");
        setPending("form");
        try {
          let raw = configRaw;
          let list = parseServices(raw);
          const has = (entries, id) => Array.isArray(entries) && entries.some((entry) => entry !== null && typeof entry === "object" && entry.id === id);
          if (has(list, service.id) === false) {
            const data = unwrap(await call("config.get", {}));
            if (data !== null && data !== undefined) {
              if (typeof data.revision === "string") setConfigRevision(data.revision);
              if (typeof data.path === "string") setConfigPath(data.path);
              if (typeof data.raw === "string") { raw = data.raw; setConfigRaw(raw); }
            }
            list = parseServices(raw);
          }
          const definition = Array.isArray(list)
            ? list.find((entry) => entry !== null && typeof entry === "object" && entry.id === service.id) ?? null
            : null;
          if (definition === null) {
            setActionError("读不到这条服务的定义：配置文件可能不是合法 JSON。请用下面的「高级：直接编辑 JSON」修正后再用表单。");
            return;
          }
          setEditing({
            mode: "edit",
            error: "",
            advanced: false,
            draft: {
              id: String(definition.id ?? service.id),
              title: String(definition.title ?? service.title ?? ""),
              port: definition.port === null || definition.port === undefined ? "" : String(definition.port),
              command: String(definition.command ?? ""),
              cwd: String(definition.cwd ?? ""),
              signature: String((definition.match && definition.match.commandLinePattern) ?? ""),
              probePath: String((definition.probe && definition.probe.path) ?? ""),
              autostart: definition.autostart === true,
              autoStopOnExit: definition.autoStopOnExit !== false,
            },
          });
        } catch (failure) {
          setActionError(describeError(failure));
        } finally {
          setPending(null);
        }
      };

      const patchDraft = (patch) => setEditing((previous) => (previous === null ? previous : { ...previous, error: "", draft: { ...previous.draft, ...patch } }));

      /** 表单提交：只写定义类字段，走 config.upsert（宿主校验 + 原子写 + expectedRevision）。 */
      const submitForm = async () => {
        if (editing === null) return;
        const draft = editing.draft;
        const problems = [];
        if (draft.title.trim() === "") problems.push("服务名称必填");
        if (draft.command.trim() === "") problems.push("启动命令必填");
        if (draft.cwd.trim() === "") problems.push("工作目录必填");
        const portText = draft.port.trim();
        const port = portText === "" ? null : Number(portText);
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push("端口必须是 1-65535 的整数");
        if (problems.length > 0) { setEditing({ ...editing, error: problems.join("；") }); return; }
        setPending("form");
        try {
          const service = {
            id: draft.id.trim(),
            title: draft.title.trim(),
            port,
            command: draft.command.trim(),
            cwd: draft.cwd.trim(),
            autostart: draft.autostart === true,
            autoStopOnExit: draft.autoStopOnExit !== false,
            match: { commandLinePattern: draft.signature.trim() },
            probe: { path: draft.probePath.trim() === "" ? null : draft.probePath.trim() },
          };
          const result = unwrap(await call("config.upsert", { service, expectedRevision: configRevision }));
          if (result !== null && typeof result === "object") {
            if (typeof result.revision === "string") setConfigRevision(result.revision);
            if (typeof result.raw === "string") { setConfigRaw(result.raw); setConfigText(result.raw); }
          }
          setEditing(null);
          await loadSnapshot("snapshot.full");
        } catch (failure) {
          setEditing((previous) => (previous === null ? previous : { ...previous, error: describeError(failure) }));
        } finally {
          setPending(null);
        }
      };

      /** 删除一条服务的配置；不动正在运行的进程。 */
      const removeService = async (id) => {
        if (window.confirm("删除服务「" + id + "」的配置？\n正在运行的进程不会因此被停止。") !== true) return;
        setPending("form");
        setActionError("");
        try {
          const result = unwrap(await call("config.remove", { id, expectedRevision: configRevision }));
          if (result !== null && typeof result === "object") {
            if (typeof result.revision === "string") setConfigRevision(result.revision);
            if (typeof result.raw === "string") { setConfigRaw(result.raw); setConfigText(result.raw); }
          }
          setEditing(null);
          await loadSnapshot("snapshot.full");
        } catch (failure) {
          setActionError(describeError(failure));
        } finally {
          setPending(null);
        }
      };

      /** 只读地取一次配置：表单与高级编辑器共用它的 expectedRevision / 原文。 */
      const refreshConfig = async () => {
        try {
          const data = unwrap(await call("config.get", {}));
          if (data === null || data === undefined) return;
          if (typeof data.revision === "string") setConfigRevision(data.revision);
          if (typeof data.path === "string") setConfigPath(data.path);
          if (typeof data.raw === "string") { setConfigRaw(data.raw); setConfigLoaded(true); }
        } catch { /* 配置读不到不阻塞服务列表 */ }
      };

      /** 一键重启 DSH：先确认，再调度；收到 ALREADY_SCHEDULED 时按「已安排」处理。 */
      const restartDsh = async () => {
        const confirmed = window.confirm(
          "将重启承载当前页面的 dsh 实例：\n" +
          "· 默认 " + RESTART_GRACE_SECONDS + " 秒后执行；\n" +
          "· 本页面会断开，需要用新实例的 token 重新连接；\n" +
          "· 会清扫本次 DSH 安装的进程树（含其它会话正在执行的命令子进程）。\n\n" +
          "确认现在安排重启吗？");
        if (confirmed !== true) return;
        setPending("refresh");
        setActionError("");
        try {
          const data = unwrap(await call("restart-dsh", { graceSeconds: RESTART_GRACE_SECONDS }));
          setScheduled(data);
        } catch (failure) {
          if (failure.code === "ALREADY_SCHEDULED") {
            setScheduled({ already: true, ...(failure.details || {}) });
          } else {
            setActionError(describeError(failure));
          }
        } finally {
          setPending(null);
        }
      };

      const summary = snapshot && snapshot.summary ? snapshot.summary : null;
      const services = snapshot && Array.isArray(snapshot.services) ? snapshot.services : [];
      const anyBusy = pending !== null;

      // 新鲜度：宿主算、客户端只投影。tier 1 表示详情（PID 等）还没到。
      const timingInfo = timing !== null && typeof timing === "object" ? timing : null;
      const detailPending = (service) => timingInfo !== null && timingInfo.tier === 1
        && service.status === "running" && (service.pid === null || service.pid === undefined);
      const pidText = (service) => {
        if (detailPending(service)) return { text: "读取中…", empty: true };    // 不写「未知」：那是另一个含义
        if (service.pid === null || service.pid === undefined) return { text: "—", empty: true };
        return { text: String(service.pid), empty: false };
      };
      const stale = timingInfo !== null && timingInfo.degraded === true;
      const freshnessText = timingInfo === null ? "" : [
        stale === true ? "🕓 详情可能已过期" : null,
        timingInfo.returnedFromCache === true ? "快照缓存命中" : "刚刚采集",
        typeof timingInfo.ageMs === "number" ? "数据年龄 " + timingInfo.ageMs + "ms" : null,
        timingInfo.tier === 1 ? "详情读取中" : null,
        timingInfo.refreshing === true ? "后台补齐中 ⟳" : null,
      ].filter((part) => part !== null).join(" · ");

      const scheduledText = scheduled === null ? "" : (() => {
        const seconds = typeof scheduled.graceMs === "number" ? Math.round(scheduled.graceMs / 1000) : RESTART_GRACE_SECONDS;
        const lines = [scheduled.already === true ? "已安排重启（ALREADY_SCHEDULED）。" : "已安排重启：约 " + seconds + " 秒后执行。"];
        if (typeof scheduled.scheduledAt === "string" && scheduled.scheduledAt.length > 0) lines.push("执行时刻：" + formatTime(scheduled.scheduledAt));
        if (typeof scheduled.logPath === "string" && scheduled.logPath.length > 0) lines.push("重启日志：" + scheduled.logPath);
        lines.push("当前页面会断开，请稍后刷新页面重新连接。");
        return lines.join("\n");
      })();

      const btn = (variant, extra) => "svc-btn" + (variant === undefined ? "" : " svc-btn--" + variant) + (extra === undefined ? "" : " " + extra);

      /** 只留图标的按钮：文字只出现在 hover（title）与无障碍名（aria-label）里。 */
      const iconButton = (options) => h("button", {
        key: options.key,
        className: btn(options.variant, "svc-btn--icon"),
        title: options.title,
        "aria-label": options.title,
        disabled: options.disabled === true,
        onClick: options.onClick,
      }, icon(options.icon));

      /** 操作按钮：启动/停止/重启=次按钮，日志=弱按钮；busy 时禁用。 */
      const actionButtons = (service) => {
        const canStart = service.status !== "running";
        const canStop = service.status !== "stopped";
        const busy = anyBusy || pending === service.id;
        return h("div", { className: "svc-actions" },
          iconButton({ key: "start", variant: "secondary", icon: "play", title: "启动", disabled: busy || canStart !== true, onClick: () => { void operate("start", service); } }),
          iconButton({ key: "stop", variant: "secondary", icon: "stop", title: "停止", disabled: busy || canStop !== true, onClick: () => { void operate("stop", service); } }),
          iconButton({ key: "restart", variant: "secondary", icon: "restart", title: "重启", disabled: busy || canStop !== true, onClick: () => { void operate("restart", service); } }),
          iconButton({ key: "logs", variant: "ghost", icon: "logs", title: logId === service.id ? "收起日志" : "查看日志", disabled: anyBusy, onClick: () => { void toggleLogs(service); } }),
          iconButton({ key: "edit", variant: "ghost", icon: "edit", title: "编辑配置", disabled: anyBusy, onClick: () => { void startEdit(service); } }));
      };

      /** 「最近事件」只在真的有事时占一行（错误 / 非零退出），避免每行都挂一条空的「—」。 */
      const tailIsWorthShowing = (service) => {
        if (typeof service.lastError === "string" && service.lastError.length > 0) return true;
        if (service.lastExit !== null && service.lastExit !== undefined) {
          return service.lastExit.code !== 0 && service.lastExit.code !== null;
        }
        return false;
      };

      /**
       * 一张服务 = 一行（信息分层）：
       * 必要 —— 状态、名称（有 URL 时即链接）、端口、PID、操作按钮；
       * 次要 —— 来源（符号 + tooltip）、id（tooltip）、原始 URL（tooltip）、最近事件（仅异常时占行）。
       */
      const serviceCard = (service) => {
        const meta = STATUS_META[service.status] || STATUS_META.unknown;
        const serviceId = service.id;
        const entry = logs[serviceId];
        const pid = pidText(service);
        const portEmpty = service.port === null || service.port === undefined;
        const isSpawned = service.ownership === "spawned";
        const ownershipKnown = service.ownership === "spawned" || service.ownership === "discovered";
        const hasUrl = service.url !== null && service.url !== undefined && service.url.length > 0;
        const tail = tailIsWorthShowing(service) ? tailText(service) : null;
        const title = service.title || serviceId;
        const nameNode = hasUrl
          ? h("a", { className: "svc-name", href: service.url, target: "_blank", rel: "noreferrer", title: service.url }, title)
          : h("span", { className: "svc-name", title: serviceId }, title);
        return h("article", { key: serviceId, className: "svc-card", "data-status": service.status, "data-ownership": service.ownership },
          h("div", { className: "svc-card__row" },
            h("span", { className: "svc-badge", "data-status": service.status },
              h("span", { className: "svc-dot", "data-status": service.status, "aria-hidden": "true" }),
              meta.prefix + meta.label + (service.status === "starting" || service.status === "stopping" ? "…" : "")),
            nameNode,
            h("span", { className: "svc-meta" },
              portEmpty ? null : h("span", { title: "监听端口" }, ":" + service.port),
              pid.empty ? null : h("span", { title: "进程 ID" }, "pid " + pid.text),
              pid.empty && portEmpty === false ? h("span", { title: "进程详情尚未采到" }, "读取中…") : null),
            ownershipKnown === false ? null : h("span", {
              className: "svc-own",
              "data-ownership": service.ownership,
              title: isSpawned ? "本插件启动（dsh 退出时会一并停止）" : "外部进程（不是本插件启动的）",
            }, isSpawned ? "◆" : "◇"),
            pending === serviceId ? h("span", { className: "svc-chip" }, "处理中…") : null,
            actionButtons(service)),
          tail === null ? null : h("div", { className: "svc-tail", "data-error": tail.error === true ? "true" : "false" }, tail.text),
          logId !== serviceId ? null : h("div", null,
            h("p", { className: "svc-log__path" }, "日志文件：" + (entry !== undefined && entry.path ? entry.path : "—")),
            h("pre", { className: "svc-log" }, entry === undefined ? "读取中…" : entry.text)));
      };

      /** 首帧骨架：宿主手上还没有任何观测（timing.cacheMiss）时不要显示「0 个服务」。 */
      const skeleton = () => h("div", { className: "svc-skeleton" },
        [0, 1, 2].map((index) => h("div", { key: index, className: "svc-skeleton__line" })));

      const isEmpty = services.length === 0;
      const showSkeleton = isEmpty && (snapshot === null || (timingInfo !== null && timingInfo.cacheMiss === true));
      // 骨架态不渲染计数：设计规范 §2 明确「cacheMiss 不显示『0 个服务』」。
      const summaryText = (summary === null || showSkeleton === true)
        ? ""
        : "共 " + summary.total + " · 运行 " + summary.running + " · 已停止 " + summary.stopped + " · 异常 " + summary.error
          + (summary.unknown > 0 ? " · 未知 " + summary.unknown : "");

      return h("section", { className: "svc-section" },
        h("div", { className: "svc-heading" },
          h("h2", { className: "svc-title" }, "服务管理"),
          h("p", { className: "svc-desc" }, "宿主后台网络服务的状态与操作；服务定义以配置文件为唯一事实来源，运行态不落盘。")),
        h("div", { className: "svc-toolbar" },
          iconButton({ key: "add", variant: "secondary", icon: "plus", title: "添加服务", disabled: anyBusy, onClick: startAdd }),
          iconButton({ key: "refresh", variant: "secondary", icon: "refresh", title: pending === "refresh" ? "刷新中…" : "全部刷新（重新采集真实状态）", disabled: anyBusy, onClick: () => { setPending("refresh"); void refresh().finally(() => setPending(null)); } }),
          iconButton({ key: "restart-dsh", variant: "primary", icon: "power", title: scheduled === null ? "重启 DSH" : "已安排重启", disabled: anyBusy || scheduled !== null, onClick: () => { void restartDsh(); } })),
        summaryText.length === 0 ? null : h("p", { className: "svc-summary" }, summaryText),
        freshnessText.length === 0 ? null : h("p", { className: "svc-freshness", "data-stale": stale === true ? "true" : "false" }, freshnessText),
        actionError.length === 0 ? null : h("div", { className: "svc-alert svc-alert--error" }, "⚠ " + actionError),
        pollError.length === 0 ? null : h("div", { className: "svc-alert svc-alert--error" }, "⚠ " + pollError),
        scheduledText.length === 0 ? null : h("div", { className: "svc-alert svc-alert--note" }, scheduledText),
        editing === null ? null : h("section", { className: "svc-form" },
          h("p", { className: "svc-form__title" }, editing.mode === "add" ? "添加服务" : "编辑服务：" + (editing.draft.title !== "" ? editing.draft.title : editing.draft.id)),
          h("div", { className: "svc-form__grid" },
            h("label", null, "名称"),
            h("input", { className: "svc-input", value: editing.draft.title, placeholder: "例如 tiny-world Web 原型", onChange: (event) => patchDraft({ title: event.target.value }) }),
            h("label", null, "端口"),
            h("input", { className: "svc-input", value: editing.draft.port, inputMode: "numeric", placeholder: "例如 5173（留空表示不是网络服务）", onChange: (event) => patchDraft({ port: event.target.value.replace(/[^0-9]/g, "") }) }),
            h("label", null, "启动命令"),
            h("input", { className: "svc-input", value: editing.draft.command, placeholder: "例如 npm run dev -- --port 5173", onChange: (event) => patchDraft({ command: event.target.value }) }),
            h("label", null, "工作目录"),
            h("input", { className: "svc-input", value: editing.draft.cwd, placeholder: "例如 G:\\Projects\\tiny-world\\Web Prototype", onChange: (event) => patchDraft({ cwd: event.target.value }) }),
            h("label", null, "选项"),
            h("div", null,
              h("label", { className: "svc-form__check" },
                h("input", { type: "checkbox", checked: editing.draft.autostart === true, onChange: (event) => patchDraft({ autostart: event.target.checked }) }),
                "dsh 启动时自动拉起"),
              h("label", { className: "svc-form__check" },
                h("input", { type: "checkbox", checked: editing.draft.autoStopOnExit !== false, onChange: (event) => patchDraft({ autoStopOnExit: event.target.checked }) }),
                "dsh 退出时停止（仅限本插件启动的实例）"))),
          h("button", { className: btn("ghost"), onClick: () => setEditing({ ...editing, advanced: editing.advanced !== true }) }, (editing.advanced === true ? "▾ " : "▸ ") + "高级选项"),
          editing.advanced !== true ? null : h("div", { className: "svc-form__grid" },
            h("label", null, "标识 id"),
            h("input", { className: "svc-input", value: editing.draft.id, placeholder: "留空则按名称自动生成（纯中文名称会生成 service、service-2）", onChange: (event) => patchDraft({ id: event.target.value }) }),
            h("label", null, "接管签名"),
            h("input", { className: "svc-input", value: editing.draft.signature, placeholder: "终止端口占用者前的身份校验（正则，留空=拒绝接管）", onChange: (event) => patchDraft({ signature: event.target.value }) }),
            h("label", null, "健康检查"),
            h("input", { className: "svc-input", value: editing.draft.probePath, placeholder: "例如 /health（留空则不探测）", onChange: (event) => patchDraft({ probePath: event.target.value }) })),
          h("p", { className: "svc-form__hint" }, "保存后写入配置文件（唯一事实来源）；只改定义，不会动正在运行的进程。"),
          editing.error.length === 0 ? null : h("div", { className: "svc-alert svc-alert--error" }, "⚠ " + editing.error),
          h("div", { className: "svc-form__actions" },
            editing.mode === "edit" ? iconButton({ key: "delete", variant: "secondary", icon: "trash", title: "删除这条配置（不会停止正在运行的进程）", disabled: anyBusy, onClick: () => { void removeService(editing.draft.id); } }) : null,
            iconButton({ key: "cancel", variant: "ghost", icon: "close", title: "取消", disabled: anyBusy, onClick: () => setEditing(null) }),
            iconButton({ key: "save", variant: "primary", icon: "check", title: pending === "form" ? "保存中…" : "保存到配置文件", disabled: anyBusy, onClick: () => { void submitForm(); } }))),
        showSkeleton
          ? skeleton()
          : (isEmpty
            ? h("div", { className: "svc-empty" },
              h("p", { className: "svc-desc" }, "配置里还没有服务。"),
              h("p", { className: "svc-desc" }, "在 services.json 添加服务后，点「全部刷新」。"))
            : h("div", { className: "svc-list" }, services.map(serviceCard))),
        h("section", { className: "svc-config" },
          h("div", { className: "svc-config__bar" },
            h("button", { className: btn("ghost"), onClick: toggleConfig }, (configOpen === true ? "▾ " : "▸ ") + "高级：直接编辑 JSON"),
            configRevision.length === 0 ? null : h("span", { className: "svc-chip" }, "修订 " + configRevision),
            configPath.length === 0 ? null : h("span", { className: "svc-config__path" }, configPath)),
          configOpen !== true ? null : h(React.Fragment, null,
            h("p", { className: "svc-form__hint" }, "日常请用上面的表单；这里用于批量修改或表单未覆盖的字段（env、probe.expectStatus 等）。保存同样受 expectedRevision 保护。"),
            h("textarea", { className: "svc-textarea", value: configText, rows: 12, spellCheck: false, "aria-label": "服务配置 JSON", onChange: (event) => setConfigText(event.target.value) }),
            h("div", { className: "svc-toolbar" },
              iconButton({ key: "json-save", variant: "secondary", icon: "check", title: configBusy ? "保存中…" : "保存 JSON", disabled: configBusy, onClick: () => { void saveConfig(); } }),
              iconButton({ key: "json-reload", variant: "ghost", icon: "refresh", title: "重新载入", disabled: configBusy, onClick: () => { void loadConfig(); } })),
            configError.length === 0 ? null : h("div", { className: "svc-alert svc-alert--error" }, "⚠ " + (configConflict === true ? "文件已被外部修改，请重新载入。\n" : "") + configError))));
    }

    /** 注册设置分区；call 是这一份注册唯一的宿主出口。 */
    function apply(ctx) {
      const call = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload);
      ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "services", order: 50, label: () => "服务管理", inject: () => ({ call }) }, ServicesSection));
    }

    return { inject, apply };
  },
});
