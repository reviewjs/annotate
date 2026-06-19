/* =============================================================================
 * annotate.js — a drop-in visual review & annotation layer for any website.
 * Open-source edition · local-only · zero backend.
 *
 * Load with a single <script> tag:
 *   <script src="https://cdn.jsdelivr.net/npm/reviewjs/annotate.js" defer></script>
 *
 * Comments are stored in the visitor's own browser (localStorage) and can be
 * exported to / imported from a portable JSON file — no server, no database,
 * no tracking. Perfect for design reviews, client feedback, QA passes and docs.
 *
 * Configure via data-attributes on the script tag (all optional):
 *   data-project   namespace for stored comments (keep separate sites apart)
 *   data-page      page key (default: location.pathname)
 *   data-accent    brand color for primary buttons / active tool
 *   data-theme     "light" | "dark" | "auto"  (default auto — sniffs page bg)
 *   data-position  "bottom-right" | "bottom-left"  (toolbar corner)
 *   data-blocks    CSS selector for section-comment (+) targets
 *   data-note      author's note to reviewers — what should be reviewed
 *   data-share-email  where reviewers send comments: an email address, or a
 *                     Slack / Hangout (chat) link
 * …or via `window.AnnotateConfig = { project, page, … }` before the script.
 *
 * Tools: text highlight, rectangle, circle, pin, freehand ink and section
 * notes — each carries a threaded comment.
 *
 * All UI lives under ids/classes prefixed `an-` / `__an`; styles are injected
 * and scoped so it never collides with host-page content.
 *
 * MIT Licensed.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__ANNOTATE_LOADED__) return;
  window.__ANNOTATE_LOADED__ = true;

  var VERSION = "1.0.1";

  // --------------------------------------------------------------------------
  // CONFIG — resolved from (in priority order) the script tag's data-* attrs,
  // then a global window.AnnotateConfig object, then built-in defaults.
  // --------------------------------------------------------------------------
  var SCRIPT = document.currentScript ||
    document.querySelector('script[src*="annotate"]');
  var scriptData = (SCRIPT && SCRIPT.dataset) || {};   // data-* attributes
  var globalConfig = window.AnnotateConfig || {};       // window.AnnotateConfig
  var CFG = {
    project: scriptData.project || globalConfig.project || "",
    page: scriptData.page || globalConfig.page || location.pathname,
    accent: scriptData.accent || globalConfig.accent || "",
    theme: scriptData.theme || globalConfig.theme || "auto",
    position: scriptData.position || globalConfig.position || "bottom-right",
    blocks: scriptData.blocks || globalConfig.blocks || "",
    note: scriptData.note || globalConfig.note || "",
    share: String(scriptData.shareEmail || globalConfig.shareEmail || "").trim(),
  };
  var PAGE = (CFG.project ? CFG.project + ":" : "") + CFG.page;

  // localStorage can be denied (private mode, sandboxed iframes) — never crash
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  var COLORS = [
    { name: "Amber", hex: "#f59e0b" },
    { name: "Rose", hex: "#f43f5e" },
    { name: "Violet", hex: "#8b5cf6" },
    { name: "Sky", hex: "#0ea5e9" },
    { name: "Emerald", hex: "#10b981" },
  ];

  var state = {
    tool: "cursor", // cursor | highlight | rect | circle | pin | pen
    color: store.get("an-color") || COLORS[0].hex,
    author: store.get("an-author") || "",
    // note & share are set by the author via data-note / data-share-email on
    // the embed script — they are static and never edited by the reviewer.
    note: CFG.note || "",
    share: CFG.share || "",
    comments: [],
    panelOpen: false,
    activeId: null,
    filter: "open", // open | resolved | all
    query: "",
    enabled: store.get("an-off") !== "1", // master on/off
  };

  // --------------------------------------------------------------------------
  // tiny helpers
  // --------------------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k.slice(0, 2) === "on")
          n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtTime(iso) {
    var d = new Date(iso), now = Date.now(), diff = (now - d) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return d.toLocaleDateString();
  }
  function initials(name) {
    var p = String(name || "?").trim().split(/\s+/);
    return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }
  function nameHue(name) {
    var h = 0, s = String(name || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function avatarEl(name, size) {
    var a = el("span", { class: "an-avatar", text: initials(name), title: name || "" });
    a.style.background = "hsl(" + nameHue(name) + " 55% 45%)";
    if (size) { a.style.width = a.style.height = size + "px"; a.style.fontSize = (size * 0.4) + "px"; }
    return a;
  }

  // --------------------------------------------------------------------------
  // STORAGE — a tiny localStorage-backed comment store. One JSON blob per
  // project; comments are namespaced by page key.
  // --------------------------------------------------------------------------
  // localStorage key holding this project's entire comment blob
  var STORE_KEY = "annotate:" + (CFG.project || location.host || "default");
  function dbRead() {
    var d;
    try { d = JSON.parse(store.get(STORE_KEY) || "null"); } catch (e) { d = null; }
    if (!d || typeof d !== "object") d = {};
    if (!Array.isArray(d.comments)) d.comments = [];
    return d;
  }
  function dbWrite(d) { store.set(STORE_KEY, JSON.stringify(d)); }
  function uid() {
    return "c" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function pageComments() {
    return dbRead().comments.filter(function (c) { return c.page === PAGE; });
  }
  function createComment(draft) {
    var d = dbRead(), now = new Date().toISOString();
    var c = {
      id: uid(),
      page: PAGE,
      url: location.href,
      type: draft.type || "note",
      author: state.author || "Anonymous",
      text: String(draft.text || "").slice(0, 5000),
      color: draft.color || state.color,
      anchor: draft.anchor || null,
      geom: draft.geom || null,
      resolved: false,
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    d.comments.push(c); dbWrite(d);
    return c;
  }
  function patchComment(id, changes) {
    var d = dbRead();
    var c = d.comments.filter(function (x) { return x.id === id; })[0];
    if (!c) return null;
    if (typeof changes.text === "string") c.text = changes.text.slice(0, 5000);
    if (typeof changes.resolved === "boolean") c.resolved = changes.resolved;
    if (typeof changes.color === "string") c.color = changes.color;
    if (changes.reply) c.replies.push(changes.reply);
    c.updatedAt = new Date().toISOString();
    dbWrite(d);
    return c;
  }
  function removeComment(id) {
    var d = dbRead();
    d.comments = d.comments.filter(function (c) { return c.id !== id; });
    dbWrite(d);
  }

  // unique-ish css selector for an element (for re-anchoring overlays)
  function cssPath(node) {
    if (node === document.body) return "body";
    if (node.id) return "#" + CSS.escape(node.id);
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.body) {
      var sel = node.nodeName.toLowerCase();
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      var i = 1, sib = node;
      while ((sib = sib.previousElementSibling))
        if (sib.nodeName === node.nodeName) i++;
      sel += ":nth-of-type(" + i + ")";
      parts.unshift(sel);
      node = node.parentElement;
    }
    return (parts[0] && parts[0][0] === "#" ? "" : "body > ") + parts.join(" > ");
  }
  function resolveAnchorEl(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  // ignore our own UI when walking content
  function isOurs(node) {
    while (node) {
      if (node.id && String(node.id).indexOf("__an") === 0) return true;
      if (node.classList && node.classList.contains("an-mark")) return false;
      node = node.parentNode;
    }
    return false;
  }

  // ==========================================================================
  // STYLES — design tokens + components, light & dark
  // ==========================================================================
  var CSS_TEXT = `
  :root {
    --an-font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --an-surface: #ffffff;
    --an-surface-2: #f6f6f8;
    --an-glass: rgba(255,255,255,.85);
    --an-fg: #17171f;
    --an-muted: #84848f;
    --an-border: rgba(22,22,34,.09);
    --an-border-strong: rgba(22,22,34,.16);
    --an-btn-bg: #17171f;
    --an-btn-fg: #ffffff;
    --an-danger: #e11d48;
    --an-ok: #10b981;
    --an-shadow-sm: 0 2px 10px rgba(18,18,32,.10);
    --an-shadow-md: 0 8px 30px rgba(18,18,32,.14);
    --an-shadow-lg: 0 18px 60px rgba(18,18,32,.20);
    --an-ring: 0 0 0 3px rgba(99,102,241,.25);
  }
  :root.an-dark {
    --an-surface: #1e1e26;
    --an-surface-2: #28282f;
    --an-glass: rgba(30,30,38,.86);
    --an-fg: #ededf2;
    --an-muted: #9d9da8;
    --an-border: rgba(255,255,255,.10);
    --an-border-strong: rgba(255,255,255,.20);
    --an-btn-bg: #ededf2;
    --an-btn-fg: #17171f;
    --an-shadow-sm: 0 2px 10px rgba(0,0,0,.35);
    --an-shadow-md: 0 8px 30px rgba(0,0,0,.45);
    --an-shadow-lg: 0 18px 60px rgba(0,0,0,.55);
  }

  #__an_root, #__an_root *, #__an_compose, #__an_compose *,
  #__an_toasts, #__an_toasts *, #__an_namewrap, #__an_namewrap *,
  #__an_sharewrap, #__an_sharewrap *, #__an_launch, #__an_launch *,
  #__an_plus, #__an_plus * { box-sizing: border-box; }

  .an-mark { border-radius: 2px; padding: .04em 0; cursor: pointer;
    transition: background .15s, box-shadow .15s; }
  .an-mark.an-active { box-shadow: 0 0 0 2px rgba(0,0,0,.14); }

  #__an_overlay { position: absolute; top:0; left:0; pointer-events:none;
    z-index: 2147483000; overflow: visible; }
  #__an_overlay .an-hit { pointer-events: stroke; cursor: pointer; }

  .an-pin { position:absolute; width:26px; height:26px; margin:-13px 0 0 -13px;
    border-radius: 50% 50% 50% 2px; transform: rotate(45deg);
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    color:#fff; font:600 12px/1 var(--an-font);
    box-shadow: 0 4px 14px rgba(0,0,0,.28); z-index: 2147483100;
    border: 2px solid rgba(255,255,255,.85);
    transition: transform .15s cubic-bezier(.34,1.56,.64,1);
    animation: an-drop .25s cubic-bezier(.34,1.56,.64,1); }
  @keyframes an-drop { from { transform: rotate(45deg) scale(.4); opacity:0 }
    to { transform: rotate(45deg) scale(1); opacity:1 } }
  .an-pin span { transform: rotate(-45deg); }
  .an-pin:hover { transform: rotate(45deg) scale(1.14); }
  .an-pin.an-active { outline: 3px solid rgba(0,0,0,.18); }

  .an-avatar { width:22px; height:22px; border-radius:50%; flex:none;
    display:inline-flex; align-items:center; justify-content:center;
    color:#fff; font:600 9px/1 var(--an-font); letter-spacing:.02em; }

  /* ---- toolbar ----------------------------------------------------------- */
  #__an_bar { position: fixed; bottom: 18px; z-index: 2147483200;
    display:flex; flex-direction:column; gap:6px; align-items:center;
    background: var(--an-glass); backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
    padding: 8px; border-radius: 18px;
    box-shadow: var(--an-shadow-md), 0 1px 0 rgba(255,255,255,.55) inset;
    border: 1px solid var(--an-border);
    font-family: var(--an-font);
    animation: an-rise .3s cubic-bezier(.34,1.4,.64,1); }
  @keyframes an-rise { from { transform: translateY(14px); opacity:0 }
    to { transform: translateY(0); opacity:1 } }
  #__an_bar.an-right { right: 18px; transition: right .3s cubic-bezier(.32,.72,.28,1); }
  #__an_bar.an-left { left: 18px; }
  @media (min-width: 641px) {
    #__an_root.an-popen #__an_bar.an-right { right: 398px; }
  }
  .an-btn { width:40px; height:40px; border:none; border-radius:12px;
    background: transparent; cursor:pointer; display:flex; align-items:center;
    justify-content:center; color: var(--an-fg); position:relative;
    transition: background .15s, transform .1s, color .15s; }
  .an-btn:hover { background: rgba(127,127,140,.14); }
  .an-btn:active { transform: scale(.92); }
  .an-btn.an-on { background: var(--an-btn-bg); color: var(--an-btn-fg);
    box-shadow: 0 4px 12px rgba(0,0,0,.22); }
  .an-btn svg { width:20px; height:20px; }
  .an-btn[data-tip]:hover::after { content: attr(data-tip);
    position:absolute; top:50%; transform:translateY(-50%);
    background:#17171f; color:#fff; font:500 12px var(--an-font); padding:6px 10px;
    border-radius:8px; white-space:pre; pointer-events:none;
    box-shadow: var(--an-shadow-sm); z-index: 5; }
  #__an_bar.an-right .an-btn[data-tip]:hover::after { right:50px; }
  #__an_bar.an-left .an-btn[data-tip]:hover::after { left:50px; }
  .an-sep { width:24px; height:1px; background: var(--an-border-strong); margin:1px 0; }
  .an-count { position:absolute; top:-3px; right:-3px; min-width:17px; height:17px;
    padding:0 4px; background:#f43f5e; color:#fff; border-radius:9px;
    font-size:10px; font-weight:700; display:flex; align-items:center;
    justify-content:center; border:2px solid var(--an-surface); }

  /* ---- color picker ------------------------------------------------------ */
  #__an_colorbtn { width:40px; height:40px; border:none; border-radius:12px;
    background:transparent; cursor:pointer; display:flex; align-items:center;
    justify-content:center; position:relative; transition:background .15s; }
  #__an_colorbtn:hover { background:rgba(127,127,140,.14); }
  #__an_colorbtn .an-swdot { width:21px; height:21px; border-radius:50%;
    border:2px solid var(--an-surface);
    box-shadow:0 1px 4px rgba(0,0,0,.28), 0 0 0 1px var(--an-border); }
  #__an_colorpop { position:absolute; z-index:2147483210;
    background: var(--an-glass); backdrop-filter:blur(16px) saturate(1.5);
    -webkit-backdrop-filter:blur(16px) saturate(1.5);
    border:1px solid var(--an-border); border-radius:16px; padding:9px;
    box-shadow: var(--an-shadow-md); display:none; gap:8px; }
  #__an_bar.an-right #__an_colorpop { right:52px; }
  #__an_bar.an-left #__an_colorpop { left:52px; }
  #__an_colorpop.an-show { display:flex; }
  .an-sw { width:24px; height:24px; border-radius:50%; cursor:pointer;
    border:2px solid var(--an-surface);
    box-shadow:0 1px 4px rgba(0,0,0,.25), 0 0 0 1px var(--an-border);
    transition: transform .12s; }
  .an-sw:hover { transform: scale(1.18); }
  .an-sw.an-on { transform: scale(1.18); box-shadow:0 0 0 2px var(--an-btn-bg), 0 1px 4px rgba(0,0,0,.3); }

  /* ---- side panel (floating, Figma-style) -------------------------------- */
  #__an_panel { position: fixed; top:12px; right:12px; bottom:12px; width:374px;
    max-width: calc(100vw - 24px); background: var(--an-surface); z-index:2147483150;
    border:1px solid var(--an-border); border-radius:18px;
    box-shadow: var(--an-shadow-lg); transform: translateX(calc(100% + 26px));
    transition: transform .3s cubic-bezier(.32,.72,.28,1); display:flex;
    flex-direction:column; font-family: var(--an-font); color: var(--an-fg);
    overflow:hidden; }
  #__an_panel.an-open { transform: translateX(0); }
  .an-ph { padding:16px 18px 12px; display:flex; align-items:center; gap:10px; }
  .an-ph h2 { margin:0; font:700 15px/1.2 var(--an-font); letter-spacing:-.01em; }
  .an-ph .an-pcount { font-size:11px; font-weight:600; color: var(--an-muted);
    background: var(--an-surface-2); border-radius:10px; padding:2px 8px; }
  .an-x { border:none; background: var(--an-surface-2); width:28px; height:28px;
    border-radius:8px; cursor:pointer; font-size:16px; color: var(--an-muted);
    display:flex; align-items:center; justify-content:center; margin-left:auto;
    transition: background .15s, color .15s; }
  .an-x:hover { background: var(--an-border); color: var(--an-fg); }
  .an-ph .an-x { margin-left:0; }
  .an-hbtn { border:none; background:transparent; width:28px; height:28px; padding:5px;
    border-radius:8px; cursor:pointer; color: var(--an-muted); display:flex;
    align-items:center; justify-content:center; transition: background .15s, color .15s; }
  .an-hbtn:first-of-type { margin-left:auto; }
  .an-hbtn:hover { background: var(--an-surface-2); color: var(--an-fg); }
  .an-hbtn svg { width:16px; height:16px; }
  .an-toolsrow { padding:0 18px 12px; display:flex; flex-direction:column; gap:9px;
    border-bottom:1px solid var(--an-border); }
  .an-search { position:relative; }
  .an-search svg { position:absolute; left:10px; top:50%; transform:translateY(-50%);
    width:14px; height:14px; color: var(--an-muted); pointer-events:none; }
  .an-search input { width:100%; border:1px solid var(--an-border);
    background: var(--an-surface-2); border-radius:10px; padding:8px 10px 8px 31px;
    font:13px var(--an-font); outline:none; color: var(--an-fg); transition:border-color .15s; }
  .an-search input:focus { border-color: var(--an-border-strong); }
  .an-filters { display:flex; gap:6px; }
  .an-chip { padding:4px 11px; border-radius:20px; border:1px solid var(--an-border);
    background: var(--an-surface); cursor:pointer; color: var(--an-muted);
    font:500 12px var(--an-font); transition: all .15s; }
  .an-chip:hover { border-color: var(--an-border-strong); color: var(--an-fg); }
  .an-chip.an-on { background: var(--an-btn-bg); color: var(--an-btn-fg);
    border-color: var(--an-btn-bg); }
  .an-list { flex:1; overflow-y:auto; padding:8px 12px 16px; }
  .an-list::-webkit-scrollbar { width:8px; }
  .an-list::-webkit-scrollbar-thumb { background: var(--an-border-strong); border-radius:4px; }

  .an-empty { text-align:center; color: var(--an-muted); padding:42px 24px;
    font-size:13px; line-height:1.65; }
  .an-empty .an-eicon { width:42px; height:42px; margin:0 auto 12px; border-radius:14px;
    background: var(--an-surface-2); display:flex; align-items:center; justify-content:center; }
  .an-empty .an-eicon svg { width:20px; height:20px; color: var(--an-muted); }
  .an-empty kbd { font:600 11px var(--an-font); background: var(--an-surface-2);
    border:1px solid var(--an-border-strong); border-bottom-width:2px;
    border-radius:5px; padding:1px 5px; }

  /* ---- comment card ------------------------------------------------------ */
  .an-card { border:1px solid var(--an-border); border-radius:14px; padding:12px 13px;
    margin:8px 2px; background: var(--an-surface);
    transition: box-shadow .15s, border-color .15s; cursor:pointer; position:relative; }
  .an-card:hover { box-shadow: var(--an-shadow-sm); border-color: var(--an-border-strong); }
  .an-card.an-active { border-color: var(--an-btn-bg); box-shadow: var(--an-shadow-sm); }
  .an-card.an-resolved { opacity:.6; }
  .an-cmeta { display:flex; align-items:center; gap:8px; margin-bottom:7px; }
  .an-author { font-weight:600; font-size:13px; }
  .an-tag { font-size:10px; font-weight:600; color: var(--an-muted);
    display:inline-flex; align-items:center; gap:4px; }
  .an-tag .an-dot { width:8px; height:8px; border-radius:50%; }
  .an-when { font-size:11px; color: var(--an-muted); margin-left:auto; flex:none; }
  .an-rbadge { display:inline-flex; align-items:center; gap:3px; font:600 10px var(--an-font);
    color: var(--an-ok); }
  .an-rbadge svg { width:11px; height:11px; }
  .an-quote { font-size:12px; color: var(--an-muted); background: var(--an-surface-2);
    border-left:3px solid var(--an-border-strong);
    padding:5px 9px; border-radius:0 6px 6px 0; margin:6px 0; line-height:1.45;
    max-height:54px; overflow:hidden; }
  .an-body { font-size:13.5px; line-height:1.5; color: var(--an-fg);
    white-space:pre-wrap; word-break:break-word; }
  .an-replies { margin-top:9px; border-top:1px dashed var(--an-border); padding-top:8px;
    display:flex; flex-direction:column; gap:7px; }
  .an-reply { display:flex; gap:8px; font-size:12.5px; line-height:1.45; }
  .an-reply .an-rwho { font-weight:600; margin-right:5px; }
  .an-reply .an-rwhen { color: var(--an-muted); font-size:10.5px; margin-left:5px; }
  .an-cact { display:flex; gap:5px; margin-top:10px; flex-wrap:wrap;
    opacity:.45; transition: opacity .15s; }
  .an-card:hover .an-cact, .an-card.an-active .an-cact { opacity:1; }
  .an-mini { border:1px solid var(--an-border); background: var(--an-surface);
    border-radius:8px; padding:4px 9px; font:500 11.5px var(--an-font); cursor:pointer;
    color: var(--an-muted); display:inline-flex; align-items:center; gap:4px;
    transition: all .15s; }
  .an-mini svg { width:12px; height:12px; }
  .an-mini:hover { background: var(--an-surface-2); color: var(--an-fg); }
  .an-mini.an-danger:hover { background:rgba(225,29,72,.08); color: var(--an-danger);
    border-color: rgba(225,29,72,.3); }
  .an-replybox, .an-editbox { display:none; margin-top:8px; gap:6px; flex-direction:column; }
  .an-replybox.an-show, .an-editbox.an-show { display:flex; }
  .an-input, .an-ta { width:100%; border:1px solid var(--an-border-strong);
    background: var(--an-surface); border-radius:9px;
    padding:8px 10px; font:13px var(--an-font); resize:vertical; outline:none;
    color: var(--an-fg); transition: border-color .15s, box-shadow .15s; }
  .an-input:focus, .an-ta:focus { border-color: var(--an-btn-bg); }

  /* ---- panel footer ------------------------------------------------------ */
  #__an_foot { border-top:1px solid var(--an-border); padding:12px 16px;
    background: var(--an-surface-2); display:flex; flex-direction:column; gap:9px; }
  #__an_foot .an-localnote { display:flex; align-items:center; gap:7px;
    font-size:11.5px; color: var(--an-muted); }
  #__an_foot .an-localnote svg { width:14px; height:14px; flex:none; }
  #__an_foot .an-footrow { display:flex; gap:8px; }
  #__an_foot .an-fbtn { flex:1; border:1px solid var(--an-border-strong);
    background: var(--an-surface); color: var(--an-fg); border-radius:10px; padding:9px;
    font:600 12.5px var(--an-font); cursor:pointer; display:flex; align-items:center;
    justify-content:center; gap:7px; transition: background .15s, border-color .15s; }
  #__an_foot .an-fbtn:hover { background: var(--an-surface-2); border-color: var(--an-btn-bg); }
  #__an_foot .an-fbtn svg { width:15px; height:15px; }

  /* ---- composer popover -------------------------------------------------- */
  #__an_compose { position:absolute; z-index:2147483300; width:304px;
    background: var(--an-surface); border-radius:14px; box-shadow: var(--an-shadow-lg);
    border:1px solid var(--an-border); padding:13px; font-family: var(--an-font);
    color: var(--an-fg); display:none;
    animation: an-pop .18s cubic-bezier(.34,1.4,.64,1); }
  #__an_compose.an-show { display:block; }
  #__an_compose .an-ctitle { font-size:11px; font-weight:700; text-transform:uppercase;
    letter-spacing:.05em; color: var(--an-muted); margin-bottom:9px;
    display:flex; align-items:center; gap:6px; }
  #__an_compose .an-cquote { font-size:12.5px; line-height:1.45; color: var(--an-muted);
    background: var(--an-surface-2); border-left:3px solid var(--an-border-strong);
    padding:6px 10px; border-radius:0 6px 6px 0; margin-bottom:9px; max-height:84px;
    overflow-y:auto; font-style:italic; white-space:pre-wrap; word-break:break-word; }
  #__an_compose .an-cfoot { display:flex; align-items:center; margin-top:10px; gap:7px; }
  #__an_compose .an-ckbd { font-size:10.5px; color: var(--an-muted); margin-right:auto; }
  .an-primary { background: var(--an-btn-bg); color: var(--an-btn-fg); border:none;
    border-radius:9px; padding:7px 15px; font:600 12.5px var(--an-font); cursor:pointer;
    transition: filter .15s, opacity .15s; }
  .an-primary:hover { filter: brightness(1.15); }
  .an-primary:disabled { opacity:.55; cursor:default; }
  .an-ghost { background:transparent; border:1px solid var(--an-border-strong);
    border-radius:9px; padding:7px 13px; font:500 12.5px var(--an-font); cursor:pointer;
    color: var(--an-muted); }
  .an-ghost:hover { color: var(--an-fg); }

  /* ---- name modal -------------------------------------------------------- */
  #__an_namewrap { position:fixed; inset:0; z-index:2147483400;
    background:rgba(14,14,22,.45); backdrop-filter:blur(4px);
    display:flex; align-items:center; justify-content:center;
    font-family: var(--an-font); }
  #__an_namebox { background: var(--an-surface); color: var(--an-fg);
    width:380px; max-width:92vw; border-radius:18px;
    padding:26px 26px 22px; box-shadow: var(--an-shadow-lg);
    animation: an-pop .22s cubic-bezier(.34,1.56,.64,1);
    max-height:calc(100vh - 32px); overflow-y:auto; }
  @keyframes an-pop { from{transform:scale(.92);opacity:0} to{transform:scale(1);opacity:1} }
  #__an_namebox .an-nt { font:700 19px/1.2 var(--an-font); letter-spacing:-.01em; margin:0 0 6px; }
  #__an_namebox .an-nd { font-size:13.5px; color: var(--an-muted); line-height:1.5; margin:0 0 18px; }
  #__an_namebox input { width:100%; border:1.5px solid var(--an-border-strong);
    background: var(--an-surface); color: var(--an-fg); border-radius:11px;
    padding:12px 14px; font:15px var(--an-font); outline:none; margin-bottom:14px; }
  #__an_namebox input:focus { border-color: var(--an-btn-bg); }
  #__an_namebox button { width:100%; background: var(--an-btn-bg); color: var(--an-btn-fg);
    border:none; border-radius:11px; padding:12px; font:600 14px var(--an-font);
    cursor:pointer; transition: filter .15s; }
  #__an_namebox button:hover { filter: brightness(1.15); }
  #__an_namebox .an-nnote { background: var(--an-surface-2);
    border:1px solid var(--an-border); border-radius:11px;
    padding:11px 13px; margin:0 0 16px; font:13.5px/1.5 var(--an-font);
    color: var(--an-fg); overflow-wrap:anywhere; }
  #__an_namebox .an-nnote .an-nlbl { display:block; font-weight:700;
    font-size:11px; letter-spacing:.04em; text-transform:uppercase;
    color: var(--an-muted); margin-bottom:3px; }

  /* ---- share dialog ------------------------------------------------------ */
  #__an_sharewrap { position:fixed; inset:0; z-index:2147483400;
    background:rgba(14,14,22,.45); backdrop-filter:blur(4px);
    display:flex; align-items:center; justify-content:center;
    font-family: var(--an-font); }
  #__an_sharebox { background: var(--an-surface); color: var(--an-fg);
    width:440px; max-width:92vw; border-radius:18px; padding:24px 24px 18px;
    box-shadow: var(--an-shadow-lg); animation: an-pop .22s cubic-bezier(.34,1.56,.64,1);
    max-height:calc(100vh - 32px); overflow-y:auto; }
  #__an_sharebox .an-st { font:700 19px/1.2 var(--an-font); letter-spacing:-.01em; margin:0 0 5px; }
  #__an_sharebox .an-sd { font-size:13.5px; color: var(--an-muted); line-height:1.5; margin:0 0 16px; }
  #__an_sharebox .an-sdest { display:flex; align-items:center; gap:8px;
    background: var(--an-surface-2); border:1px solid var(--an-border);
    border-radius:10px; padding:9px 12px; margin-bottom:18px; font-size:13px;
    word-break:break-all; }
  #__an_sharebox .an-sdest svg { width:15px; height:15px; flex:none; color: var(--an-muted); }
  #__an_sharebox .an-sstep { display:flex; gap:11px; margin-bottom:16px; }
  #__an_sharebox .an-snum { flex:none; width:22px; height:22px; border-radius:50%;
    background: var(--an-btn-bg); color: var(--an-btn-fg); font:700 12px var(--an-font);
    display:flex; align-items:center; justify-content:center; margin-top:1px; }
  #__an_sharebox .an-stext { font-size:13.5px; line-height:1.5; overflow-wrap:anywhere; }
  #__an_sharebox .an-stext b { font-weight:700; }
  #__an_sharebox .an-srow { display:flex; gap:8px; flex-wrap:wrap; margin-top:9px; }
  #__an_sharebox .an-sbtn { display:inline-flex; align-items:center; gap:6px;
    background: var(--an-btn-bg); color: var(--an-btn-fg); border:none;
    border-radius:9px; padding:8px 13px; font:600 13px var(--an-font);
    cursor:pointer; transition: filter .15s; }
  #__an_sharebox .an-sbtn.an-ghost2 { background: var(--an-surface-2);
    color: var(--an-fg); border:1px solid var(--an-border-strong); }
  #__an_sharebox .an-sbtn:hover { filter: brightness(1.12); }
  #__an_sharebox .an-sbtn svg { width:14px; height:14px; }
  #__an_sharebox .an-sclose { width:100%; margin-top:8px; background:none;
    border:none; color: var(--an-muted); font:600 13px var(--an-font);
    cursor:pointer; padding:9px; border-radius:9px; }
  #__an_sharebox .an-sclose:hover { background: var(--an-surface-2); color: var(--an-fg); }

  /* ---- author note banner inside panel ----------------------------------- */
  #__an_note { display:none; gap:9px; align-items:flex-start;
    margin:0 16px 10px; padding:10px 12px; border-radius:11px;
    background: var(--an-surface-2); border:1px solid var(--an-border);
    font:13px/1.45 var(--an-font); color: var(--an-fg);
    overflow-wrap:anywhere; }
  #__an_note.an-show { display:flex; }
  #__an_note svg { width:15px; height:15px; flex:none; color: var(--an-muted); margin-top:1px; }
  #__an_note .an-nlbl { font-weight:700; }

  /* ---- pulsating download cue -------------------------------------------- */
  @keyframes an-pulse {
    0%   { box-shadow:0 0 0 0 rgba(245,158,11,.55); }
    70%  { box-shadow:0 0 0 8px rgba(245,158,11,0); }
    100% { box-shadow:0 0 0 0 rgba(245,158,11,0); }
  }
  .an-pulse { animation: an-pulse 1.8s ease-out infinite;
    border-color:#f59e0b !important; color:#f59e0b !important; }

  /* ---- toasts ------------------------------------------------------------ */
  #__an_toasts { position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
    z-index:2147483500; display:flex; flex-direction:column; align-items:center;
    gap:8px; pointer-events:none; font-family: var(--an-font); }
  .an-toast { pointer-events:auto; display:flex; align-items:center; gap:9px;
    background:#1c1c24; color:#f2f2f6; font:500 13px var(--an-font);
    padding:10px 14px; border-radius:12px; box-shadow: var(--an-shadow-md);
    border:1px solid rgba(255,255,255,.08); max-width:min(440px, 90vw);
    animation: an-toast-in .25s cubic-bezier(.34,1.3,.64,1); }
  .an-toast.an-out { animation: an-toast-out .2s ease forwards; }
  @keyframes an-toast-in { from { transform: translateY(12px) scale(.96); opacity:0 }
    to { transform: translateY(0) scale(1); opacity:1 } }
  @keyframes an-toast-out { to { transform: translateY(8px); opacity:0 } }
  .an-toast .an-ticon { width:17px; height:17px; flex:none; display:flex; }
  .an-toast .an-ticon svg { width:17px; height:17px; }
  .an-toast.an-success .an-ticon { color:#34d399; }
  .an-toast.an-error .an-ticon { color:#fb7185; }
  .an-toast.an-info .an-ticon { color:#a5b4fc; }
  .an-toast .an-taction { background:none; border:none; color:#a5b4fc;
    font:600 12.5px var(--an-font); cursor:pointer; padding:2px 4px; margin-left:2px;
    border-radius:6px; flex:none; }
  .an-toast .an-taction:hover { background:rgba(165,180,252,.14); }

  /* ---- section (+) and margin bubbles ------------------------------------ */
  #__an_plus { position:fixed; z-index:2147483120; width:30px; height:30px;
    border-radius:50%; background: var(--an-surface);
    border:1.5px solid var(--an-border-strong); color: var(--an-muted);
    display:none; align-items:center; justify-content:center; cursor:pointer;
    box-shadow: var(--an-shadow-sm); transition:transform .12s, border-color .12s, color .12s; }
  #__an_plus svg { width:16px; height:16px; display:block; }
  #__an_plus.an-show { display:flex; }
  #__an_plus:hover { transform:scale(1.12); border-color: var(--an-btn-bg); color: var(--an-fg); }
  .an-block-tab { position:absolute; z-index:2147483100; min-width:24px; height:24px;
    padding:0 7px; border-radius:13px; display:flex; align-items:center; gap:5px;
    color:#fff; font:600 12px/1 var(--an-font); cursor:pointer;
    box-shadow: var(--an-shadow-sm); pointer-events:auto;
    transition:transform .12s; }
  .an-block-tab:hover { transform:scale(1.06); }
  .an-block-tab.an-active { outline:3px solid rgba(0,0,0,.14); }
  .an-block-tab svg { width:13px; height:13px; }

  /* ---- off-mode launcher -------------------------------------------------- */
  #__an_launch { position:fixed; bottom:24px; z-index:2147483200;
    display:none; align-items:center; gap:8px; background: var(--an-btn-bg);
    color: var(--an-btn-fg); border:none; border-radius:24px;
    padding:10px 16px 10px 13px; cursor:pointer;
    font:600 13px var(--an-font); box-shadow: var(--an-shadow-md);
    transition:transform .12s, filter .15s; }
  #__an_launch.an-right { right:18px; }
  #__an_launch.an-left { left:18px; }
  #__an_launch.an-show { display:flex; }
  #__an_launch:hover { transform:translateY(-1px); filter: brightness(1.12); }
  #__an_launch svg { width:16px; height:16px; }
  #__an_launch .an-lc { background:#f43f5e; color:#fff; border-radius:9px; min-width:17px;
    height:17px; padding:0 4px; font-size:10px; font-weight:700;
    display:flex; align-items:center; justify-content:center; }

  /* ---- hint pill + shortcuts card ----------------------------------------- */
  body.an-drawing { cursor: crosshair !important; touch-action: none; user-select: none; -webkit-user-select: none; }
  body.an-drawing ::selection { background: transparent; }
  #__an_hint { position:fixed; top:14px; left:50%; transform:translateX(-50%);
    background:#1c1c24; color:#f2f2f6; font:500 13px var(--an-font); padding:8px 16px;
    border-radius:24px; z-index:2147483300; box-shadow: var(--an-shadow-md);
    display:none; align-items:center; gap:8px; pointer-events:none; }
  #__an_hint.an-show { display:flex; }
  #__an_hint kbd { font:600 11px var(--an-font); background:rgba(255,255,255,.14);
    border-radius:5px; padding:1px 6px; }
  #__an_help { position:fixed; bottom:80px; z-index:2147483300;
    background: var(--an-surface); color: var(--an-fg); border:1px solid var(--an-border);
    border-radius:16px; padding:16px 18px; box-shadow: var(--an-shadow-lg);
    font-family: var(--an-font); display:none; min-width:230px;
    animation: an-pop .18s cubic-bezier(.34,1.4,.64,1); }
  #__an_help.an-right { right:80px; }
  #__an_help.an-left { left:80px; }
  #__an_help.an-show { display:block; }
  #__an_help h3 { margin:0 0 10px; font:700 13px var(--an-font); }
  #__an_help .an-krow { display:flex; align-items:center; justify-content:space-between;
    gap:18px; font-size:12.5px; color: var(--an-muted); padding:3.5px 0; }
  #__an_help kbd { font:600 11px var(--an-font); background: var(--an-surface-2);
    border:1px solid var(--an-border-strong); border-bottom-width:2px;
    border-radius:5px; padding:1px 6px; color: var(--an-fg); min-width:20px;
    text-align:center; display:inline-block; }

  @media (max-width: 640px) {
    #__an_panel { top:auto; height:72vh; border-radius:18px 18px 0 0;
      right:0; left:0; bottom:0; width:auto; max-width:none;
      transform: translateY(110%); }
    #__an_panel.an-open { transform: translateY(0); }
    #__an_root.an-popen #__an_bar { display:none; }
    #__an_compose { width: min(304px, calc(100vw - 16px)); }
    .an-btn[data-tip]:hover::after { display:none; }
    #__an_hint { font-size:11px; padding:7px 12px; }
    #__an_bar { padding:6px; gap:4px; }
    .an-btn { width:36px; height:36px; }
    #__an_colorbtn { width:36px; height:36px; }
    #__an_panel .an-list { -webkit-overflow-scrolling: touch; }
    .an-ph { padding:14px 14px 10px; }
  }

  @media (hover: none) and (pointer: coarse) {
    .an-btn[data-tip]:hover::after { display:none; }
    .an-cact { opacity:1; }
  }
  @media (prefers-reduced-motion: reduce) {
    #__an_bar, #__an_panel, #__an_compose, #__an_namebox, #__an_sharebox,
    .an-toast, .an-pin { animation:none !important; transition:none !important; }
    .an-pulse { animation:none !important; }
  }
  `;

  // ==========================================================================
  // ICONS — inline SVG markup, keyed by name (tool icons share the tool's key)
  // ==========================================================================
  var ICONS = {
    cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.5 18 2.2-7.3L20 11.5z"/></svg>',
    highlight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l-6 6v3h3l6-6"/><path d="M22 3l-7 7-4-4 7-7z" transform="translate(-2 2)"/><path d="M12.5 6.5l5 5"/></svg>',
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="9" ry="7.5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c2-1 3.5-2.5 5-5 1.5 2 3 2 4 1s1.5-3 3-3 2 1 3 1"/><path d="M15.5 4.5l4 4L9 19l-5 1 1-5z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9M7 13l5-5 5 5"/><path d="M5 3h14"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="M3 6l9 6 9-6"/></svg>',
  };

  // ==========================================================================
  // TOASTS — non-blocking alerts with optional action (e.g. Undo)
  // ==========================================================================
  var toastWrap;
  function toast(msg, opts) {
    opts = opts || {};
    if (!toastWrap) {
      toastWrap = el("div", { id: "__an_toasts" });
      document.body.appendChild(toastWrap);
    }
    var kind = opts.kind || "info";
    var icon = { success: ICONS.check, error: ICONS.alert, info: ICONS.info }[kind];
    var t = el("div", { class: "an-toast an-" + kind }, [
      el("span", { class: "an-ticon", html: icon }),
      el("span", { text: msg }),
    ]);
    var expired = false, acted = false, timer;
    function close(expire) {
      if (acted || expired) return;
      if (expire) { expired = true; if (opts.onExpire) opts.onExpire(); }
      clearTimeout(timer);
      t.classList.add("an-out");
      setTimeout(function () { t.remove(); }, 220);
    }
    if (opts.action) {
      var btn = el("button", { class: "an-taction", text: opts.action });
      btn.addEventListener("click", function () {
        if (expired) return;
        acted = true;
        clearTimeout(timer);
        t.classList.add("an-out");
        setTimeout(function () { t.remove(); }, 220);
        if (opts.onAction) opts.onAction();
      });
      t.appendChild(btn);
    }
    var dur = opts.duration || 3800;
    timer = setTimeout(function () { close(true); }, dur);
    t.addEventListener("mouseenter", function () { clearTimeout(timer); });
    t.addEventListener("mouseleave", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { close(true); }, 1500);
    });
    toastWrap.appendChild(t);
    while (toastWrap.children.length > 3) toastWrap.firstChild.remove();
    return { dismiss: function () { close(false); } };
  }

  // ==========================================================================
  // TEXT ANCHORING (text-quote: prefix + exact + suffix)
  // ==========================================================================
  function getTextNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isOurs(n.parentNode)) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode.nodeName;
        if (p === "SCRIPT" || p === "STYLE" || p === "NOSCRIPT")
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function quoteFromRange(range) {
    var exact = range.toString();
    if (!exact.trim()) return null;
    var CTX = 48;
    var nodes = getTextNodes();
    var full = "", startGlobal = -1;
    var pos = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node === range.startContainer) startGlobal = pos + range.startOffset;
      full += node.nodeValue;
      pos += node.nodeValue.length;
    }
    if (startGlobal < 0) {
      startGlobal = full.indexOf(exact);
      if (startGlobal < 0) return { exact: exact, prefix: "", suffix: "" };
    }
    var endGlobal = startGlobal + exact.length;
    return {
      exact: exact,
      prefix: full.slice(Math.max(0, startGlobal - CTX), startGlobal),
      suffix: full.slice(endGlobal, endGlobal + CTX),
    };
  }

  function rangeFromQuote(q) {
    var nodes = getTextNodes();
    var full = "", map = [];
    for (var i = 0; i < nodes.length; i++) {
      map.push({ node: nodes[i], start: full.length });
      full += nodes[i].nodeValue;
    }
    var needle = (q.prefix || "") + q.exact + (q.suffix || "");
    var idx = full.indexOf(needle);
    var startOff;
    if (idx >= 0) startOff = idx + (q.prefix || "").length;
    else {
      idx = full.indexOf((q.prefix || "") + q.exact);
      if (idx >= 0) startOff = idx + (q.prefix || "").length;
      else { idx = full.indexOf(q.exact); if (idx < 0) return null; startOff = idx; }
    }
    var endOff = startOff + q.exact.length;
    var sn = locate(map, startOff), en = locate(map, endOff);
    if (!sn || !en) return null;
    var r = document.createRange();
    r.setStart(sn.node, sn.offset);
    r.setEnd(en.node, en.offset);
    return r;
  }
  function locate(map, globalOff) {
    for (var i = map.length - 1; i >= 0; i--) {
      if (globalOff >= map[i].start) {
        return { node: map[i].node, offset: globalOff - map[i].start };
      }
    }
    return null;
  }

  function paintRange(range, color, id) {
    var marks = [];
    var nodes = getTextNodes().filter(function (n) {
      return range.intersectsNode(n);
    });
    nodes.forEach(function (node) {
      var s = node === range.startContainer ? range.startOffset : 0;
      var e = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (e <= s) return;
      var r = document.createRange();
      r.setStart(node, s); r.setEnd(node, e);
      var mark = el("mark", { class: "an-mark", "data-an": id });
      mark.style.background = hexA(color, 0.32);
      mark.style.boxShadow = "inset 0 -0.55em 0 " + hexA(color, 0.18);
      try { r.surroundContents(mark); marks.push(mark); } catch (e2) {}
    });
    return marks;
  }
  function hexA(hex, a) {
    var h = hex.replace("#", "");
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // ==========================================================================
  // OVERLAY (shapes + pen) — rendered in document coordinates
  // ==========================================================================
  var overlay, pinLayer;
  function ensureOverlay() {
    if (overlay) return;
    overlay = svgEl("svg", { id: "__an_overlay" });
    document.body.appendChild(overlay);
    pinLayer = el("div", { id: "__an_pins" });
    pinLayer.style.cssText = "position:absolute;top:0;left:0;z-index:2147483100;pointer-events:none;";
    document.body.appendChild(pinLayer);
    sizeOverlay();
  }
  function sizeOverlay() {
    var w = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    var h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    overlay.setAttribute("width", w);
    overlay.setAttribute("height", h);
    overlay.style.width = w + "px";
    overlay.style.height = h + "px";
  }

  function docBox(elm) {
    var r = elm.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  }

  // ==========================================================================
  // RENDER ALL ANNOTATIONS
  // ==========================================================================
  function clearVisuals() {
    document.querySelectorAll("mark.an-mark").forEach(function (m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    if (overlay) while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    if (pinLayer) pinLayer.innerHTML = "";
  }

  function showResolvedVisuals() { return state.filter !== "open"; }

  function renderAll() {
    ensureOverlay();
    clearVisuals();
    sizeOverlay();
    state.comments.forEach(function (c) {
      if (c.resolved && !showResolvedVisuals()) return;
      if (c.type === "highlight" && c.anchor) {
        var r = rangeFromQuote(c.anchor);
        if (r) {
          var marks = paintRange(r, c.color, c.id);
          marks.forEach(function (m) {
            m.addEventListener("click", function (ev) {
              ev.stopPropagation(); focusComment(c.id, true);
            });
            if (c.id === state.activeId) m.classList.add("an-active");
          });
        }
      } else if (c.geom && (c.type === "shape" || c.type === "pen")) {
        renderGeom(c);
      } else if (c.type === "pin" && c.geom) {
        renderPin(c);
      } else if (c.type === "block" && c.geom) {
        renderBlock(c);
      }
    });
    updateCount();
  }

  function renderBlock(c) {
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : null;
    if (!anchorEl) return;
    var box = docBox(anchorEl);
    var idx = state.comments.indexOf(c) + 1;
    var tab = el("div", { class: "an-block-tab" + (c.id === state.activeId ? " an-active" : "") }, [
      el("span", { html: ICONS.bubble }), el("span", { text: String(idx) }),
    ]);
    tab.style.background = c.color;
    var docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    var rightGap = box.x + box.w + 14;
    if (rightGap > docW - 40) rightGap = box.x + box.w - 30;
    tab.style.left = rightGap + "px";
    tab.style.top = (box.y + 2) + "px";
    tab.title = c.text || "";
    tab.addEventListener("click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    pinLayer.appendChild(tab);
  }

  function renderGeom(c) {
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : document.body;
    if (!anchorEl) anchorEl = document.body;
    var box = docBox(anchorEl);
    var g = c.geom;
    var node;
    if (g.kind === "rect") {
      node = svgEl("rect", {
        x: box.x + g.x * box.w, y: box.y + g.y * box.h,
        width: g.w * box.w, height: g.h * box.h, rx: 6,
        fill: hexA(c.color, 0.08), stroke: c.color, "stroke-width": 2.5,
        class: "an-hit",
      });
    } else if (g.kind === "circle") {
      node = svgEl("ellipse", {
        cx: box.x + (g.x + g.w / 2) * box.w, cy: box.y + (g.y + g.h / 2) * box.h,
        rx: Math.abs(g.w / 2) * box.w, ry: Math.abs(g.h / 2) * box.h,
        fill: hexA(c.color, 0.07), stroke: c.color, "stroke-width": 2.5,
        class: "an-hit",
      });
    } else if (g.kind === "pen") {
      var d = g.points.map(function (p, i) {
        return (i ? "L" : "M") + (box.x + p[0] * box.w).toFixed(1) + " " + (box.y + p[1] * box.h).toFixed(1);
      }).join(" ");
      node = svgEl("path", {
        d: d, fill: "none", stroke: c.color, "stroke-width": 3,
        "stroke-linecap": "round", "stroke-linejoin": "round", class: "an-hit",
      });
    }
    if (!node) return;
    if (c.id === state.activeId) node.setAttribute("stroke-width", 4);
    node.style.cursor = "pointer";
    node.addEventListener("click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    overlay.appendChild(node);
    var fx = g.kind === "pen" ? g.points[0][0] : g.x;
    var fy = g.kind === "pen" ? g.points[0][1] : g.y;
    var bx = box.x + fx * box.w, by = box.y + fy * box.h;
    var idx = state.comments.indexOf(c) + 1;
    var badge = svgEl("g", {});
    var circ = svgEl("circle", { cx: bx, cy: by, r: 11, fill: c.color, stroke: "#fff", "stroke-width": 2 });
    var txt = svgEl("text", { x: bx, y: by + 4, "text-anchor": "middle", fill: "#fff",
      "font-size": "11", "font-weight": "700", "font-family": "Inter, sans-serif" });
    txt.textContent = idx;
    badge.appendChild(circ); badge.appendChild(txt);
    badge.style.cursor = "pointer";
    badge.style.pointerEvents = "all";
    badge.addEventListener("click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    overlay.appendChild(badge);
  }

  function renderPin(c) {
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : document.body;
    if (!anchorEl) anchorEl = document.body;
    var box = docBox(anchorEl);
    var idx = state.comments.indexOf(c) + 1;
    var pin = el("div", { class: "an-pin" + (c.id === state.activeId ? " an-active" : ""), title: c.text || "" },
      [el("span", { text: String(idx) })]);
    pin.style.background = c.color;
    pin.style.left = (box.x + c.geom.x * box.w) + "px";
    pin.style.top = (box.y + c.geom.y * box.h) + "px";
    pin.style.pointerEvents = "auto";
    pin.addEventListener("click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    pinLayer.appendChild(pin);
  }

  // ==========================================================================
  // COMPOSER (new comment popover)
  // ==========================================================================
  var composer, pendingDraft = null, composerShownAt = 0;
  function ensureComposer() {
    if (composer) return;
    composer = el("div", { id: "__an_compose" });
    document.body.appendChild(composer);
    document.addEventListener("pointerdown", function (e) {
      if (performance.now() - composerShownAt < 120) return;
      if (composer.classList.contains("an-show") && !composer.contains(e.target))
        cancelDraft();
    });
  }
  function openComposer(x, y, draft) {
    ensureComposer();
    composerShownAt = performance.now();
    pendingDraft = draft;
    var label = { highlight: "Highlight", shape: draft.geom && draft.geom.kind === "circle" ? "Circle" : "Rectangle", pin: "Pin", pen: "Sketch", block: "Section" }[draft.type] || "Note";
    composer.innerHTML = "";
    composer.appendChild(el("div", { class: "an-ctitle" }, [
      swatchDot(draft.color), document.createTextNode(label + " comment"),
      state.author ? (function () {
        var w = el("span", { style: "margin-left:auto" });
        w.appendChild(avatarEl(state.author, 20));
        return w;
      })() : null,
    ]));
    if (draft.anchor && draft.anchor.exact)
      composer.appendChild(el("div", { class: "an-cquote", text: draft.anchor.exact }));
    var ta = el("textarea", { class: "an-ta", rows: "3", placeholder: "Write your review…" });
    composer.appendChild(ta);
    var save = el("button", { class: "an-primary", text: "Comment" });
    var cancel = el("button", { class: "an-ghost", text: "Cancel" });
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "";
    var isMac = /Mac|iPhone|iPad/i.test(plat);
    composer.appendChild(el("div", { class: "an-cfoot" }, [
      el("span", { class: "an-ckbd", text: (isMac ? "⌘" : "Ctrl") + "↵ to post" }),
      cancel, save,
    ]));
    save.addEventListener("click", function () {
      if (!state.author) { askName(function () { save.click(); }); return; }
      draft.author = state.author;
      draft.text = ta.value.trim();
      commitDraft(draft);
    });
    cancel.addEventListener("click", cancelDraft);
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save.click();
      if (e.key === "Escape") cancelDraft();
      e.stopPropagation();
    });

    var vw = window.innerWidth, vh = window.innerHeight;
    var W = Math.min(304, vw - 16), H = 210;
    var mobile = vw <= 640;
    var px, py;
    if (mobile) {
      px = 8;
      py = Math.max(8, Math.min(y, vh * 0.45));
    } else {
      px = Math.min(Math.max(8, x), vw - W - 8);
      py = Math.min(Math.max(8, y), vh - H - 8);
    }
    composer.style.left = (px + window.scrollX) + "px";
    composer.style.top = (py + window.scrollY) + "px";
    composer.classList.add("an-show");
    setTimeout(function () { ta.focus(); }, 30);
  }
  function askName(onDone) {
    if (document.getElementById("__an_namewrap")) return;
    var wrap = el("div", { id: "__an_namewrap" });
    var input = el("input", { placeholder: "e.g. Jane Doe", value: state.author || "" });
    var btn = el("button", { text: "Start reviewing" });
    var kids = [
      el("h3", { class: "an-nt", text: "Please provide your name" }),
      el("p", { class: "an-nd", text: "Your name appears on every comment so collaborators know who said what. Saved on this device — you won't be asked again." }),
    ];
    // Surface the author's note (data-note) up front so the reviewer knows
    // what to focus on before they start.
    if (state.note) {
      kids.push(el("div", { class: "an-nnote" }, [
        el("span", { class: "an-nlbl", text: "What to review" }),
        el("span", { text: state.note }),
      ]));
    }
    kids.push(input, btn);
    var box = el("div", { id: "__an_namebox" }, kids);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    function done() {
      state.author = input.value.trim() || "Anonymous";
      store.set("an-author", state.author);
      wrap.remove();
      renderNote();
      if (onDone) onDone();
    }
    btn.addEventListener("click", done);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") done(); });
    setTimeout(function () { input.focus(); }, 40);
  }

  function swatchDot(color) {
    var d = el("span");
    d.style.cssText = "width:11px;height:11px;border-radius:50%;display:inline-block;background:" + color;
    return d;
  }
  var tempMarks = [];
  function paintTemp(range, color) {
    tempMarks = paintRange(range, color, "__temp");
  }
  function clearTemp() {
    tempMarks.forEach(function (m) {
      if (!m.parentNode) return;
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    tempMarks = [];
  }
  function cancelDraft() {
    pendingDraft = null;
    clearTemp();
    if (composer) composer.classList.remove("an-show");
    setTool("cursor");
  }
  function commitDraft(draft) {
    var c = createComment(draft);
    composer.classList.remove("an-show");
    clearTemp();
    state.comments.push(c);
    state.activeId = c.id;
    renderAll();
    renderPanel();
    openPanel();
    setTool("cursor");
    pendingDraft = null;
  }

  // ==========================================================================
  // TOOL INTERACTIONS (pointer events — mouse, touch, stylus)
  // ==========================================================================
  var justCancelledDraw = false;
  document.addEventListener("pointerup", function (e) {
    if (!state.enabled) return;
    if (drawing) return;
    if (justCancelledDraw) { justCancelledDraw = false; return; }
    if (state.tool === "pin") return;
    if (composer && composer.classList.contains("an-show")) return;
    if (composer && composer.contains(e.target)) return;
    if (e.target.closest && (e.target.closest("#__an_bar") || e.target.closest("#__an_panel") || e.target.closest("#__an_toasts"))) return;
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      if (isOurs(range.commonAncestorContainer)) return;
      var q = quoteFromRange(range);
      if (!q) return;
      var rect = range.getBoundingClientRect();
      paintTemp(range.cloneRange(), state.color);
      sel.removeAllRanges();
      openComposer(rect.left, rect.bottom + 6, { type: "highlight", color: state.color, anchor: q });
    }, 0);
  });

  var drawing = null;
  function onDown(e) {
    if (!state.enabled) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.closest && (e.target.closest("#__an_bar") || e.target.closest("#__an_panel") || e.target.closest("#__an_compose") || e.target.closest("#__an_toasts")))
      return;
    var t = state.tool;
    if (t === "pin") {
      var anchorEl = pickAnchor(e.target);
      var box = docBox(anchorEl);
      var fx = (e.pageX - box.x) / box.w, fy = (e.pageY - box.y) / box.h;
      openComposer(e.clientX + 6, e.clientY + 6, {
        type: "pin", color: state.color,
        geom: { kind: "pin", selector: cssPath(anchorEl), x: clamp01(fx), y: clamp01(fy) },
      });
      return;
    }
    if (t === "rect" || t === "circle" || t === "pen") {
      e.preventDefault();
      ensureOverlay();
      var anchor = pickAnchor(e.target);
      drawing = {
        tool: t, anchorEl: anchor, box: docBox(anchor),
        startX: e.pageX, startY: e.pageY, points: [[e.pageX, e.pageY]], node: null,
      };
    }
  }
  function onMove(e) {
    if (!drawing) return;
    e.preventDefault();
    var d = drawing;
    if (d.node) overlay.removeChild(d.node);
    if (d.tool === "rect") {
      var x = Math.min(d.startX, e.pageX), y = Math.min(d.startY, e.pageY);
      d.node = svgEl("rect", { x: x, y: y, width: Math.abs(e.pageX - d.startX),
        height: Math.abs(e.pageY - d.startY), rx: 6, fill: hexA(state.color, 0.08),
        stroke: state.color, "stroke-width": 2.5 });
    } else if (d.tool === "circle") {
      var cx = (d.startX + e.pageX) / 2, cy = (d.startY + e.pageY) / 2;
      d.node = svgEl("ellipse", { cx: cx, cy: cy, rx: Math.abs(e.pageX - d.startX) / 2,
        ry: Math.abs(e.pageY - d.startY) / 2, fill: hexA(state.color, 0.07),
        stroke: state.color, "stroke-width": 2.5 });
    } else if (d.tool === "pen") {
      addPenPoint(d, e.pageX, e.pageY);
      var dd = d.points.map(function (p, i) { return (i ? "L" : "M") + p[0] + " " + p[1]; }).join(" ");
      d.node = svgEl("path", { d: dd, fill: "none", stroke: state.color,
        "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" });
    }
    overlay.appendChild(d.node);
  }
  function addPenPoint(d, x, y) {
    var last = d.points[d.points.length - 1];
    if (!last || Math.abs(last[0] - x) > 0.5 || Math.abs(last[1] - y) > 0.5)
      d.points.push([x, y]);
  }
  function onUp(e) {
    if (!drawing) return;
    var d = drawing; drawing = null;
    if (d.node) overlay.removeChild(d.node);
    var box = d.box, geom;
    function clearSel() { try { window.getSelection && window.getSelection().removeAllRanges(); } catch (ex) {} }
    if (d.tool === "pen") {
      addPenPoint(d, e.pageX, e.pageY);
      var dx = e.pageX - d.startX, dy = e.pageY - d.startY;
      if (d.points.length < 2 || Math.sqrt(dx * dx + dy * dy) < 6) {
        clearSel(); justCancelledDraw = true; return setTool("cursor");
      }
      geom = { kind: "pen", selector: cssPath(d.anchorEl),
        points: d.points.map(function (p) { return [(p[0] - box.x) / box.w, (p[1] - box.y) / box.h]; }) };
    } else {
      var x0 = Math.min(d.startX, e.pageX), y0 = Math.min(d.startY, e.pageY);
      var w = Math.abs(e.pageX - d.startX), h = Math.abs(e.pageY - d.startY);
      if (w < 6 && h < 6) { clearSel(); justCancelledDraw = true; return setTool("cursor"); }
      geom = { kind: d.tool === "circle" ? "circle" : "rect", selector: cssPath(d.anchorEl),
        x: (x0 - box.x) / box.w, y: (y0 - box.y) / box.h, w: w / box.w, h: h / box.h };
    }
    openComposer(e.clientX + 6, e.clientY + 6, { type: d.tool === "pen" ? "pen" : "shape", color: state.color, geom: geom });
  }
  function pickAnchor(target) {
    var n = target;
    while (n && n !== document.body) {
      if (n.id || (n.classList && (n.classList.contains("container") || n.classList.contains("svg-figure") || n.nodeName === "SECTION"))) {
        var r = n.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) return n;
      }
      n = n.parentElement;
    }
    return document.body;
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerup", onUp, true);

  // ==========================================================================
  // TOOLBAR + PANEL UI
  // ==========================================================================
  var bar, panel, listEl, footEl, countBadge, hintEl, launchEl, helpEl, noteEl;
  var SIDE = CFG.position === "bottom-left" ? "an-left" : "an-right";
  function buildUI() {
    var style = el("style", { html: CSS_TEXT });
    document.head.appendChild(style);
    applyTheme();
    if (CFG.accent) {
      document.documentElement.style.setProperty("--an-btn-bg", CFG.accent);
      document.documentElement.style.setProperty("--an-btn-fg", "#fff");
    }

    var root = el("div", { id: "__an_root" });
    document.body.appendChild(root);

    bar = el("div", { id: "__an_bar", class: SIDE });
    var tools = [
      ["cursor", "Browse", "V"], ["highlight", "Highlight text", "H"],
      ["rect", "Rectangle", "R"], ["circle", "Circle", "C"],
      ["pen", "Freehand", "D"], ["pin", "Pin", "P"],
    ];
    tools.forEach(function (t) {
      var tip = t[1] + "  ·  " + t[2];
      var b = el("button", {
        class: "an-btn", "data-tool": t[0], "data-tip": tip,
        title: tip, "aria-label": t[1], html: ICONS[t[0]]
      });
      b.addEventListener("click", function () { setTool(t[0]); });
      bar.appendChild(b);
    });
    bar.appendChild(el("div", { class: "an-sep" }));

    var colorBtn = el("button", { id: "__an_colorbtn", "data-tip": "Color", title: "Color", "aria-label": "Color" });
    var colorDot = el("span", { class: "an-swdot" });
    colorDot.style.background = state.color;
    colorBtn.appendChild(colorDot);
    var colorPop = el("div", { id: "__an_colorpop" });
    COLORS.forEach(function (c) {
      var sw = el("div", { class: "an-sw" + (c.hex === state.color ? " an-on" : ""), "data-c": c.hex, title: c.name });
      sw.style.background = c.hex;
      sw.addEventListener("click", function (e) {
        e.stopPropagation();
        state.color = c.hex;
        store.set("an-color", c.hex);
        colorDot.style.background = c.hex;
        colorPop.querySelectorAll(".an-sw").forEach(function (x) { x.classList.toggle("an-on", x.getAttribute("data-c") === c.hex); });
        colorPop.classList.remove("an-show");
      });
      colorPop.appendChild(sw);
    });
    colorBtn.appendChild(colorPop);
    colorBtn.addEventListener("click", function (e) { e.stopPropagation(); colorPop.classList.toggle("an-show"); });
    document.addEventListener("click", function () { colorPop.classList.remove("an-show"); });
    bar.appendChild(colorBtn);
    bar.appendChild(el("div", { class: "an-sep" }));

    var listBtn = el("button", { class: "an-btn", "data-tip": "Comments  ·  A", title: "Comments  ·  A", "aria-label": "Comments", html: ICONS.list });
    countBadge = el("span", { class: "an-count" }); countBadge.style.display = "none";
    listBtn.appendChild(countBadge);
    listBtn.addEventListener("click", togglePanel);
    bar.appendChild(listBtn);

    var offBtn = el("button", { class: "an-btn", "data-tip": "Hide review tools  ·  O", title: "Hide review tools  ·  O", "aria-label": "Hide review tools", html: ICONS.hide });
    offBtn.addEventListener("click", function () { setEnabled(false); });
    bar.appendChild(offBtn);
    root.appendChild(bar);

    launchEl = el("button", { id: "__an_launch", class: SIDE, html: ICONS.bubble + "<span>Review</span>" });
    launchEl.addEventListener("click", function () {
      if (!state.author) askName(function () { setEnabled(true); });
      else setEnabled(true);
    });
    document.body.appendChild(launchEl);

    hintEl = el("div", { id: "__an_hint" });
    root.appendChild(hintEl);

    helpEl = el("div", { id: "__an_help", class: SIDE }, [
      el("h3", { text: "Keyboard shortcuts" }),
    ]);
    [["V", "Browse"], ["H", "Highlight"], ["R", "Rectangle"], ["C", "Circle"],
     ["D", "Freehand"], ["P", "Pin"], ["A", "Comments panel"], ["O", "Show / hide tools"],
     ["Esc", "Cancel"], ["?", "This card"]].forEach(function (row) {
      helpEl.appendChild(el("div", { class: "an-krow" }, [
        el("span", { text: row[1] }), el("kbd", { text: row[0] }),
      ]));
    });
    root.appendChild(helpEl);

    panel = el("div", { id: "__an_panel" });
    var header = el("div", { class: "an-ph" }, [
      el("h2", { text: "Comments" }),
      el("span", { class: "an-pcount", id: "__an_sub", text: "0" }),
      el("button", { class: "an-hbtn", html: ICONS.upload, title: "Import comments from a JSON file", "aria-label": "Import comments from a JSON file", onclick: function (e) { e.stopPropagation(); pickImportFile(); } }),
      el("button", { class: "an-hbtn", html: ICONS.download, title: "Download comments as JSON", "aria-label": "Download comments as JSON", onclick: function (e) { e.stopPropagation(); exportComments(); } }),
      el("button", { class: "an-x", html: "&times;", "aria-label": "Close comments panel", onclick: closePanel }),
    ]);
    var search = el("div", { class: "an-search" }, [
      (function () { var s = el("span", { html: ICONS.search }); return s.firstChild; })(),
    ]);
    var searchInput = el("input", { placeholder: "Search comments…" });
    searchInput.addEventListener("input", function () {
      state.query = searchInput.value.toLowerCase();
      renderPanel();
    });
    search.appendChild(searchInput);
    var filters = el("div", { class: "an-filters" });
    [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].forEach(function (f) {
      var ch = el("span", { class: "an-chip" + (state.filter === f[0] ? " an-on" : ""), "data-f": f[0], text: f[1] });
      ch.addEventListener("click", function () {
        state.filter = f[0];
        filters.querySelectorAll(".an-chip").forEach(function (x) {
          x.classList.toggle("an-on", x.getAttribute("data-f") === f[0]);
        });
        renderAll(); renderPanel();
      });
      filters.appendChild(ch);
    });
    var toolsRow = el("div", { class: "an-toolsrow" }, [search, filters]);
    noteEl = el("div", { id: "__an_note" });
    listEl = el("div", { class: "an-list", id: "__an_list" });
    footEl = el("div", { id: "__an_foot" });
    panel.appendChild(header);
    panel.appendChild(toolsRow);
    panel.appendChild(noteEl);
    panel.appendChild(listEl);
    panel.appendChild(footEl);
    root.appendChild(panel);

    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.nodeName)) return;
      if (e.target && e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "o") { setEnabled(!state.enabled); return; }
      if (!state.enabled) return;
      var map = { v: "cursor", h: "highlight", r: "rect", c: "circle", d: "pen", p: "pin" };
      if (map[e.key]) { setTool(map[e.key]); }
      else if (e.key === "a") togglePanel();
      else if (e.key === "?") helpEl.classList.toggle("an-show");
      else if (e.key === "Escape") {
        if (helpEl.classList.contains("an-show")) { helpEl.classList.remove("an-show"); return; }
        setTool("cursor"); cancelDraft();
      }
    });

    var rt;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(renderAll, 150); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(renderAll, 60); });
    window.addEventListener("load", function () { setTimeout(renderAll, 120); });
  }

  function applyTheme() {
    var dark;
    if (CFG.theme === "dark") dark = true;
    else if (CFG.theme === "light") dark = false;
    else {
      var lum = bgLuminance();
      if (lum != null) dark = lum < 0.45;
      else dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    document.documentElement.classList.toggle("an-dark", !!dark);
  }
  function bgLuminance() {
    var n = document.body;
    while (n) {
      var bg = getComputedStyle(n).backgroundColor;
      var m = bg && bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
        return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      }
      n = n === document.body ? document.documentElement : null;
    }
    return null;
  }

  var plusBtn, plusTarget = null, plusHideTimer = null;
  var BLOCK_SEL = CFG.blocks ||
    "h1,h2,h3,h4,p,li,blockquote,pre,figure,.section-title,.section-deck,.hero-title,.pullquote,.fact-text";
  function eligibleBlock(node) {
    while (node && node.nodeType === 1) {
      if (node.id && String(node.id).indexOf("__an") === 0) return null;
      if (node.closest && (node.closest("#__an_bar") || node.closest("#__an_panel") || node.closest("#__an_compose"))) return null;
      if (node.matches && node.matches(BLOCK_SEL)) {
        var r = node.getBoundingClientRect();
        if (r.width > 60 && r.height > 14) return node;
      }
      node = node.parentElement;
    }
    return null;
  }
  function setupBlockPlus() {
    plusBtn = el("div", { id: "__an_plus", title: "Comment on this section",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>' });
    document.body.appendChild(plusBtn);
    plusBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!plusTarget) return;
      var r = plusTarget.getBoundingClientRect();
      openComposer(r.left, r.bottom + 6, {
        type: "block", color: state.color,
        geom: { kind: "block", selector: cssPath(plusTarget) },
      });
      hidePlus(true);
    });
    plusBtn.addEventListener("mouseenter", function () { clearTimeout(plusHideTimer); });
    plusBtn.addEventListener("mouseleave", function () { hidePlus(); });

    document.addEventListener("mouseover", function (e) {
      if (!state.enabled) return;
      if (state.tool !== "cursor" && state.tool !== "highlight") return;
      if (drawing) return;
      var blk = eligibleBlock(e.target);
      if (blk && blk !== plusTarget) { plusTarget = blk; positionPlus(blk); }
    });
    document.addEventListener("mousemove", function (e) {
      if (!plusTarget) return;
      if (state.tool !== "cursor" && state.tool !== "highlight") { hidePlus(true); return; }
      if (inKeepZone(e.clientX, e.clientY)) {
        clearTimeout(plusHideTimer);
        plusBtn.classList.add("an-show");
      } else {
        hidePlus();
      }
    });
    // Touch: long-press any eligible block to reveal the + button
    var touchHoldTimer = null, touchHoldTarget = null;
    document.addEventListener("touchstart", function (e) {
      if (!state.enabled) return;
      if (state.tool !== "cursor" && state.tool !== "highlight") return;
      touchHoldTarget = eligibleBlock(e.target);
      if (!touchHoldTarget) return;
      touchHoldTimer = setTimeout(function () {
        if (!touchHoldTarget) return;
        plusTarget = touchHoldTarget;
        positionPlus(touchHoldTarget);
        plusBtn.classList.add("an-show");
      }, 500);
    }, { passive: true });
    document.addEventListener("touchend", function () { clearTimeout(touchHoldTimer); touchHoldTarget = null; }, { passive: true });
    document.addEventListener("touchmove", function () { clearTimeout(touchHoldTimer); touchHoldTarget = null; }, { passive: true });
    window.addEventListener("scroll", function () { if (plusTarget) positionPlus(plusTarget); }, { passive: true });
  }
  function inKeepZone(x, y) {
    if (!plusTarget) return false;
    var pr = plusBtn.getBoundingClientRect();
    var tr = plusTarget.getBoundingClientRect();
    var pad = 18;
    if (x >= tr.left - pad && x <= tr.right + pad && y >= tr.top - pad && y <= tr.bottom + pad) return true;
    if (x >= pr.left - pad && x <= pr.right + pad && y >= pr.top - pad && y <= pr.bottom + pad) return true;
    if (x >= pr.left - pad && x <= tr.left + pad && y >= pr.top - pad && y <= pr.bottom + pad) return true;
    return false;
  }
  function positionPlus(blk) {
    var r = blk.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { hidePlus(true); return; }
    var cs = getComputedStyle(blk);
    var lh = parseFloat(cs.lineHeight);
    if (!lh || isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.3;
    var padTop = parseFloat(cs.paddingTop) || 0;
    var firstLineMid = r.top + padTop + lh / 2;
    var top = firstLineMid - 15;
    var left = r.left - 40;
    if (left < 6) left = r.left + 6;
    plusBtn.style.left = left + "px";
    plusBtn.style.top = top + "px";
    clearTimeout(plusHideTimer);
    plusBtn.classList.add("an-show");
  }
  function hidePlus(now) {
    clearTimeout(plusHideTimer);
    if (now) { plusBtn.classList.remove("an-show"); plusTarget = null; return; }
    plusHideTimer = setTimeout(function () { plusBtn.classList.remove("an-show"); plusTarget = null; }, 600);
  }

  function setEnabled(on) {
    state.enabled = on;
    store.set("an-off", on ? "0" : "1");
    var root = document.getElementById("__an_root");
    if (on) {
      if (root) root.style.display = "";
      if (overlay) overlay.style.display = "";
      if (pinLayer) pinLayer.style.display = "";
      if (launchEl) launchEl.classList.remove("an-show");
      renderAll();
      renderPanel();
    } else {
      setTool("cursor");
      cancelDraft();
      closePanel();
      hidePlus(true);
      if (helpEl) helpEl.classList.remove("an-show");
      clearVisuals();
      if (overlay) overlay.style.display = "none";
      if (pinLayer) pinLayer.style.display = "none";
      if (root) root.style.display = "none";
      if (launchEl) {
        var n = state.comments.filter(function (c) { return !c.resolved; }).length;
        launchEl.querySelector("span").textContent = n ? "Review (" + n + ")" : "Review";
        launchEl.classList.add("an-show");
      }
    }
  }

  function setTool(t) {
    state.tool = t;
    bar.querySelectorAll(".an-btn[data-tool]").forEach(function (b) {
      b.classList.toggle("an-on", b.getAttribute("data-tool") === t);
    });
    var drawingTool = t === "rect" || t === "circle" || t === "pen" || t === "pin";
    document.body.classList.toggle("an-drawing", drawingTool);
    var hints = { highlight: "Select any text to highlight & comment",
      rect: "Drag to draw a rectangle", circle: "Drag to draw a circle",
      pen: "Draw freehand — release to comment", pin: "Click anywhere to drop a pin" };
    if (hints[t]) showHint(hints[t]); else hideHint();
  }
  function showHint(txt) {
    hintEl.innerHTML = "";
    hintEl.appendChild(document.createTextNode(txt + " "));
    hintEl.appendChild(el("kbd", { text: "Esc" }));
    hintEl.appendChild(document.createTextNode(" to cancel"));
    hintEl.classList.add("an-show");
  }
  function hideHint() { hintEl.classList.remove("an-show"); }

  function togglePanel() { state.panelOpen ? closePanel() : openPanel(); }
  function openPanel() {
    state.panelOpen = true;
    panel.classList.add("an-open");
    var root = document.getElementById("__an_root");
    if (root) root.classList.add("an-popen");
    renderNote();
    renderPanel();
    setupPanelSwipe();
  }
  function closePanel() {
    state.panelOpen = false;
    panel.classList.remove("an-open");
    var root = document.getElementById("__an_root");
    if (root) root.classList.remove("an-popen");
  }

  var panelSwipeSetup = false;
  function setupPanelSwipe() {
    if (panelSwipeSetup || !panel) return;
    panelSwipeSetup = true;
    var startY = 0, startScrollTop = 0, dragging = false;
    panel.addEventListener("touchstart", function (e) {
      if (window.innerWidth > 640) return;
      startY = e.touches[0].clientY;
      startScrollTop = listEl ? listEl.scrollTop : 0;
      dragging = false;
    }, { passive: true });
    panel.addEventListener("touchmove", function (e) {
      if (window.innerWidth > 640) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 0 && startScrollTop <= 0) { dragging = true; }
    }, { passive: true });
    panel.addEventListener("touchend", function (e) {
      if (!dragging || window.innerWidth > 640) return;
      var dy = e.changedTouches[0].clientY - startY;
      if (dy > 80) closePanel();
      dragging = false;
    }, { passive: true });
  }

  function updateCount() {
    var n = state.comments.filter(function (c) { return !c.resolved; }).length;
    if (countBadge) { countBadge.textContent = n; countBadge.style.display = n ? "flex" : "none"; }
    var sub = document.getElementById("__an_sub");
    if (sub) sub.textContent = String(state.comments.length);
  }

  var TYPE_LABEL = { highlight: "Highlight", shape: "Shape", pin: "Pin", pen: "Sketch", note: "Note", block: "Section" };
  function visibleComments() {
    return state.comments.filter(function (c) {
      if (state.filter === "open" && c.resolved) return false;
      if (state.filter === "resolved" && !c.resolved) return false;
      if (state.query) {
        var hay = ((c.text || "") + " " + (c.author || "") + " " +
          (c.anchor && c.anchor.exact ? c.anchor.exact : "") + " " +
          (c.replies || []).map(function (r) { return r.text + " " + r.author; }).join(" ")
        ).toLowerCase();
        if (hay.indexOf(state.query) < 0) return false;
      }
      return true;
    });
  }
  function renderPanel() {
    if (!listEl) return;
    listEl.innerHTML = "";
    var list = visibleComments();
    if (!list.length) {
      var msg = state.query
        ? "No comments match “" + esc(state.query) + "”."
        : state.filter === "resolved"
          ? "Nothing resolved yet."
          : "No comments yet.<br>Select any text, or pick a tool from the toolbar — try <kbd>H</kbd> highlight or <kbd>P</kbd> pin.";
      listEl.appendChild(el("div", { class: "an-empty" }, [
        el("div", { class: "an-eicon", html: ICONS.bubble }),
        el("div", { html: msg }),
      ]));
      updateCount();
      renderFooter();
      return;
    }
    list.forEach(function (c) {
      var idx = state.comments.indexOf(c) + 1;
      var card = el("div", { class: "an-card" + (c.id === state.activeId ? " an-active" : "") + (c.resolved ? " an-resolved" : ""), "data-id": c.id });
      var meta = el("div", { class: "an-cmeta" }, [
        avatarEl(c.author),
        el("span", { class: "an-author", text: c.author || "Anonymous" }),
        el("span", { class: "an-tag" }, [
          (function(){ var d = el("span",{class:"an-dot"}); d.style.background=c.color; return d; })(),
          document.createTextNode("#" + idx + " " + (TYPE_LABEL[c.type] || c.type)),
        ]),
        c.resolved ? el("span", { class: "an-rbadge", html: ICONS.check + "<span>Resolved</span>" }) : null,
        el("span", { class: "an-when", text: fmtTime(c.createdAt) }),
      ]);
      card.appendChild(meta);
      if (c.type === "highlight" && c.anchor && c.anchor.exact)
        card.appendChild(el("div", { class: "an-quote", text: '“' + c.anchor.exact + '”' }));
      var bodyEl = el("div", { class: "an-body", text: c.text || "" });
      if (c.text) card.appendChild(bodyEl);

      if (c.replies && c.replies.length) {
        var rep = el("div", { class: "an-replies" });
        c.replies.forEach(function (r) {
          rep.appendChild(el("div", { class: "an-reply" }, [
            avatarEl(r.author, 18),
            el("span", {}, [
              el("span", { class: "an-rwho", text: r.author }),
              document.createTextNode(r.text),
              el("span", { class: "an-rwhen", text: fmtTime(r.createdAt) }),
            ]),
          ]));
        });
        card.appendChild(rep);
      }

      var rbox = el("div", { class: "an-replybox" });
      var rin = el("input", { class: "an-input", placeholder: "Reply…" });
      rbox.appendChild(rin);
      rin.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter" && rin.value.trim()) {
          var reply = { id: uid(), author: state.author || "Anonymous", text: rin.value.trim(), createdAt: new Date().toISOString() };
          var updated = patchComment(c.id, { reply: reply });
          if (updated) { mergeComment(updated); renderPanel(); }
        }
      });
      card.appendChild(rbox);

      var ebox = el("div", { class: "an-editbox" });
      var eta = el("textarea", { class: "an-ta", rows: "2" });
      var esave = el("button", { class: "an-primary", text: "Save" });
      ebox.appendChild(eta);
      ebox.appendChild(el("div", { style: "display:flex;justify-content:flex-end" }, [esave]));
      eta.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") esave.click();
      });
      esave.addEventListener("click", function (e) {
        e.stopPropagation();
        var updated = patchComment(c.id, { text: eta.value.trim() });
        if (updated) { mergeComment(updated); renderPanel(); }
      });
      card.appendChild(ebox);

      var act = el("div", { class: "an-cact" }, [
        el("button", { class: "an-mini", html: ICONS.reply + "<span>Reply</span>", onclick: function (e) {
          e.stopPropagation(); rbox.classList.toggle("an-show"); rin.focus();
        } }),
        el("button", { class: "an-mini", html: (c.resolved ? "" : ICONS.check) + "<span>" + (c.resolved ? "Reopen" : "Resolve") + "</span>", onclick: function (e) {
          e.stopPropagation();
          var updated = patchComment(c.id, { resolved: !c.resolved });
          if (updated) { mergeComment(updated); renderAll(); renderPanel(); }
        } }),
        c.author === state.author ? el("button", { class: "an-mini", html: ICONS.edit + "<span>Edit</span>", onclick: function (e) {
          e.stopPropagation();
          eta.value = c.text || "";
          ebox.classList.toggle("an-show");
          eta.focus();
        } }) : null,
        el("button", { class: "an-mini", html: ICONS.link, title: "Copy link to this comment", onclick: function (e) {
          e.stopPropagation(); copyLink(c.id);
        } }),
        el("button", { class: "an-mini an-danger", html: ICONS.trash, title: "Delete", onclick: function (e) {
          e.stopPropagation(); deleteComment(c);
        } }),
      ]);
      card.appendChild(act);

      card.addEventListener("click", function () { focusComment(c.id, false); });
      listEl.appendChild(card);
    });
    updateCount();
    renderFooter();
  }

  // --------------------------------------------------------------------------
  // EXPORT / IMPORT — share a page's review as a portable JSON file
  // --------------------------------------------------------------------------
  function downloadJSON(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportComments() {
    var comments = state.comments.slice();
    if (!comments.length) {
      toast("No comments on this page to export", { kind: "info" });
      return;
    }
    var payload = {
      annotate: VERSION,
      kind: "annotate-export",
      exportedAt: new Date().toISOString(),
      page: PAGE,
      url: location.href,
      project: CFG.project || "",
      comments: comments,
    };
    var slug = (PAGE || "page").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
    var stamp = new Date().toISOString().slice(0, 10);
    downloadJSON(payload, "annotate-" + slug + "-" + stamp + ".json");
    toast("Exported " + comments.length + " comment" + (comments.length === 1 ? "" : "s"), { kind: "success" });
  }

  function pickImportFile() {
    var inp = el("input", { type: "file", accept: "application/json,.json" });
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(reader.result); }
        catch (e) { toast("That file isn’t valid JSON", { kind: "error" }); return; }
        importComments(data);
      };
      reader.onerror = function () { toast("Couldn’t read that file", { kind: "error" }); };
      reader.readAsText(f);
    });
    inp.click();
  }

  function importComments(data) {
    var incoming = data && Array.isArray(data.comments) ? data.comments : null;
    if (!incoming) { toast("No comments found in that file", { kind: "error" }); return; }
    var existing = {};
    state.comments.forEach(function (c) { existing[c.id] = true; });
    var prepared = [];
    incoming.forEach(function (c) {
      if (!c || !c.text && !c.anchor && !c.geom) return;
      var copy = JSON.parse(JSON.stringify(c));
      copy.page = PAGE;
      if (!copy.id || existing[copy.id]) copy.id = uid();
      if (!Array.isArray(copy.replies)) copy.replies = [];
      prepared.push(copy);
    });
    if (!prepared.length) { toast("Nothing new to import", { kind: "info" }); return; }
    var d = dbRead();
    d.comments = d.comments.concat(prepared);
    dbWrite(d);
    load();
    toast("Imported " + prepared.length + " comment" + (prepared.length === 1 ? "" : "s"), { kind: "success" });
  }

  function copyLink(id) {
    var link = location.origin + location.pathname + location.search + "#an=" + id;
    function ok() { toast("Link copied to clipboard", { kind: "success" }); }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(link).then(ok, function () { prompt("Copy link:", link); });
    else prompt("Copy link:", link);
  }

  // delete with undo — remove locally now, persist when the toast expires
  var pendingDeletes = {};
  function deleteComment(c) {
    var idx = state.comments.indexOf(c);
    state.comments = state.comments.filter(function (x) { return x.id !== c.id; });
    if (state.activeId === c.id) state.activeId = null;
    pendingDeletes[c.id] = c;
    renderAll(); renderPanel();
    toast("Comment deleted", {
      kind: "info", action: "Undo", duration: 5000,
      onAction: function () {
        delete pendingDeletes[c.id];
        state.comments.splice(Math.min(idx, state.comments.length), 0, c);
        renderAll(); renderPanel();
      },
      onExpire: function () {
        delete pendingDeletes[c.id];
        removeComment(c.id);
      },
    });
  }

  function renderNote() {
    if (!noteEl) return;
    if (state.note) {
      noteEl.innerHTML = "";
      noteEl.appendChild(el("span", { html: ICONS.info }).firstChild);
      noteEl.appendChild(el("span", {}, [
        el("span", { class: "an-nlbl", text: "What to review: " }),
        document.createTextNode(state.note),
      ]));
      noteEl.classList.add("an-show");
    } else {
      noteEl.classList.remove("an-show");
    }
  }

  function renderFooter() {
    if (!footEl) return;
    var n = state.comments.length;
    var canShare = !!(state.share && state.share.trim());
    footEl.innerHTML = "";
    footEl.appendChild(el("div", { class: "an-localnote" }, [
      el("span", { html: ICONS.info }),
      el("span", { text: canShare
        ? "Saved in this browser. Download or share to send your comments."
        : "Saved in this browser. Download to send your comments." }),
    ]));
    footEl.appendChild(el("div", { class: "an-footrow" }, [
      el("button", { class: "an-fbtn" + (n ? " an-pulse" : ""), title: "Download comments as JSON", html: ICONS.download + "<span>Download</span>", onclick: exportComments }),
      canShare ? el("button", { class: "an-fbtn", title: "Send comments to " + state.share, html: ICONS.share + "<span>Share</span>", onclick: shareComments }) : null,
      el("button", { class: "an-fbtn", html: ICONS.upload + "<span>Import</span>", onclick: pickImportFile }),
    ]));
  }

  // Copy text to the clipboard with graceful fallback + toast feedback.
  function copyText(text, okMsg) {
    function ok() { toast(okMsg || "Copied to clipboard", { kind: "success" }); }
    function fail() { window.prompt("Copy this:", text); }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text).then(ok, fail);
    else fail();
  }
  function clipText(text, max) {
    var s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  function safeHttpUrl(url) {
    try {
      var u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.href : "";
    } catch (e) {
      return "";
    }
  }

  // Build the plain-text review summary used in emails / chat messages.
  function shareSummary(comments) {
    var visible = comments.slice(0, 25);
    var lines = visible.map(function (c, i) {
      var who = c.author || "Anonymous";
      var what = clipText(c.text, 280) || "(no text)";
      return (i + 1) + ". [" + (TYPE_LABEL[c.type] || c.type) + "] " + who + ": " + what;
    }).join("\n");
    if (comments.length > visible.length)
      lines += "\n… and " + (comments.length - visible.length) + " more comment" + (comments.length - visible.length === 1 ? "" : "s") + " in the JSON file.";
    return {
      subject: "Review comments — " + (CFG.project || PAGE),
      body: "Review of " + location.href + "\n\n" + lines +
        "\n\n(" + comments.length + " comment" + (comments.length === 1 ? "" : "s") +
        ". The full JSON file keeps positions & replies — attach it.)",
    };
  }

  function closeShareDialog() {
    var w = document.getElementById("__an_sharewrap");
    if (w) w.remove();
  }

  // Show a guided dialog rather than blindly firing a mailto: that may not
  // resolve to a mail client. Walks the reviewer through the exact steps.
  function shareComments() {
    var comments = state.comments.slice();
    if (!comments.length) { toast("No comments to share yet", { kind: "info" }); return; }
    var dest = (state.share || "").trim();
    if (!dest) {
      toast("No share destination set by the author — use Download instead", { kind: "info" });
      return;
    }
    if (document.getElementById("__an_sharewrap")) return;

    var isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest);
    var sum = shareSummary(comments);
    var fileSlug = (PAGE || "page").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";

    function step(num, textNode, buttons) {
      return el("div", { class: "an-sstep" }, [
        el("div", { class: "an-snum", text: String(num) }),
        el("div", { class: "an-stext" }, [textNode, el("div", { class: "an-srow" }, buttons)]),
      ]);
    }
    function btn(label, icon, ghost, onclick) {
      return el("button", { class: "an-sbtn" + (ghost ? " an-ghost2" : ""), html: icon + "<span>" + esc(label) + "</span>", onclick: onclick });
    }

    var dlButton = btn("Download JSON", ICONS.download, false, function () { exportComments(); });

    var step2;
    if (isEmail) {
      step2 = step(2, el("span", {}, [
        document.createTextNode("Email the comments to "),
        el("b", { text: dest }),
        document.createTextNode(". Open your mail app below (or copy the details), then "),
        el("b", { text: "attach the file from step 1" }),
        document.createTextNode("."),
      ]), [
        btn("Open email", ICONS.mail, false, function () {
          window.location.href = "mailto:" + encodeURIComponent(dest) +
            "?subject=" + encodeURIComponent(sum.subject) +
            "&body=" + encodeURIComponent(sum.body);
        }),
        btn("Copy address", ICONS.copy, true, function () { copyText(dest, "Email address copied"); }),
        btn("Copy summary", ICONS.copy, true, function () { copyText(sum.subject + "\n\n" + sum.body, "Summary copied"); }),
      ]);
    } else {
      var channelUrl = safeHttpUrl(dest);
      step2 = step(2, el("span", {}, [
        document.createTextNode("Post the comments to your channel. Open it below, paste the copied summary, and "),
        el("b", { text: "attach the file from step 1" }),
        document.createTextNode("."),
      ]), [
        channelUrl ? btn("Open channel", ICONS.share, false, function () { window.open(channelUrl, "_blank", "noopener"); }) : null,
        channelUrl ? null : btn("Copy destination", ICONS.copy, true, function () { copyText(dest, "Destination copied"); }),
        btn("Copy summary", ICONS.copy, true, function () { copyText(sum.subject + "\n\n" + sum.body, "Summary copied"); }),
      ]);
    }

    var box = el("div", { id: "__an_sharebox" }, [
      el("h3", { class: "an-st", text: "Share your review" }),
      el("p", { class: "an-sd", text: "Comments live only in this browser. Send them in two steps — they’re not uploaded anywhere automatically." }),
      el("div", { class: "an-sdest" }, [
        el("span", { html: isEmail ? ICONS.mail : ICONS.share }).firstChild,
        el("span", {}, [el("b", { text: isEmail ? "Email to: " : "Channel: " }), document.createTextNode(dest)]),
      ]),
      step(1, el("span", {}, [
        document.createTextNode("Download the comments file "),
        el("b", { text: "(annotate-" + fileSlug + "-….json)" }),
        document.createTextNode("."),
      ]), [dlButton]),
      step2,
      el("button", { class: "an-sclose", text: "Done", onclick: closeShareDialog }),
    ]);

    var wrap = el("div", { id: "__an_sharewrap" }, [box]);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeShareDialog(); });
    document.body.appendChild(wrap);
  }

  function mergeComment(updated) {
    var i = state.comments.findIndex(function (x) { return x.id === updated.id; });
    if (i >= 0) state.comments[i] = updated; else state.comments.push(updated);
  }

  function focusComment(id, scrollToContent) {
    state.activeId = id;
    renderAll();
    renderPanel();
    if (!state.panelOpen) openPanel();
    var c = state.comments.find(function (x) { return x.id === id; });
    if (!c) return;
    if (scrollToContent) {
      var card = listEl.querySelector('[data-id="' + id + '"]');
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      var targetY = null;
      if (c.type === "highlight" && c.anchor) {
        var m = document.querySelector('mark[data-an="' + id + '"]');
        if (m) targetY = m.getBoundingClientRect().top + window.scrollY - 120;
      } else if (c.geom) {
        var ae = c.geom.selector ? resolveAnchorEl(c.geom.selector) : document.body;
        if (ae) {
          var box = docBox(ae);
          var fy = c.geom.y != null ? c.geom.y : (c.geom.points ? c.geom.points[0][1] : 0.2);
          targetY = box.y + fy * box.h - 160;
        }
      }
      if (targetY != null) window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
    }
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================
  var firstLoad = true;
  function load() {
    if (pendingDraft || drawing) return;
    state.comments = pageComments().filter(function (c) { return !pendingDeletes[c.id]; });
    renderAll();
    renderPanel();
    if (firstLoad) {
      firstLoad = false;
      var m = location.hash.match(/^#an=(.+)$/);
      if (m) {
        var target = decodeURIComponent(m[1]);
        if (state.comments.some(function (c) { return c.id === target; }))
          setTimeout(function () { focusComment(target, false); }, 150);
      }
    }
  }

  function boot() {
    buildUI();
    ensureOverlay();
    setupBlockPlus();
    setTool("cursor");
    renderFooter();
    load();
    // Start with the review bubble rather than the full
    // toolbar — and never prompt for a name on startup. The name is asked for
    // only when the reviewer actually clicks Review (see launchEl handler).
    // A deep link (#an=<id>) is the one exception: open straight into review
    // so the linked comment can be focused.
    if (/^#an=./.test(location.hash)) setEnabled(true);
    else setEnabled(false);
  }

  function ensureEnabled() {
    if (!state.enabled) setEnabled(true);
  }

  // public API — lets host pages and other scripts compose with the layer
  window.Annotate = {
    version: VERSION,
    config: CFG,
    open: function () { ensureEnabled(); openPanel(); },
    close: function () { closePanel(); },
    toggle: function () {
      if (!state.enabled) { setEnabled(true); openPanel(); }
      else togglePanel();
    },
    enable: function () { setEnabled(true); },
    disable: function () { setEnabled(false); },
    setTool: function (t) { ensureEnabled(); setTool(t); },
    refresh: function () { load(); },
    comments: function () { return state.comments.slice(); },
    focus: function (id) { focusComment(id, false); },
    toast: toast,
    export: function () { exportComments(); },
    import: function () { pickImportFile(); },
    clear: function () {
      var d = dbRead();
      d.comments = d.comments.filter(function (c) { return c.page !== PAGE; });
      dbWrite(d);
      load();
    },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
