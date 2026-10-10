// Generated from annotate.js by scripts/build.mjs. Do not edit directly.
const createController = function (host) {
  "use strict";
  var instance = null, lastConfig, lastScript;
  var activeKey = typeof Symbol === "function" ? Symbol.for("reviewjs.annotate.controller") : "__ANNOTATE_CONTROLLER__";
  var controller = {
    version: "1.4.0",
    init: function (config, script) {
      if (!host || !host.document) throw new Error("Annotate.init requires a browser document");
      if (instance && config === undefined) return controller;
      if (host[activeKey] && host[activeKey] !== controller) host[activeKey].destroy();
      controller.destroy();
      if (config !== undefined || script !== undefined) { lastConfig = config; lastScript = script; }
      instance = createInstance(host, lastConfig, lastScript);
      host[activeKey] = controller;
      return controller;
    },
    destroy: function () {
      if (instance) instance.destroy(); instance = null;
      if (host && host[activeKey] === controller) delete host[activeKey];
    },
  };
  Object.defineProperty(controller, "config", { enumerable: true, get: function () { return instance ? instance.config : null; } });
  ["open", "close", "toggle", "enable", "disable", "setTool", "refresh", "comments", "focus", "toast", "export", "import", "clear", "submit", "setStatus", "assign", "syncState"].forEach(function (name) {
    controller[name] = function () {
      if (!instance) throw new Error("Call Annotate.init() first");
      return instance[name].apply(instance, arguments);
    };
  });
  return controller;

  function createInstance(window, config, SCRIPT) {
  var document = window.document, location = window.location;
  var destroyed = false, booted = false, uiHost = null, contentObserver = null, observedBody = null;
  var cleanups = [], timers = new Set(), frames = new Set(), objectUrls = new Set();
  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    // Detached UI nodes can be garbage-collected without retaining every
    // rendered card; only long-lived event targets need explicit teardown.
    if (target === document || target === window)
      cleanups.push(function () { target.removeEventListener(name, callback, options); });
  }
  function setTimeout(callback, delay) {
    if (destroyed) return 0;
    var id = window.setTimeout(function () { timers.delete(id); if (!destroyed) callback(); }, delay);
    timers.add(id); return id;
  }
  function clearTimeout(id) { window.clearTimeout(id); timers.delete(id); }
  function requestAnimationFrame(callback) {
    if (destroyed) return 0;
    var id = window.requestAnimationFrame(function () { frames.delete(id); if (!destroyed) callback(); });
    frames.add(id); return id;
  }
  function cancelAnimationFrame(id) { window.cancelAnimationFrame(id); frames.delete(id); }
  function ensureHost() {
    if (!uiHost) {
      uiHost = document.createElement("div"); uiHost.id = "__an_host";
      uiHost.style.display = "contents";
    }
    if (!uiHost.isConnected && document.body) document.body.appendChild(uiHost);
    if (_anchorRO && document.body && observedBody !== document.body) {
      if (observedBody) _anchorRO.unobserve(observedBody);
      observedBody = document.body; _anchorRO.observe(observedBody);
    }
    return uiHost;
  }

  var VERSION = "1.4.0";

  // --------------------------------------------------------------------------
  // CONFIG — resolved from (in priority order) the script tag's data-* attrs,
  // then a global window.AnnotateConfig object, then built-in defaults.
  // --------------------------------------------------------------------------
  var scriptData = (SCRIPT && SCRIPT.dataset) || {};   // data-* attributes
  var globalConfig = config || window.AnnotateConfig || {};       // window.AnnotateConfig
  var explicitPage = scriptData.page || globalConfig.page || "";
  var CFG = {
    project: scriptData.project || globalConfig.project || "",
    page: explicitPage || location.pathname,
    accent: scriptData.accent || globalConfig.accent || "",
    theme: scriptData.theme || globalConfig.theme || "auto",
    position: scriptData.position || globalConfig.position || "bottom-right",
    blocks: scriptData.blocks || globalConfig.blocks || "",
    startOpen: truthy(scriptData.startOpen || globalConfig.startOpen),
    note: scriptData.note || globalConfig.note || "",
    share: String(scriptData.shareEmail || globalConfig.shareEmail || "").trim(),
    spa: truthy(scriptData.spa !== undefined ? scriptData.spa : globalConfig.spa),
    postUrl: String(scriptData.postUrl || globalConfig.postUrl || "").trim(),
    api: String(scriptData.api || globalConfig.api || "").trim().replace(/\/+$/, ""),
    reviewId: String(scriptData.reviewId || globalConfig.reviewId || "").trim(),
    inviteParam: String(scriptData.inviteParam || globalConfig.inviteParam || "an_invite").trim(),
    pollInterval: Math.max(500, Number(scriptData.pollInterval || globalConfig.pollInterval) || 20000),
  };
  // Integrator-supplied auth ({ getToken, onUnauthorized }) is object-only,
  // so it can come from AnnotateConfig / init() but never from data-*.
  var authHook = globalConfig.auth && typeof globalConfig.auth.getToken === "function" ? globalConfig.auth : null;
  // An explicit data-page / AnnotateConfig.page is fixed; otherwise the page key
  // tracks the current pathname so history-based SPA routing stays isolated.
  var pageExplicit = !!explicitPage;
  function currentPageKey() {
    if (!pageExplicit) CFG.page = location.pathname;
    return (CFG.project ? CFG.project + ":" : "") + CFG.page;
  }
  var PAGE = currentPageKey();

  // localStorage can be denied (private mode, sandboxed iframes) or fill up —
  // never crash, and never pretend a failed write persisted. dbWrite reports
  // success so callers can keep unsaved work in memory and surface the issue.
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    // Returns whether the write actually reached storage. Callers must not
    // assume persistence on failure — that is what surfaces the unsaved banner.
    set: function (k, v) {
      try { localStorage.setItem(k, v); return true; } catch (e) {
        if (e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED"))
          setTimeout(function () { toast("Storage full — export your comments before adding more.", { kind: "error", duration: 8000 }); }, 0);
        return false;
      }
    },
  };
  var UNSAVED_MSG = "Changes may not be saved — this browser is refusing storage. Your comments are kept on screen and can still be downloaded as JSON.";
  var quotaWarned = false;
  // Persistent (not toast) warning for the failure modes that toasts can't
  // express: storage denied outright, or writes silently failing. Visibility
  // is derived from the write that just happened (`ok`), not a shared flag, so
  // an unrelated failed preference write can't leave the banner stuck on.
  function showUnsavedBanner(ok) {
    if (!ok) {
      if (!quotaWarned) { quotaWarned = true; toast("Storage is unavailable — your comments are kept on screen only.", { kind: "error", duration: 8000 }); }
      if (!document.getElementById("__an_unsaved"))
        ensureHost().appendChild(el("div", { id: "__an_unsaved", role: "alert", text: UNSAVED_MSG }));
    } else if (document.getElementById("__an_unsaved")) {
      document.getElementById("__an_unsaved").remove();
    }
  }
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
    authorId: null, // server-assigned reviewer id; only set by a remote session
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
          listen(n, k.slice(2).toLowerCase(), attrs[k]);
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
  function truthy(v) {
    return v === true || /^(1|true|yes|open)$/i.test(String(v || ""));
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
  var LOCAL_STORE_KEY = "annotate:" + (CFG.project || location.host || "default");
  // With a backend the blob is a per-review cache, kept apart from local-only
  // comments so the two never mix.
  var API_BASE = "";
  if (CFG.api && CFG.reviewId) {
    try {
      var apiUrl = new URL(CFG.api, location.href);
      if (/^https?:$/.test(apiUrl.protocol))
        API_BASE = apiUrl.href.replace(/\/+$/, "") + "/v1/annotate/reviews/" + encodeURIComponent(CFG.reviewId);
    } catch (e) {}
  }
  var REMOTE = !!API_BASE;
  var STORE_KEY = REMOTE ? "annotate:remote:" + CFG.reviewId : LOCAL_STORE_KEY;
  function dbRead() {
    var d;
    try { d = JSON.parse(store.get(STORE_KEY) || "null"); } catch (e) { d = null; }
    if (!d || typeof d !== "object") d = {};
    if (!Array.isArray(d.comments)) d.comments = [];
    return d;
  }
  function dbWrite(d) {
    var ok = store.set(STORE_KEY, JSON.stringify(d));
    showUnsavedBanner(ok);
    return ok;
  }
  function uid() {
    if (window.crypto && crypto.getRandomValues) {
      var arr = new Uint32Array(3);
      crypto.getRandomValues(arr);
      return "c" + arr[0].toString(36) + arr[1].toString(36) + arr[2].toString(36);
    }
    return "c" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  // Comment / reply size caps — enforced BOTH when accepting input and when
  // validating imports, so the app can never export something it would later
  // reject. Kept as named constants so the two stay in lock-step.
  var MAX_COMMENT_TEXT = 5000;
  var MAX_REPLY_TEXT = 5000;
  var MAX_REPLIES = 500;

  // In-memory store of comments whose last write was refused by localStorage
  // (private mode, quota…). They stay visible, editable and exportable even
  // though they are not persisted; pageComments() overlays them back in.
  var unsaved = {};

  // --------------------------------------------------------------------------
  // RECORD SCHEMA v2 — one shape for storage, export, and the wire protocol.
  // v1 records (no `schema`) are upgraded in memory on read; the next write
  // persists them as v2. Runtime-only keys start with "__" and never leave
  // the page: serialize() is the single exit point.
  // --------------------------------------------------------------------------
  var SCHEMA = 2;
  var STATUSES = { open: "Open", in_progress: "In progress", resolved: "Resolved", wont_fix: "Won’t fix" };
  function isClosed(status) { return status === "resolved" || status === "wont_fix"; }
  function safeColor(v) {
    return typeof v === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : COLORS[0].hex;
  }
  function strOrNull(v) { return typeof v === "string" && v ? v : null; }
  var GEOM_KEYS = ["kind", "selector", "x", "y", "w", "h", "vw", "vh", "points"];
  function normalizeGeom(g) {
    if (!g || typeof g !== "object") return null;
    var out = {};
    GEOM_KEYS.forEach(function (k) { if (g[k] !== undefined) out[k] = k === "points" ? g.points.map(function (p) { return [p[0], p[1]]; }) : g[k]; });
    return out;
  }
  function normalizeAssignee(a) {
    if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name.trim()) return null;
    return { id: strOrNull(a.id), name: a.name.trim().slice(0, 80) };
  }
  function normalizeReply(r) {
    return { id: r.id, author: r.author, authorId: strOrNull(r.authorId), text: r.text,
      createdAt: r.createdAt, editedAt: strOrNull(r.editedAt) };
  }
  // Allowlists known fields (unknown keys are dropped) and fills v2 defaults.
  // Callers validate with isValidComment() first.
  function normalizeComment(c) {
    var status = STATUSES[c.status] ? c.status : (c.resolved === true ? "resolved" : "open");
    var closed = isClosed(status);
    return {
      schema: SCHEMA,
      id: c.id,
      page: c.page,
      url: typeof c.url === "string" ? c.url : "",
      type: c.type,
      author: c.author,
      authorId: strOrNull(c.authorId),
      text: c.text,
      color: safeColor(c.color),
      anchor: c.anchor ? { exact: c.anchor.exact, prefix: c.anchor.prefix, suffix: c.anchor.suffix } : null,
      geom: normalizeGeom(c.geom),
      visibility: c.visibility === "private" ? "private" : "shared",
      status: status,
      resolved: closed,
      resolvedBy: closed ? strOrNull(c.resolvedBy) : null,
      resolvedAt: closed ? strOrNull(c.resolvedAt) : null,
      assignee: normalizeAssignee(c.assignee),
      assignedAt: c.assignee ? strOrNull(c.assignedAt) : null,
      replies: c.replies.map(normalizeReply),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : (typeof c.createdAt === "string" ? c.createdAt : ""),
      editedAt: strOrNull(c.editedAt),
    };
  }
  // Deep copy without runtime ("__"-prefixed) keys. Used by export, copy,
  // submit, undo and every wire write.
  function serialize(c) {
    return JSON.parse(JSON.stringify(c, function (k, v) { return k.slice(0, 2) === "__" ? undefined : v; }));
  }
  // A comment is "mine" when the server identity matches, or — with no
  // identity on either side — when the display name matches.
  function isMine(c) {
    if (state.authorId && c.authorId) return c.authorId === state.authorId;
    return c.author === (state.author || "Anonymous");
  }

  // Local-only mode keeps 1.4 behavior: this browser owns its whole store,
  // so any comment in it may be deleted. A review backend allows the creator
  // and review authors.
  function canDelete(c) { return !REMOTE || isMine(c) || isReviewAuthor(); }
  // Review authors (session role "author") see every reviewer's comments
  // and address them; reviewers only ever receive their own.
  function isReviewAuthor() { return REMOTE && !!sync.reviewer && sync.reviewer.role === "author"; }

  function pageComments() {
    // Validate stored records before touching properties: a corrupt/legacy
    // entry (e.g. [null]) must be skipped rather than crash rendering.
    var listed = dbRead().comments.filter(function (c) {
      return isValidComment(c) && c.page === PAGE;
    }).map(normalizeComment);
    // Reoverlay unsaved records for this page onto the persisted list (upsert
    // by id) so work that never reached storage is not lost on reload.
    Object.keys(unsaved).forEach(function (id) {
      var u = unsaved[id];
      if (!u || u.page !== PAGE) return;
      var idx = -1;
      for (var i = 0; i < listed.length; i++) if (listed[i].id === id) { idx = i; break; }
      if (idx >= 0) listed[idx] = u; else listed.push(u);
    });
    return listed;
  }
  function createComment(draft) {
    var d = dbRead(), now = new Date().toISOString();
    var c = {
      schema: SCHEMA,
      id: uid(),
      page: PAGE,
      url: location.href,
      type: draft.type || "note",
      author: state.author || "Anonymous",
      authorId: state.authorId,
      text: String(draft.text || "").slice(0, MAX_COMMENT_TEXT),
      color: safeColor(draft.color || state.color),
      anchor: draft.anchor || null,
      geom: draft.geom || null,
      visibility: "shared",
      status: "open",
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      assignee: null,
      assignedAt: null,
      replies: [],
      createdAt: now,
      updatedAt: now,
      editedAt: null,
    };
    if (!isValidComment(c)) { toast("Cannot save this comment: invalid anchor or content", { kind: "error" }); return null; }
    d.comments.push(c);
    var ok = dbWrite(d); // surfaces the banner if the write was refused; the caller
                // keeps the comment in state so it stays visible & exportable
    if (!ok) unsaved[c.id] = c; // keep it so edits/reloads don't lose it
    remotePut(c, ["*"]);
    return c;
  }
  function patchComment(id, changes) {
    var d = dbRead();
    var c = d.comments.filter(function (x) { return x && x.id === id && x.page === PAGE; })[0];
    var fromUnsaved = !c;
    if (unsaved[id] && unsaved[id].page === PAGE) c = unsaved[id];
    if (!c) {
      // A comment created while storage was unavailable never reached the
      // persisted list; fall back to our in-memory copy so it stays editable.
      return null;
    }
    if (!isValidComment(c)) return null;
    c = normalizeComment(serialize(c));
    var now = new Date().toISOString(), fields = [];
    if (typeof changes.text === "string" && changes.text.slice(0, MAX_COMMENT_TEXT) !== c.text) {
      c.text = changes.text.slice(0, MAX_COMMENT_TEXT); c.editedAt = now; fields.push("text");
    }
    var status = STATUSES[changes.status] ? changes.status
      : typeof changes.resolved === "boolean" ? (changes.resolved ? "resolved" : "open") : null;
    if (status && status !== c.status) {
      c.status = status;
      c.resolved = isClosed(status);
      c.resolvedBy = c.resolved ? state.authorId : null;
      c.resolvedAt = c.resolved ? now : null;
      fields.push("status");
    }
    if (changes.assignee !== undefined) {
      var assignee = normalizeAssignee(changes.assignee);
      if (JSON.stringify(assignee) !== JSON.stringify(c.assignee)) {
        c.assignee = assignee; c.assignedAt = assignee ? now : null; fields.push("assignee");
      }
    }
    if (typeof changes.color === "string" && safeColor(changes.color) !== c.color) { c.color = safeColor(changes.color); fields.push("color"); }
    var replyAdded = false;
    if (changes.reply) {
      var reply = normalizeReply(Object.assign({ authorId: state.authorId, editedAt: null }, changes.reply,
        { text: String(changes.reply.text || "").slice(0, MAX_REPLY_TEXT) }));
      // Enforce the thread cap at input too — a comment can never grow beyond
      // the number imports will accept, so native exports always round-trip.
      if (c.replies.length < MAX_REPLIES) { c.replies.push(reply); replyAdded = true; }
    }
    if (changes.editReply) {
      var ri = c.replies.findIndex(function (r) { return r.id === changes.editReply.id; });
      if (ri >= 0) c.replies[ri] = Object.assign({}, c.replies[ri],
        { text: String(changes.editReply.text || "").slice(0, MAX_REPLY_TEXT), editedAt: now });
    }
    var replyRemoved = false;
    if (changes.deleteReply) {
      var before = c.replies.length;
      c.replies = c.replies.filter(function (r) { return r.id !== changes.deleteReply; });
      replyRemoved = c.replies.length < before;
    }
    c.updatedAt = now;
    if (!isValidComment(c)) { toast("Cannot save this edit: invalid content", { kind: "error" }); return null; }
    if (fromUnsaved) d.comments.push(c);
    else d.comments = d.comments.map(function (x) { return x && x.id === id ? c : x; });
    if (!dbWrite(d)) {
      // Keep the (updated) in-memory copy authoritative and mirror it into the
      // live list so the UI reflects what the user just did — even though the
      // change did not reach storage.
      unsaved[id] = c;
      var live = state.comments.filter(function (x) { return x.id === id; })[0];
      if (live) mergeComment(c);
      renderAll(); renderPanel();
    } else {
      delete unsaved[id];
    }
    if (fields.length) remotePut(c, fields);
    if (replyAdded) remoteEnqueue({ t: "reply", id: id, r: { id: changes.reply.id, text: c.replies[c.replies.length - 1].text } });
    if (replyRemoved) remoteEnqueue({ t: "unreply", id: id, rid: changes.deleteReply });
    return c;
  }
  function removeComment(id, holdMs) {
    delete unsaved[id]; // it must not linger in the recoverable memory set
    var d = dbRead();
    d.comments = d.comments.filter(function (c) { return c.id !== id; });
    dbWrite(d);
    remoteDelete(id, holdMs);
  }

  // --------------------------------------------------------------------------
  // REMOTE SYNC — opt-in backend (data-api + data-review-id) speaking the
  // annotate wire protocol v1. localStorage stays the UI's synchronous source
  // as a per-review cache. Every write is mirrored into a persisted FIFO
  // queue that one request at a time drains to the server; a poll merges the
  // server's view back in. Nothing here runs, and nothing leaves the page,
  // without data-api.
  // --------------------------------------------------------------------------
  var QUEUE_KEY = "annotate:queue:" + CFG.reviewId;
  var INVITE_KEY = "annotate:invite:" + CFG.reviewId;
  var CONTENT_FIELDS = ["text", "color", "anchor", "geom", "status", "assignee"];
  var UNDO_MS = 5500;
  var sync = {
    token: null, expiresAt: 0, reviewer: null, sessionPromise: null, refused: false,
    inflight: null, timer: 0, pollTimer: 0, polling: false, etag: "", etagPage: "",
    failures: 0, offline: false, held: false, state: "", acks: 0, waiters: [], controllers: new Set(),
    baselined: {},
  };
  var queueOk = true, queueMem = [];

  function wirePage(local) {
    var prefix = CFG.project ? CFG.project + ":" : "";
    return prefix && local.indexOf(prefix) === 0 ? local.slice(prefix.length) : local;
  }
  function localPage(wire) { return (CFG.project ? CFG.project + ":" : "") + wire; }
  function idemKey() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : uid() + "-" + uid().slice(1);
  }
  var OP_TYPES = { put: 1, del: 1, reply: 1, unreply: 1 };
  function readQueue() {
    if (!queueOk) return queueMem.slice();
    var q;
    try { q = JSON.parse(store.get(QUEUE_KEY) || "[]"); } catch (e) { q = []; }
    return (Array.isArray(q) ? q : []).filter(function (o) {
      return o && OP_TYPES[o.t] === 1 && typeof o.id === "string" && typeof o.key === "string";
    });
  }
  function writeQueue(q) {
    queueMem = q.slice();
    queueOk = store.set(QUEUE_KEY, JSON.stringify(q));
  }
  function remoteEnqueue(op) {
    if (!REMOTE) return;
    op.key = idemKey();
    var q = readQueue();
    // Coalesce consecutive edits of one record into the queued PUT that has
    // not been sent yet; the body is built from the cache at send time.
    if (op.t === "put") {
      for (var i = q.length - 1; i >= 0; i--) {
        if (q[i].id !== op.id) continue;
        if (q[i].t === "put" && !(sync.inflight && sync.inflight.key === q[i].key)) {
          q[i].f = q[i].f.indexOf("*") >= 0 || op.f.indexOf("*") >= 0 ? ["*"]
            : q[i].f.concat(op.f.filter(function (f) { return q[i].f.indexOf(f) < 0; }));
          writeQueue(q); syncChanged(); scheduleFlush(0);
          return;
        }
        break;
      }
    }
    q.push(op);
    writeQueue(q);
    syncChanged();
    scheduleFlush(0);
  }
  function remotePut(c, fields) {
    // Private notes never reach the wire.
    if (REMOTE && c.visibility !== "private") remoteEnqueue({ t: "put", id: c.id, f: fields });
  }
  function serverStamps(d) {
    if (!d.stamps || typeof d.stamps !== "object") d.stamps = {};
    return d.stamps;
  }
  // The delete is held for the undo window, and so is every earlier op for
  // that id (see nextOp), so Undo can cancel it and lose nothing. Once due,
  // earlier ops for a record no longer in the cache are skipped (sendOp).
  function remoteDelete(id, holdMs) {
    if (!REMOTE) return;
    var q = readQueue();
    q.push({ t: "del", id: id, key: idemKey(), nb: Date.now() + (holdMs || 0) });
    writeQueue(q);
    syncChanged();
    scheduleFlush(0);
  }
  // Undo of a delete: cancel the held DELETE if it has not been sent;
  // otherwise re-create (a tombstoned id answers 410 and is dropped).
  function remoteRestore(c) {
    if (!REMOTE) return;
    var q = readQueue(), cancelled = false;
    q = q.filter(function (o) {
      var drop = o.t === "del" && o.id === c.id && !(sync.inflight && sync.inflight.key === o.key);
      if (drop) cancelled = true;
      return !drop;
    });
    writeQueue(q);
    if (!cancelled) remotePut(c, ["*"]);
    syncChanged();
    scheduleFlush(0);
  }

  function dispatch(name, detail) {
    try { window.dispatchEvent(new window.CustomEvent(name, { detail: detail })); } catch (e) {}
  }
  function syncState() {
    if (!REMOTE) return { state: "local", pending: 0 };
    var pending = readQueue().length;
    var s = sync.held ? "error" : sync.offline ? "offline" : pending ? "pending" : "idle";
    return { state: s, pending: pending };
  }
  var SYNC_TEXT = {
    idle: "Saved to the review. Only you and the review owner see your comments.",
    pending: "Saving changes to the review…",
    offline: "Offline — changes are kept here and sync when the connection returns.",
    error: "Not signed in to the review — changes are kept on this device.",
  };
  function syncChanged() {
    if (!REMOTE) return;
    var s = syncState(), sig = s.state + ":" + s.pending;
    if (sig === sync.state) return;
    sync.state = sig;
    var note = document.getElementById("__an_syncnote");
    if (note) { note.textContent = SYNC_TEXT[s.state]; note.setAttribute("data-state", s.state); }
    dispatch("annotate:sync", s);
  }
  function settleWaiters(error) {
    var waiters = sync.waiters; sync.waiters = [];
    waiters.forEach(function (w) { if (error) w.reject(error); else w.resolve(); });
  }

  function apiFetch(method, path, body, headers) {
    var controller = window.AbortController ? new window.AbortController() : null;
    if (controller) sync.controllers.add(controller);
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 30000);
    var h = Object.assign({}, headers || {});
    if (sync.token) h.Authorization = "Bearer " + sync.token;
    if (body !== undefined) h["Content-Type"] = "application/json";
    return window.fetch(API_BASE + path, {
      method: method, headers: h, credentials: "omit", cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      if (res.status === 204 || res.status === 304) return { res: res, data: null };
      return res.json().then(function (data) { return { res: res, data: data }; }, function () { return { res: res, data: null }; });
    }).finally(function () { clearTimeout(timeout); if (controller) sync.controllers.delete(controller); });
  }

  // Invite tokens arrive once in the URL; keep them for this review and strip
  // them so they are not bookmarked, shared or sent as a Referer.
  function captureInvite() {
    if (!REMOTE || !CFG.inviteParam) return;
    var u;
    try { u = new URL(location.href); } catch (e) { return; }
    var token = u.searchParams.get(CFG.inviteParam);
    if (!token) return;
    store.set(INVITE_KEY, token);
    u.searchParams.delete(CFG.inviteParam);
    try { window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash); } catch (e) {}
  }
  function hasInvite() { return REMOTE && !!store.get(INVITE_KEY); }

  // Resolves with a session token, or null when none can be had yet (no
  // invite and no name). The session token itself lives in memory only.
  function ensureSession(force) {
    if (!REMOTE || destroyed) return Promise.resolve(null);
    if (!force && sync.token && sync.expiresAt > Date.now() + 60000) return Promise.resolve(sync.token);
    if (sync.sessionPromise) return sync.sessionPromise;
    var p;
    if (authHook) {
      p = Promise.resolve().then(function () { return authHook.getToken(); }).then(function (token) {
        sync.token = typeof token === "string" && token ? token : null;
        sync.expiresAt = sync.token ? Infinity : 0;
        return sync.token;
      });
    } else {
      var invite = store.get(INVITE_KEY);
      var body = invite ? { invite: invite } : state.author ? { name: state.author } : null;
      if (!body) return Promise.resolve(null);
      sync.token = null;
      p = apiFetch("POST", "/session", body).then(function (r) {
        if (r.res.status === 200 && r.data && typeof r.data.token === "string") { acceptSession(r.data); return sync.token; }
        if (r.res.status === 403 || r.res.status === 404) { sessionRefused(r.data && r.data.error, !!invite); return null; }
        throw new Error("HTTP " + r.res.status);
      });
    }
    sync.sessionPromise = p.finally(function () { sync.sessionPromise = null; });
    return sync.sessionPromise;
  }
  function acceptSession(data) {
    sync.token = data.token;
    sync.expiresAt = Date.parse(data.expiresAt) || Date.now() + 3600000;
    sync.held = false;
    if (data.reviewer && typeof data.reviewer.id === "string") {
      sync.reviewer = { id: data.reviewer.id, name: String(data.reviewer.name || ""),
        role: data.reviewer.role === "author" ? "author" : "reviewer" };
      state.authorId = sync.reviewer.id;
      if (sync.reviewer.name) state.author = sync.reviewer.name;
    }
    if (data.review && typeof data.review.note === "string" && data.review.note) { state.note = data.review.note; renderNote(); }
    dispatch("annotate:auth", { reviewer: sync.reviewer });
    syncChanged();
    if (booted) renderPanel();
  }
  // The server refused this link: say so and fall back to local-only mode
  // rather than degrading silently.
  function sessionRefused(code, viaInvite) {
    if (viaInvite) store.set(INVITE_KEY, "");
    toast(viaInvite || code === "invite_invalid" ? "This review link is no longer valid. Comments stay in this browser only."
      : "Could not join the review (" + (code || "refused") + "). Comments stay in this browser only.", { kind: "error", duration: 8000 });
    goLocal();
  }
  function goLocal() {
    REMOTE = false;
    stopSync();
    STORE_KEY = LOCAL_STORE_KEY;
    state.authorId = null;
    dispatch("annotate:sync", { state: "local", pending: 0 });
    if (booted) { loadData(); renderFooter(); }
  }
  function stopSync() {
    clearTimeout(sync.timer); clearTimeout(sync.pollTimer);
    sync.controllers.forEach(function (c) { c.abort(); });
    sync.controllers.clear();
    settleWaiters(new Error("Sync stopped"));
  }
  function startSync() {
    if (!REMOTE || destroyed) return;
    ensureSession().then(function (token) {
      if (!token) return;
      scheduleFlush(0);
      poll();
    }, function () { networkFailure(); });
  }

  function scheduleFlush(delay) {
    if (!REMOTE || destroyed) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(flushQueue, delay || 0);
  }
  // Picks the first op that is due, keeping per-record order: an op never
  // overtakes an earlier op for the same id.
  function nextOp(q) {
    var now = Date.now(), blocked = {}, wait = Infinity;
    q.forEach(function (o) {
      if (o.t === "del" && o.nb && o.nb > now) { blocked[o.id] = true; wait = Math.min(wait, o.nb - now); }
    });
    for (var i = 0; i < q.length; i++) {
      var o = q[i];
      if (blocked[o.id]) continue;
      if (o.nb && o.nb > now) { blocked[o.id] = true; wait = Math.min(wait, o.nb - now); continue; }
      return { op: o };
    }
    return { wait: wait };
  }
  function flushQueue() {
    if (!REMOTE || destroyed || sync.inflight || sync.held) return;
    var q = readQueue();
    syncChanged();
    if (!q.length) { settleWaiters(); return; }
    var pick = nextOp(q);
    if (!pick.op) { if (pick.wait < Infinity) scheduleFlush(pick.wait); return; }
    if (!sync.token) {
      ensureSession().then(function (token) {
        if (token) scheduleFlush(0);
        else settleWaiters(new Error("Not signed in to the review"));
      }, function () { networkFailure(); });
      return;
    }
    var op = sync.inflight = pick.op;
    sendOp(op).then(function (r) {
      sync.inflight = null;
      handleResponse(op, r);
    }, function () {
      sync.inflight = null;
      if (destroyed) return;
      networkFailure();
    });
  }
  function sendOp(op) {
    var path = "/comments/" + encodeURIComponent(op.id), headers = { "Idempotency-Key": op.key };
    var d = dbRead();
    var rec = d.comments.filter(function (c) { return c && c.id === op.id; })[0] || unsaved[op.id];
    // The record is gone locally (its delete follows) or turned private.
    if (op.t !== "del" && (!rec || !isValidComment(rec) || rec.visibility === "private")) return Promise.resolve({ skip: true });
    if (op.t === "put") {
      var body = serialize(normalizeComment(rec));
      body.page = wirePage(body.page);
      body.replies = [];   // replies travel on their own endpoint
      body.updatedAt = serverStamps(d)[op.id] || body.updatedAt;   // the base for the stale check
      return apiFetch("PUT", path, body, headers);
    }
    if (op.t === "del") return apiFetch("DELETE", path, undefined, headers);
    if (op.t === "reply") return apiFetch("POST", path + "/replies", { id: op.r.id, text: op.r.text }, headers);
    return apiFetch("DELETE", path + "/replies/" + encodeURIComponent(op.rid), undefined, headers);
  }
  function dropOps(pred) {
    writeQueue(readQueue().filter(function (o) { return !pred(o); }));
  }
  function retryAfterMs(res) {
    var v = res.headers.get("Retry-After"), n = Number(v);
    if (v && isFinite(n)) return Math.max(0, n * 1000);
    var at = v ? Date.parse(v) : NaN;
    return isFinite(at) ? Math.max(0, at - Date.now()) : backoffMs();
  }
  function backoffMs() {
    var base = Math.min(60000, 1000 * Math.pow(2, Math.min(sync.failures, 6)));
    return Math.round(base / 2 + Math.random() * base / 2);
  }
  function networkFailure() {
    sync.failures++;
    sync.offline = true;
    syncChanged();
    settleWaiters(new Error("Offline — changes are queued and will sync later"));
    scheduleFlush(backoffMs());
  }
  function handleResponse(op, r) {
    if (destroyed) return;
    if (r.skip) { dropOps(function (o) { return o.key === op.key; }); scheduleFlush(0); return; }
    var res = r.res, data = r.data || {}, status = res.status;
    if (status === 429 || status === 503 || status >= 500) {
      sync.failures++;
      if (status >= 500 && status !== 503) sync.offline = true;
      syncChanged();
      scheduleFlush(status === 429 || status === 503 ? retryAfterMs(res) : backoffMs());
      return;
    }
    sync.failures = 0; sync.offline = false;
    if (status === 401) {
      // Re-exchange once; a second refusal holds the queue for the host.
      if (op.reauth) {
        sync.held = true; syncChanged();
        settleWaiters(new Error("Not signed in to the review"));
        if (authHook && typeof authHook.onUnauthorized === "function") { try { authHook.onUnauthorized(); } catch (e) {} }
        return;
      }
      markOp(op, { reauth: true });
      sync.token = null;
      ensureSession(true).then(function (token) {
        if (token) scheduleFlush(0);
        else { sync.held = true; syncChanged(); settleWaiters(new Error("Not signed in to the review")); }
      }, function () { networkFailure(); });
      return;
    }
    if (status === 409 && data.comment) {
      // Someone changed it first: take theirs, re-apply our fields, resend
      // with a new key (the body differs from the one the old key covered).
      var attempts = (op.n || 0) + 1;
      applyServer(data.comment, op);
      if (attempts > 5) dropOps(function (o) { return o.key === op.key; });
      else markOp(op, { key: idemKey(), n: attempts });
      scheduleFlush(0);
      return;
    }
    if (status === 410) {
      dropOps(function (o) { return o.id === op.id; });
      forgetRecord(op.id);
      if (op.t !== "del") toast("A comment you changed was already deleted.", { kind: "info", duration: 6000 });
      afterSync();
      scheduleFlush(0);
      return;
    }
    dropOps(function (o) { return o.key === op.key; });
    if (res.ok) {
      sync.acks++;
      if (data.comment) applyServer(data.comment, null);
      else if (op.t === "del") forgetRecord(op.id);
    } else {
      // 403 not_owner, 404, 413, 422…: the server will never accept this op.
      // Drop it and re-read so the UI shows what the server holds.
      toast("The review server rejected a change (" + (data.error || "HTTP " + status) + ").", { kind: "error", duration: 6000 });
      sync.etag = "";
      setTimeout(poll, 0);
    }
    syncChanged();
    scheduleFlush(0);
  }
  function markOp(op, patch) {
    var q = readQueue();
    q.forEach(function (o) { if (o.key === op.key) Object.assign(o, patch); });
    writeQueue(q);
  }
  function forgetRecord(id) {
    var d = dbRead();
    d.comments = d.comments.filter(function (c) { return !c || c.id !== id; });
    delete serverStamps(d)[id];
    delete unsaved[id];
    dbWrite(d);
    afterSync();
  }
  // Server record → cache. Ops still queued for that id are re-applied on
  // top, so pending local work is never overwritten by an older server view.
  function fromWire(w) {
    if (!isValidComment(w) || typeof w.page !== "string" || w.visibility === "private") return null;
    var c = normalizeComment(w);
    c.page = localPage(w.page);
    return c;
  }
  function overlayOps(server, local, ops) {
    var out = server;
    ops.forEach(function (o) {
      if (o.t === "put" && local) {
        (o.f.indexOf("*") >= 0 ? CONTENT_FIELDS : o.f).forEach(function (f) {
          out[f] = local[f] === undefined ? out[f] : JSON.parse(JSON.stringify(local[f]));
          if (f === "status") { out.resolved = isClosed(out.status); out.resolvedBy = local.resolvedBy || null; out.resolvedAt = local.resolvedAt || null; }
          if (f === "assignee") out.assignedAt = local.assignedAt || null;
          if (f === "text") out.editedAt = local.editedAt || out.editedAt;
        });
      } else if (o.t === "reply" && local && !out.replies.some(function (r) { return r.id === o.r.id; })) {
        var mine = (local.replies || []).filter(function (r) { return r.id === o.r.id; })[0];
        if (mine) out.replies.push(mine);
      } else if (o.t === "unreply") {
        out.replies = out.replies.filter(function (r) { return r.id !== o.rid; });
      }
    });
    return out;
  }
  function applyServer(wire, exceptOp) {
    var c = fromWire(wire);
    if (!c) return;
    var d = dbRead(), q = readQueue().filter(function (o) { return o.id === c.id && (!exceptOp || o.key !== exceptOp.key); });
    if (exceptOp) q.unshift(exceptOp);   // a 409'd op is re-applied too
    serverStamps(d)[c.id] = wire.updatedAt;
    // Our own acknowledged write is not news to us.
    if (!exceptOp) setReadMark(c.id, wire.updatedAt);
    var idx = -1;
    for (var i = 0; i < d.comments.length; i++) if (d.comments[i] && d.comments[i].id === c.id) { idx = i; break; }
    var local = idx >= 0 ? d.comments[idx] : unsaved[c.id];
    if (q.some(function (o) { return o.t === "del"; })) { dbWrite(d); return; }
    var merged = overlayOps(c, local && isValidComment(local) ? normalizeComment(local) : null, q);
    if (idx >= 0) d.comments[idx] = merged; else d.comments.push(merged);
    if (dbWrite(d)) delete unsaved[c.id]; else unsaved[c.id] = merged;
    afterSync();
  }
  // Server page list → cache. Records with pending ops keep their local
  // form; a cached record the server no longer lists, with no pending op and
  // a server stamp, was deleted elsewhere.
  function mergeServerPage(list) {
    var d = dbRead(), stamps = serverStamps(d), q = readQueue(), seen = {};
    var byId = {};
    d.comments.forEach(function (c) { if (c && typeof c.id === "string") byId[c.id] = c; });
    var pending = {};
    q.forEach(function (o) { (pending[o.id] = pending[o.id] || []).push(o); });
    var kept = d.comments.filter(function (c) { return c && c.page !== PAGE; });
    // The first read of a page this session sets read marks for comments
    // never seen before; after that, a new or changed server record with no
    // local op behind it is someone else's change and counts as unread.
    var marks = readMarks(), first = !sync.baselined[PAGE], fresh = 0, removed = 0;
    sync.baselined[PAGE] = true;
    list.forEach(function (w) {
      var c = fromWire(w);
      if (!c || c.page !== PAGE || seen[c.id]) return;
      seen[c.id] = true;
      var previous = stamps[c.id];
      stamps[c.id] = w.updatedAt;
      if (!pending[c.id]) {
        if (marks[c.id] === undefined && (first || c.authorId && c.authorId === state.authorId)) marks[c.id] = w.updatedAt;
        else if (previous !== w.updatedAt && (marks[c.id] === undefined || w.updatedAt > marks[c.id])) fresh++;
      }
      var ops = pending[c.id];
      if (ops && ops.some(function (o) { return o.t === "del"; })) return;
      var local = byId[c.id] && isValidComment(byId[c.id]) ? normalizeComment(byId[c.id]) : null;
      kept.push(ops ? overlayOps(c, local, ops) : c);
    });
    d.comments.forEach(function (c) {
      if (!c || c.page !== PAGE || seen[c.id]) return;
      if (pending[c.id]) { kept.push(c); return; }
      if (stamps[c.id]) { delete stamps[c.id]; delete marks[c.id]; removed++; return; }   // deleted remotely
      kept.push(c);   // never reached the server (private, or rejected): stays local
    });
    var pageList = kept.filter(function (c) { return c && c.page === PAGE; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });
    d.comments = kept.filter(function (c) { return c.page !== PAGE; }).concat(pageList);
    dbWrite(d);
    writeMarks(marks);
    if (fresh) toast(isReviewAuthor()
      ? fresh + " comment" + (fresh === 1 ? "" : "s") + " changed on this page"
      : "The review owner updated " + fresh + " of your comments", { kind: "info", duration: 6000 });
    if (removed && !isReviewAuthor())
      toast("The review owner removed " + removed + " of your comments", { kind: "info", duration: 6000 });
    afterSync();
  }

  // Read marks: per comment, the server updatedAt this browser last showed
  // the reviewer. Kept per review in localStorage, never sent anywhere.
  var READ_KEY = "annotate:read:" + CFG.reviewId;
  function readMarks() {
    var m;
    try { m = JSON.parse(store.get(READ_KEY) || "{}"); } catch (e) { m = null; }
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  }
  function writeMarks(m) { store.set(READ_KEY, JSON.stringify(m)); }
  function setReadMark(id, stamp) {
    if (!REMOTE || !stamp) return;
    var m = readMarks();
    m[id] = stamp;
    writeMarks(m);
  }
  // Ids whose server version is newer than what the reviewer has seen.
  function unreadIds() {
    var out = {};
    if (!REMOTE) return out;
    var stamps = serverStamps(dbRead()), marks = readMarks(), pending = {};
    readQueue().forEach(function (o) { pending[o.id] = true; });
    state.comments.forEach(function (c) {
      var stamp = stamps[c.id];
      if (stamp && !pending[c.id] && (marks[c.id] === undefined || stamp > marks[c.id])) out[c.id] = true;
    });
    return out;
  }
  function acknowledge(id) {
    if (!REMOTE) return;
    setReadMark(id, serverStamps(dbRead())[id]);
  }
  function poll() {
    if (!REMOTE || destroyed) return;
    clearTimeout(sync.pollTimer);
    if (document.hidden) return;   // resumed on visibilitychange
    sync.pollTimer = setTimeout(poll, CFG.pollInterval);
    if (!sync.token || sync.polling) return;
    var page = wirePage(PAGE), localKey = PAGE, acks = sync.acks;
    if (sync.etagPage !== page) { sync.etag = ""; sync.etagPage = page; }
    sync.polling = true;
    apiFetch("GET", "/comments?page=" + encodeURIComponent(page), undefined, sync.etag ? { "If-None-Match": sync.etag } : {})
      .then(function (r) {
        if (destroyed || !REMOTE) return;
        var status = r.res.status;
        if (status === 401) { sync.token = null; ensureSession(true); return; }
        if (status === 304) { sync.offline = false; syncChanged(); return; }
        if (status !== 200 || !r.data || !Array.isArray(r.data.comments)) return;
        sync.offline = false; syncChanged();
        // A write acknowledged while this read was in flight may be missing
        // from it; discard the snapshot and read again rather than regress.
        if (sync.acks !== acks || PAGE !== localKey) { sync.etag = ""; setTimeout(poll, 0); return; }
        sync.etag = r.res.headers.get("ETag") || "";
        mergeServerPage(r.data.comments);
      }, function () { if (!destroyed && REMOTE) { sync.offline = true; syncChanged(); } })
      .finally(function () { sync.polling = false; });
  }
  // Re-render after background sync, keeping any reply/edit drafts intact.
  var lastSyncSig = "";
  function afterSync() {
    if (!booted || destroyed) return;
    var sig = JSON.stringify(pageComments().map(function (c) { return [c.id, c.updatedAt, c.status, c.text, c.replies.length, c.assignee && c.assignee.name]; }));
    if (sig === lastSyncSig) return;
    lastSyncSig = sig;
    backgroundLoad();
  }
  function flushAll() {
    if (!REMOTE) return Promise.resolve();
    // An explicit submit ends any undo window.
    var q = readQueue();
    q.forEach(function (o) { o.nb = 0; });
    writeQueue(q);
    sync.held = false;
    return new Promise(function (resolve, reject) {
      sync.waiters.push({ resolve: resolve, reject: reject });
      scheduleFlush(0);
    });
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

  // Trap Tab focus inside a modal container; returns a cleanup function.
  function trapFocus(container) {
    function getFocusable() {
      return Array.prototype.slice.call(
        container.querySelectorAll("button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]")
      ).filter(function (el) { return el.offsetParent !== null; });
    }
    function handler(e) {
      if (e.key !== "Tab") return;
      var focusable = getFocusable();
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
    }
    listen(container, "keydown", handler);
    return function () { container.removeEventListener("keydown", handler); };
  }

  // ignore our own UI when walking content
  function isOurs(node) {
    while (node) {
      if (node.id && String(node.id).indexOf("__an") === 0) return true;
      node = node.parentNode;
    }
    return false;
  }

  // ==========================================================================
  // STYLES — design tokens + components, light & dark
  // ==========================================================================
  var CSS_TEXT = `
  #__an_host {
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
  #__an_host.an-dark {
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

  .an-highlight.an-active { stroke: var(--an-fg); stroke-width: 1; }

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
  .an-pin:focus-visible { outline: 3px solid #4f46e5; outline-offset: 2px; }
  #__an_overlay [tabindex]:focus-visible, .an-block-tab:focus-visible {
    outline: 3px solid #4f46e5; outline-offset: 2px; }

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
  .an-sbadge { font:600 10px var(--an-font); color: var(--an-muted); }
  .an-sbadge.an-s-in_progress { color: #0ea5e9; }
  .an-assignee, .an-disposal { font-size:11px; color: var(--an-muted); margin:-3px 0 6px; }
  .an-disposal { color: var(--an-ok); }
  .an-card.an-unread { border-color: var(--an-btn-bg); }
  .an-newpill { display:inline-block; border:0; border-radius:999px; margin:-2px 0 7px;
    padding:2px 9px; font:600 10.5px var(--an-font); cursor:pointer;
    background: var(--an-btn-bg); color: var(--an-btn-fg); }
  .an-history { display:none; margin-top:8px; border-top:1px dashed var(--an-border); padding-top:7px; }
  .an-history.an-show { display:block; }
  .an-hlist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
  .an-hlist li { display:flex; gap:8px; font-size:11.5px; line-height:1.4; color: var(--an-fg); }
  .an-hwhen { color: var(--an-muted); margin-left:auto; flex:none; font-size:10.5px; }
  .an-hnote { font-size:10.5px; color: var(--an-muted); margin-top:5px; }
  select.an-status { border:1px solid var(--an-border); background: var(--an-surface);
    border-radius:8px; padding:3px 6px; font:500 11.5px var(--an-font); cursor:pointer;
    color: var(--an-muted); max-width:120px; }
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
  #__an_foot .an-footrow.an-four { flex-wrap:wrap; }
  #__an_foot .an-fbtn { flex:1; border:1px solid var(--an-border-strong);
    background: var(--an-surface); color: var(--an-fg); border-radius:10px; padding:9px;
    font:600 12.5px var(--an-font); cursor:pointer; display:flex; align-items:center;
    justify-content:center; gap:7px; transition: background .15s, border-color .15s; }
  #__an_foot .an-footrow.an-four .an-fbtn { flex-basis:calc(50% - 4px); }
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

  /* ---- unanchored highlight pill ------------------------------------------ */
  .an-unanchored-pill { position:absolute; left:16px; z-index:2147483110;
    display:flex; align-items:center; gap:7px; max-width:280px;
    background:#78350f; color:#fde68a; font:500 11.5px/1.35 var(--an-font);
    padding:7px 11px; border-radius:10px; box-shadow: var(--an-shadow-md);
    border:1px solid rgba(255,255,255,.14); cursor:pointer; }
  .an-unanchored-pill svg { width:14px; height:14px; flex:none; }

  /* ---- persistent "storage unavailable" banner --------------------------- */
  #__an_unsaved { position:fixed; top:14px; left:50%; transform:translateX(-50%);
    z-index:2147483510; display:flex; align-items:center; gap:9px;
    background:#7f1d1d; color:#ffe4e6; font:500 12.5px var(--an-font);
    padding:10px 14px; border-radius:12px; box-shadow: var(--an-shadow-md);
    border:1px solid rgba(255,255,255,.14); max-width:min(460px, 92vw);
    animation: an-toast-in .25s cubic-bezier(.34,1.3,.64,1); }

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
    #__an_foot .an-footrow { flex-wrap:wrap; }
    #__an_foot .an-fbtn { flex-basis:calc(50% - 4px); }
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
      ensureHost().appendChild(toastWrap);
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
      listen(btn, "click", function () {
        // Guard on `acted` too: a rapid second click within the removal window
        // (220ms) must not re-run onAction (e.g. restoring a comment twice).
        if (acted || expired) return;
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
    listen(t, "mouseenter", function () { clearTimeout(timer); });
    listen(t, "mouseleave", function () {
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
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
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

  function rangeFromQuote(q, legacy) {
    var nodes = getTextNodes().filter(function (node) { return !legacy || !!node.nodeValue.trim(); });
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

  var highlightRanges = {};
  function textVisible(node) {
    var parent = node.parentElement;
    if (!parent || !parent.isConnected || getComputedStyle(parent).visibility !== "visible") return false;
    for (var el = parent; el; el = el.parentElement) {
      var style = getComputedStyle(el);
      if (style.display === "none" || style.opacity === "0" || style.contentVisibility === "hidden") return false;
    }
    return true;
  }
  function paintRange(range, color, id) {
    ensureOverlay();
    var fragments = [];

    getTextNodes().forEach(function (node) {
      if (!range.intersectsNode(node) || !textVisible(node)) return;
      var start = node === range.startContainer ? range.startOffset : 0;
      var end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (end <= start) return;
      var fragment = document.createRange();
      fragment.setStart(node, start); fragment.setEnd(node, end);
      Array.prototype.forEach.call(fragment.getClientRects(), function (r) {
        if (!r.width || !r.height) return;
        var mark = svgEl("rect", { class: "an-highlight", "data-an": id,
          x: r.left + window.scrollX, y: r.top + window.scrollY,
          width: r.width, height: r.height, rx: 2,
          fill: hexA(/^#[0-9a-f]{6}$/i.test(color) ? color : "#f59e0b", 0.32) });
        mark.style.pointerEvents = "none";
        overlay.appendChild(mark); fragments.push(mark);
      });
    });
    if (fragments.length) highlightRanges[id] = fragments;
    return fragments;
  }
  listen(document, "click", function (event) {
    if (!state.enabled || state.tool !== "cursor" || isOurs(event.target)) return;
    if (event.target.closest && event.target.closest("a,button,input,textarea,select,[role=button],[contenteditable=true]")) return;
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    Object.keys(highlightRanges).some(function (id) {
      if (id === "__temp") return false;
      var hit = highlightRanges[id].some(function (fragment) {
        var r = fragment.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      });
      if (hit) focusComment(id, true);
      return hit;
    });
  });
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
    ensureHost();
    if (overlay) {
      if (!overlay.isConnected) uiHost.appendChild(overlay);
      if (!pinLayer.isConnected) uiHost.appendChild(pinLayer);
      return;
    }
    overlay = svgEl("svg", { id: "__an_overlay" });
    ensureHost().appendChild(overlay);
    pinLayer = el("div", { id: "__an_pins" });
    pinLayer.style.cssText = "position:absolute;top:0;left:0;z-index:2147483100;pointer-events:none;";
    ensureHost().appendChild(pinLayer);
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
    highlightRanges = {};
    if (overlay) while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    if (pinLayer) pinLayer.innerHTML = "";
  }

  // Anchor boxes at last render, so layout observers can tell whether a full
  // re-render is actually needed (cheap to check, avoids re-render churn).
  var anchorCache = {};
  function rememberAnchor(c, box) {
    anchorCache[c.id] = { x: box.x, y: box.y, w: box.w, h: box.h };
  }
  function anchorsMoved() {
    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (c.resolved && !showResolvedVisuals()) continue;
      if (c.type === "highlight" || !c.geom || !c.geom.selector) continue; // marks reflow with the DOM
      var ae = resolveAnchorEl(c.geom.selector);
      var wasAnchored = !!anchorCache[c.id];
      if (!ae) {
        // present -> missing is a move: the last render drew in place, so a
        // re-render must now replace it with the missing-anchor badge instead
        // of leaving the old marker visible.
        if (wasAnchored) return true;
        continue;
      }
      var prev = anchorCache[c.id];
      var b = docBox(ae);
      if (!prev || Math.abs(prev.x - b.x) > 0.5 || Math.abs(prev.y - b.y) > 0.5 ||
        Math.abs(prev.w - b.w) > 0.5 || Math.abs(prev.h - b.h) > 0.5) return true;
    }
    return false;
  }

  // Observe each resolved anchor element directly (in addition to <body>), so
  // an anchor that moves without changing <body>'s box still re-renders.
  var _anchorRO = null;
  var observedAnchors = {}; // comment id -> element currently observed
  function observeAnchors() {
    if (!_anchorRO) return;
    var current = {}; // comment id -> live anchor element now
    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (!c.geom || !c.geom.selector || c.type === "highlight") continue;
      var ae = resolveAnchorEl(c.geom.selector);
      if (ae) current[c.id] = ae;
    }
    var before = new Set(Object.keys(observedAnchors).map(function (id) { return observedAnchors[id]; }));
    var after = new Set(Object.keys(current).map(function (id) { return current[id]; }));
    before.forEach(function (node) { if (!after.has(node)) _anchorRO.unobserve(node); });
    after.forEach(function (node) { if (!before.has(node)) _anchorRO.observe(node); });
    observedAnchors = current;
  }

  function showResolvedVisuals() { return state.filter !== "open"; }

  // Make a DOM or SVG marker keyboard-operable: focusable, announced by name,
  // and activated with Enter / Space (mirrors the mouse click). Returns nothing.
  function makeMarkerInteractive(node, c, idx, verb) {
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-label", (verb || "Annotation") + " comment #" + idx +
      ": " + (c.text || "no text").slice(0, 120));
    listen(node, "keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault(); ev.stopPropagation(); focusComment(c.id, true);
      }
    });
  }

  // Count full occurrences of a needle in the page text. Overlapping matches
  // each count (advancing by one, not by the needle length, so e.g. "ana"
  // inside "banana" is counted twice rather than once).
  function countOccurrences(full, needle) {
    if (!needle) return 0;
    var count = 0, at = 0;
    while ((at = full.indexOf(needle, at)) >= 0) { count++; if (count > 1) return count; at += 1; }
    return count;
  }
  function countMatches(needle, legacy) {
    var nodes = getTextNodes(), full = "";
    if (legacy) nodes = nodes.filter(function (node) { return !!node.nodeValue.trim(); });
    for (var i = 0; i < nodes.length; i++) full += nodes[i].nodeValue;
    return countOccurrences(full, needle);
  }

  // Decide whether a saved quote can be highlighted honestly:
  //  - the saved prefix+exact+suffix context occurs exactly once, or
  //  - the context is gone but the exact text occurs exactly once
  //    (the rangeFromQuote fallback is then unambiguous),
  // otherwise the anchor is ambiguous (2+ candidates) or lost (0).
  function resolveHighlightAnchor(q) {
    var context = (q.prefix || "") + q.exact + (q.suffix || "");
    var contextCount = countMatches(context);
    if (contextCount === 1) return { status: "ok" };
    // Earlier versions omitted whitespace-only text nodes when saving context.
    // Try that stream only when the current stream has no contextual match;
    // multiple current matches must remain ambiguous.
    if (contextCount === 0 && countMatches(context, true) === 1)
      return { status: "ok", legacy: true };
    var exactCount = countMatches(q.exact);
    if (exactCount === 1) return { status: "ok" };
    if (exactCount === 0 && countMatches(q.exact, true) === 1) return { status: "ok", legacy: true };
    return { status: exactCount === 0 ? "lost" : "ambiguous" };
  }

  // Explicit "can't find your text" marker instead of a silent guess: shown
  // when a highlight's quote has disappeared (0 matches) or been duplicated
  // (2+ matches) since it was written. `slot` is the pre-computed stack index
  // among unanchored comments (see renderAll) so positioning stays O(1).
  function unanchoredPill(c, slot) {
    var idx = state.comments.indexOf(c) + 1;
    var pill = el("div", { class: "an-unanchored-pill", title: "The quoted text for comment #" + idx +
      " can’t be found (or appears multiple times), so it isn’t highlighted. Open the comment for details." },
      [el("span", { html: ICONS.alert }), el("span", { text: "Moved or duplicated — #" + idx })]);
    pill.style.top = (16 + slot * 34 + window.scrollY) + "px";
    pill.style.left = "16px";
    pill.style.pointerEvents = "auto";
    listen(pill, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    makeMarkerInteractive(pill, c, idx, "Unanchored note");
    pinLayer.appendChild(pill);
  }

  function renderAll() {
    if (destroyed || !booted || drawing || pendingDraft) return;
    ensureOverlay();
    if (!state.enabled) { clearVisuals(); updateCount(); return; }
    clearVisuals();
    anchorCache = {};
    sizeOverlay();
    // Running stack slots so the floating "unanchored" / "anchor missing"
    // markers don't each scan the whole comment list to find their offset.
    var unanchoredSlot = 0, missingSlot = 0;
    state.comments.forEach(function (c) {
      if (c.resolved && !showResolvedVisuals()) return;
      if (c.type === "highlight" && c.anchor) {
        var resolved = resolveHighlightAnchor(c.anchor);
        var status = resolved.status;
        if (status !== "ok") {
          // "lost" = the quoted text vanished; "ambiguous" = it can no longer
          // identify one intended target. Surface it — never guess a copy.
          c.__unanchored = status;
          unanchoredPill(c, unanchoredSlot++);
          return;
        }
        c.__unanchored = false;
        var r = rangeFromQuote(c.anchor, resolved.legacy);
        if (r) {
          var marks = paintRange(r, c.color, c.id);
          marks.forEach(function (m) {
            listen(m, "click", function (ev) {
              ev.stopPropagation(); focusComment(c.id, true);
            });
            makeMarkerInteractive(m, c, state.comments.indexOf(c) + 1, "Highlight");
            if (c.id === state.activeId) m.classList.add("an-active");
          });
        }
      } else if (c.geom && (c.type === "shape" || c.type === "pen")) {
        renderGeom(c, missingSlot);
        if (c.__anchorMissing) missingSlot++;
      } else if (c.type === "pin" && c.geom) {
        renderPin(c, missingSlot);
        if (c.__anchorMissing) missingSlot++;
      } else if (c.type === "block" && c.geom) {
        renderBlock(c);
      }
    });
    observeAnchors();
    updateCount();
  }

  function anchorVisible(node) {
    if (!node || !node.isConnected) return false;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    var box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
  }

  function renderBlock(c) {
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : null;
    if (!anchorVisible(anchorEl)) return;
    var box = docBox(anchorEl);
    rememberAnchor(c, box);
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
    listen(tab, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    makeMarkerInteractive(tab, c, idx, "Section");
    pinLayer.appendChild(tab);
  }

  function viewportMismatch(g) {
    return g && g.vw && Math.abs(g.vw - window.innerWidth) > 200;
  }
  function renderGeom(c, missingSlot) {
    // A shape only makes sense relative to its anchor element. If that
    // element no longer exists we must NOT silently redraw the shape over
    // <body> — that pretends the annotation still lives where it was meant
    // to. Draw only when the anchor can be resolved; otherwise surface a
    // floating "anchor missing" badge the user can open to reposition or delete.
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : null;
    if (!anchorEl) { c.__anchorMissing = true; renderMissingAnchor(c, missingSlot); return; }
    c.__anchorMissing = false;
    if (!anchorVisible(anchorEl)) return;
    var box = docBox(anchorEl);
    rememberAnchor(c, box);
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
    listen(node, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    overlay.appendChild(node);
    var fx = g.kind === "pen" ? g.points[0][0] : g.x;
    var fy = g.kind === "pen" ? g.points[0][1] : g.y;
    var bx = box.x + fx * box.w, by = box.y + fy * box.h;
    var idx = state.comments.indexOf(c) + 1;
    var badge = svgEl("g", {});
    var badgeR = viewportMismatch(g) ? 13 : 11;
    var badgeFill = viewportMismatch(g) ? "#f59e0b" : c.color;
    var circ = svgEl("circle", { cx: bx, cy: by, r: badgeR, fill: badgeFill, stroke: "#fff", "stroke-width": 2 });
    var txt = svgEl("text", { x: bx, y: by + 4, "text-anchor": "middle", fill: "#fff",
      "font-size": "11", "font-weight": "700", "font-family": "Inter, sans-serif" });
    txt.textContent = viewportMismatch(g) ? "⚠" : idx;
    if (viewportMismatch(g)) {
      var badgeTitle = svgEl("title");
      badgeTitle.textContent = "Drawn at " + g.vw + "px wide — positions may differ on this viewport";
      badge.appendChild(badgeTitle);
    }
    badge.appendChild(circ); badge.appendChild(txt);
    badge.style.cursor = "pointer";
    badge.style.pointerEvents = "all";
    listen(badge, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    makeMarkerInteractive(badge, c, idx, "Shape");
    overlay.appendChild(badge);
  }

  // Floating badge shown when a shape/pin anchor element no longer exists.
  // Positioned at a stable page offset (never over <body>, which would imply
  // the annotation still has a valid position).
  function renderMissingAnchor(c, missingSlot) {
    var idx = state.comments.indexOf(c) + 1;
    var badgeR = 13;
    var bx = 40 + missingSlot * 36;
    var by = 40 + window.scrollY;
    var badge = svgEl("g", {});
    var circ = svgEl("circle", { cx: bx, cy: by, r: badgeR, fill: "#f59e0b", stroke: "#fff", "stroke-width": 2, class: "an-badge-circle" });
    var title = svgEl("title");
    title.textContent = "The element this comment points to no longer exists — it is not drawn in place.";
    circ.setAttribute("title", "Anchor element missing");
    var txt = svgEl("text", { x: bx, y: by + 4, "text-anchor": "middle", fill: "#fff",
      "font-size": "11", "font-weight": "700", "font-family": "Inter, sans-serif" });
    txt.textContent = idx;
    badge.appendChild(title); badge.appendChild(circ); badge.appendChild(txt);
    badge.style.cursor = "pointer";
    badge.style.pointerEvents = "all";
    listen(badge, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    makeMarkerInteractive(badge, c, idx, "Annotation (anchor missing)");
    overlay.appendChild(badge);
  }

  function renderPin(c, missingSlot) {
    var anchorEl = c.geom.selector ? resolveAnchorEl(c.geom.selector) : null;
    if (!anchorEl && c.geom.selector !== "body") { c.__anchorMissing = true; renderMissingAnchor(c, missingSlot); return; }
    if (!anchorEl) anchorEl = document.body;
    c.__anchorMissing = false;
    if (!anchorVisible(anchorEl)) return;
    var box = docBox(anchorEl);
    rememberAnchor(c, box);
    var idx = state.comments.indexOf(c) + 1;
    var pin = el("div", { class: "an-pin" + (c.id === state.activeId ? " an-active" : ""), title: c.text || "" },
      [el("span", { text: String(idx) })]);
    pin.style.background = c.color;
    pin.style.left = (box.x + c.geom.x * box.w) + "px";
    pin.style.top = (box.y + c.geom.y * box.h) + "px";
    pin.style.pointerEvents = "auto";
    listen(pin, "click", function (ev) { ev.stopPropagation(); focusComment(c.id, true); });
    makeMarkerInteractive(pin, c, idx, "Pin");
    pinLayer.appendChild(pin);
  }

  // ==========================================================================
  // COMPOSER (new comment popover)
  // ==========================================================================
  var composer, pendingDraft = null, composerShownAt = 0;
  function ensureComposer() {
    if (composer) return;
    composer = el("div", { id: "__an_compose" });
    ensureHost().appendChild(composer);
    listen(document, "pointerdown", function (e) {
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
    listen(save, "click", function () {
      if (!state.author && hasInvite()) {
        // An invite link names the reviewer through the session exchange,
        // which may still be in flight: wait for it instead of asking. If it
        // fails without a name, fall back to asking.
        save.disabled = true;
        ensureSession().then(null, function () {}).then(function () {
          save.disabled = false;
          if (state.author || !hasInvite()) save.click();
          else askName(function () { save.click(); });
        });
        return;
      }
      if (!state.author) { askName(function () { save.click(); }); return; }
      draft.author = state.author;
      draft.text = ta.value.trim();
      commitDraft(draft);
    });
    listen(cancel, "click", cancelDraft);
    listen(ta, "keydown", function (e) {
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
    ensureHost().appendChild(wrap);
    var releaseTrap = trapFocus(wrap);
    function done() {
      state.author = input.value.trim() || "Anonymous";
      store.set("an-author", state.author);
      releaseTrap();
      wrap.remove();
      renderNote();
      if (REMOTE && !sync.token) startSync();
      if (onDone) onDone();
    }
    listen(btn, "click", done);
    listen(input, "keydown", function (e) { if (e.key === "Enter") done(); });
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
    tempMarks.forEach(function (m) { m.remove(); });
    delete highlightRanges.__temp;
    tempMarks = [];
  }
  function cancelDraft() {
    pendingDraft = null;
    clearTemp();
    if (composer) composer.classList.remove("an-show");
    setTool("cursor");
  }
  function commitDraft(draft) {
    if (destroyed || pendingDraft !== draft) return;
    var c = createComment(draft);
    if (!c) return;
    composer.classList.remove("an-show");
    clearTemp();
    state.comments.push(c);
    pendingDraft = null;
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
  listen(document, "pointerup", function (e) {
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
        geom: { kind: "pin", selector: cssPath(anchorEl), x: clamp01(fx), y: clamp01(fy),
          vw: window.innerWidth, vh: window.innerHeight },
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
      // Capture pointer so pointermove/pointerup are reliably delivered during touch drawing
      if (e.pointerId != null && overlay && overlay.setPointerCapture)
        try { overlay.setPointerCapture(e.pointerId); } catch (ex) {}
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
        points: d.points.map(function (p) { return [(p[0] - box.x) / box.w, (p[1] - box.y) / box.h]; }),
        vw: window.innerWidth, vh: window.innerHeight };
    } else {
      var x0 = Math.min(d.startX, e.pageX), y0 = Math.min(d.startY, e.pageY);
      var w = Math.abs(e.pageX - d.startX), h = Math.abs(e.pageY - d.startY);
      if (w < 6 && h < 6) { clearSel(); justCancelledDraw = true; return setTool("cursor"); }
      geom = { kind: d.tool === "circle" ? "circle" : "rect", selector: cssPath(d.anchorEl),
        x: (x0 - box.x) / box.w, y: (y0 - box.y) / box.h, w: w / box.w, h: h / box.h,
        vw: window.innerWidth, vh: window.innerHeight };
    }
    openComposer(e.clientX + 6, e.clientY + 6, { type: d.tool === "pen" ? "pen" : "shape", color: state.color, geom: geom });
  }
  var SEMANTIC_TAGS = /^(MAIN|ARTICLE|SECTION|ASIDE|HEADER|FOOTER|NAV)$/;
  var CONTAINER_CLASSES = /\b(container|wrap(?:per)?|content|layout|inner|page)\b/;
  function pickAnchor(target) {
    var n = target;
    while (n && n !== document.body) {
      if (isOurs(n)) { n = n.parentElement; continue; }
      var hasId = !!n.id;
      var isSemantic = SEMANTIC_TAGS.test(n.nodeName);
      var isContainer = n.classList && CONTAINER_CLASSES.test(n.className);
      if (hasId || isSemantic || isContainer) {
        var r = n.getBoundingClientRect();
        if (r.width > 80 && r.height > 40) return n;
      }
      n = n.parentElement;
    }
    return document.body;
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  listen(document, "pointerdown", onDown, true);
  listen(document, "pointermove", onMove, true);
  listen(document, "pointerup", onUp, true);

  // ==========================================================================
  // TOOLBAR + PANEL UI
  // ==========================================================================
  var bar, panel, listEl, footEl, countBadge, hintEl, launchEl, helpEl, noteEl;
  var SIDE = CFG.position === "bottom-left" ? "an-left" : "an-right";
  function buildUI() {
    var style = el("style", { id: "__an_style", html: CSS_TEXT });
    var _nonce = SCRIPT && (SCRIPT.nonce || SCRIPT.getAttribute("nonce"));
    if (_nonce) style.setAttribute("nonce", _nonce);
    document.head.appendChild(style);
    applyTheme();
    if (CFG.accent) {
      ensureHost().style.setProperty("--an-btn-bg", CFG.accent);
      ensureHost().style.setProperty("--an-btn-fg", "#fff");
    }

    var root = el("div", { id: "__an_root" });
    ensureHost().appendChild(root);

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
      listen(b, "click", function () { setTool(t[0]); });
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
      listen(sw, "click", function (e) {
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
    listen(colorBtn, "click", function (e) { e.stopPropagation(); colorPop.classList.toggle("an-show"); });
    listen(document, "click", function () { colorPop.classList.remove("an-show"); });
    bar.appendChild(colorBtn);
    bar.appendChild(el("div", { class: "an-sep" }));

    var listBtn = el("button", { class: "an-btn", "data-tip": "Comments  ·  A", title: "Comments  ·  A", "aria-label": "Comments", html: ICONS.list });
    countBadge = el("span", { class: "an-count" }); countBadge.style.display = "none";
    listBtn.appendChild(countBadge);
    listen(listBtn, "click", togglePanel);
    bar.appendChild(listBtn);

    var offBtn = el("button", { class: "an-btn", "data-tip": "Hide review tools  ·  O", title: "Hide review tools  ·  O", "aria-label": "Hide review tools", html: ICONS.hide });
    listen(offBtn, "click", function () { setEnabled(false); });
    bar.appendChild(offBtn);
    root.appendChild(bar);

    launchEl = el("button", { id: "__an_launch", class: SIDE, html: ICONS.bubble + "<span>Review</span>" });
    listen(launchEl, "click", function () {
      if (!state.author && !hasInvite() && !authHook) askName(function () { setEnabled(true); });
      else setEnabled(true);
    });
    ensureHost().appendChild(launchEl);

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
    listen(searchInput, "input", function () {
      state.query = searchInput.value.toLowerCase();
      renderPanel();
    });
    search.appendChild(searchInput);
    var filters = el("div", { class: "an-filters" });
    [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].forEach(function (f) {
      var ch = el("span", { class: "an-chip" + (state.filter === f[0] ? " an-on" : ""), "data-f": f[0], text: f[1] });
      listen(ch, "click", function () {
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

    listen(document, "keydown", function (e) {
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
    listen(window, "resize", function () { clearTimeout(rt); rt = setTimeout(renderAll, 150); });
    // Keep tabs in sync: reload annotations when another tab writes to storage
    listen(window, "storage", function (e) {
      if (e.key === STORE_KEY) backgroundLoad();
      else if (REMOTE && e.key === QUEUE_KEY) syncChanged();
    });
    if (REMOTE) {
      // Poll only while the page is visible; catch up as soon as it is.
      listen(document, "visibilitychange", function () { if (!document.hidden) poll(); });
      listen(window, "online", function () { sync.failures = 0; scheduleFlush(0); poll(); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(renderAll, 60); });
    listen(window, "load", function () { setTimeout(renderAll, 120); });
    // Keep overlays aligned after layout changes (lazy images, dynamic
    // content, nested scroll containers, SPA route swaps). Coalesced to one
    // pass per frame; a full re-render happens only when an annotation anchor
    // actually moved, so idle layout churn never restarts markers mid-animation.
    if (typeof ResizeObserver !== "undefined") {
      var _roRaf = 0;
      var _scRaf = 0;
      function relayout() {
        if (!overlay || drawing || pendingDraft) return;
        sizeOverlay();
        if (anchorsMoved() || Object.keys(highlightRanges).length) renderAll();
      }
      var _ro = new ResizeObserver(function () {
        if (_roRaf) return;
        _roRaf = requestAnimationFrame(function () { _roRaf = 0; relayout(); });
      });
      _anchorRO = _ro;
      observedBody = document.body;
      _ro.observe(observedBody);
      // capture:true so scrolls inside nested scrollable containers count too
      listen(document, "scroll", function () {
        if (_scRaf) return;
        _scRaf = requestAnimationFrame(function () { _scRaf = 0; relayout(); });
      }, { passive: true, capture: true });
    }
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
    ensureHost().classList.toggle("an-dark", !!dark);
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
    ensureHost().appendChild(plusBtn);
    listen(plusBtn, "click", function (e) {
      e.stopPropagation();
      if (!plusTarget) return;
      var r = plusTarget.getBoundingClientRect();
      openComposer(r.left, r.bottom + 6, {
        type: "block", color: state.color,
        geom: { kind: "block", selector: cssPath(plusTarget) },
      });
      hidePlus(true);
    });
    listen(plusBtn, "mouseenter", function () { clearTimeout(plusHideTimer); });
    listen(plusBtn, "mouseleave", function () { hidePlus(); });

    var _plusMoveRaf = null;
    listen(document, "mousemove", function (e) {
      if (_plusMoveRaf) return;
      _plusMoveRaf = requestAnimationFrame(function () {
        _plusMoveRaf = null;
        if (!state.enabled) return;
        if (state.tool !== "cursor" && state.tool !== "highlight") { hidePlus(true); return; }
        if (drawing) return;
        var blk = eligibleBlock(e.target || document.elementFromPoint(e.clientX, e.clientY));
        if (blk && blk !== plusTarget) { plusTarget = blk; positionPlus(blk); }
        if (!plusTarget) return;
        if (inKeepZone(e.clientX, e.clientY)) {
          clearTimeout(plusHideTimer);
          plusBtn.classList.add("an-show");
        } else {
          hidePlus();
        }
      });
    });
    // Touch: long-press any eligible block to reveal the + button
    var touchHoldTimer = null, touchHoldTarget = null;
    listen(document, "touchstart", function (e) {
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
    listen(document, "touchend", function () { clearTimeout(touchHoldTimer); touchHoldTarget = null; }, { passive: true });
    listen(document, "touchmove", function () { clearTimeout(touchHoldTimer); touchHoldTarget = null; }, { passive: true });
    listen(window, "scroll", function () { if (plusTarget) positionPlus(plusTarget); }, { passive: true });
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
    watchContent();
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
    listen(panel, "touchstart", function (e) {
      if (window.innerWidth > 640) return;
      startY = e.touches[0].clientY;
      startScrollTop = listEl ? listEl.scrollTop : 0;
      dragging = false;
    }, { passive: true });
    listen(panel, "touchmove", function (e) {
      if (window.innerWidth > 640) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 0 && startScrollTop <= 0) { dragging = true; }
    }, { passive: true });
    listen(panel, "touchend", function (e) {
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
  function visibleComments(unread) {
    unread = unread || {};
    return state.comments.filter(function (c) {
      // A comment the review owner just closed stays under Open until the
      // reviewer has seen it, so a disposal is never silent.
      if (state.filter === "open" && c.resolved && !unread[c.id]) return false;
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
  // Background renders (sync merges, other tabs) must never eat what the
  // reviewer is typing: open reply/edit boxes, their text, focus and caret
  // are captured by comment id and restored on the rebuilt cards.
  var preservingDrafts = false;
  function captureDrafts() {
    var drafts = {};
    if (!preservingDrafts || !listEl) return drafts;
    Array.prototype.forEach.call(listEl.querySelectorAll(".an-card"), function (card) {
      var entry = {}, keep = false;
      [["reply", ".an-replybox"], ["edit", ".an-editbox"]].forEach(function (pair) {
        var box = card.querySelector(pair[1]), ta = box && box.querySelector("textarea");
        if (!box || !ta || !box.classList.contains("an-show")) return;
        entry[pair[0]] = { value: ta.value, focus: document.activeElement === ta,
          start: ta.selectionStart, end: ta.selectionEnd };
        keep = true;
      });
      if (keep) drafts[card.getAttribute("data-id")] = entry;
    });
    return drafts;
  }
  function restoreDraft(entry, box, ta) {
    if (!entry) return;
    box.classList.add("an-show");
    ta.value = entry.value;
    if (entry.focus) {
      ta.focus({ preventScroll: true });
      try { ta.setSelectionRange(entry.start, entry.end); } catch (e) {}
    }
  }
  function backgroundLoad() {
    preservingDrafts = true;
    try { loadData(); } finally { preservingDrafts = false; }
  }
  function renderPanel() {
    if (!listEl) return;
    var drafts = captureDrafts();
    listEl.innerHTML = "";
    var unread = unreadIds();
    var list = visibleComments(unread);
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
        c.status === "resolved" ? el("span", { class: "an-rbadge", html: ICONS.check + "<span>Resolved</span>" })
          : c.status !== "open" && STATUSES[c.status] ? el("span", { class: "an-sbadge an-s-" + c.status, text: STATUSES[c.status] }) : null,
        el("span", { class: "an-when", text: fmtTime(c.createdAt) }),
      ]);
      card.appendChild(meta);
      if (unread[c.id]) {
        card.classList.add("an-unread");
        card.appendChild(el("button", { class: "an-newpill", title: "Mark as seen", text: "Updated · mark as seen", onclick: function (e) {
          e.stopPropagation(); acknowledge(c.id); renderPanel();
        } }));
      }
      if (c.assignee)
        card.appendChild(el("div", { class: "an-assignee", text: "Assigned to " + c.assignee.name }));
      if (c.resolved)
        card.appendChild(el("div", { class: "an-disposal", text: STATUSES[c.status] +
          (c.resolvedBy ? " by " + whoIs(c, c.resolvedBy) : "") + (c.resolvedAt ? " · " + fmtTime(c.resolvedAt) : "") }));
      if (c.type === "highlight" && c.anchor && c.anchor.exact)
        card.appendChild(el("div", { class: "an-quote", text: '“' + c.anchor.exact + '”' }));
      var bodyEl = el("div", { class: "an-body", text: c.text || "" });
      if (c.text) card.appendChild(bodyEl);

      if (c.replies && c.replies.length) {
        var rep = el("div", { class: "an-replies" });
        c.replies.forEach(function (r) {
          var replyRow = el("div", { class: "an-reply" }, [
            avatarEl(r.author, 18),
            el("span", { style: "flex:1;min-width:0" }, [
              el("span", { class: "an-rwho", text: r.author }),
              document.createTextNode(r.text),
              el("span", { class: "an-rwhen", text: fmtTime(r.createdAt) }),
            ]),
          ]);
          if (isMine(r)) {
            var rAct = el("span", { style: "display:flex;gap:4px;flex:none;margin-left:6px" });
            var rDel = el("button", { class: "an-mini an-danger", html: ICONS.trash, title: "Delete reply" });
            listen(rDel, "click", function (e) {
              e.stopPropagation();
              var updated = patchComment(c.id, { deleteReply: r.id });
              if (updated) { mergeComment(updated); renderPanel(); }
            });
            rAct.appendChild(rDel);
            replyRow.appendChild(rAct);
          }
          rep.appendChild(replyRow);
        });
        card.appendChild(rep);
      }

      var rbox = el("div", { class: "an-replybox" });
      var rin = el("textarea", { class: "an-ta", rows: "2", placeholder: "Reply… (Ctrl+↵ to post)" });
      rbox.appendChild(rin);
      var rsend = el("button", { class: "an-primary", style: "margin-top:6px;align-self:flex-end", text: "Reply" });
      rbox.appendChild(rsend);
      function submitReply() {
        if (!rin.value.trim()) return;
        var reply = { id: uid(), author: state.author || "Anonymous", text: rin.value.trim(), createdAt: new Date().toISOString() };
        var updated = patchComment(c.id, { reply: reply });
        if (!updated) return;
        // patchComment refuses the reply once the thread hits MAX_REPLIES but
        // still returns the (unchanged) comment. Detect that so we don't discard
        // the user's draft or pretend the reply was saved.
        var added = updated.replies.some(function (r) { return r.id === reply.id; });
        if (!added) {
          toast("This thread has reached its reply limit.", { kind: "error" });
          return;
        }
        rin.value = ""; mergeComment(updated); renderPanel();
      }
      listen(rsend, "click", function (e) { e.stopPropagation(); submitReply(); });
      listen(rin, "keydown", function (e) {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitReply();
      });
      card.appendChild(rbox);

      var ebox = el("div", { class: "an-editbox" });
      var eta = el("textarea", { class: "an-ta", rows: "2" });
      var esave = el("button", { class: "an-primary", text: "Save" });
      ebox.appendChild(eta);
      ebox.appendChild(el("div", { style: "display:flex;justify-content:flex-end" }, [esave]));
      listen(eta, "keydown", function (e) {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") esave.click();
      });
      listen(esave, "click", function (e) {
        e.stopPropagation();
        var updated = patchComment(c.id, { text: eta.value.trim() });
        if (updated) { mergeComment(updated); renderPanel(); }
      });
      card.appendChild(ebox);

      var hbox = el("div", { class: "an-history" });
      if (historyOpen[c.id]) { hbox.classList.add("an-show"); fillHistory(c, hbox); }
      var act = el("div", { class: "an-cact" }, [
        el("button", { class: "an-mini", html: ICONS.reply + "<span>Reply</span>", onclick: function (e) {
          e.stopPropagation(); rbox.classList.toggle("an-show"); rin.focus();
        } }),
        el("button", { class: "an-mini", html: (c.resolved ? "" : ICONS.check) + "<span>" + (c.resolved ? "Reopen" : "Resolve") + "</span>", onclick: function (e) {
          e.stopPropagation();
          var updated = patchComment(c.id, { resolved: !c.resolved });
          if (updated) { mergeComment(updated); renderAll(); renderPanel(); }
        } }),
        !REMOTE || isReviewAuthor() ? statusSelect(c) : null,
        assignButton(c),
        isMine(c) ? el("button", { class: "an-mini", html: ICONS.edit + "<span>Edit</span>", onclick: function (e) {
          e.stopPropagation();
          eta.value = c.text || "";
          ebox.classList.toggle("an-show");
          eta.focus();
        } }) : null,
        el("button", { class: "an-mini an-histbtn", text: "History", "aria-expanded": historyOpen[c.id] ? "true" : "false", onclick: function (e) {
          e.stopPropagation();
          historyOpen[c.id] = !historyOpen[c.id];
          if (historyOpen[c.id]) { hbox.classList.add("an-show"); fillHistory(c, hbox); }
          else { delete historyOpen[c.id]; hbox.classList.remove("an-show"); }
          this.setAttribute("aria-expanded", historyOpen[c.id] ? "true" : "false");
        } }),
        el("button", { class: "an-mini", html: ICONS.link, title: "Copy link to this comment", onclick: function (e) {
          e.stopPropagation(); copyLink(c.id);
        } }),
        canDelete(c) ? el("button", { class: "an-mini an-danger", html: ICONS.trash, title: "Delete", onclick: function (e) {
          e.stopPropagation(); deleteComment(c);
        } }) : null,
      ]);
      card.appendChild(act);
      card.appendChild(hbox);

      listen(card, "click", function () { focusComment(c.id, false); });
      listEl.appendChild(card);
      // Restore after attaching: a detached textarea cannot take focus.
      if (drafts[c.id]) {
        restoreDraft(drafts[c.id].reply, rbox, rin);
        if (isMine(c)) restoreDraft(drafts[c.id].edit, ebox, eta);
      }
    });
    updateCount();
    renderFooter();
  }

  // Display name for a reviewer id seen on a comment. Anyone other than
  // the reviewer who can touch a reviewer's comment is a review author.
  function whoIs(c, id) {
    if (id && id === state.authorId) return "you";
    if (c.authorId === id) return c.author;
    if (c.assignee && c.assignee.id === id) return c.assignee.name;
    for (var i = c.replies.length - 1; i >= 0; i--) if (c.replies[i].authorId === id) return c.replies[i].author;
    return "the review owner";
  }

  // HISTORY — a comment's lifecycle, oldest first. With a backend it is the
  // server's activity log; locally (or offline) it is derived from the
  // record's own timestamps, which keeps the latest of each transition.
  var historyOpen = {}, historyCache = {};
  function derivedHistory(c) {
    var events = [{ at: c.createdAt, by: { id: c.authorId, name: c.author }, kind: "created" }];
    if (c.editedAt) events.push({ at: c.editedAt, by: { id: c.authorId, name: c.author }, kind: "edited" });
    if (c.assignedAt && c.assignee) events.push({ at: c.assignedAt, by: null, kind: "assigned", to: c.assignee });
    c.replies.forEach(function (r) { events.push({ at: r.createdAt, by: { id: r.authorId, name: r.author }, kind: "replied" }); });
    if (c.resolved && c.resolvedAt) events.push({ at: c.resolvedAt, by: c.resolvedBy ? { id: c.resolvedBy, name: whoIs(c, c.resolvedBy) } : null, kind: "status", to: c.status });
    return events.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  }
  function describeEvent(e) {
    var mine = e.by && (e.by.id ? e.by.id === state.authorId : !state.authorId && e.by.name === state.author);
    var who = !e.by ? "" : mine ? "You" : e.by.name || "Someone";
    var label = function (s) { return STATUSES[s] || s; };
    var what = {
      created: "raised this comment",
      edited: "edited the comment",
      status: e.from ? "changed status: " + label(e.from) + " → " + label(e.to) : "marked it " + label(e.to),
      assigned: e.to ? "assigned it to " + e.to.name : "removed the assignee",
      replied: "replied",
      reply_deleted: "deleted a reply",
      deleted: "deleted the comment",
    }[e.kind] || e.kind;
    return (who ? who + " " : "") + (who ? what : what.charAt(0).toUpperCase() + what.slice(1));
  }
  function drawHistory(box, events, note) {
    box.innerHTML = "";
    var listNode = el("ol", { class: "an-hlist" });
    events.forEach(function (e) {
      listNode.appendChild(el("li", {}, [
        el("span", { text: describeEvent(e) }),
        el("span", { class: "an-hwhen", text: e.at ? fmtTime(e.at) : "" }),
      ]));
    });
    box.appendChild(listNode);
    if (note) box.appendChild(el("div", { class: "an-hnote", text: note }));
  }
  function fillHistory(c, box) {
    var stamp = REMOTE ? serverStamps(dbRead())[c.id] : null;
    if (!REMOTE || !stamp || !sync.token) {
      drawHistory(box, derivedHistory(c), REMOTE ? "Full history appears once this comment is saved to the review." : "");
      return;
    }
    var cached = historyCache[c.id];
    if (cached && cached.stamp === stamp) { drawHistory(box, cached.events); return; }
    drawHistory(box, derivedHistory(c), "Loading full history…");
    apiFetch("GET", "/comments/" + encodeURIComponent(c.id) + "/activity").then(function (r) {
      if (destroyed || !r.data || !Array.isArray(r.data.events)) throw new Error("unavailable");
      var events = r.data.events.filter(function (e) { return e && typeof e.kind === "string" && typeof e.at === "string"; });
      historyCache[c.id] = { stamp: stamp, events: events };
      if (box.isConnected) drawHistory(box, events);
    }).catch(function () {
      if (!destroyed && box.isConnected) drawHistory(box, derivedHistory(c), "Showing a summary — the full history could not be loaded.");
    });
  }

  // Lifecycle controls: the creator may move a comment between states;
  // only review authors assign it. Only the creator edits it.
  function setCommentStatus(id, status) {
    if (!STATUSES[status]) throw new Error("Unknown status: " + status);
    var updated = patchComment(id, { status: status });
    if (updated) { mergeComment(updated); renderAll(); renderPanel(); }
    return updated;
  }
  function setCommentAssignee(id, assignee) {
    var updated = patchComment(id, { assignee: assignee || null });
    if (updated) { mergeComment(updated); renderPanel(); }
    return updated;
  }
  function statusSelect(c) {
    var select = el("select", { class: "an-status", "aria-label": "Status", title: "Status" });
    Object.keys(STATUSES).forEach(function (key) {
      var option = el("option", { value: key, text: STATUSES[key] });
      if (key === c.status) option.selected = true;
      select.appendChild(option);
    });
    listen(select, "click", function (e) { e.stopPropagation(); });
    listen(select, "change", function (e) { e.stopPropagation(); setCommentStatus(c.id, select.value); });
    return select;
  }
  function assignButton(c) {
    if (!isReviewAuthor()) return null;
    var me = { id: state.authorId, name: state.author || "Anonymous" };
    var mineNow = c.assignee && (c.assignee.id && me.id ? c.assignee.id === me.id : c.assignee.name === me.name);
    return el("button", { class: "an-mini", text: mineNow ? "Unassign" : "Assign to me",
      title: mineNow ? "Stop working on this" : "Take this on", onclick: function (e) {
        e.stopPropagation(); setCommentAssignee(c.id, mineNow ? null : me);
      } });
  }

  // --------------------------------------------------------------------------
  // EXPORT / IMPORT — share a page's review as a portable JSON file
  // --------------------------------------------------------------------------
  function downloadJSON(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    objectUrls.add(url);
    var a = el("a", { href: url, download: filename });
    ensureHost().appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); objectUrls.delete(url); }, 1000);
  }

  function buildExportPayload(allowEmpty) {
    var comments = state.comments.map(serialize);
    if (!comments.length && !allowEmpty) return null;
    return {
      annotate: VERSION,
      schema: SCHEMA,
      kind: "annotate-export",
      exportedAt: new Date().toISOString(),
      page: PAGE,
      url: location.href,
      project: CFG.project || "",
      exportedViewport: { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      comments: comments,
    };
  }

  function exportComments() {
    var payload = buildExportPayload();
    if (!payload) {
      toast("No comments on this page to export", { kind: "info" });
      return;
    }
    var comments = payload.comments;
    var slug = (PAGE || "page").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
    var stamp = new Date().toISOString().slice(0, 10);
    downloadJSON(payload, "annotate-" + slug + "-" + stamp + ".json");
    toast("Exported " + comments.length + " comment" + (comments.length === 1 ? "" : "s"), { kind: "success" });
  }

  // With a backend, submit means "every queued change is acknowledged";
  // data-post-url, when also set, then receives the snapshot as in 1.4.
  function submitAll() {
    if (!REMOTE) return submitFeedback();
    return flushAll().then(function () {
      if (CFG.postUrl) return submitFeedback();
      if (!destroyed) toast("All changes saved to the review", { kind: "success" });
      return buildExportPayload(true);
    }, function (error) {
      if (!destroyed) toast("Could not save to the review: " + error.message, { kind: "error", duration: 8000 });
      throw error;
    });
  }

  var submitting = null, postController = null;
  function submitFeedback() {
    if (submitting) return submitting;
    var payload = buildExportPayload();
    var endpoint;
    try { endpoint = new URL(CFG.postUrl, location.href); } catch (e) {}
    if (!CFG.postUrl || !endpoint || !/^https?:$/.test(endpoint.protocol)) return Promise.reject(new Error("Configure an HTTP(S) postUrl first"));
    if (!payload) { toast("No comments to send yet", { kind: "info" }); return Promise.reject(new Error("No comments to send")); }
    postController = window.AbortController ? new window.AbortController() : null;
    var timeout = setTimeout(function () { if (postController) postController.abort(); }, 30000);
    toast("Sending feedback…", { kind: "info" });
    submitting = window.fetch(endpoint.href, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), credentials: "omit", signal: postController ? postController.signal : undefined })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        if (!destroyed) toast("Feedback sent", { kind: "success" });
        return payload;
      }).catch(function (error) {
        if (!destroyed) toast("Could not send feedback: " + error.message + ". Your comments are still saved locally.", { kind: "error", duration: 8000 });
        throw error;
      }).finally(function () { clearTimeout(timeout); submitting = null; postController = null; });
    return submitting;
  }

  function copyComments() {
    var payload = buildExportPayload();
    if (!payload) {
      toast("No comments on this page to copy", { kind: "info" });
      return;
    }
    copyText(JSON.stringify(payload, null, 2), "Comments copied as JSON");
  }

  function pickImportFile() {
    var inp = el("input", { type: "file", accept: "application/json,.json" });
    inp.style.display = "none";
    ensureHost().appendChild(inp);
    listen(inp, "change", function () {
      var f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        if (destroyed) return;
        var data;
        try { data = JSON.parse(reader.result); }
        catch (e) { toast("That file isn’t valid JSON", { kind: "error" }); return; }
        importComments(data);
      };
      reader.onerror = function () { if (destroyed) return; toast("Couldn’t read that file", { kind: "error" }); };
      reader.readAsText(f);
    });
    inp.click();
  }

  var MAX_EXPORT_COMMENTS = 5000;
  function isFiniteNum(v) { return typeof v === "number" && isFinite(v); }
  function isValidGeom(g) {
    if (!g || typeof g !== "object" || typeof g.kind !== "string") return false;
    if (g.kind === "pin")
      return isFiniteNum(g.x) && isFiniteNum(g.y);
    // Rect/circle are positioned and sized relative to their anchor element;
    // both dimensions must be finite numbers or rendering would produce NaN.
    if (g.kind === "rect" || g.kind === "circle")
      return isFiniteNum(g.x) && isFiniteNum(g.y) && isFiniteNum(g.w) && isFiniteNum(g.h);
    if (g.kind === "pen")
      return Array.isArray(g.points) && g.points.length >= 2 && g.points.length <= 10000 &&
        g.points.every(function (p) { return Array.isArray(p) && p.length === 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]); });
    if (g.kind === "block") return typeof g.selector === "string" && g.selector.trim().length > 0 && g.selector.length < 4096;
    return false; // unknown geometry kinds are rejected, not guessed at
  }
  var VALID_TYPES = { highlight: 1, shape: 1, pin: 1, pen: 1, note: 1, block: 1 };
  // Which geometry kinds each comment type may carry. A "shape" is a rect or
  // circle; a "pin" carries a pin geometry — never allow a mismatched pairing.
  var GEOM_KINDS = { shape: { rect: 1, circle: 1 }, pin: { pin: 1 }, pen: { pen: 1 }, block: { block: 1 } };
  function geomMatchesType(type, g) {
    if (type === "highlight" || type === "note") return g === null || g === undefined;
    var kinds = GEOM_KINDS[type];
    return !!(g && kinds && g.kind && kinds[g.kind] === 1);
  }
  function isValidAnchor(a) {
    if (!a || typeof a !== "object") return false;
    if (typeof a.exact !== "string" || !a.exact.trim()) return false;
    // Generous guard against absurd/bogus quotes — far above any realistic
    // native highlight, so a legitimately created highlight is never hidden
    // when validating stored records on load.
    if (a.exact.length > 1000000) return false;
    return (typeof a.prefix === "string") && (typeof a.suffix === "string");
  }
  function isValidReply(r) {
    return r && typeof r.id === "string" && r.id.length < 128 &&
      typeof r.author === "string" && typeof r.text === "string" && r.text.length <= MAX_REPLY_TEXT &&
      typeof r.createdAt === "string";
  }
  function isValidType(t) { return typeof t === "string" && VALID_TYPES[t] === 1; }
  // Single schema gate for anything read back from storage or imported from a
  // file. Returns true for well-formed records only. Limits here are kept in
  // lock-step with what input accepts (MAX_COMMENT_TEXT / MAX_REPLIES), so the
  // app can never export a record this gate would reject.
  function isValidComment(c) {
    if (!c || typeof c !== "object") return false;
    if (typeof c.id !== "string" || !c.id || c.id.length > 128) return false;
    if (!isValidType(c.type)) return false;
    if (typeof c.author !== "string" || typeof c.text !== "string" || c.text.length > MAX_COMMENT_TEXT) return false;
    if (typeof c.color !== "string") return false;
    if (c.anchor !== null && c.anchor !== undefined && !isValidAnchor(c.anchor)) return false;
    if (c.type === "highlight" && !isValidAnchor(c.anchor)) return false;
    if (!geomMatchesType(c.type, c.geom)) return false;
    if (c.geom !== null && c.geom !== undefined && !isValidGeom(c.geom)) return false;
    if (!Array.isArray(c.replies) || c.replies.length > MAX_REPLIES ||
        !c.replies.every(isValidReply)) return false;
    return true;
  }
  function importComments(data) {
    var incoming = data && Array.isArray(data.comments) ? data.comments : null;
    if (!incoming) { toast("No comments found in that file", { kind: "error" }); return; }
    if (incoming.length > MAX_EXPORT_COMMENTS) {
      toast("That file has too many comments to import", { kind: "error" }); return;
    }
    // Warn if the export came from a different page
    if (data.page && data.page !== PAGE)
      toast("These comments were from a different page — positions may not match.", { kind: "info", duration: 6000 });
    // Existing IDs span the WHOLE project (all pages), not just the current
    // route — so importing one page's export onto another page cannot create
    // colliding ids that allow cross-page edits/deletes.
    var exists = Object.create(null);
    dbRead().comments.forEach(function (x) { if (x && typeof x.id === "string") exists[x.id] = true; });
    Object.keys(unsaved).forEach(function (id) { exists[id] = true; });
    var prepared = [], skipped = 0, seenIds = {};
    incoming.forEach(function (c) {
      if (!isValidComment(c)) { skipped++; return; }        // malformed record — drop
      if (seenIds[c.id]) { skipped++; return; }            // duplicate ID within the batch
      if (exists[c.id]) { skipped++; return; }             // already imported to this project (any page)
      seenIds[c.id] = true;
      var copy = normalizeComment(serialize(c));
      copy.page = PAGE;
      prepared.push(copy);
    });
    if (!prepared.length) {
      toast(skipped ? "Nothing new to import (" + skipped + " invalid or already present)" : "Nothing new to import", { kind: skipped ? "error" : "info" });
      return;
    }
    var d = dbRead();
    d.comments = d.comments.concat(prepared);
    if (!dbWrite(d)) {
      // The write was refused: keep the imported records in memory so they
      // stay visible/exportable, and surface the unsaved banner.
      prepared.forEach(function (c) { unsaved[c.id] = c; });
    }
    prepared.forEach(function (c) { remotePut(c, ["*"]); });
    loadData();
    var ok = prepared.length + (skipped ? " (" + skipped + " skipped)" : "");
    toast("Imported " + ok + " comment" + (prepared.length === 1 ? "" : "s"), { kind: "success" });
  }

  function copyLink(id) {
    var link = location.origin + location.pathname + location.search + "#an=" + id;
    function ok() { toast("Link copied to clipboard", { kind: "success" }); }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(link).then(ok, function () { prompt("Copy link:", link); });
    else prompt("Copy link:", link);
  }

  // delete with undo — persist the deletion immediately (so a reload in the
  // undo window can't resurrect it) and let Undo restore the record.
  var pendingDeletes = {};
  function deleteComment(c) {
    state.comments = state.comments.filter(function (x) { return x.id !== c.id; });
    if (state.activeId === c.id) state.activeId = null;
    pendingDeletes[c.id] = c;
    removeComment(c.id, UNDO_MS); // persist the deletion now; the server copy waits out the undo window
    renderAll(); renderPanel();
    toast("Comment deleted", {
      kind: "info", action: "Undo", duration: 5000,
      onAction: function () {
        // Idempotent: only the first activation of Undo restores. A second
        // click (or a stale activation) must no-op instead of re-inserting.
        if (!pendingDeletes[c.id]) return;
        delete pendingDeletes[c.id];
        var restored = serialize(c);
        // Only re-show the comment if we're still on the page it belongs to;
        // after an SPA route change it must be restored to storage without
        // leaking into the current route's list.
        if (restored.page === PAGE) {
          // Re-insert in chronological order so concurrent deletes don't break positions
          var inserted = false;
          for (var i = 0; i < state.comments.length; i++) {
            if (state.comments[i].createdAt > c.createdAt) {
              state.comments.splice(i, 0, restored); inserted = true; break;
            }
          }
          if (!inserted) state.comments.push(restored);
        }
        // Idempotent restore: another path (cross-tab sync, a re-import) may
        // have already put this id back in storage during the undo window —
        // never write a second copy.
        var d = dbRead();
        if (!d.comments.some(function (x) { return x.id === restored.id; })) {
          d.comments.push(restored);
          dbWrite(d);
          remoteRestore(restored);
        }
        renderAll(); renderPanel();
      },
      onExpire: function () {
        delete pendingDeletes[c.id];
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
    var syncNow = syncState();
    footEl.appendChild(el("div", { class: "an-localnote" }, [
      el("span", { html: ICONS.info }),
      REMOTE ? el("span", { id: "__an_syncnote", "data-state": syncNow.state, role: "status", text: SYNC_TEXT[syncNow.state] })
        : el("span", { text: canShare
        ? "Saved in this browser. Download or share to send your comments."
        : "Saved in this browser. Download to send your comments." }),
    ]));
    footEl.appendChild(el("div", { class: "an-footrow" + (canShare ? " an-four" : "") }, [
      el("button", { class: "an-fbtn" + (n ? " an-pulse" : ""), title: "Download comments as JSON", html: ICONS.download + "<span>Download</span>", onclick: exportComments }),
      el("button", { class: "an-fbtn", title: "Copy comments as JSON", "aria-label": "Copy comments as JSON", html: ICONS.copy + "<span>Copy</span>", onclick: copyComments }),
      CFG.postUrl ? el("button", { class: "an-fbtn", text: "Send feedback", onclick: function () { submitAll().catch(function () {}); } }) : null,
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
    var visible = comments.slice(0, 50);
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
      var channelUrl = safeHttpUrl(dest.replace(/\{(page|count|summary)\}/g, function (_, key) {
        return encodeURIComponent(key === "page" ? location.href : key === "count" ? String(comments.length) : sum.body);
      }));
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
    listen(wrap, "click", function (e) { if (e.target === wrap) closeShareDialog(); });
    ensureHost().appendChild(wrap);
    var _shareTrap = trapFocus(wrap);
    var _origClose = closeShareDialog;
    closeShareDialog = function () { _shareTrap(); closeShareDialog = _origClose; _origClose(); };
    setTimeout(function () { var f = wrap.querySelector("button"); if (f) f.focus(); }, 40);
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
        var m = document.querySelector('[data-an="' + id + '"]');
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
    if (scrollToContent) {
      // Keyboard activation (Enter/Space on a marker) should land focus inside
      // the opened comment, not leave it dangling on the page.
      var fc = listEl.querySelector('[data-id="' + id + '"]');
      if (fc) { fc.setAttribute("tabindex", "-1"); fc.focus({ preventScroll: true }); }
    }
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================
  var firstLoad = true;
  // Route identity changes ONLY here — during boot, an explicit public
  // refresh() or opt-in SPA navigation. Internal reloads (storage sync, import, clear) must not switch
  // PAGE mid-route, or they'd discard the current route's drafts/comments.
  function syncPageKey() {
    var newKey = currentPageKey();
    if (newKey !== PAGE) {
      if (pendingDraft || drawing) { drawing = null; cancelDraft(); }
      PAGE = newKey;
      state.activeId = null;
      // Public reads and submission must use the new page immediately, even
      // while SPA navigation waits for the router before rendering the UI.
      state.comments = pageComments().filter(function (c) { return !pendingDeletes[c.id]; });
    }
  }
  function loadData() {
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
  function load() {
    syncPageKey();
    loadData();
  }

  var contentTimer = 0, contentMaxTimer = 0;
  function flushContent() {
    clearTimeout(contentTimer); clearTimeout(contentMaxTimer);
    contentTimer = contentMaxTimer = 0;
    if (!state.enabled || destroyed) return;
    if (drawing || pendingDraft) { scheduleContent(); return; }
    ensureHost(); renderAll();
  }
  function scheduleContent() {
    clearTimeout(contentTimer);
    contentTimer = setTimeout(flushContent, 150);
    if (!contentMaxTimer) contentMaxTimer = setTimeout(flushContent, 1000);
  }
  function watchContent() {
    if (!contentObserver && window.MutationObserver) contentObserver = new window.MutationObserver(function (records) {
      if (!state.enabled) {
        if (uiHost && !uiHost.isConnected) ensureHost();
        return;
      }
      var changed = records.some(function (r) {
        if (isOurs(r.target)) return false;
        if (r.type !== "childList") return true;
        return Array.prototype.some.call(r.addedNodes, function (n) { return !isOurs(n); }) ||
          Array.prototype.some.call(r.removedNodes, function (n) { return n === uiHost || !isOurs(n); });
      });
      if (changed) scheduleContent();
    });
    if (!contentObserver) return;
    contentObserver.disconnect();
    if (state.enabled) contentObserver.observe(document.documentElement, { subtree: true, childList: true,
      characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    else {
      clearTimeout(contentTimer); clearTimeout(contentMaxTimer); contentTimer = contentMaxTimer = 0;
      // While collapsed only recover removed UI; do not resolve content or
      // observe attributes/text until the reviewer enables the layer.
      contentObserver.observe(document.documentElement, { subtree: true, childList: true });
    }
  }
  function watchNavigation() {
    if (!CFG.spa) return;
    var routeTimer = 0;
    function navigate() {
      // Cancel old-page drafts synchronously, before a same-turn UI action can
      // persist them against the new URL. Defer DOM rendering for the router.
      syncPageKey();
      clearTimeout(routeTimer); routeTimer = setTimeout(function () { loadData(); }, 0);
    }
    listen(window, "popstate", navigate);
    ["pushState", "replaceState"].forEach(function (name) {
      var original = window.history[name];
      var wrapper = function () { var result = original.apply(this, arguments); if (!destroyed) navigate(); return result; };
      window.history[name] = wrapper;
      cleanups.push(function () { if (window.history[name] === wrapper) window.history[name] = original; });
    });
  }

  function boot() {
    if (destroyed || booted) return;
    booted = true;
    captureInvite();
    buildUI();
    ensureOverlay();
    setupBlockPlus();
    watchNavigation();
    setTool("cursor");
    renderFooter();
    load();
    // Start with the review bubble rather than the full
    // toolbar — and never prompt for a name on startup. The name is asked for
    // only when the reviewer actually clicks Review (see launchEl handler).
    // A deep link (#an=<id>) and opt-in data-start-open embeds open straight
    // into review mode. All other embeds start as the collapsed Review pill.
    if (/^#an=./.test(location.hash) || CFG.startOpen) setEnabled(true);
    else setEnabled(false);
    startSync();
  }

  function ensureEnabled() {
    if (!state.enabled) setEnabled(true);
  }

  // public API — lets host pages and other scripts compose with the layer
  var api = {
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
    refresh: function () {
      load();
      if (REMOTE) { sync.held = false; sync.etag = ""; ensureSession(!sync.token).then(function (t) { if (t) { scheduleFlush(0); poll(); } }, function () {}); }
    },
    comments: function () { return state.comments.map(serialize); },
    focus: function (id) { focusComment(id, false); },
    toast: toast,
    export: function () { exportComments(); },
    import: function () { pickImportFile(); },
    submit: submitAll,
    setStatus: function (id, status) { return setCommentStatus(id, status); },
    assign: function (id, assignee) { return setCommentAssignee(id, assignee); },
    syncState: function () { return syncState(); },
    destroy: function () {
      if (destroyed) return;
      destroyed = true;
      if (contentObserver) contentObserver.disconnect();
      if (_anchorRO) _anchorRO.disconnect();
      cleanups.forEach(function (fn) { fn(); }); cleanups = [];
      timers.forEach(function (id) { window.clearTimeout(id); }); timers.clear();
      frames.forEach(function (id) { window.cancelAnimationFrame(id); }); frames.clear();
      if (postController) postController.abort();
      stopSync();
      objectUrls.forEach(function (url) { URL.revokeObjectURL(url); }); objectUrls.clear();
      document.body && document.body.classList.remove("an-drawing", "an-highlighting");
      if (uiHost) uiHost.remove();
      var style = document.getElementById("__an_style"); if (style) style.remove();
    },
    clear: function () {
      var d = dbRead(), removed = [];
      // With a backend, clear() deletes only your own comments; everyone
      // else's stay in the review.
      d.comments = d.comments.filter(function (c) {
        var drop = c && c.page === PAGE && (!REMOTE || isMine(c));
        if (drop) removed.push(c.id);
        return !drop;
      });
      Object.keys(unsaved).forEach(function (id) {
        if (unsaved[id] && unsaved[id].page === PAGE && (!REMOTE || isMine(unsaved[id]))) {
          if (removed.indexOf(id) < 0) removed.push(id);
          delete unsaved[id];
        }
      });
      dbWrite(d);
      removed.forEach(function (id) { remoteDelete(id, 0); });
      loadData();
    },
  };

  if (document.readyState === "loading")
    listen(document, "DOMContentLoaded", boot);
  else boot();
  // ANNOTATE TEST INJECTION POINT
  return api;
  }
};
const Annotate = createController(typeof window !== "undefined" ? window : null);
const init = (config) => Annotate.init(config);
const destroy = () => Annotate.destroy();
export { init, destroy };
export default Annotate;
