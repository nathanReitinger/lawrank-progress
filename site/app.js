/* Law Tags Mission Control (v2).
   Reads status.json (schema 2, or schema 1) and history.jsonl. Live: the `live` branch through the GitHub contents API
   (every live.poll_s, with an ETag; it backs off on 403/429 and when the hourly allowance runs low), with the Pages copy
   beside this page as the fallback and the long history. Opened from this Mac (localhost or a file) it reads the files
   beside it only. Every value from the data reaches the page through textContent or a computed number, never as HTML.
   The page cannot start, stop or change anything: it only reads. No external code, fonts or images. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ settings and state
  var CFG = {
    repo: "nathanReitinger/lawrank-progress",
    liveFile: "site/status.json",
    liveRef: "live",
    pollS: 75,            // the API poll; status.live.poll_s wins (never under 60 s)
    pagesS: 120,          // the Pages copy, revalidated every 2 minutes (a 304 when unchanged)
    historyS: 600,        // history.jsonl every 10 minutes (and when the Pages copy changes)
    bases: ["", "../site/"],
    themeKey: "progress-theme",
    visitKey: "lawtags-v2-visit",
    rangeKey: "lawtags-v2-range",
    missionStart: "2026-11-03",
    allowHosts: ["github.com", "nathanreitinger.github.io", "huggingface.co"]
  };
  var SVGNS = "http://www.w3.org/2000/svg";
  var S = {
    status: null, src: null, prev: null, firstRender: true,
    pages: { gen: null, base: null, next: 0, err: null, at: 0 },
    live: { state: "idle", etag: null, next: 0, remaining: null, reset: null, err: null, fails: 0, at: 0, gen: null },
    hist: [], histNext: 0, histGen: null, merged: [],
    range: 86400, baseline: undefined, sig: {},
    tiles: {}, ui: { open: {}, tables: {}, logKind: "all", logCrew: "all", logShown: 20 },
    charts: [], cells: [], lastNew: 0, error: null
  };
  function mq(q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: function () {} }; }
  var REDUCED = mq("(prefers-reduced-motion: reduce)");
  var DARKQ = mq("(prefers-color-scheme: dark)");
  var HOST = location.hostname || "";
  var LOCAL = location.protocol === "file:" || HOST === "localhost" || /\.localhost$/.test(HOST) ||
    /^127(\.\d{1,3}){3}$/.test(HOST) || HOST === "[::1]";
  var WANT_LIVE = !LOCAL || /[?&]live=1\b/.test(location.search);

  // ------------------------------------------------------------------ tiny helpers
  function $(id) { return document.getElementById(id); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function str(x) { return typeof x === "string" ? x : (isNum(x) ? String(x) : ""); }
  function g(o, path) {
    var parts = path.split("."), cur = o;
    for (var i = 0; i < parts.length; i++) { if (!isObj(cur) && !Array.isArray(cur)) return null; cur = cur[parts[i]]; if (cur === undefined) return null; }
    return cur;
  }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return el;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return el; }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    return el;
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function sv(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]); });
    return el;
  }
  function setText(el, t) { if (typeof el === "string") el = $(el); if (el && el.textContent !== t) el.textContent = t; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function announce(t) { var el = $("sr-live"); if (el) { el.textContent = ""; setTimeout(function () { el.textContent = t; }, 60); } }

  // ------------------------------------------------------------------ numbers and times
  var NF = new Intl.NumberFormat("en-US");
  var NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
  var NF2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  function fInt(x) { return isNum(x) ? NF.format(Math.round(x)) : "–"; }
  function f1(x) { return isNum(x) ? NF1.format(x) : "–"; }
  function f2(x) { return isNum(x) ? NF2.format(x) : "–"; }
  function fPct(x, d) { return isNum(x) ? x.toFixed(d === undefined ? 1 : d) + "%" : "–"; }
  function fShare(x, d) { return isNum(x) ? (100 * x).toFixed(d === undefined ? 1 : d) + "%" : "–"; }
  function fmtv(x, fmt) {
    if (!isNum(x)) return "–";
    if (fmt === "1") return f1(x);
    if (fmt === "p1") { var p = x.toFixed(1).split("."); return NF.format(+p[0]) + "." + p[1]; }   // always one decimal
    if (fmt === "2") return f2(x);
    if (fmt === "pct") return x.toFixed(1);
    if (fmt === "x") return x.toFixed(2);
    return fInt(x);
  }
  function fAxis(x) {
    if (!isNum(x)) return "";
    var a = Math.abs(x);
    if (a >= 1e6) return NF1.format(x / 1e6) + "M";
    if (a >= 1e4) return NF1.format(x / 1e3) + "K";
    return NF1.format(x);
  }
  function fTick(x, axMax) {   // one style per axis: in full under 10,000, else compact for every tick
    if (!isNum(x)) return "";
    if (x === 0) return "0";
    if (axMax >= 1e6) return NF2.format(x / 1e6) + "M";
    if (axMax >= 1e4) return NF1.format(x / 1e3) + "K";
    return NF1.format(x);
  }
  function fSigned(x, fmt) { return isNum(x) ? (x > 0 ? "+" : x < 0 ? "−" : "±") + fmtv(Math.abs(x), fmt) : "–"; }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function ms(v) { if (typeof v !== "string" || !v) return null; var t = Date.parse(v); return isFinite(t) ? t : null; }
  function fDur(s) {
    if (!isNum(s)) return "–";
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + " s";
    if (s < 3600) { var m = Math.floor(s / 60), r = s % 60; return m + " min" + (r ? " " + pad2(r) + " s" : ""); }
    if (s < 86400) { var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh + " h" + (mm ? " " + pad2(mm) + " min" : ""); }
    var d = Math.floor(s / 86400), h2 = Math.floor((s % 86400) / 3600);
    return d + " d" + (h2 ? " " + h2 + " h" : "");
  }
  function fDurShort(s) {
    if (!isNum(s)) return "–";
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h " + pad2(Math.floor((s % 3600) / 60)) + " min";
    return Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h";
  }
  function fClock(s) {
    if (!isNum(s)) return "–";
    s = Math.max(0, Math.round(s));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ":" + pad2(mm) : String(mm)) + ":" + pad2(ss);
  }
  function fAgo(t) {
    if (!isNum(t)) return "–";
    var s = (Date.now() - t) / 1000;
    if (s < -90) return "in " + fDurShort(-s);
    if (s < 5) return "just now";
    return fDurShort(s) + " ago";
  }
  function fUntil(t) {
    if (!isNum(t)) return "–";
    var s = (t - Date.now()) / 1000;
    if (s <= 0) return "due now";
    return "in " + fDurShort(s);
  }
  function fTime(t) { return isNum(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "–"; }
  function fTimeS(t) { return isNum(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "–"; }
  function fDay(t) { return isNum(t) ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : "–"; }
  function fDayTime(t) { return isNum(t) ? fDay(t) + ", " + fTime(t) : "–"; }
  function sameDay(a, b) { var x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); }
  function ymdText(v) {
    var m = typeof v === "string" ? /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v) : null;
    if (!m) return str(v) || "–";
    var d = new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, 12);
    var yearNow = new Date().getFullYear();
    if (!m[3]) return d.toLocaleDateString([], { month: "short", year: "numeric" });
    return d.toLocaleDateString([], d.getFullYear() === yearNow ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }
  function ymdMs(v, end) {
    var m = typeof v === "string" ? /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v) : null;
    if (!m) return null;
    if (m[3]) return new Date(+m[1], +m[2] - 1, +m[3], end ? 23 : 12).getTime();
    return end ? new Date(+m[1], +m[2], 0, 23).getTime() : new Date(+m[1], +m[2] - 1, 1, 12).getTime();
  }
  function rangeText(e) {
    if (!isObj(e)) return "–";
    var a = ymdText(e.from), b = ymdText(e.to);
    return a === b ? a : a + " – " + b;
  }

  // ------------------------------------------------------------------ data access
  function st() { return isObj(S.status) ? S.status : {}; }
  function jobs() { return arr(st().jobs).filter(function (j) { return isObj(j) && typeof j.id === "string"; }); }
  function job(id) { var j = jobs().filter(function (x) { return x.id === id; })[0]; return j || null; }
  function nowOf(j) { return j && isObj(j.now) ? j.now : {}; }
  function genMs() { return ms(st().generated_at); }
  function events() { return arr(st().events).filter(function (e) { return isObj(e) && ms(e.t) !== null; }); }
  function estimate(id) { return arr(st().estimates).filter(function (e) { return isObj(e) && e.id === id; })[0] || null; }
  function schemaV() { var s = str(st().schema); return /status 2/.test(s) ? 2 : (s ? 1 : 0); }
  function factOf(j, re) {
    var f = arr(nowOf(j).facts).filter(function (x) { return isObj(x) && re.test(str(x.k)); })[0];
    return f && isNum(f.v) ? f.v : null;
  }
  function rateOf(j, re) {
    var r = arr(j && j.rates).filter(function (x) { return isObj(x) && re.test(str(x.label)); })[0];
    return r && isNum(r.value) ? r.value : null;
  }
  function lastPoint() { return S.merged.length ? S.merged[S.merged.length - 1] : {}; }
  function hv(key) {   // the newest measured value of a history key
    for (var i = S.merged.length - 1; i >= 0; i--) if (isNum(S.merged[i][key])) return S.merged[i][key];
    return null;
  }
  function windowStart() {
    var end = genMs() || Date.now();
    if (!S.range) return S.merged.length ? ms(S.merged[0].t) : end - 86400000;
    return end - S.range * 1000;
  }
  function series(key, t0) {
    var out = [];
    t0 = t0 === undefined ? windowStart() : t0;
    for (var i = 0; i < S.merged.length; i++) {
      var p = S.merged[i], t = p._t;
      if (t >= t0 && isNum(p[key])) out.push({ t: t, v: p[key] });
    }
    return /^b_/.test(key) ? sinceReset(out) : out;
  }
  // a heartbeat's count starts again when its job moves to a new step: keep only the points since the last restart,
  // so its trend and delta are about the count it reports now
  function sinceReset(pts) {
    for (var i = pts.length - 1; i > 0; i--) if (pts[i].v < pts[i - 1].v * 0.5) return pts.slice(i);
    return pts;
  }
  function seriesFn(fn, t0) {
    var out = [];
    t0 = t0 === undefined ? windowStart() : t0;
    for (var i = 0; i < S.merged.length; i++) {
      var p = S.merged[i];
      if (p._t < t0) continue;
      var v = fn(p);
      if (isNum(v)) out.push({ t: p._t, v: v });
    }
    return out;
  }
  function thin(pts, n) {
    if (pts.length <= n) return pts;
    var out = [], step = (pts.length - 1) / (n - 1);
    for (var i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
    return out;
  }
  function rangeWord() {
    var r = S.range;
    if (!r) return "in all the history";
    return r < 86400 ? "in " + Math.round(r / 3600) + " h" : "in " + Math.round(r / 86400) + (r === 86400 ? " day" : " days");
  }

  // derived numbers
  function coverageLow() {   // measured with a text (the coverage count) plus the CORE lane's finds since: a lower bound
    var c = g(st(), "collection.coverage") || g(st(), "headline.coverage");
    if (!isObj(c) || !isNum(c.with_text)) return null;
    var core = job("core"), found = core && isObj(core.found) && isNum(core.found.with_text) ? core.found.with_text : (hv("c_txt") || 0);
    return { low: c.with_text + found, measured: c.with_text, core: found, papers: isNum(c.papers) ? c.papers : g(st(), "project.paper_list.papers"), at: ms(c.measured_at), how: str(c.how) };
  }
  function codingTotals(id) {
    var j = job(id);
    if (!j) return null;
    var p = isObj(j.progress) ? j.progress : {};
    return { done: isNum(p.done) ? p.done : null, total: isNum(p.total) ? p.total : null, j: j };
  }

  // ------------------------------------------------------------------ icons
  var GLYPHS = {
    harvest: "M12 21V8 M12 8c0-2.8 1.9-4.7 4.8-5.5C16.8 5.3 14.9 7.2 12 8z M12 12.5c0-2.8-1.9-4.7-4.8-5.5C7.2 9.8 9.1 11.7 12 12.5z M12 17c0-2.8 1.9-4.7 4.8-5.5C16.8 14.3 14.9 16.2 12 17z",
    scout: "M10.5 4.5a6 6 0 1 1 0 12a6 6 0 0 1 0-12z M15 15l5.5 5.5",
    diver: "M3 9c2 0 2-2 4.5-2S10 9 12 9s2-2 4.5-2S19 9 21 9 M3 15c2 0 2-2 4.5-2S10 15 12 15s2-2 4.5-2S19 15 21 15",
    map: "M9 4L3 6v14l6-2l6 2l6-2V4l-6 2z M9 4v14 M15 6v14",
    library: "M4 19V5h4v14z M10 19V5h4v14z M15.6 6.3l2.9-.8l3.4 12.5l-2.9.8z",
    tag: "M3 12V4h8l10 10l-8 8z M7.5 6.5a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 0 1 0-2.4z",
    flask: "M9 3h6 M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3 M7.6 15h8.8",
    antenna: "M12 13v8 M8 21h8 M8.6 9.6a4.8 4.8 0 0 1 6.8 0 M5.6 6.6a9 9 0 0 1 12.8 0 M12 11.2a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8z",
    shield: "M12 3l8 3v6c0 4.5-3.5 8-8 9c-4.5-1-8-4.5-8-9V6z M8.5 12l2.5 2.5l4.5-5",
    star: "M12 3l2.7 5.6l6.1.9l-4.4 4.3l1 6.1L12 17l-5.4 2.9l1-6.1l-4.4-4.3l6.1-.9z",
    check: "M5 12.5l4.5 4.5L19 7.5",
    info: "M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M12 11v6 M12 7.5v.6",
    alert: "M12 3.5l9.5 16.5h-19z M12 10v4.5 M12 17.2v.5",
    stop: "M8 3h8l5 5v8l-5 5H8l-5-5V8z M12 8v5 M12 15.6v.5",
    copy: "M9 9h10.5a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5H10.5A1.5 1.5 0 0 1 9 20z M5 15V5a2 2 0 0 1 2-2h8",
    pause: "M9 5v14 M15 5v14",
    clock: "M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M12 7v5l3.2 2",
    mac: "M4 5h16v11H4z M2 19h20",
    globe: "M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18",
    branch: "M6 4a2 2 0 1 1 0 4a2 2 0 0 1 0-4z M6 16a2 2 0 1 1 0 4a2 2 0 0 1 0-4z M18 6a2 2 0 1 1 0 4a2 2 0 0 1 0-4z M6 8v8 M18 10c0 4-6 3-11 6.5",
    db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3s-3.6 3-8 3s-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    users: "M9 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7z M2.5 20c.8-3.8 3.4-6 6.5-6s5.7 2.2 6.5 6 M16 4.6a3.4 3.4 0 0 1 0 6.8 M18 14.2c2 .8 3.2 2.8 3.5 5.8",
    flag: "M5 21V4 M5 4h11l-2 4l2 4H5",
    bolt: "M13 2L4 14h7l-1 8l9-12h-7z",
    terminal: "M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z M7 9l3 3l-3 3 M12.5 15H17",
    note: "M5 4h14v12l-4 4H5z M15 20v-4h4 M8 8.5h8 M8 12h6"
  };
  function icon(name, cls) {
    var el = sv("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", "class": cls || null,
      fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" });
    el.appendChild(sv("path", { d: GLYPHS[name] || GLYPHS.info }));
    return el;
  }

  // ------------------------------------------------------------------ the crew (one color each, everywhere)
  var CREW = [
    { id: "harvest", slot: 1, glyph: "harvest", name: "The Harvester", jobs: ["harvest"], role: "Reads the journals' own sites, school repositories and Wayback copies, one polite request at a time per site." },
    { id: "core", slot: 2, glyph: "scout", name: "The CORE Scout", jobs: ["core"], role: "Looks up every paper still without a text in CORE, twenty papers a window." },
    { id: "s2", slot: 3, glyph: "diver", name: "The Diver", jobs: ["s2"], role: "Read the Semantic Scholar datasets offline, part by part, then paired what it kept with our list." },
    { id: "openalex", slot: 4, glyph: "map", name: "The Cartographer", jobs: ["openalex"], role: "Paired the OpenAlex snapshot with our paper list." },
    { id: "faculty", slot: 5, glyph: "library", name: "The Librarian", jobs: ["faculty"], role: "Read the schools' faculty-scholarship repositories." },
    { id: "coders", slot: 6, glyph: "tag", name: "The Coders", jobs: ["coding_s1", "coding_test", "coding_dev"], role: "Independent Claude agents who code the subject labels, one coding workflow per usage window." },
    { id: "lab", slot: 7, glyph: "flask", name: "The Model Lab", jobs: ["preview"], role: "Built the four architectures and the preview model; trains the contest once silver S1 is coded." },
    { id: "relay", slot: 0, glyph: "antenna", name: "The Relay", jobs: ["updater"], role: "Collects these numbers every cycle, scans them for anything private, and publishes them." },
    { id: "keeper", slot: 0, glyph: "shield", name: "The Keeper", jobs: [], role: "The always-on supervisor on the Mac: it restarts any job that stops, unless someone stopped it on purpose." },
    { id: "pi", slot: 0, glyph: "star", name: "The PI", jobs: [], role: "Sets the course, reads this page, and leaves notes for the team." }
  ];
  var CREW_BY = {};
  CREW.forEach(function (c) { CREW_BY[c.id] = c; });
  function crewOf(jobId) {
    if (!jobId) return null;
    for (var i = 0; i < CREW.length; i++) if (CREW[i].jobs.indexOf(jobId) >= 0) return CREW[i];
    if (/^coding/.test(jobId)) return CREW_BY.coders;
    if (jobId === "store") return CREW_BY.harvest;
    if (jobId === "model") return CREW_BY.lab;
    if (jobId === "machine" || jobId === "collector") return CREW_BY.relay;
    if (jobId === "supervisor" || jobId === "keepalive") return CREW_BY.keeper;
    if (jobId === "note" || jobId === "notes") return CREW_BY.pi;
    var j = job(jobId);
    if (j && j.source === "heartbeat") return CREW_BY.lab;
    return null;
  }
  function crewVar(c) { return "var(--c" + (c ? c.slot : 0) + ")"; }
  function avatar(c, small) {
    var el = h("span", { "class": "avatar" + (small ? " sm" : ""), "aria-hidden": "true" }, icon(c ? c.glyph : "info"));
    el.style.setProperty("--crew", crewVar(c));
    return el;
  }
  function crewDot(c) { var el = h("span", { "class": "crew-dot", "aria-hidden": "true" }); el.style.setProperty("--crew", crewVar(c)); return el; }
  var KEY_LABEL = { machine: "The Mac", supervisor: "Keep-alive", keepalive: "Keep-alive", store: "The store", collector: "The collector" };
  function jobLabel(id) { var j = job(id); if (j && j.label) return j.label; if (KEY_LABEL[id]) return KEY_LABEL[id]; var c = crewOf(id); return c ? c.name : (id || "the project"); }
  // "Label: text", unless the text already starts with the label ("TEST coding: 9 units finished")
  function labelled(id, text) {
    var t = str(text), lab = id === "machine" && /supervisor/i.test(t) ? "Keep-alive" : jobLabel(id);
    return lab && t.toLowerCase().indexOf(String(lab).toLowerCase()) !== 0 ? lab + ": " + t : t;
  }

  // status lights: always a mark plus a word
  var LIGHTS = {
    running: ["go", "Running"], serving: ["go", "Serving"], pairing: ["go", "Pairing"], training: ["go", "Training"],
    waiting: ["wait", "Waiting"], restarting: ["wait", "Restarting"], building: ["wait", "Building"],
    stopped: ["stop", "Stopped"], failing: ["stop", "Failing"], silent: ["stop", "Silent"], failed: ["stop", "Failed"],
    finished: ["done", "Finished"], built: ["done", "Built"], done: ["done", "Done"],
    paused: ["rest", "Paused"], idle: ["rest", "Idle"], stopped_on_purpose: ["rest", "Stopped on purpose"],
    missing: ["stop", "Missing"], stale: ["wait", "Stale"], unreadable: ["stop", "Unreadable"], off: ["rest", "Off"], unknown: ["unknown", "Unknown"]
  };
  function light(state, health, label, live) {
    var m = LIGHTS[state] || LIGHTS.unknown, cls = m[0];
    if (health === "critical" && cls !== "done") cls = "stop";
    else if (health === "warn" && (cls === "rest" || cls === "go")) cls = "wait";
    var el = h("span", { "class": "light " + cls + (live && cls === "go" ? " live" : "") });
    if (cls === "done") el.appendChild(icon("check"));
    else if (state === "paused" || state === "stopped_on_purpose" || state === "off") el.appendChild(icon("pause"));
    else if (cls === "unknown") el.appendChild(icon("info"));
    else el.appendChild(h("i", { "aria-hidden": "true" }));
    add(el, label || m[1]);
    return el;
  }
  function estChip(t) { return h("span", { "class": "chip est", title: "An estimate, not a promise" }, t || "estimate"); }

  // ------------------------------------------------------------------ tooltip (one for the page)
  var TIP = null;
  function tipShow(parts, x, y) {
    if (!TIP) TIP = $("tip");
    clear(TIP);
    parts.forEach(function (p) { TIP.appendChild(p); });
    TIP.hidden = false;
    var r = TIP.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var left = x + 14, top = y + 14;
    if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
    if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 14);
    TIP.style.left = left + "px";
    TIP.style.top = top + "px";
  }
  function tipHide() { if (!TIP) TIP = $("tip"); if (TIP) TIP.hidden = true; }
  function tipT(t) { return h("div", { "class": "tt-t" }, t); }
  function tipRow(value, label, color) {
    var i = h("i");
    if (color) i.style.setProperty("--k", color);
    return h("div", { "class": "tt-row" }, color ? i : null, h("b", null, value), label ? h("span", null, label) : null);
  }
  function tipNote(t) { return h("div", { "class": "tt-note" }, t); }
  function hoverTip(el, fn) {   // a tooltip on hover and keyboard focus for any element
    el.addEventListener("pointerenter", function (ev) { tipShow(fn(), ev.clientX, ev.clientY); });
    el.addEventListener("pointermove", function (ev) { tipShow(fn(), ev.clientX, ev.clientY); });
    el.addEventListener("pointerleave", tipHide);
    el.addEventListener("focus", function () { var r = el.getBoundingClientRect(); tipShow(fn(), r.left + Math.min(r.width, 40), r.bottom - 6); });
    el.addEventListener("blur", tipHide);
  }
  window.addEventListener("scroll", tipHide, { passive: true });

  // ------------------------------------------------------------------ commands (the runbook): only well-formed lawrank commands
  // the fixed forms only: lawrank status | check | help | start all | stop all | logs <job> | supervisor on|off|status |
  // start|stop|logs|status <job>; anything else in the data is never shown as a command
  var CMD_RE = /^lawrank (status|check|help|start all|stop all|logs <job>|supervisor (on|off|status)|(start|stop|logs|status) [a-z0-9_-]{1,24})$/;
  function safeCmd(c) { return typeof c === "string" && CMD_RE.test(c) ? c : null; }
  // the fixed-form commands a sentence names ("... run on the Mac: lawrank supervisor on"), in order, each once
  function cmdsIn(text) {
    var re = /lawrank (?:supervisor (?:on|off|status)|start all|stop all|(?:start|stop|logs|status) [a-z0-9_-]{1,24}|status|check|help)(?![a-z0-9_-])/g, out = [], m;
    while ((m = re.exec(str(text)))) { var c = safeCmd(m[0]); if (c && out.indexOf(c) < 0) out.push(c); }
    return out;
  }
  function cmdChip(cmd, primary, label) {
    var c = safeCmd(cmd);
    if (!c) return null;
    var code = h("code", null, c);
    var btnLabel = h("span", null, "Copy");
    var btn = h("button", { type: "button", "aria-label": "Copy the command: " + c, title: "Copy to the clipboard" }, icon("copy"), btnLabel);
    var wrap = h("span", { "class": "cmd" + (primary ? " primary" : "") }, code, btn);
    if (label) wrap.setAttribute("title", label);
    btn.addEventListener("click", function () {
      function done(ok) {
        wrap.classList.toggle("copied", ok);
        btnLabel.textContent = ok ? "Copied" : "Selected";
        announce(ok ? "Copied: " + c : "Selected: " + c + ". Press the copy keys.");
        setTimeout(function () { btnLabel.textContent = "Copy"; wrap.classList.remove("copied"); }, 1800);
      }
      function select() {
        try { var rg = document.createRange(); rg.selectNodeContents(code); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch (e) {}
        done(false);
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(function () { done(true); }, select);
        else select();
      } catch (e) { select(); }
    });
    return wrap;
  }

  // ------------------------------------------------------------------ the keep-alive panel (built in even without data)
  var KA_FALLBACK = [
    { name: "harvest", label: "Journal harvest", job: "harvest" },
    { name: "core", label: "CORE lane", job: "core" },
    { name: "replan", label: "Harvest re-planner", job: "harvest" },
    { name: "updater", label: "Progress page updater", job: "updater" }
  ];
  var KA_GENERAL = [
    { id: "status", label: "See what runs", cmd: "lawrank status", what: "every job, running or not, with auto-restart on or off" },
    { id: "start_all", label: "Start everything", cmd: "lawrank start all", what: "starts every job that is not running and turns auto-restart back on" },
    { id: "stop_all", label: "Stop everything", cmd: "lawrank stop all", what: "stops every job on purpose; nothing restarts until you start it again" },
    { id: "logs", label: "Read a job's log", cmd: "lawrank logs <job>", what: "the newest lines a job wrote (put a job name in place of <job>)" },
    { id: "desktop", label: "Or double-click", cmd: null, what: "double-click Start LawRank on the Mac's Desktop (the same as lawrank start all)" }
  ];
  var KA_SENTENCE = "This page cannot start programs on the Mac; the supervisor restarts anything that stops within a few minutes, unless you stopped it on purpose.";
  function keepalive() {
    var k = st().keepalive;
    if (isObj(k)) return { k: k, fallback: false };
    // schema 1 (or no data): the same panel from the job list, with a warning
    var rows = KA_FALLBACK.map(function (r) {
      var j = job(r.job), running = null;
      if (r.name === "replan") {
        var w = arr(nowOf(job("harvest")).watchers).filter(function (x) { return isObj(x) && /replan/.test(str(x.name)); })[0];
        running = w ? !!w.running : null;
      } else if (j) running = typeof j.running === "boolean" ? j.running : null;
      var state = running === true ? "running" : running === false ? "stopped" : "unknown";
      if (j && j.state === "finished") state = "finished";
      return { name: r.name, label: r.label, job: r.job, state: state, running: running, auto_restart: null, last_restart_at: null,
        commands: [{ id: "start", label: "Start", cmd: "lawrank start " + r.name }, { id: "stop", label: "Stop", cmd: "lawrank stop " + r.name }, { id: "logs", label: "Logs", cmd: "lawrank logs " + r.name }] };
    });
    return { k: { title: "Keep-alive and runbook", sentence: KA_SENTENCE, supervisor: { state: S.status || S.error ? "missing" : "loading" }, jobs: rows, commands: KA_GENERAL,
      warning: S.status ? "This status has no keep-alive block yet (the collector that reads the supervisor is not installed), so the states below come from the job list. The commands work once the supervisor is installed on the Mac." :
        S.error ? "The status could not be loaded, so the states of the jobs are unknown here. The commands below still work at the Mac: lawrank status shows what runs." : null }, fallback: true };
  }
  function kaRowFor(jobId) {
    var k = keepalive().k;
    return arr(k.jobs).filter(function (r) { return isObj(r) && r.job === jobId && r.name !== "replan"; })[0] || null;
  }
  function kaCmd(row, id) {
    var c = arr(row && row.commands).filter(function (x) { return isObj(x) && x.id === id; })[0];
    return c ? safeCmd(c.cmd) : null;
  }
  function kaNeedsStart(row) { return row && ["stopped", "failing", "restarting", "unknown", "stopped_on_purpose"].indexOf(row.state) >= 0 && row.running !== true; }
  // the one command a person should run for this row now (the supervisor's suggestion first), or null when none is needed
  function kaPrimary(r) {
    var sg = safeCmd(str(r.suggest));
    if (sg && r.running !== true) return { cmd: sg, start: /^lawrank start /.test(sg) };
    if (r.state === "finished" || r.running === true) return { cmd: kaCmd(r, "logs"), start: false };
    return { cmd: kaCmd(r, "start"), start: true };
  }
  // a row that needs a person: dead and nothing restarts it, or its starts keep failing (an unknown state is not an alarm:
  // the warning explains it; restarting or waiting rows are being handled and show their command without the alarm)
  function kaAttn(r) { return !!r && r.running !== true && (r.state === "stopped" || r.state === "failing"); }
  function kaHandled(r) { return !!r && r.running !== true && (r.state === "restarting" || r.state === "waiting"); }
  var SV_WORD = { running: "Supervisor on duty", stale: "Supervisor quiet", missing: "No supervisor status", unreadable: "Supervisor status unreadable", off: "Supervisor turned off" };
  function svLight(sup, short) {
    if (sup.state === "loading") return light("unknown", null, "Loading");
    var w = short ? { running: "On duty", stale: "Quiet", missing: "Not reporting", unreadable: "Unreadable", off: "Turned off" }[sup.state] : SV_WORD[sup.state];
    if (sup.state === "stale" && sup.switch_on === true) w = short ? "On (paused by macOS)" : "Supervisor on, paused by macOS";
    var st0 = ["running", "stale", "unreadable", "off"].indexOf(sup.state) >= 0 ? sup.state : "missing";
    return light(st0, null, w || "Unknown", sup.state === "running");
  }

  // the keep-alive strip under the headline: every kept-alive job at a glance, with the command when one is needed
  function renderKaStrip() {
    var box = clear($("ka-strip"));
    var K = keepalive(), k = K.k, sup = isObj(k.supervisor) ? k.supervisor : { state: "missing" };
    var rows = arr(k.jobs).filter(isObj);
    var supAt = ms(sup.at), bad = rows.filter(kaAttn), loading = !S.status && !S.error, oldData = freshness() === "stale";
    box.classList.toggle("old", oldData);
    box.classList.toggle("attn", bad.length > 0);
    var supPaused = sup.state === "stale" && sup.switch_on === true;
    box.classList.toggle("warn", !bad.length && !loading && ((sup.state !== "running" && !supPaused) || rows.some(kaHandled)));
    var lead = h("div", { "class": "ka-lead" }, icon("shield"), h("b", null, "Keep-alive"), loading ? light("unknown", null, "Loading") : svLight(sup, true));
    var leadMeta = [];
    if (loading) leadMeta.push(h("span", null, "reading the latest status"));
    else if (oldData) leadMeta.push(h("span", { "class": "ka-old" }, "states from " + fAgo(genMs()) + ": no newer data"));
    else if (sup.state === "running" || sup.state === "stale") {
      if (supAt) leadMeta.push(h("span", null, "checked ", h("span", { "data-ago": supAt }, fAgo(supAt))));
      if (isNum(sup.every_s)) leadMeta.push(h("span", null, "every " + fDurShort(sup.every_s)));
    } else leadMeta.push(h("span", null, sup.state === "unreadable" ? "its status file is unreadable" : sup.state === "off" ? "turned off on purpose: it restarts nothing" : "its status is missing: run commands by hand"));
    if (leadMeta.length) lead.appendChild(h("span", { "class": "ka-lead-meta" }, leadMeta));
    box.appendChild(lead);
    var list = h("ul", { "class": "ka-pills" });
    rows.forEach(function (r) {
      var attn = kaAttn(r), c = crewOf(r.job);
      var li = h("li", { "class": "ka-pill" + (attn ? " attn" : kaHandled(r) ? " handled" : "") + (r.state === "stopped_on_purpose" ? " rest" : "") });
      li.appendChild(h("span", { "class": "ka-name" }, crewDot(c), str(r.label) || str(r.name)));
      li.appendChild(light(str(r.state) || "unknown", null, null, r.state === "running"));
      li.appendChild(h("span", { "class": "ka-auto" + (r.auto_restart === true ? " on" : ""), title: r.auto_by === "watcher" ? "Restarted by its own Terminal watcher" : null },
        r.auto_restart === true ? "auto-restart on" : r.auto_restart === false ? "auto-restart off" : "auto-restart unknown"));
      if (attn || kaHandled(r) || r.state === "stopped_on_purpose" || (r.state === "unknown" && !loading)) {
        var p = kaPrimary(r), ch = p.cmd ? cmdChip(p.cmd, attn) : null;
        if (ch) li.appendChild(ch);
      }
      list.appendChild(li);
    });
    if (!rows.length) list.appendChild(h("li", { "class": "ka-pill" }, "No kept-alive jobs are listed."));
    box.appendChild(list);
    box.appendChild(h("a", { "class": "ka-more", href: "#runbook" }, bad.length ? "Runbook: what to run" : "Runbook: every command"));
  }

  function renderRunbook() {
    var K = keepalive(), k = K.k, sup = isObj(k.supervisor) ? k.supervisor : { state: "missing" };
    setText("runbook-h", str(k.title) || "Keep-alive and runbook");
    setText("runbook-sentence", str(k.sentence) || KA_SENTENCE);
    setText("runbook-how", str(k.how) || "To run a command by hand: open Terminal on the Mac, paste the command, press Return.");
    var chip = clear($("sv-chip"));
    chip.appendChild(svLight(sup));
    var warn = clear($("runbook-warn"));
    var supLine = [];
    if (ms(sup.at)) supLine.push(h("span", null, "checked ", h("b", { "data-ago": ms(sup.at) }, fAgo(ms(sup.at)))));
    if (isNum(sup.every_s)) supLine.push(h("span", null, "checks every " + fDur(sup.every_s)));
    if (isNum(sup.restart_within_s)) supLine.push(h("span", null, "restarts a stopped job within " + fDurShort(sup.restart_within_s)));
    if (sup.auto_restart === true) supLine.push(h("span", null, "auto-restart on"));
    if (str(sup.run_by)) supLine.push(h("span", null, "run by " + str(sup.run_by)));
    if (supLine.length) warn.appendChild(h("p", { "class": "kr-meta", style: "margin-top:6px" }, supLine));
    if (S.status && freshness() === "stale") warn.appendChild(h("div", { "class": "banner warn", style: "margin-top:8px" }, icon("clock"), h("span", { "class": "b-body" },
      "This page has had no new data for " + fDurShort(dataAge()) + ", so the states below may be out of date. To see what runs now:", cmdChip("lawrank status", true))));
    if (sup.install_running === true) warn.appendChild(h("p", { "class": "banner info", style: "margin-top:8px" }, icon("clock"), h("span", { "class": "b-body" }, "An install is running on the Mac: the harvest, the CORE lane and the re-planner wait for it and start by themselves when it ends.")));
    if (k.warning) warn.appendChild(h("p", { "class": "banner " + (sup.state === "stale" && sup.switch_on === true ? "info" : "warn"), style: "margin-top:8px" }, icon(sup.state === "stale" && sup.switch_on === true ? "clock" : "alert"), h("span", { "class": "b-body" }, str(k.warning))));
    else if (sup.state === "running" && sup.auto_restart === false) warn.appendChild(h("p", { "class": "banner warn", style: "margin-top:8px" }, icon("alert"), h("span", { "class": "b-body" }, "Auto-restart is switched off for the whole supervisor: nothing restarts by itself until it is switched on again.", cmdChip("lawrank supervisor on", true))));
    if (S.status && ["missing", "stale", "unreadable", "off"].indexOf(sup.state) >= 0 && !(sup.state === "stale" && sup.switch_on === true))   // the supervisor itself is not on duty (not: on, paused by macOS)
      warn.appendChild(h("p", { "class": "kr-meta", style: "margin-top:8px" }, h("span", null, "Is the supervisor itself on?"), cmdChip("lawrank supervisor status"), h("span", null, "To turn it on:"), cmdChip("lawrank supervisor on")));

    var list = clear($("kr-list"));
    var rows = arr(k.jobs).filter(isObj);
    if (!rows.length) list.appendChild(h("li", { "class": "placeholder" }, "No kept-alive jobs are listed."));
    S.ui.kaOpen = S.ui.kaOpen || {};
    rows.forEach(function (r) {
      var li = h("li", { "class": "kr" + (kaAttn(r) ? " attn" : "") });
      var c = crewOf(r.job);
      var by = str(r.auto_by);
      var arTitle = by === "watcher" ? "Its own Terminal keep-alive shell restarts it (the supervisor is not reporting)" : by === "supervisor" ? "The supervisor restarts it" : "";
      var ar = r.auto_restart === true ? h("span", { "class": "chip on", title: arTitle || null }, "auto-restart: on" + (by === "watcher" ? " (its watcher)" : ""))
        : r.auto_restart === false ? h("span", { "class": "chip off" }, "auto-restart: off")
        : h("span", { "class": "chip off", title: "Unknown until the supervisor reports" }, "auto-restart: unknown");
      li.appendChild(h("div", { "class": "kr-top" }, crewDot(c), h("span", { "class": "kr-name" }, str(r.label) || str(r.name)), light(str(r.state) || "unknown", null, null, r.state === "running"), ar));
      var meta = h("div", { "class": "kr-meta" });
      var lr = ms(r.last_restart_at);
      meta.appendChild(h("span", null, "last restart: ", lr ? h("b", { "data-ago": lr }, fAgo(lr)) : h("b", null, "none recorded")));
      if (isNum(r.restarts_24h)) meta.appendChild(h("span", null, fInt(r.restarts_24h) + (r.restarts_24h === 1 ? " restart" : " restarts") + " in 24 h"));
      var ps = ms(r.pid_since);
      if (ps && r.running) meta.appendChild(h("span", null, "up ", h("b", { "data-dur-since": ps }, fDurShort((Date.now() - ps) / 1000))));
      var nt = ms(r.next_try_at);
      if (nt && r.running !== true) meta.appendChild(h("span", null, "next try ", h("b", { "data-until": nt }, fUntil(nt))));
      if (isNum(r.failed_starts) && r.failed_starts > 0) meta.appendChild(h("span", null, h("b", null, fInt(r.failed_starts)), r.failed_starts === 1 ? " failed start" : " failed starts in a row"));
      if (isNum(r.starts_today) && r.starts_today > 0) meta.appendChild(h("span", null, fInt(r.starts_today) + (r.starts_today === 1 ? " start" : " starts") + " today" + (str(r.last_start_by) ? ", the last by " + str(r.last_start_by) : "")));
      if (r.watcher_running === false && by === "watcher") meta.appendChild(h("span", null, "its watcher shell is not running"));
      if (r.seen_running === false && r.running === true) meta.appendChild(h("span", null, "this page's own check did not see it"));
      li.appendChild(meta);
      if (r.note && !/^(running|finished)$/i.test(str(r.note))) li.appendChild(h("p", { "class": "kr-note" }, str(r.note)));
      var pr = kaPrimary(r);
      var cmds = h("div", { "class": "kr-cmds" });
      if (pr.cmd) cmds.appendChild(cmdChip(pr.cmd, kaAttn(r)));
      var others = ["start", "stop", "logs"].map(function (id) { return kaCmd(r, id); }).filter(function (x) { return x && x !== pr.cmd; });
      if (others.length) {
        var more = h("details", { "class": "kr-more" }, h("summary", null, "and " + others.map(function (x) { return x.split(" ")[1]; }).join(", ")));
        if (S.ui.kaOpen[r.name]) more.open = true;
        more.addEventListener("toggle", function () { S.ui.kaOpen[r.name] = more.open; });
        var box = h("div", { "class": "kr-cmds" });
        others.forEach(function (x) { box.appendChild(cmdChip(x)); });
        more.appendChild(box);
        cmds.appendChild(more);
      }
      if (cmds.childNodes.length) li.appendChild(cmds);
      list.appendChild(li);
    });

    var cl = clear($("cmd-list"));
    var gens = arr(k.commands).filter(isObj);
    if (!gens.length) gens = KA_GENERAL;
    gens.forEach(function (c) {
      if (!c.cmd) { cl.appendChild(h("li", { "class": "cmd-plain" }, icon("mac"), h("span", null, h("b", null, str(c.label) + ": "), str(c.what)))); return; }
      var chipEl = cmdChip(c.cmd, c.id === "start_all");
      if (!chipEl) return;
      cl.appendChild(h("li", { "class": "cmd-row" }, chipEl, h("span", { "class": "cmd-what" }, h("b", null, str(c.label)), str(c.what) ? ": " + str(c.what) : "")));
    });
    var names = rows.map(function (r) { return str(r.name); }).filter(function (n) { return /^[a-z0-9_-]{1,24}$/.test(n); });
    if (names.length) cl.appendChild(h("li", { "class": "cmd-names" }, "Job names for the commands: ", names.map(function (n, i) { return [i ? " · " : "", h("code", null, n)]; })));
  }

  // ------------------------------------------------------------------ counters
  function setNum(el, v, fmt, fromZero) {
    var old = el._v;
    el._v = v;
    if (el._raf) cancelAnimationFrame(el._raf);
    if (!isNum(v)) { el.textContent = "–"; return; }
    if (fromZero && !isNum(old)) old = 0;
    if (!isNum(old) || old === v || REDUCED.matches || document.hidden) { el.textContent = fmtv(v, fmt); return; }
    var t0 = performance.now(), dur = fromZero ? 1100 : 900;
    function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      k = 1 - Math.pow(1 - k, 3);
      el.textContent = fmtv(old + (v - old) * k, fmt);
      if (k < 1) el._raf = requestAnimationFrame(step); else el._raf = null;
    }
    el._raf = requestAnimationFrame(step);
  }
  function flash(el) { if (!el || REDUCED.matches) return; el.classList.remove("changed"); void el.offsetWidth; el.classList.add("changed"); }

  // ------------------------------------------------------------------ sparklines and small charts
  function sparkSvg(pts, W, H, color, opts) {
    opts = opts || {};
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true", focusable: "false", preserveAspectRatio: "none" });
    if (pts.length < 2) {
      if (pts.length === 1) svg.appendChild(sv("circle", { cx: W - 4, cy: H / 2, r: 3, style: "fill:" + color }));
      return svg;
    }
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t, lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (opts.zero) lo = Math.min(0, lo);
    if (hi === lo) { hi += 1; lo -= 1; }
    var pad = 3;
    function X(t) { return pad + (W - 2 * pad) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0)); }
    function Y(v) { return H - pad - (H - 2 * pad) * (v - lo) / (hi - lo); }
    var d = "", a = "";
    pts.forEach(function (p, i) { d += (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); });
    a = d + "L" + X(t1).toFixed(1) + " " + (H - pad) + "L" + X(t0).toFixed(1) + " " + (H - pad) + "Z";
    svg.appendChild(sv("path", { d: a, style: "fill:" + color + ";opacity:.12" }));
    svg.appendChild(sv("path", { d: d, "class": "g-line", style: "stroke:" + (opts.muted ? "var(--c0)" : color) + ";stroke-width:1.6" }));
    var last = pts[pts.length - 1];
    svg.appendChild(sv("circle", { cx: X(last.t).toFixed(1), cy: Y(last.v).toFixed(1), r: 3, "class": "g-dot", style: "fill:" + color + ";stroke-width:1.5" }));
    return svg;
  }
  function sparkTip(el, pts, fmt, unit, label, color) {
    if (pts.length < 1) return;
    el.addEventListener("pointermove", function (ev) {
      var r = el.getBoundingClientRect(), k = clamp((ev.clientX - r.left) / r.width, 0, 1);
      var t = pts[0].t + k * (pts[pts.length - 1].t - pts[0].t), best = pts[0];
      pts.forEach(function (p) { if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; });
      tipShow([tipT(fDayTime(best.t)), tipRow(fmtv(best.v, fmt) + (unit ? " " + unit : ""), label, color)], ev.clientX, ev.clientY);
    });
    el.addEventListener("pointerleave", tipHide);
  }
  function columnsSvg(vals, W, H, color, labelFn, fmt, unit) {   // a column per value, the newest on the right
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", focusable: "false" });
    var n = vals.length, mx = 0;
    vals.forEach(function (v) { if (isNum(v)) mx = Math.max(mx, v); });
    if (!mx) mx = 1;
    var slot = W / n, bw = Math.min(24, slot - 2), base = H - 1;
    svg.appendChild(sv("line", { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, "class": "g-axis" }));
    vals.forEach(function (v, i) {
      var hgt = isNum(v) ? Math.max(1, (H - 4) * v / mx) : 0, x = i * slot + (slot - bw) / 2, y = base - hgt;
      var r = Math.min(4, bw / 2, hgt);
      var d = "M" + x + " " + base + "V" + (y + r) + "Q" + x + " " + y + " " + (x + r) + " " + y + "H" + (x + bw - r) + "Q" + (x + bw) + " " + y + " " + (x + bw) + " " + (y + r) + "V" + base + "Z";
      var bar = sv("path", { d: d, style: "fill:" + color + (i === n - 1 ? "" : ";opacity:.55") });
      svg.appendChild(bar);
      var hit = sv("rect", { x: i * slot, y: 0, width: slot, height: H, fill: "transparent" });
      hit.addEventListener("pointermove", function (ev) { tipShow([tipT(labelFn(i)), tipRow(fmtv(v, fmt) + (unit ? " " + unit : ""), null, color)], ev.clientX, ev.clientY); });
      hit.addEventListener("pointerleave", tipHide);
      svg.appendChild(hit);
    });
    return svg;
  }

  // ------------------------------------------------------------------ headline, subline, readiness
  function missionDay() {
    var start = ymdMs(str(g(st(), "project.started")) || CFG.missionStart);
    if (!start) return null;
    var d0 = new Date(start); d0.setHours(0, 0, 0, 0);
    return Math.floor((Date.now() - d0.getTime()) / 86400000) + 1;
  }
  function renderHead() {
    var s = st(), hd = isObj(s.headline) ? s.headline : {};
    setText("bridge-eyebrow", str(g(s, "project.name")) || "Law review subject tags");
    var h1 = $("bridge-h"), more = "";
    if (!S.status) { setText(h1, S.error ? "The status could not be loaded." : "Loading the latest status…"); }
    else {
      // the first sentence is the headline; the rest reads below it in smaller type
      var sent = str(hd.sentence), m = /^(.+?[.!?])\s+(?=[A-Z0-9])([\s\S]+)$/.exec(sent);
      setText(h1, (m ? m[1] : sent) || "The status loaded, but it carries no headline.");
      more = m ? m[2] : "";
    }
    setText("headline-more", more);
    $("headline-more").hidden = !more;
    var sub = clear($("subline"));
    if (!S.status) { if (S.error) sub.appendChild(h("span", null, S.error + " The keep-alive commands below work without it.")); return; }
    var day = missionDay();
    if (day) sub.appendChild(h("span", null, "Mission day ", h("b", null, String(day))));
    var fp = arr(s.phases).filter(function (p) { return isObj(p) && p.id === hd.focus_phase; })[0];
    if (fp) sub.appendChild(h("span", null, "Focus: ", h("b", null, "Phase " + fp.n + " · " + str(fp.name))));
    if (isNum(hd.must_total)) sub.appendChild(h("span", null, "Must-run jobs up: ", h("b", null, fInt(hd.must_up) + " of " + fInt(hd.must_total))));
    var al = arr(s.alerts).filter(isObj), crit = al.filter(function (a) { return a.severity === "critical"; }).length, warn = al.filter(function (a) { return a.severity === "warn"; }).length;
    sub.appendChild(h("span", null, "Alerts: ", h("b", null, crit + " critical, " + warn + (warn === 1 ? " warning" : " warnings"))));
    var team = g(s, "team.agents_in_flight");
    if (isNum(team)) sub.appendChild(h("span", null, "Agents at work: ", h("b", null, fInt(team))));
    sub.appendChild(h("span", null, "Schema ", h("b", null, String(schemaV() || "?"))));
  }

  function readinessItems() {
    var s = st(), out = [];
    var cov = coverageLow();
    var hv_left = g(job("harvest") || {}, "queue.left"), core = job("core"), coreP = core && isObj(core.progress) ? core.progress : null;
    var p1 = arr(s.phases).filter(function (p) { return isObj(p) && p.id === "p1"; })[0];
    var collectFrac = cov && isNum(cov.papers) && cov.papers ? cov.low / cov.papers : null;
    var needs1 = [];
    if (isNum(hv_left)) needs1.push(fInt(hv_left) + " papers in the harvest's gaps queue");
    if (coreP && isNum(coreP.total)) needs1.push(fInt(coreP.total - coreP.done) + " CORE lookups");
    out.push({ phase: "Collect", word: p1 && p1.status === "done" ? "Done" : "Collecting", frac: collectFrac, crew: CREW_BY.harvest,
      note: collectFrac !== null ? "at least " + fPct(100 * collectFrac) + " of papers have a text" : "",
      needs: needs1.length ? "Still to go: " + needs1.join(" and ") + "." : "" });
    var s1 = codingTotals("coding_s1"), f2v = s1 && isNum(s1.done) && s1.total ? s1.done / s1.total : null;
    var w2 = f2v === null ? "Unknown" : f2v >= 1 ? "Done" : f2v >= 0.75 ? "Nearly there" : f2v >= 0.5 ? "Over halfway" : f2v >= 0.1 ? "Under way" : "Starting";
    var dv = codingTotals("coding_dev");
    out.push({ phase: "Labels", word: w2, frac: f2v, crew: CREW_BY.coders,
      note: s1 && isNum(s1.done) ? fInt(s1.done) + " of " + fInt(s1.total) + " silver S1 units" : "",
      needs: s1 && isNum(s1.total) ? (s1.total - s1.done) + " S1 units to go" + (dv && dv.done === dv.total && isNum(dv.total) ? "; DEV is complete (" + fInt(dv.total) + " units)." : ".") : "" });
    var m = isObj(s.model) ? s.model : {}, archs = arr(m.architectures).filter(isObj);
    var trained = archs.filter(function (a) { return a.trained_on_real_labels; }).length;
    var contest = isObj(m.contest) ? m.contest : {};
    var w3 = contest.training_now ? "Training" : trained >= archs.length && archs.length ? "Trained" : g(m, "preview.exists") ? "Preview only" : "Waiting";
    out.push({ phase: "Model", word: w3, frac: archs.length ? trained / archs.length : null, crew: CREW_BY.lab,
      note: archs.length ? trained + " of " + archs.length + " contest models trained" : "",
      needs: str(contest.status) ? "Contest: " + str(contest.status) + "." : "" });
    var beta = isObj(s.beta) ? s.beta : {}, cl = arr(beta.checklist).filter(isObj);
    var bd = cl.filter(function (c) { return c.done || c.auto_met; }).length;
    out.push({ phase: "Beta " + (str(beta.version) || "v0.9"), word: cl.length && bd >= cl.length ? "Ready" : "Not yet", frac: cl.length ? bd / cl.length : null, crew: null,
      note: cl.length ? bd + " of " + cl.length + " checklist items" : "",
      needs: isObj(beta.estimate) ? "Estimated " + rangeText(beta.estimate) + " (an estimate)." : "" });
    return out;
  }
  function renderReadiness() {
    var row = clear($("readiness"));
    if (!S.status || (!arr(st().phases).length && !jobs().length)) { row.appendChild(h("p", { "class": "placeholder" }, S.status ? "This status carries no phases or jobs to rate." : "Readiness shows once a status loads.")); setText("ready-note", ""); return; }
    readinessItems().forEach(function (it) {
      var meter = h("div", { "class": "meter" + (isNum(it.frac) && it.frac <= 0 ? " zero" : ""), role: "img", "aria-label": it.phase + ": " + (isNum(it.frac) ? fPct(100 * it.frac) : "unknown") });
      var span = h("span");
      span.style.width = (isNum(it.frac) ? clamp(100 * it.frac, 0, 100) : 0) + "%";
      meter.appendChild(span);
      meter.style.setProperty("--meter", it.crew ? crewVar(it.crew) : "var(--ink-2)");
      row.appendChild(h("div", { "class": "ready" },
        h("div", { "class": "ready-top" }, h("span", { "class": "ready-phase" }, it.phase), h("span", { "class": "muted", style: "font-size:11.5px" }, isNum(it.frac) ? fPct(100 * it.frac, 0) : "")),
        h("div", { "class": "ready-word" }, it.word), meter,
        it.note ? h("div", { "class": "ready-needs" }, it.note) : null,
        it.needs ? h("div", { "class": "ready-needs muted" }, it.needs) : null));
    });
    var bt = g(st(), "beta.estimate");
    setText("ready-note", isObj(bt) ? "v0.9 beta: " + rangeText(bt) + " (estimate)" : "");
  }

  // ------------------------------------------------------------------ hero tiles (the speed-test numbers)
  function heroDefs() {
    var s = st(), hv1 = job("harvest"), core = job("core"), s1 = job("coding_s1"), pv = g(s, "model.preview.numbers");
    var cov = coverageLow();
    var defs = [];
    defs.push({ id: "texts", crew: CREW_BY.harvest, label: "Papers with a text", value: cov ? cov.low : null, unit: "papers", fmt: "int", prefix: "≥",
      sub: cov ? [h("span", null, "at least " + fPct(cov.papers ? 100 * cov.low / cov.papers : null) + " of " + fInt(cov.papers)), h("span", null, fInt(cov.measured) + " measured " + fDay(cov.at) + " + " + fInt(cov.core) + " CORE finds since")] : null,
      info: (cov && cov.how ? "Measured: " + cov.how + ". " : "") + "A lower bound: texts the harvest and Semantic Scholar found since that count are not added until the next measurement.",
      pts: cov ? seriesFn(function (p) { return isNum(p.c_txt) ? cov.measured + p.c_txt : null; }) : [], key: "c_txt", good: "up" });
    var rpm = hv1 && isObj(hv1.rate) ? hv1.rate.last10 : hv("h_rpm");
    var perMin = arr(nowOf(hv1).requests_per_min);
    defs.push({ id: "rpm", crew: CREW_BY.harvest, label: "Requests a minute", value: rpm, unit: "/min", fmt: "1",
      sub: [h("span", null, "archive.org " + f1(g(nowOf(hv1), "archive.rpm10") !== null ? g(nowOf(hv1), "archive.rpm10") : hv("h_arpm")) + " /min"),
        h("span", null, fInt(rateOf(hv1, /^requests \(last 10/)) + " in 10 min, " + fInt(rateOf(hv1, /not found|failed/)) + " failed")],
      info: "The harvest's requests to all sites, averaged over the last 10 minutes; archive.org allows about 15 a minute. The bars are the last 10 whole minutes, oldest on the left.",
      cols: perMin.length ? perMin : null, pts: series("h_rpm"), key: "h_rpm" });
    var t = codingTotals("coding_s1");
    var papers = t && isNum(t.done) ? t.done * 10000 / 264 : null;
    defs.push({ id: "s1", crew: CREW_BY.coders, label: "Silver S1 units coded", value: t ? t.done : null, unit: t && isNum(t.total) ? "of " + fInt(t.total) : "units", fmt: "int",
      sub: [h("span", null, "about " + fInt(papers) + " papers (estimate: 37.9 a batch)"), h("span", null, fInt(g(nowOf(s1), "in_flight") ? arr(nowOf(s1).in_flight).length : hv("s1_fl")) + " in flight, " + fInt(isNum(g(nowOf(s1), "finished_last_hour")) ? nowOf(s1).finished_last_hour : hv("s1_h")) + " in the last hour")],
      info: "A unit is one coder agent reading one batch of 37-38 papers. Silver S1: 264 batches coded once plus 53 coded a second time (317 units, 10,000 papers and 2,000 again).",
      pts: series("s1"), key: "s1", good: "up" });
    var mv = pv && arr(pv.measures).filter(isObj)[0];
    var metric = null, lo = null, hi = null, mlabel = "Preview model on DEV";
    if (mv && isNum(mv.v)) { metric = 100 * mv.v; lo = mv.lo; hi = mv.hi; }
    else {
      var pm = arr(g(s, "model.preview.metrics")).filter(isObj)[0];
      if (pm && isNum(pm.v)) metric = pm.v <= 1 ? 100 * pm.v : pm.v;
    }
    defs.push({ id: "model", crew: CREW_BY.lab, label: mlabel, value: metric, unit: "%", fmt: "p1",
      sub: [h("span", null, "lenient rank-1" + (isNum(lo) ? ", 95% interval " + fShare(lo) + "–" + fShare(hi) : "")), h("span", null, (pv && isNum(pv.n_papers) ? fInt(pv.n_papers) + " DEV papers; " : "") + "never the paper's numbers")],
      info: "The quick preview model on frozen embeddings, cross-fitted on DEV-main; never a contest entry. Contest: " + (str(g(s, "model.contest.status")) || "not started") + ".",
      intervals: pv ? arr(pv.measures).filter(isObj) : null });
    var est = estimate("collection");
    var heta = hv1 && isObj(hv1.eta) ? ms(hv1.eta.at) : null, ceta = core && isObj(core.eta) ? ms(core.eta.at) : null;
    defs.push({ id: "finish", crew: CREW_BY.core, label: "Collection finishes", text: est ? ymdText(est.from) : "–", unit: est && est.to && est.to !== est.from ? "to " + ymdText(est.to) : "", est: true,
      sub: [heta ? h("span", null, "harvest's own: " + fDay(heta)) : null, ceta ? h("span", null, "CORE at its 60-min pace: " + fDay(ceta)) : null],
      info: est ? "Estimate. Assumes: " + str(est.assumes) : "No collection estimate in this status.",
      pts: series("h_left"), key: "h_left", good: "down", ptsLabel: "gaps queue left" });
    return defs;
  }
  function renderHero() {
    var box = $("hero-tiles");
    var defs = heroDefs();
    if (!box.childNodes.length || box._ids !== defs.map(function (d) { return d.id; }).join()) {
      clear(box); S.tiles = {};
      box._ids = defs.map(function (d) { return d.id; }).join();
      defs.forEach(function (d) {
        var num = h("span", { "class": "hero-num" }), unit = h("span", { "class": "hero-unit" }), pre = h("span", { "class": "hero-pre" });
        var infoBtn = h("button", { type: "button", "class": "info-btn", "aria-expanded": "false", "aria-label": "About " + d.label }, "i");
        var pop = h("p", { "class": "info-pop", hidden: true });
        infoBtn.addEventListener("click", function () { var o = pop.hidden; pop.hidden = !o; infoBtn.setAttribute("aria-expanded", o ? "true" : "false"); });
        var tile = h("div", { "class": "hero", id: "hero-" + d.id },
          h("div", { "class": "hero-top" }, crewDot(d.crew), h("span", { "class": "hero-label" }, d.label), infoBtn),
          h("div", { "class": "hero-val" }, h("span", { "class": "hero-num-wrap" }, pre, num), unit),
          h("div", { "class": "hero-sub" }), h("div", { "class": "hero-chart" }), h("div", { "class": "hero-foot" }), pop);
        box.appendChild(tile);
        S.tiles["hero-" + d.id] = { el: tile, num: num, unit: unit, pre: pre, pop: pop };
      });
    }
    defs.forEach(function (d) {
      var T = S.tiles["hero-" + d.id];
      if (!T) return;
      var old = T.num._v;
      if (d.text !== undefined) { setText(T.num, d.text); T.num._v = d.text; }
      else setNum(T.num, d.value, d.fmt, S.firstRender);
      setText(T.unit, d.unit || "");
      T.unit.classList.toggle("tight", d.unit === "%");
      setText(T.pre, d.prefix && isNum(d.value) ? d.prefix : "");
      setText(T.pop, d.info || "");
      var sub = clear(T.el.querySelector(".hero-sub"));
      add(sub, d.sub);
      var chart = clear(T.el.querySelector(".hero-chart"));
      var W = Math.max(120, Math.floor(chart.clientWidth || 160)), H = 46, color = crewVar(d.crew);
      if (d.cols) {
        var gm = genMs();
        chart.appendChild(columnsSvg(d.cols, W, H, color, function (i) { var back = d.cols.length - 1 - i; return back === 0 ? "the newest whole minute" : back + " min before the newest"; }, "int", "requests"));
      } else if (d.intervals && d.intervals.length) {
        chart.appendChild(intervalsMini(d.intervals, W, H, color));
      } else if (d.pts && d.pts.length) {
        var pts = thin(d.pts, 80);
        chart.appendChild(sparkSvg(pts, W, H, color));
        sparkTip(chart, pts, d.id === "texts" ? "int" : d.fmt, d.id === "texts" ? "papers" : (d.unit || ""), d.ptsLabel || d.label, color);
      } else chart.appendChild(h("span", { "class": "muted", style: "font-size:11.5px" }, "no trend yet"));
      var foot = clear(T.el.querySelector(".hero-foot"));
      if (d.est) foot.appendChild(estChip());
      if (d.key) {
        var dl = deltaEl(d.key, d.good, d.id === "rpm" ? "1" : "int", d.id === "finish" ? "queue" : "");
        if (dl) foot.appendChild(dl);
      }
      if (d.id === "model") foot.appendChild(h("span", null, "contest: " + (str(g(st(), "model.contest.status")) || "not started")));
      if (!S.firstRender && old !== undefined && old !== (d.text !== undefined ? d.text : d.value)) flash(T.el);
    });
  }
  function intervalsMini(ms_, W, H, color) {
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true", focusable: "false" });
    var n = Math.min(ms_.length, 6), lo = 0.6, hi = 1.0, rowH = H / n;
    function X(v) { return 4 + (W - 8) * (clamp(v, lo, hi) - lo) / (hi - lo); }
    for (var i = 0; i < n; i++) {
      var m = ms_[i], y = rowH * i + rowH / 2;
      svg.appendChild(sv("line", { x1: 4, x2: W - 4, y1: y, y2: y, "class": "g-grid" }));
      if (isNum(m.lo) && isNum(m.hi)) svg.appendChild(sv("line", { x1: X(m.lo), x2: X(m.hi), y1: y, y2: y, style: "stroke:" + color + ";stroke-width:3;stroke-linecap:round;opacity:.45" }));
      if (isNum(m.v)) svg.appendChild(sv("circle", { cx: X(m.v), cy: y, r: 3, "class": "g-dot", style: "fill:" + color + ";stroke-width:1.5" }));
    }
    return svg;
  }
  function deltaEl(key, good, fmt, what) {
    var pts = series(key);
    if (pts.length < 2) return null;
    var dv = pts[pts.length - 1].v - pts[0].v;
    var span = (pts[pts.length - 1].t - pts[0].t) / 1000;
    var cls = "delta";
    if (dv !== 0 && good) cls += ((dv > 0) === (good === "up")) ? " good" : " bad";
    var arrow = dv > 0 ? "▲ " : dv < 0 ? "▼ " : "";
    var el = h("span", { "class": cls, title: "Change from " + fDayTime(pts[0].t) + " to " + fDayTime(pts[pts.length - 1].t) },
      arrow + (dv === 0 ? "no change" : fmtv(Math.abs(dv), fmt)), " ", h("span", { "class": "win" }, "in " + fDurShort(span)));
    return el;
  }

  // ------------------------------------------------------------------ stat tile groups (rows of live numbers)
  // twelve tiles a group, so the rows fill at six, four or two a row
  function statDefs() {
    var s = st(), hv1 = job("harvest"), hn = nowOf(hv1), core = job("core"), cn = nowOf(core);
    var q = hv1 && isObj(hv1.queue) ? hv1.queue : {};
    function pick(a, b) { return isNum(a) ? a : (isNum(b) ? b : null); }
    var groups = [];
    groups.push({ id: "harvest", short: "harvest", crew: CREW_BY.harvest, title: "Harvest", note: "journal sites and archive.org; last 10 min unless said", tiles: [
      { id: "h_left", label: "Gaps queue left", v: pick(q.left, hv("h_left")), unit: "papers", key: "h_left", good: "down" },
      { id: "h_gd", label: "Gaps papers asked this run", v: pick(g(hn, "gaps.asked_this_run"), hv("h_gd")), unit: "papers", key: "h_gd", good: "up" },
      { id: "h_gt", label: "Texts found this run", v: pick(g(hn, "gaps.texts_this_run"), hv("h_gt")), unit: "texts", key: "h_gt", good: "up" },
      { id: "secs", label: "Seconds a gaps paper takes", v: pick(q.secs_each, g(hn, "gaps.secs_each")), unit: "s", fmt: "1", good: "down" },
      { id: "h_wk", label: "Workers working", v: pick(g(hn, "workers.working"), hv("h_wk")), unit: "of " + fInt(pick(g(hn, "workers.size"), hv("h_ws"))), key: "h_wk" },
      { id: "mem", label: "Memory in use (aim 90-95%)", v: pick(g(s, "machine.memory_pct"), hv("mem")), unit: "%", fmt: "1", key: "mem" },
      { id: "h_pass", label: "Journal passes done", v: pick(g(hn, "passes.done"), hv("h_pass")), unit: "of " + fInt(g(hn, "passes.planned")), key: "h_pass", good: "up" },
      { id: "h_rec", label: "Records kept", v: pick(hv("h_rec"), rateOf(hv1, /^records kept/)), unit: "/10 min", key: "h_rec", good: "up" },
      { id: "h_abs", label: "Abstracts kept", v: pick(hv("h_abs"), rateOf(hv1, /^abstracts kept/)), unit: "/10 min", key: "h_abs", good: "up" },
      { id: "h_err", label: "Requests that failed", v: pick(hv("h_err"), rateOf(hv1, /not found|failed/)), unit: "/10 min", key: "h_err", good: "down" },
      { id: "h_arpm", label: "archive.org requests a minute", v: pick(g(hn, "archive.rpm10"), hv("h_arpm")), unit: "/min", fmt: "1", key: "h_arpm" },
      { id: "pace", label: "archive.org pace against today's", v: g(hn, "archive.pace.x"), unit: "×", fmt: "x" }
    ] });
    var w = isObj(cn.window) ? cn.window : {}, rq = isObj(cn.requests) ? cn.requests : {}, cp = core && isObj(core.progress) ? core.progress : {};
    groups.push({ id: "core", short: "CORE", crew: CREW_BY.core, title: "CORE lane", note: "twenty papers a window", tiles: [
      { id: "c_done", label: "Papers looked up", v: pick(cp.done, hv("c_done")), unit: "of " + fInt(cp.total), key: "c_done", good: "up" },
      { id: "c_left", label: "Papers still to look up", v: isNum(cp.total) && isNum(cp.done) ? cp.total - cp.done : null, unit: "papers", good: "down" },
      { id: "c_txt", label: "Looked up and got a text", v: pick(g(core || {}, "found.with_text"), hv("c_txt")), unit: "papers", key: "c_txt", good: "up" },
      { id: "c_match", label: "Matched papers", v: pick(hv("c_match"), factOf(core, /^matched/)), unit: "papers", key: "c_match", good: "up" },
      { id: "c_ppm", label: "Papers a minute (60 min)", v: pick(g(core || {}, "rate.last60"), hv("c_ppm")), unit: "/min", fmt: "1", key: "c_ppm", good: "up" },
      { id: "c_rpm", label: "Requests a minute (10 min)", v: pick(hv("c_rpm"), factOf(core, /^requests a minute/)), unit: "/min", fmt: "1", key: "c_rpm" },
      { id: "c_req", label: "Requests to CORE in all", v: pick(rq.total, hv("c_req")), unit: "requests", key: "c_req" },
      { id: "c_win", label: "Window now", v: isNum(w.n) ? w.n : null, unit: "of " + fInt(w.of) },
      { id: "c_err", label: "Answers 400 or above (60 min)", v: pick(rq.errors60, factOf(core, /400 or above/)), unit: "answers", good: "down" },
      { id: "c_429", label: "Rate-limit answers (60 min)", v: pick(rq.rate_limited60, factOf(core, /429/)), unit: "answers", good: "down" },
      { id: "c_5xx", label: "Server errors handed back (60 min)", v: factOf(core, /server errors/), unit: "errors", good: "down" },
      { id: "c_gap", label: "Seconds between requests", v: pick(rq.gap_s, factOf(core, /seconds between/)), unit: "s", fmt: "1" }
    ] });
    var tm = isObj(s.team) ? s.team : {};
    var te = codingTotals("coding_test"), dv = codingTotals("coding_dev"), s1t = codingTotals("coding_s1"), s1j = job("coding_s1"), tej = job("coding_test");
    groups.push({ id: "coding", short: "coding", crew: CREW_BY.coders, title: "Coding and the team", note: "Claude coders; a unit is one agent on one batch", tiles: [
      { id: "s1_fl", label: "S1 units in flight", v: s1j && isObj(s1j.now) ? arr(nowOf(s1j).in_flight).length : hv("s1_fl"), unit: "units", key: "s1_fl" },
      { id: "s1_h", label: "S1 units finished (60 min)", v: pick(nowOf(s1j).finished_last_hour, hv("s1_h")), unit: "/h", key: "s1_h", good: "up" },
      { id: "s1_24", label: "S1 units finished (24 h)", v: rateOf(s1j, /24 h/), unit: "units", good: "up" },
      { id: "te", label: "TEST units final", v: te ? te.done : hv("te"), unit: te && isNum(te.total) ? "of " + fInt(te.total) : "units", key: "te", good: "up" },
      { id: "te_fl", label: "TEST units in flight", v: tej && isObj(tej.now) ? arr(nowOf(tej).in_flight).length : hv("te_fl"), unit: "units", key: "te_fl" },
      { id: "te_24", label: "TEST units finished (24 h)", v: rateOf(tej, /24 h/), unit: "units", good: "up" },
      { id: "dv", label: "DEV units final", v: dv ? dv.done : hv("dv"), unit: dv && isNum(dv.total) ? "of " + fInt(dv.total) : "units", key: "dv" },
      { id: "team", label: "Agents at work now", v: pick(tm.agents_in_flight, hv("team")), unit: "agents", key: "team" },
      { id: "cuf", label: "Coding units in flight", v: isNum(tm.coding_units_in_flight) ? tm.coding_units_in_flight : null, unit: "units" },
      { id: "oth", label: "Other agents in flight", v: isNum(tm.other_agents_in_flight) ? tm.other_agents_in_flight : null, unit: "agents" },
      { id: "wf", label: "Workflows active", v: isNum(tm.workflows_active) ? tm.workflows_active : null, unit: "workflows" },
      { id: "s1_left", label: "S1 units still to code", v: s1t && isNum(s1t.total) && isNum(s1t.done) ? s1t.total - s1t.done : null, unit: "units", good: "down" }
    ] });
    var upd = job("updater"), coll = isObj(s.collector) ? s.collector : {};
    var cyc = g(s, "live.seq"); if (!isNum(cyc)) cyc = factOf(upd, /^cycles/);
    var mainAt = ms(g(nowOf(upd), "main.at")) || ms(g(upd || {}, "last_activity"));
    var mt = [
      { id: "disk", label: "Free disk", v: pick(g(s, "machine.disk_free_gb"), hv("disk")), unit: "GB", fmt: "1", key: "disk", good: "up" },
      { id: "swap", label: "Swap in use", v: pick(g(s, "machine.swap_used_gb"), hv("swap")), unit: "GB", fmt: "1", key: "swap", good: "down" },
      { id: "load", label: "Load (1 minute)", v: g(s, "machine.load_1m"), unit: "", fmt: "2" },
      { id: "st", label: "Store lines with a text", v: pick(g(s, "collection.store.with_text"), hv("st")), unit: "lines", key: "st", good: "up" },
      { id: "sl", label: "Store record lines", v: pick(g(s, "collection.store.lines"), hv("sl")), unit: "lines", key: "sl", good: "up" },
      { id: "s2m", label: "Semantic Scholar papers matched", v: pick(g(nowOf(job("s2")), "pair.match"), hv("s2_match")), unit: "papers", key: "s2_match" },
      { id: "run", label: "Must-run jobs up", v: pick(g(s, "headline.must_up"), hv("run")), unit: "of " + fInt(g(s, "headline.must_total")), key: "run", good: "up" },
      { id: "alerts", label: "Warnings and critical alerts", v: S.status ? arr(s.alerts).filter(function (a) { return isObj(a) && a.severity !== "info"; }).length : null, unit: "open", key: "alerts", good: "down" },
      { id: "cycle", label: "Updater cycle", v: cyc, unit: "cycles" },
      { id: "mainage", label: "Page pushed to GitHub", v: mainAt ? Math.max(0, (Date.now() - mainAt) / 60000) : null, unit: "min ago", fmt: "int", ago: mainAt },
      { id: "coll", label: "Collector time a cycle", v: isNum(coll.seconds) ? coll.seconds : null, unit: "s", fmt: "2" },
      { id: "rss", label: "Collector memory a cycle", v: isNum(coll.max_rss_mb) ? coll.max_rss_mb : null, unit: "MB", fmt: "1" }
    ];
    var beats = jobs().filter(function (j) { return j.source === "heartbeat"; }).slice(0, 4).map(function (j) {
      var b = isObj(nowOf(j).beat) ? nowOf(j).beat : {};
      return { id: "b_" + j.id, label: "Heartbeat " + str(j.label), v: pick(b.done, hv("b_" + j.id)), unit: str(b.unit) || "done", key: "b_" + j.id, good: "up" };
    });
    if (beats.length) mt = mt.slice(0, 12 - beats.length).concat(beats);   // heartbeats take the places of the collector's own numbers
    groups.push({ id: "machine", short: "machine", crew: CREW_BY.relay, title: "Machine, stores and this page", note: "the Mac is shared with the harvest", tiles: mt });
    return groups;
  }
  function renderStats() {
    var box = $("stat-groups");
    var groups = statDefs();
    var ids = groups.map(function (gr) { return gr.id + ":" + gr.tiles.map(function (t) { return t.id; }).join(","); }).join("|");
    if (box._ids !== ids) {
      clear(box); box._ids = ids;
      groups.forEach(function (gr) {
        var tiles = h("div", { "class": "sg-tiles" });
        gr.tiles.forEach(function (t) {
          var num = h("span", { "class": "stat-num" }), unit = h("span", { "class": "stat-unit" });
          var foot = h("div", { "class": "stat-foot" });
          var el = h("div", { "class": "stat", id: "st-" + t.id }, h("div", { "class": "stat-label" }, t.label), h("div", { "class": "stat-val" }, num, unit), foot);
          tiles.appendChild(el);
          S.tiles["st-" + t.id] = { el: el, num: num, unit: unit, foot: foot };
        });
        S.ui.sgOpen = S.ui.sgOpen || {};
        var open = !!S.ui.sgOpen[gr.id];
        var sgEl = h("div", { "class": "sg" + (open ? " open" : "") }, h("div", { "class": "sg-head" }, crewDot(gr.crew), gr.title, h("span", { "class": "sg-note" }, gr.note)), tiles);
        // on a phone a group shows its first four numbers until it is opened (CSS hides the rest only at phone width)
        var more = h("button", { type: "button", "class": "btn sm sg-more", "aria-expanded": open ? "true" : "false" }, open ? "Show fewer" : "Show all " + gr.tiles.length + " " + (gr.short || "") + " numbers");
        more.addEventListener("click", function () {
          var o = !sgEl.classList.contains("open");
          S.ui.sgOpen[gr.id] = o;
          sgEl.classList.toggle("open", o);
          more.setAttribute("aria-expanded", o ? "true" : "false");
          more.textContent = o ? "Show fewer" : "Show all " + gr.tiles.length + " " + (gr.short || "") + " numbers";
          if (o) { S.sig.stats = null; renderStats(); }
        });
        sgEl.appendChild(more);
        box.appendChild(sgEl);
      });
    }
    groups.forEach(function (gr) {
      var color = crewVar(gr.crew);
      gr.tiles.forEach(function (t) {
        var T = S.tiles["st-" + t.id];
        if (!T) return;
        var old = T.num._v;
        setNum(T.num, isNum(t.v) ? t.v : null, t.fmt || "int", S.firstRender);
        if (t.ago) T.num.setAttribute("data-ago-min", t.ago); else T.num.removeAttribute("data-ago-min");
        setText(T.unit, t.unit || "");
        clear(T.foot);
        var dl = t.key ? deltaEl(t.key, t.good, t.fmt === "x" ? "2" : t.fmt === "2" ? "2" : t.fmt || "int") : null;
        T.foot.appendChild(dl || h("span", { "class": "delta" }, h("span", { "class": "win" }, t.key ? "no trend yet" : "now")));
        var sp = h("span", { "class": "stat-spark", "aria-hidden": "true" });
        T.foot.appendChild(sp);
        if (t.key) {
          var pts = thin(series(t.key), 60);
          if (pts.length > 1) {
            var sw = Math.max(60, Math.floor((T.el.clientWidth || 150) - 22));
            sp.appendChild(sparkSvg(pts, sw, 20, color));
            sparkTip(sp, pts, t.fmt || "int", t.unit, t.label, color);
          }
        }
        if (!S.firstRender && isNum(old) && isNum(t.v) && old !== t.v) flash(T.el);
      });
    });
  }

  // ------------------------------------------------------------------ alerts and the stale banner
  function dataAge() { var gm = genMs(); return gm ? Math.max(0, (Date.now() - gm) / 1000) : null; }
  function expectedCycle() {
    var lv = isObj(st().live) ? st().live : null;
    if (S.src === "live" && lv && isNum(lv.cycle_s)) return lv.cycle_s;
    if (lv && isNum(lv.main_every_s)) return lv.main_every_s;
    return 600;
  }
  function freshness() {
    var age = dataAge();
    if (age === null) return S.status ? "undated" : S.error ? "error" : "loading";
    var cyc = expectedCycle();
    if (age <= cyc * 2 + 120) return "live";
    if (age < 1800) return "late";
    return "stale";
  }
  function renderAlerts() {
    var box = clear($("alerts"));
    var age = dataAge(), fr = freshness();
    if (S.error && !S.status) {
      box.appendChild(h("div", { "class": "banner crit", role: "alert" }, icon("stop"), h("div", { "class": "b-body" },
        h("span", { "class": "b-sev" }, "No data"), h("span", null, "The status could not be loaded: " + S.error + " The page keeps trying. If the Mac's jobs stopped, use the runbook below."))));
    }
    if (fr === "undated") box.appendChild(h("div", { "class": "banner warn", role: "status" }, icon("alert"), h("div", { "class": "b-body" },
      h("span", { "class": "b-sev" }, "Undated data"), h("span", null, "The status file carries no time, so this page cannot tell how old it is. To see what runs now:"), cmdChip("lawrank status", true))));
    if (fr === "stale") {
      var old6 = age >= 6 * 3600;
      box.appendChild(h("div", { "class": "banner " + (old6 ? "crit" : "warn"), role: "status" }, icon("alert"), h("div", { "class": "b-body" },
        h("span", { "class": "b-sev" }, old6 ? "Very old data" : "Stale data"),
        h("span", null, "The newest status is " + fDurShort(age) + " old. The updater on the Mac may have stopped. Check, then start it:"),
        cmdChip("lawrank status"), cmdChip("lawrank start updater", true))));
    }
    var SEV = { critical: 0, warn: 1 };
    arr(st().alerts).filter(isObj).map(function (a, i) { return { a: a, i: i }; })   // most severe first, else as listed
      .sort(function (x, y) { return (SEV[x.a.severity] !== undefined ? SEV[x.a.severity] : 2) - (SEV[y.a.severity] !== undefined ? SEV[y.a.severity] : 2) || x.i - y.i; })
      .map(function (x) { return x.a; }).forEach(function (a) {
      var sev = a.severity === "critical" ? "crit" : a.severity === "warn" ? "warn" : "info";
      var body = h("div", { "class": "b-body" }, h("span", { "class": "b-sev" }, sev === "crit" ? "Critical" : sev === "warn" ? "Warning" : "Note"),
        h("span", null, labelled(a.job, a.text)));
      var since = ms(a.since), until = ms(a.until);
      if (since) body.appendChild(h("span", { "class": "muted" }, "since ", h("span", { "data-ago": since }, fAgo(since))));
      if (until) body.appendChild(h("span", { "class": "muted" }, "until ", fTime(until), " (", h("span", { "data-until": until }, fUntil(until)), ")"));
      var row = kaRowFor(a.job);
      if (row && kaNeedsStart(row) && row.state !== "stopped_on_purpose" && !/lawrank start/.test(str(a.text))) { var c = cmdChip(kaPrimary(row).cmd, kaAttn(row)); if (c) body.appendChild(c); }
      else cmdsIn(a.text).filter(function (x) { return !/^lawrank (stop |supervisor off)/.test(x); })   // what was done is not what to do
        .slice(0, 2).forEach(function (x, i) { var c2 = cmdChip(x, i === 0 && a.severity !== "info"); if (c2) body.appendChild(c2); });
      box.appendChild(h("div", { "class": "banner " + sev, role: sev === "crit" ? "alert" : null }, icon(sev === "crit" ? "stop" : sev === "warn" ? "alert" : "info"), body));
    });
  }

  // ------------------------------------------------------------------ where the work happens
  function renderWhere() {
    var box = clear($("where"));
    var s = st(), upd = job("updater"), un = nowOf(upd);
    var mem = g(s, "machine.memory_pct"), disk = g(s, "machine.disk_free_gb");
    function item(ic, title, lines, lt) {
      var body = h("div", { "class": "where-body" }, h("b", null, title));
      lines.forEach(function (l) { if (l) body.appendChild(h("span", null, l)); });
      if (lt) body.appendChild(lt);
      box.appendChild(h("div", { "class": "where-item" }, icon(ic), body));
    }
    var hn = nowOf(job("harvest"));
    item("mac", "The Mac", ["memory " + fPct(mem) + " (" + (str(g(s, "machine.memory_source")) || "measured") + "), " + f1(disk) + " GB disk free",
      "the harvest's pool aims memory at " + (isNum(g(hn, "workers.aim_low_pct")) ? fInt(g(hn, "workers.aim_low_pct")) + "-" + fInt(g(hn, "workers.aim_high_pct")) + "%" : "90-95%")],
      light(S.status ? (freshness() === "stale" ? "stale" : "running") : "unknown", null, S.status ? (freshness() === "stale" ? "Quiet" : "Reporting") : "Unknown", freshness() === "live"));
    var KK = keepalive().k, sup = isObj(KK.supervisor) ? KK.supervisor : { state: "missing" }, cnt = isObj(KK.counts) ? KK.counts : null;
    item("shield", "The supervisor (launchd, on the Mac)", [
      sup.state === "running" || sup.state === "stale" ? (ms(sup.at) ? "last check " + fAgo(ms(sup.at)) : "") + (isNum(sup.every_s) ? ", every " + fDurShort(sup.every_s) : "")
        : sup.state === "unreadable" ? "its status file is there but unreadable" : sup.state === "off" ? "turned off on purpose (lawrank supervisor off): it restarts nothing" : "its status was not found: nothing restarts by itself",
      cnt && isNum(cnt.jobs) ? fInt(cnt.running) + " of " + fInt(cnt.jobs) + " kept-alive jobs running; auto-restart on for " + fInt(cnt.auto_restart_on) : ""], svLight(sup, true));
    var mainAt = ms(g(un, "main.at")) || ms(upd && upd.last_activity);
    item("globe", "GitHub Pages (this page)", [mainAt ? "page data pushed " + fAgo(mainAt) : "page push time unknown", "rebuilt about 1 minute after each push, every 10 minutes"],
      light(g(un, "main.ok") === false ? "failing" : "running", g(un, "main.failures") > 0 ? "warn" : null, g(un, "main.ok") === false ? "Push failing" : "Publishing"));
    var lvAt = ms(g(un, "live.at"));
    var liveLine = S.live.state === "ok" ? "this page reads it every " + pollSeconds() + " s" : S.live.state === "absent" ? "not set up yet: the page reads the Pages copy" : S.live.state === "limited" ? "GitHub's hourly allowance is used up: back " + fUntil(S.live.reset) : LOCAL && !WANT_LIVE ? "not read from this Mac (local files instead)" : "connecting";
    item("branch", "Live channel (the live branch)", [lvAt ? "data pushed " + fAgo(lvAt) : "", liveLine],
      light(S.live.state === "ok" ? "running" : S.live.state === "absent" || (LOCAL && !WANT_LIVE) ? "idle" : S.live.state === "limited" ? "waiting" : "unknown", null,
        S.live.state === "ok" ? "Live" : S.live.state === "absent" ? "Not yet" : S.live.state === "limited" ? "Paused" : LOCAL && !WANT_LIVE ? "Off here" : "Checking", S.live.state === "ok"));
    var srcs = [];
    if (job("harvest")) srcs.push("journal sites and archive.org (harvest)");
    if (job("core")) srcs.push("CORE (" + (str(job("core").state) || "?") + ")");
    if (job("s2")) srcs.push("Semantic Scholar (" + (str(job("s2").state) || "?") + ")");
    if (job("openalex")) srcs.push("OpenAlex (" + (str(job("openalex").state) || "?") + ")");
    item("db", "Sources", [srcs.join(", ") || "none listed"]);
  }

  // ------------------------------------------------------------------ running now: the team strip and coding units in flight
  function codingJobs() { return jobs().filter(function (j) { return /^coding/.test(j.id); }); }
  function runName(id) { return id === "coding_s1" ? "S1" : id === "coding_test" ? "TEST" : id === "coding_dev" ? "DEV" : id.replace(/^coding_/, "").toUpperCase(); }
  function renderFlight() {
    var s = st(), tm = isObj(s.team) ? s.team : {};
    var strip = clear($("team-strip"));
    function mini(v, label) { strip.appendChild(h("div", { "class": "mini" }, h("div", { "class": "mini-num" }, isNum(v) ? fInt(v) : "–"), h("div", { "class": "mini-label" }, label))); }
    mini(tm.agents_in_flight, "agents at work now");
    mini(tm.coding_units_in_flight, "coding units in flight");
    mini(tm.other_agents_in_flight, "other agents in flight");
    mini(tm.workflows_active, "workflows active");
    mini(tm.journals_read, "journals read (48 h)");
    mini(tm.open_without_activity, "started, quiet 45+ min");
    var box = clear($("flight"));
    var units = [];
    codingJobs().forEach(function (j) {
      var n = nowOf(j), at = ms(n.at);
      arr(n.in_flight).filter(isObj).forEach(function (u) { units.push({ u: u, run: runName(j.id), job: j, at: at }); });
    });
    setText("flight-note", units.length ? units.length + " in flight; times tick live from each unit's start" : "");
    if (!units.length) {
      var why = codingJobs().length ? "No coding unit is in flight right now. A coding run works in five-hour usage windows; between windows nothing is in flight." : "This status lists no coding units in flight (schema 1 has no in-flight list).";
      box.appendChild(h("p", { "class": "placeholder" }, why));
      return;
    }
    units.sort(function (a, b) { return (ms(a.u.started_at) || 0) - (ms(b.u.started_at) || 0); });
    var maxRun = 0;
    units.forEach(function (x) { var st0 = ms(x.u.started_at); x.start = st0 || (x.at && isNum(x.u.running_s) ? x.at - x.u.running_s * 1000 : null); });
    var list = h("div", { "class": "units" });
    units.forEach(function (x) {
      var u = x.u, quietAt = x.at && isNum(u.quiet_s) ? x.at - u.quiet_s * 1000 : null;
      var timeEl = h("span", { "class": "unit-time", "data-clock-since": x.start || "" }, x.start ? fClock((Date.now() - x.start) / 1000) : fDur(u.running_s));
      var bar = h("span"); bar.setAttribute("data-run-bar", x.start || "");
      var quiet = h("span", null, "last active ", h("b", { "data-ago": quietAt || "" }, quietAt ? fAgo(quietAt) : "–"));
      var el = h("div", { "class": "unit" + (isNum(u.quiet_s) && u.quiet_s > 900 ? " quiet" : ""), tabindex: "0" },
        h("span", { "class": "spin", "aria-hidden": "true" }),
        h("span", null, h("span", { "class": "unit-id" }, str(u.batch) + " " + str(u.coder)), " ", h("span", { "class": "unit-run" }, x.run + " · stage " + str(u.stage))),
        timeEl, h("span", { "class": "unit-bar", "aria-hidden": "true" }, bar),
        h("span", { "class": "unit-quiet" }, quiet, h("span", null, "started " + fTime(x.start))));
      hoverTip(el, function () {
        return [tipT(x.run + " · " + str(u.unit)), tipRow(x.start ? fDur((Date.now() - x.start) / 1000) : fDur(u.running_s), "running"),
          tipRow(quietAt ? fAgo(quietAt) : "–", "last activity"), tipNote("Coder " + str(u.coder) + " on batch " + str(u.batch) + ", stage " + str(u.stage) + ". " + (u.coder === "adj" ? "The adjudicator reads the coders' labels." : "One coder agent reads one batch of papers."))];
      });
      list.appendChild(el);
    });
    box.appendChild(list);
    tickUnits();
  }
  function tickUnits() {
    var bars = document.querySelectorAll("[data-run-bar]"), mx = 1;
    var starts = [];
    bars.forEach(function (b) { var s0 = +b.getAttribute("data-run-bar"); if (s0) { var r = (Date.now() - s0) / 1000; starts.push(r); mx = Math.max(mx, r); } });
    mx = Math.max(mx, 1800);
    bars.forEach(function (b) { var s0 = +b.getAttribute("data-run-bar"); if (s0) b.style.width = clamp(100 * (Date.now() - s0) / 1000 / mx, 2, 100) + "%"; });
  }

  // ------------------------------------------------------------------ running now: one block per job
  var ORDER = { critical: 0, warn: 1 };
  function jobRank(j) {
    var row = kaRowFor(j.id);
    if (j.health === "critical" || (row && j.must_keep_running && kaNeedsStart(row) && row.state !== "stopped_on_purpose")) return 0;
    var stt = str(j.state);
    if (["running", "pairing", "serving", "training", "restarting", "waiting", "building"].indexOf(stt) >= 0) return j.health === "warn" ? 1 : 2;
    if (["stopped", "silent", "failed", "unknown"].indexOf(stt) >= 0) return 1;
    if (["idle", "paused", "built"].indexOf(stt) >= 0) return 3;
    return 4;
  }
  function barRow(b, color) {
    var pct = isNum(b.pct) ? b.pct : (isNum(b.done) && isNum(b.total) && b.total ? 100 * b.done / b.total : null);
    var meter = h("div", { "class": "meter" + (pct === 0 ? " zero" : ""), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": isNum(pct) ? pct.toFixed(1) : null, "aria-label": str(b.label) });
    var sp = h("span"); sp.style.width = (isNum(pct) ? clamp(pct, 0, 100) : 0) + "%"; meter.appendChild(sp);
    meter.style.setProperty("--meter", color);
    var unit = str(b.unit);
    var val = unit === "%" ? fPct(b.done) : fmtv(b.done, Number.isInteger(b.done) ? "int" : "1") + (isNum(b.total) ? " of " + fInt(b.total) : "") + (unit ? " " + unit : "");
    return h("div", { "class": "bar-row" }, h("div", { "class": "bar-top" }, h("span", null, str(b.label)), h("b", null, val + (isNum(pct) && unit !== "%" ? " · " + fPct(pct) : ""))), meter);
  }
  function factEl(f) {
    var u = str(f.unit);
    return h("div", { "class": "fact" }, h("div", { "class": "fact-v" }, u === "%" ? fPct(f.v) : fmtv(f.v, Number.isInteger(f.v) ? "int" : "1"), u && u !== "%" ? h("small", null, u) : null), h("div", { "class": "fact-k" }, str(f.k)));
  }
  function kvList(pairs, wide) {
    var dl = h("dl", { "class": "kv" + (wide ? " wide" : "") });
    pairs.forEach(function (p) { if (!p || p[1] === null || p[1] === undefined || p[1] === "") return; dl.appendChild(h("dt", null, p[0])); dl.appendChild(h("dd", null, p[1])); });
    return dl;
  }
  function tableEl(headers, rows, caption, numCols) {
    numCols = numCols || [];
    var t = h("table", { "class": "tbl" });
    if (caption) t.appendChild(h("caption", null, caption));
    var tr = h("tr");
    headers.forEach(function (x, i) { tr.appendChild(h("th", { scope: "col", "class": numCols.indexOf(i) >= 0 ? "n" : null }, x)); });
    t.appendChild(h("thead", null, tr));
    var tb = h("tbody");
    rows.forEach(function (r) { var row = h("tr"); r.forEach(function (c, i) { row.appendChild(h("td", { "class": numCols.indexOf(i) >= 0 ? "n" : null }, c)); }); tb.appendChild(row); });
    t.appendChild(tb);
    return h("div", { "class": "tbl-wrap" }, t);
  }
  function rbars(items, color, fmt, total) {
    var box = h("div", { "class": "rbars" });
    var mx = 0;
    items.forEach(function (it) { if (isNum(it.value)) mx = Math.max(mx, it.value); });
    items.forEach(function (it) {
      var tr = h("span"); tr.style.width = (mx ? 100 * (isNum(it.value) ? it.value : 0) / mx : 0) + "%";
      var row = h("div", { "class": "rbar", tabindex: "0" }, h("span", { "class": "rbar-label" }, it.label),
        h("span", { "class": "rbar-val" }, fmtv(it.value, fmt) + (total ? " · " + fPct(100 * it.value / total) : "")), h("span", { "class": "rbar-track" }, tr));
      row.style.setProperty("--crew", color);
      hoverTip(row, function () { return [tipRow(fmtv(it.value, fmt) + (total ? " (" + fPct(100 * it.value / total) + ")" : ""), it.label, color)].concat(it.note ? [tipNote(it.note)] : []); });
      box.appendChild(row);
    });
    return box;
  }
  function watcherEls(ws) {
    return tableEl(["Keep-alive shell", "State", "Acts next", "Detail"], ws.filter(isObj).map(function (w) {
      var nx = ms(w.next_at);
      return [str(w.name), str(w.state) || (w.running ? "running" : "stopped"), nx ? h("span", null, fTime(nx) + " (", h("span", { "data-until": nx }, fUntil(nx)), ")") : "–", str(w.detail) || "–"];
    }), "Shells that keep this job alive, from the process table");
  }
  function jobDrill(j, color) {
    var n = nowOf(j), body = h("div", { "class": "drill-body" });
    var bars = arr(n.bars).filter(isObj);
    if (bars.length > 2) { body.appendChild(h("h4", { "class": "mini-h" }, "Every bar")); var bb = h("div", { "class": "job-bars", style: "padding:0" }); bars.forEach(function (b) { bb.appendChild(barRow(b, color)); }); body.appendChild(bb); }
    var facts = arr(n.facts).filter(function (f) { return isObj(f) && isNum(f.v); });
    if (facts.length > 4) { body.appendChild(h("h4", { "class": "mini-h" }, "Every number")); var fb = h("div", { "class": "job-facts", style: "padding:0" }); facts.forEach(function (f) { fb.appendChild(factEl(f)); }); body.appendChild(fb); }
    // per-kind blocks
    if (j.id === "harvest") {
      var ps = isObj(n.passes) ? n.passes : null;
      if (ps) body.appendChild(kvList([["journal passes done", fInt(ps.done) + " of " + fInt(ps.planned)], ["running", fInt(ps.running)], ["waiting", fInt(ps.waiting)], ["paused", fInt(ps.paused)]]));
      var rp = arr(n.running_passes).filter(isObj);
      if (rp.length) body.appendChild(tableEl(["Pass", "Mode", "Pages", "Records", "Abstracts", "Running", "Last request"], rp.map(function (p) {
        return [str(p.id), str(p.mode), fInt(p.pages), fInt(p.records), fInt(p.abstracts), fDurShort(p.running_s), isNum(p.last_request_s_ago) ? fDurShort(p.last_request_s_ago) + " before the status" : "–"];
      }), "Journal passes running (journals are not named here)", [2, 3, 4]));
      var gp = isObj(n.gaps) ? n.gaps : null;
      if (gp) body.appendChild(kvList([["gaps papers left", fInt(gp.left)], ["asked this run", fInt(gp.asked_this_run)], ["texts found this run", fInt(gp.texts_this_run)], ["skipped for now this run", fInt(gp.skipped_this_run)], ["seconds a paper", f1(gp.secs_each)], ["the largest queue seen", fInt(gp.largest_queue)], ["the harvest's own finish estimate", ms(gp.eta_at) ? fDay(ms(gp.eta_at)) + " (estimate)" : null]]));
      var wk = isObj(n.workers) ? n.workers : null;
      if (wk) body.appendChild(kvList([["workers working", fInt(wk.working) + " of " + fInt(wk.size)], ["waiting for work", fInt(wk.waiting_for_work)], ["parked", fInt(wk.parked)], ["peak pool / start pool", fInt(wk.peak) + " / " + fInt(wk.start)], ["memory", fPct(wk.memory_pct) + (isNum(wk.aim_low_pct) ? " (aims at " + fInt(wk.aim_low_pct) + "-" + fInt(wk.aim_high_pct) + "%)" : "")], ["adaptive pool", wk.adaptive === true ? "yes" : wk.adaptive === false ? "no" : null]]));
      var ar = isObj(n.archive) ? n.archive : null;
      if (ar) body.appendChild(kvList([["archive.org lanes", fInt(ar.lanes)], ["items in its plan", fInt(ar.items_in_plan)], ["live PDFs for the workers", fInt(ar.live_pdfs_for_workers)], ["requests (10 / 60 min)", fInt(ar.requests_10m) + " / " + fInt(ar.requests_60m)], ["requests a minute (10 min)", f1(ar.rpm10)], ["pace against today's", isObj(ar.pace) ? "x" + f2(ar.pace.x) + " (" + fInt(ar.pace.good_in_a_row) + " good in a row)" : null], ["busy until", ms(ar.busy_until) ? fTime(ms(ar.busy_until)) : "not busy"]]));
      var kinds = isObj(n.request_kinds_10m) ? n.request_kinds_10m : null;
      if (kinds) { body.appendChild(h("h4", { "class": "mini-h" }, "Request kinds, last 10 min")); body.appendChild(rbars(Object.keys(kinds).map(function (k) { return { label: k.replace(/_/g, " "), value: kinds[k] }; }).sort(function (a, b) { return b.value - a.value; }), color, "int")); }
      if (n.network_down === true) body.appendChild(h("p", { "class": "banner warn" }, icon("alert"), h("span", { "class": "b-body" }, "The harvest reports the network down.")));
    }
    if (j.id === "core") {
      var w = isObj(n.window) ? n.window : null;
      if (w) body.appendChild(kvList([["window now", fInt(w.n) + " of " + fInt(w.of)], ["papers in it", "#" + fInt(w.first) + " to #" + fInt(w.last) + " (" + fInt(w.size) + " a window)"]]));
      var rq = isObj(n.requests) ? n.requests : null;
      if (rq) body.appendChild(kvList([["requests in all", fInt(rq.total)], ["requests (10 / 60 min)", fInt(rq.last10) + " / " + fInt(rq.last60)], ["answers 400 or above (60 min)", fInt(rq.errors60)], ["rate-limit answers (60 min)", fInt(rq.rate_limited60)], ["seconds between requests", f2(rq.gap_s)], ["CORE's allowance left", isNum(rq.remaining) ? fInt(rq.remaining) + " of " + fInt(rq.limit) : null]]));
      var wu = ms(n.waiting_until);
      if (wu) body.appendChild(h("p", { "class": "banner warn" }, icon("clock"), h("span", { "class": "b-body" }, "CORE asked for a pause until " + fTime(wu) + " (", h("span", { "data-until": wu }, fUntil(wu)), ").")));
    }
    if (j.id === "s2") {
      var kp = isObj(n.kept) ? n.kept : null;
      if (kp) body.appendChild(kvList([["paper records kept", fInt(kp.paper_records)], ["abstracts kept", fInt(kp.abstracts)], ["full texts kept", fInt(kp.full_texts)]]));
      var pr = isObj(n.pair) ? n.pair : null;
      if (pr) body.appendChild(kvList([["matched", fInt(pr.match)], ["not matched", fInt(pr.no)], ["held for review", fInt(pr.review)], ["texts written", fInt(pr.texts_written)], ["paired at", ms(pr.at) ? fDayTime(ms(pr.at)) : null]]));
    }
    if (/^coding/.test(j.id)) {
      var stg = arr(j.stages).filter(isObj);
      if (stg.length) body.appendChild(tableEl(["Stage", "Batches", "Coders", "Final", "Of", "Share", "Waits for"], stg.map(function (x) {
        return [str(x.stage), fInt(x.batches), fInt(x.n_coders) + (x.adjudicated ? " + adj" : ""), fInt(x.done), fInt(x.total), fPct(x.pct), x.ready === false ? str(x.wait) || "not ready" : "–"];
      }), "A unit is one agent on one batch: a coder or the adjudicator", [1, 3, 4, 5]));
      var ru = arr(n.recent_units).filter(isObj);
      if (ru.length) body.appendChild(tableEl(["Unit", "Finished", "Lines"], ru.map(function (u) { return [str(u.batch) + " " + str(u.coder), ms(u.at) ? h("span", null, fDayTime(ms(u.at))) : "–", fInt(u.items)]; }), "The newest finished units", [2]));
      if (ms(n.plan_at)) body.appendChild(kvList([["plan remade", fDayTime(ms(n.plan_at))], ["finished in the last hour", fInt(n.finished_last_hour)]]));
    }
    if (j.id === "preview") body.appendChild(kvList([["test page answering", n.serving === true ? "yes" : n.serving === false ? "no" : null], ["port", isNum(n.port) ? "localhost:" + n.port : null], ["checked", ms(n.port_checked_at) ? fDayTime(ms(n.port_checked_at)) : null], ["metrics made", ms(n.metrics_at) ? fDayTime(ms(n.metrics_at)) : null], ["model card", ms(n.model_card_at) ? fDayTime(ms(n.model_card_at)) : null]]));
    if (j.id === "updater") {
      var lv = isObj(n.live) ? n.live : null, mn = isObj(n.main) ? n.main : null;
      if (lv) body.appendChild(kvList([["live branch pushed", ms(lv.at) ? fDayTime(ms(lv.at)) : "not yet"], ["live push worked", lv.ok === true ? "yes" : lv.ok === false ? "no" : null], ["live pushes", fInt(lv.pushes)], ["live failures in a row", fInt(lv.failures)], ["scan", str(lv.scan) || null]]));
      if (mn) body.appendChild(kvList([["page (main) pushed", ms(mn.at) ? fDayTime(ms(mn.at)) : null], ["main push worked", mn.ok === true ? "yes" : mn.ok === false ? "no" : null], ["main failures in a row", fInt(mn.failures)], ["main every", isNum(mn.every_s) ? fDur(mn.every_s) : null]]));
      if (ms(n.notes_read_at)) body.appendChild(kvList([["notes read", fDayTime(ms(n.notes_read_at))]]));
    }
    if (isObj(n.beat)) {
      var b = n.beat;
      body.appendChild(kvList([["heartbeat step", str(b.step)], ["done", fInt(b.done) + (isNum(b.total) ? " of " + fInt(b.total) : "") + " " + str(b.unit)], ["last beat", ms(b.at) ? fDayTime(ms(b.at)) : null], ["beats every", isNum(b.every_s) ? fDur(b.every_s) : "not promised"], ["pace", isNum(b.rate_per_min) ? f1(b.rate_per_min) + " a minute" : null], ["note", str(b.note)]]));
    }
    var ws = arr(n.watchers);
    if (ws.length) body.appendChild(watcherEls(ws));
    var det = arr(j.details).filter(isObj);
    if (det.length) { body.appendChild(h("h4", { "class": "mini-h" }, "Details")); body.appendChild(kvList(det.map(function (d) { return [str(d.k), str(d.v)]; }), true)); }
    var rates = arr(j.rates).filter(isObj);
    if (rates.length) body.appendChild(kvList(rates.map(function (r) { return [str(r.label), fInt(r.value)]; })));
    arr(j.notes).forEach(function (t) { body.appendChild(h("p", { "class": "kr-note" }, str(t))); });
    if (j.line) body.appendChild(h("div", null, h("h4", { "class": "mini-h" }, "Its own latest line" + (ms(j.line_at) ? " (" + fTime(ms(j.line_at)) + ")" : "")), h("p", { "class": "line-quote" }, str(j.line))));
    var how = [["kept running by", str(j.kept_alive_by)], ["look at it", str(j.check)], ["stop it", str(j.stop)]];
    body.appendChild(kvList(how, true));
    if (isObj(j.estimate)) body.appendChild(h("p", { "class": "kr-note" }, estChip(), " " + str(j.estimate.what) + ": " + rangeText(j.estimate) + ". Assumes: " + str(j.estimate.assumes)));
    return body;
  }
  function jobCard(j) {
    var c = crewOf(j.id), color = crewVar(c), n = nowOf(j);
    var row = kaRowFor(j.id);
    var alarm = j.health === "critical" || (row && j.must_keep_running && kaAttn(row)), handled = !alarm && row && j.must_keep_running && kaHandled(row);
    var card = h("article", { "class": "card job" + (alarm ? " attn" : handled ? " handled" : "") + (j.state === "finished" ? " done-job" : ""), id: "job-" + j.id, "aria-label": str(j.label) });
    var at = ms(n.at) || ms(j.last_activity);
    var lightBox = h("div", { "class": "job-light" }, light(str(j.state) || "unknown", j.health, null, j.state === "running"), h("span", { "class": "job-age" }, at ? h("span", null, "status ", h("span", { "data-ago": at }, fAgo(at))) : ""));
    var phaseName = "";
    var ph = arr(st().phases).filter(function (p) { return isObj(p) && p.id === j.phase; })[0];
    if (ph) phaseName = "Phase " + ph.n + " · " + str(ph.name);
    card.appendChild(h("div", { "class": "job-head" }, avatar(c), h("div", { "class": "job-name" }, str(j.label) || j.id), lightBox,
      h("div", { "class": "job-crew" }, (c ? c.name : "") + (phaseName ? " · " + phaseName : "") + (j.must_keep_running ? " · must keep running" : j.must_continue ? " · must continue" : ""))));
    var step = str(n.step) || str(j.line) || "No current step reported.";
    card.appendChild(h("p", { "class": "job-step" }, step));
    var bars = arr(n.bars).filter(isObj);
    if (!bars.length && isObj(j.progress) && isNum(j.progress.done)) bars = [{ label: str(j.progress.unit) || "progress", done: j.progress.done, total: j.progress.total, pct: j.progress.pct }];
    if (bars.length) { var bb = h("div", { "class": "job-bars" }); bars.slice(0, 2).forEach(function (b) { bb.appendChild(barRow(b, color)); }); card.appendChild(bb); }
    var facts = arr(n.facts).filter(function (f) { return isObj(f) && isNum(f.v); });
    if (facts.length) { var fb = h("div", { "class": "job-facts" }); facts.slice(0, 4).forEach(function (f) { fb.appendChild(factEl(f)); }); card.appendChild(fb); }
    var eta = h("div", { "class": "job-eta" });
    if (isObj(j.rate) && (isNum(j.rate.last10) || isNum(j.rate.last60))) eta.appendChild(h("span", null, "pace ", h("b", null, (isNum(j.rate.last10) ? f1(j.rate.last10) + " (10 min)" : "") + (isNum(j.rate.last10) && isNum(j.rate.last60) ? ", " : "") + (isNum(j.rate.last60) ? f1(j.rate.last60) + " (60 min)" : "")), " " + str(j.rate.unit)));
    if (isObj(j.eta) && ms(j.eta.at)) eta.appendChild(h("span", { title: str(j.eta.basis) }, "finishes ", h("b", null, fDay(ms(j.eta.at))), " ", estChip(), " ", h("span", { "class": "muted" }, str(j.eta.basis))));
    if (isObj(j.eta_alt) && ms(j.eta_alt.at)) eta.appendChild(h("span", { title: str(j.eta_alt.basis) }, "or ", h("b", null, fDay(ms(j.eta_alt.at))), " ", h("span", { "class": "muted" }, "(" + str(j.eta_alt.basis) + ")")));
    if (isNum(j.uptime_s) && j.running) eta.appendChild(h("span", null, "up ", h("b", null, fDurShort(j.uptime_s))));
    if (eta.childNodes.length) card.appendChild(eta);
    if (row) {
      var cmdBox = h("div", { "class": "job-cmd" });
      if (kaNeedsStart(row) && row.state !== "finished") {
        var kp = kaPrimary(row), kc = kp.cmd ? cmdChip(kp.cmd, kaAttn(row)) : null;
        cmdBox.appendChild(h("span", null, row.state === "stopped_on_purpose" ? "Stopped on purpose. To start it again:" : kaHandled(row) ? "Being restarted. If it stays down:" :
          row.state === "failing" && /^lawrank logs /.test(str(kp.cmd)) ? "Its starts keep failing. Read its log:" : "Run by hand:"));
        if (kc) cmdBox.appendChild(kc);
      }
      else if (row.state === "running") { cmdBox.appendChild(h("span", null, "Its log:")); cmdBox.appendChild(cmdChip(kaCmd(row, "logs"))); }
      if (cmdBox.childNodes.length > 1) card.appendChild(cmdBox);
    }
    var det = h("details", { "class": "drill" });
    if (S.ui.open[j.id]) det.open = true;
    var sum = h("summary", null, "Everything it reports");
    det.appendChild(sum);
    det.addEventListener("toggle", function () {
      S.ui.open[j.id] = det.open;
      if (det.open && !det._filled) { det.appendChild(jobDrill(j, color)); det._filled = true; }
    });
    if (det.open) { det.appendChild(jobDrill(j, color)); det._filled = true; }
    card.appendChild(det);
    return card;
  }
  function renderJobs() {
    var box = clear($("jobs"));
    var list = jobs().slice();
    if (!list.length) { box.appendChild(h("p", { "class": "placeholder" }, S.status ? "This status lists no jobs." : "The jobs show once a status loads.")); return; }
    list = list.map(function (j, i) { return { j: j, i: i, r: jobRank(j) }; }).sort(function (a, b) { return a.r - b.r || a.i - b.i; });
    list.forEach(function (x) { box.appendChild(jobCard(x.j)); });
  }

  // ------------------------------------------------------------------ measurements: line charts with crosshair, tooltips and tables
  function niceStep(span, n) {
    var raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function niceScale(lo, hi, n, intOnly) {
    if (!isNum(lo) || !isNum(hi)) return { lo: 0, hi: 1, ticks: [0, 1] };
    if (hi === lo) { var pad = Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad; }
    var step = niceStep(hi - lo, n);
    if (intOnly && step < 1) step = 1;
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks = [];
    for (var v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { lo: a, hi: b, ticks: ticks };
  }
  var TSTEPS = [60e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3];
  function timeTicks(t0, t1, maxN) {
    var span = t1 - t0, step = TSTEPS[TSTEPS.length - 1];
    for (var i = 0; i < TSTEPS.length; i++) if (span / TSTEPS[i] <= maxN) { step = TSTEPS[i]; break; }
    var off = -new Date(t0).getTimezoneOffset() * 60000, out = [];
    var start = Math.ceil((t0 + off) / step) * step - off;
    if (step >= 86400e3) { var d = new Date(t0); d.setHours(0, 0, 0, 0); start = d.getTime(); while (start < t0) start += 86400e3; }
    for (var t = start; t <= t1; t += step) out.push(t);
    return { ticks: out, step: step };
  }
  function tickLabel(t, step) {
    var d = new Date(t);
    if (step >= 86400e3 || (d.getHours() === 0 && d.getMinutes() === 0)) return fDay(t);
    if (d.getMinutes() === 0) return d.toLocaleTimeString([], { hour: "numeric" });
    return fTime(t);
  }
  function lineChart(holder, cfg) {
    clear(holder);
    var W = Math.max(220, Math.floor(holder.clientWidth || 300)), H = cfg.height || 150;
    var all = [];
    cfg.series.forEach(function (s) { s.pts.forEach(function (p) { all.push(p.v); }); });
    if (!all.length) { holder.appendChild(h("p", { "class": "chart-empty" }, "No measurements in this window yet.")); return null; }
    var t0 = cfg.t0, t1 = cfg.t1;
    cfg.series.forEach(function (s) { if (s.pts.length) { t0 = Math.min(t0, s.pts[0].t); t1 = Math.max(t1, s.pts[s.pts.length - 1].t); } });
    if (t1 - t0 < 60000) t0 = t1 - 60000;
    var tData = t1;
    if (cfg.proj && isNum(cfg.proj.slope)) t1 = t1 + (t1 - t0) * 0.22;   // room for the projection to the right of the newest point
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (cfg.zero) lo = Math.min(0, lo);
    if (cfg.band) { lo = Math.min(lo, cfg.band[0] - 5); hi = Math.max(hi, cfg.band[1]); }
    if (isNum(cfg.yMax)) hi = Math.min(Math.max(hi, lo + 1), cfg.yMax);
    var sc = niceScale(lo, hi, 4, cfg.fmt === "int");
    var tickW = 0, axMax = Math.max(Math.abs(sc.lo), Math.abs(sc.hi));
    sc.ticks.forEach(function (v) { tickW = Math.max(tickW, fTick(v, axMax).length); });
    var endW = 0;   // room on the right for the end labels, measured from their text
    if (cfg.endLabels) cfg.series.forEach(function (s) { if (s.pts.length) endW = Math.max(endW, (fAxis(s.pts[s.pts.length - 1].v) + " " + (s.short || "")).length); });
    var padL = Math.max(26, tickW * 6.4 + 8), padR = cfg.endLabels ? Math.max(40, Math.ceil(endW * 6.3) + 14) : 14, padT = 8, padB = 20;
    var X = function (t) { return padL + (W - padL - padR) * (t - t0) / (t1 - t0); };
    var Y = function (v) { return padT + (H - padT - padB) * (1 - (v - sc.lo) / (sc.hi - sc.lo)); };
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": cfg.aria || cfg.title || "chart", focusable: "false" });
    if (cfg.band) svg.appendChild(sv("rect", { x: padL, width: W - padL - padR, y: Y(cfg.band[1]), height: Math.max(0, Y(cfg.band[0]) - Y(cfg.band[1])), "class": "g-aim" }));
    sc.ticks.forEach(function (v) {
      var y = Math.round(Y(v)) + 0.5;
      svg.appendChild(sv("line", { x1: padL, x2: W - padR, y1: y, y2: y, "class": v === sc.lo ? "g-axis" : "g-grid" }));
      var tx = sv("text", { x: padL - 6, y: y + 3.5, "text-anchor": "end", "class": "g-tick" }); tx.textContent = fTick(v, axMax); svg.appendChild(tx);
    });
    var tt = timeTicks(t0, t1, Math.max(2, Math.floor((W - padL - padR) / 58)));
    tt.ticks.forEach(function (t) {
      var x = X(t);
      if (x < padL + 14 || x > W - padR + (cfg.endLabels ? 30 : -4)) return;
      var tx = sv("text", { x: x, y: H - 5, "text-anchor": "middle", "class": "g-tick" });
      tx.textContent = tickLabel(t, tt.step);
      svg.appendChild(tx);
      svg.appendChild(sv("line", { x1: x, x2: x, y1: H - padB, y2: H - padB + 3, "class": "g-axis" }));
    });
    var gapMs = cfg.gapMs || 3 * 3600e3;
    cfg.series.forEach(function (s, si) {
      if (!s.pts.length) return;
      var d = "", prev = null;
      s.pts.forEach(function (p) {
        var x = X(p.t).toFixed(1), y = Y(clamp(p.v, sc.lo, sc.hi)).toFixed(1);
        if (cfg.step && prev) d += "H" + x;
        d += (!prev || p.t - prev.t > gapMs ? "M" : "L") + x + " " + y;
        prev = p;
      });
      if (cfg.series.length === 1 && !cfg.noArea) {
        var a = "", started = false, firstX = null, prevP = null;
        s.pts.forEach(function (p) {
          var x = X(p.t), y = Y(clamp(p.v, sc.lo, sc.hi));
          if (!started || p.t - prevP.t > gapMs) { if (started) a += "L" + X(prevP.t).toFixed(1) + " " + Y(sc.lo).toFixed(1) + "Z"; a += "M" + x.toFixed(1) + " " + Y(sc.lo).toFixed(1) + "L" + x.toFixed(1) + " " + y.toFixed(1); started = true; }
          else { if (cfg.step) a += "H" + x.toFixed(1); a += "L" + x.toFixed(1) + " " + y.toFixed(1); }
          prevP = p;
        });
        a += "L" + X(prevP.t).toFixed(1) + " " + Y(sc.lo).toFixed(1) + "Z";
        svg.appendChild(sv("path", { d: a, style: "fill:" + s.color + ";opacity:.1" }));
      }
      svg.appendChild(sv("path", { d: d, "class": "g-line", style: "stroke:" + s.color }));
      var last = s.pts[s.pts.length - 1];
      svg.appendChild(sv("circle", { cx: X(last.t), cy: Y(clamp(last.v, sc.lo, sc.hi)), r: 4, "class": "g-dot", style: "fill:" + s.color }));
      if (cfg.endLabels) {
        var lt = sv("text", { x: X(last.t) + 8, y: Y(clamp(last.v, sc.lo, sc.hi)) + 4 + (si && cfg.series.length > 1 ? labelNudge(cfg.series, si, Y, sc) : 0), "class": "g-lbl" });
        lt.textContent = fAxis(last.v) + " " + (s.short || "");
        svg.appendChild(lt);
      }
    });
    if (cfg.proj && isNum(cfg.proj.slope) && cfg.series[0].pts.length) {   // a dashed projection from the newest point (an estimate)
      var lp = cfg.series[0].pts[cfg.series[0].pts.length - 1];
      var vEnd = lp.v + cfg.proj.slope * (t1 - lp.t);
      svg.appendChild(sv("line", { x1: X(tData), x2: X(tData), y1: padT, y2: H - padB, "class": "g-grid" }));
      var nowL = sv("text", { x: X(tData) + 3, y: padT + 9, "class": "g-tick" }); nowL.textContent = "now"; svg.appendChild(nowL);
      svg.appendChild(sv("line", { x1: X(lp.t), y1: Y(clamp(lp.v, sc.lo, sc.hi)), x2: X(t1), y2: Y(clamp(vEnd, sc.lo, sc.hi)), "class": "g-proj", style: "stroke:" + cfg.series[0].color }));
      var pl = sv("text", { x: X(t1) - 2, y: Y(clamp(vEnd, sc.lo, sc.hi)) - 6, "text-anchor": "end", "class": "g-tick" });
      pl.textContent = "≈" + fAxis(vEnd) + " (est.)";
      svg.appendChild(pl);
    }
    // hover layer: a crosshair that snaps to the nearest measured time
    var base = cfg.series.reduce(function (a, b) { return b.pts.length > a.pts.length ? b : a; }, cfg.series[0]);
    var cross = sv("line", { y1: padT, y2: H - padB, "class": "g-cross", visibility: "hidden" });
    var dots = cfg.series.map(function (s) { return sv("circle", { r: 4, "class": "g-dot", style: "fill:" + s.color, visibility: "hidden" }); });
    svg.appendChild(cross);
    dots.forEach(function (d) { svg.appendChild(d); });
    var hit = sv("rect", { x: padL, y: 0, width: Math.max(1, W - padL - padR), height: H, fill: "transparent" });
    svg.appendChild(hit);
    function nearest(pts, t) {
      var lo2 = 0, hi2 = pts.length - 1;
      while (hi2 - lo2 > 1) { var mid = (lo2 + hi2) >> 1; if (pts[mid].t < t) lo2 = mid; else hi2 = mid; }
      return Math.abs(pts[lo2].t - t) <= Math.abs(pts[hi2].t - t) ? pts[lo2] : pts[hi2];
    }
    var idx = base.pts.length - 1;
    function show(i, cx, cy) {
      idx = clamp(i, 0, base.pts.length - 1);
      var bp = base.pts[idx], x = X(bp.t);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      var parts = [tipT(fDayTime(bp.t))];
      cfg.series.forEach(function (s, si) {
        if (!s.pts.length) { dots[si].setAttribute("visibility", "hidden"); return; }
        var p = nearest(s.pts, bp.t);
        if (Math.abs(p.t - bp.t) > 15 * 60e3) { dots[si].setAttribute("visibility", "hidden"); return; }
        dots[si].setAttribute("cx", X(p.t)); dots[si].setAttribute("cy", Y(clamp(p.v, sc.lo, sc.hi))); dots[si].setAttribute("visibility", "visible");
        parts.push(tipRow(fmtv(p.v, cfg.fmt) + (cfg.unit ? " " + cfg.unit : ""), s.label, s.color));
      });
      if (cfg.note) parts.push(tipNote(cfg.note));
      if (cx === undefined) { var r = svg.getBoundingClientRect(); cx = r.left + x * r.width / W; cy = r.top + 10; }
      tipShow(parts, cx, cy);
    }
    function hide() { cross.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); tipHide(); }
    hit.addEventListener("pointermove", function (ev) {
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * W / r.width;
      var t = t0 + (x - padL) / (W - padL - padR) * (t1 - t0), p = nearest(base.pts, t);
      show(base.pts.indexOf(p), ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", hide);
    holder.appendChild(svg);
    holder.setAttribute("tabindex", "0");
    holder.onkeydown = function (ev) {
      if (ev.key === "ArrowLeft") { show(idx - 1); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { show(idx + 1); ev.preventDefault(); }
      else if (ev.key === "Home") { show(0); ev.preventDefault(); }
      else if (ev.key === "End") { show(base.pts.length - 1); ev.preventDefault(); }
      else if (ev.key === "Escape") hide();
    };
    holder.onfocus = function () { show(idx); };
    holder.onblur = hide;
    return svg;
  }
  function labelNudge(series, si, Y, sc) {   // keep two end labels apart (never more than two series carry end labels)
    var a = series[0].pts[series[0].pts.length - 1], b = series[si].pts[series[si].pts.length - 1];
    if (!a || !b) return 0;
    var dy = Y(clamp(b.v, sc.lo, sc.hi)) - Y(clamp(a.v, sc.lo, sc.hi));
    return Math.abs(dy) < 12 ? (dy >= 0 ? 12 - dy : -(12 + dy)) : 0;
  }
  function slopeOf(pts, horizonMs) {   // least squares over the newest points (per ms)
    if (pts.length < 3) return null;
    var tEnd = pts[pts.length - 1].t, use = pts.filter(function (p) { return p.t >= tEnd - horizonMs; });
    if (use.length < 3) use = pts.slice(-3);
    var n = use.length, mt = 0, mv = 0;
    use.forEach(function (p) { mt += p.t; mv += p.v; }); mt /= n; mv /= n;
    var num = 0, den = 0;
    use.forEach(function (p) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) * (p.t - mt); });
    return den ? num / den : null;
  }

  function chartDefs() {
    var hv1 = job("harvest"), hn = nowOf(hv1), core = job("core"), cn = nowOf(core), s2 = job("s2");
    var defs = [];
    var C1 = "var(--c1)", C2 = "var(--c2)", C3 = "var(--c3)", C6 = "var(--c6)", C7 = "var(--c7)", C0 = "var(--c0)", SER = "var(--serious)";
    defs.push({ group: "harvest", id: "h-rpm", title: "Requests a minute", sub: "average over the last 10 minutes", unit: "/min", fmt: "1", zero: true, endLabels: true,
      series: [{ key: "h_rpm", label: "all sites", short: "all", color: C1 }, { key: "h_arpm", label: "archive.org", short: "archive", color: C0 }] });
    var rpm = arr(hn.requests_per_min);
    if (rpm.length) defs.push({ group: "harvest", id: "h-min", kind: "columns", title: "Requests in each of the last 10 minutes", sub: "whole minutes, oldest on the left", vals: rpm, color: C1, unit: "requests" });
    var kinds = isObj(hn.request_kinds_10m) ? hn.request_kinds_10m : null;
    if (kinds && Object.keys(kinds).length) defs.push({ group: "harvest", id: "h-kinds", kind: "rbars", title: "Request kinds", sub: "last 10 minutes", color: C1,
      items: Object.keys(kinds).map(function (k) { return { label: k.replace(/_/g, " "), value: kinds[k] }; }).sort(function (a, b) { return b.value - a.value; }) });
    var hl = series("h_left"), alt = hv1 && isObj(hv1.eta_alt) ? hv1.eta_alt : null;
    defs.push({ group: "harvest", id: "h-left", title: "Gaps queue left", sub: "papers beside the journal passes; dashed: the last 6 hours' slope carried on (an estimate)", unit: "papers", fmt: "int",
      series: [{ key: "h_left", label: "papers left", color: C1 }], proj: { slope: slopeOf(hl, 6 * 3600e3) },
      foot: [hv1 && isObj(hv1.eta) && ms(hv1.eta.at) ? "harvest's own estimate: empty about " + fDay(ms(hv1.eta.at)) + " (" + str(hv1.eta.basis) + ")" : null, alt && ms(alt.at) ? "at the queue's recent slope: about " + fDay(ms(alt.at)) + " (" + str(alt.basis) + ")" : null] });
    defs.push({ group: "harvest", id: "h-gaps", title: "Gaps papers this run", sub: "asked, and texts found; each run starts at zero", unit: "papers", fmt: "int", zero: true, endLabels: true,
      series: [{ key: "h_gd", label: "asked", short: "asked", color: C1 }, { key: "h_gt", label: "texts found", short: "texts", color: C0 }] });
    defs.push({ group: "harvest", id: "h-wk", title: "Harvest workers", sub: "working now, and the pool's size", unit: "workers", fmt: "int", zero: true, endLabels: true,
      series: [{ key: "h_wk", label: "working", short: "working", color: C1 }, { key: "h_ws", label: "pool size", short: "pool", color: C0 }] });
    defs.push({ group: "harvest", id: "h-mem", title: "Memory in use", sub: "the Mac; the shaded band is where the pool aims (90-95%)", unit: "%", fmt: "1", band: [isNum(g(hn, "workers.aim_low_pct")) ? hn.workers.aim_low_pct : 90, isNum(g(hn, "workers.aim_high_pct")) ? hn.workers.aim_high_pct : 95], yMax: 100,
      series: [{ key: "mem", label: "memory", color: C1 }] });
    defs.push({ group: "harvest", id: "h-kept", title: "Kept in the last 10 minutes", sub: "records and abstracts, the harvest's count", unit: "", fmt: "int", zero: true, endLabels: true,
      series: [{ key: "h_rec", label: "records", short: "records", color: C1 }, { key: "h_abs", label: "abstracts", short: "abstracts", color: C0 }] });
    defs.push({ group: "harvest", id: "h-err", title: "Requests that failed", sub: "not found, refused or no answer, last 10 minutes", unit: "requests", fmt: "int", zero: true,
      series: [{ key: "h_err", label: "failed", color: SER }] });
    defs.push({ group: "harvest", id: "h-pass", title: "Journal passes done", sub: "of " + fInt(g(hn, "passes.planned")) + " planned", unit: "passes", fmt: "int", step: true,
      series: [{ key: "h_pass", label: "passes done", color: C1 }] });
    var lanes = arr(hn.lanes).filter(isObj);
    if (lanes.length) defs.push({ group: "harvest", id: "h-lanes", kind: "lanes", wide: true, title: "Lanes now", sub: "archive.org and each PDF worker, last 10 minutes", lanes: lanes, at: ms(hn.at), color: C1 });

    defs.push({ group: "core", id: "c-done", title: "CORE papers looked up", sub: "and the ones that got a text", unit: "papers", fmt: "int", endLabels: true,
      series: [{ key: "c_done", label: "looked up", short: "looked up", color: C2 }, { key: "c_txt", label: "with a text", short: "texts", color: C0 }] });
    defs.push({ group: "core", id: "c-ppm", title: "CORE papers a minute", sub: "over the last 60 minutes", unit: "/min", fmt: "1", zero: true, series: [{ key: "c_ppm", label: "papers a minute", color: C2 }] });
    defs.push({ group: "core", id: "c-rpm", title: "CORE requests a minute", sub: "over the last 10 minutes", unit: "/min", fmt: "1", zero: true, series: [{ key: "c_rpm", label: "requests a minute", color: C2 }] });
    defs.push({ group: "core", id: "c-match", title: "CORE matched papers", sub: "matched to a CORE record, with or without a text", unit: "papers", fmt: "int", series: [{ key: "c_match", label: "matched", color: C2 }] });
    var outs = arr(cn.outcomes).filter(isObj);
    if (outs.length) {
      var tot = 0; outs.forEach(function (o) { if (isNum(o.n)) tot += o.n; });
      defs.push({ group: "core", id: "c-out", kind: "rbars", title: "CORE outcomes", sub: "every paper looked up so far", color: C2, total: tot,
        items: outs.map(function (o) { return { label: str(o.label) || str(o.k), value: o.n }; }).sort(function (a, b) { return b.value - a.value; }) });
    }
    var pr = isObj(nowOf(s2).pair) ? nowOf(s2).pair : null;
    if (pr) {
      var names = { match: "matched", no: "not matched", review: "held for review", with_abstract: "with an abstract", pdf_link: "a PDF link", first_pages_full_text: "first pages from a full text", first_pages: "first pages", excerpt: "an excerpt", texts_written: "texts written" };
      defs.push({ group: "s2", id: "s2-pair", kind: "rbars", title: "Semantic Scholar pairing", sub: "papers by outcome (finished " + (ms(pr.at) ? fDay(ms(pr.at)) : "") + ")", color: C3,
        items: Object.keys(names).filter(function (k) { return isNum(pr[k]); }).map(function (k) { return { label: names[k], value: pr[k] }; }).sort(function (a, b) { return b.value - a.value; }) });
    }
    var kp = isObj(nowOf(s2).kept) ? nowOf(s2).kept : null;
    if (kp) defs.push({ group: "s2", id: "s2-kept", kind: "rbars", title: "Semantic Scholar kept", sub: "papers kept from the datasets", color: C3,
      items: [{ label: "paper records", value: kp.paper_records }, { label: "abstracts", value: kp.abstracts }, { label: "full texts", value: kp.full_texts }].filter(function (x) { return isNum(x.value); }) });
    defs.push({ group: "s2", id: "s2-parts", title: "Semantic Scholar parts read", sub: "of 420", unit: "parts", fmt: "int", step: true, series: [{ key: "s2_parts", label: "parts read", color: C3 }] });

    var t1 = codingTotals("coding_s1"), te = codingTotals("coding_test"), dv = codingTotals("coding_dev");
    defs.push({ group: "coding", id: "k-s1", title: "Silver S1 units final", sub: t1 && isNum(t1.total) ? "of " + fInt(t1.total) : "", unit: "units", fmt: "int", step: true, series: [{ key: "s1", label: "S1 final", color: C6 }] });
    defs.push({ group: "coding", id: "k-te", title: "TEST units final", sub: te && isNum(te.total) ? "of " + fInt(te.total) + " (sealed until scored)" : "", unit: "units", fmt: "int", step: true, series: [{ key: "te", label: "TEST final", color: C6 }] });
    defs.push({ group: "coding", id: "k-dv", title: "DEV units final", sub: dv && isNum(dv.total) ? "of " + fInt(dv.total) : "", unit: "units", fmt: "int", step: true, series: [{ key: "dv", label: "DEV final", color: C6 }] });
    defs.push({ group: "coding", id: "k-fl", title: "Units in flight", sub: "S1 and TEST, each cycle", unit: "units", fmt: "int", zero: true, step: true, endLabels: true,
      series: [{ key: "s1_fl", label: "S1", short: "S1", color: C6 }, { key: "te_fl", label: "TEST", short: "TEST", color: C0 }] });
    defs.push({ group: "coding", id: "k-h", title: "Units finished in the last hour", sub: "S1 and TEST", unit: "units", fmt: "int", zero: true, endLabels: true,
      series: [{ key: "s1_h", label: "S1", short: "S1", color: C6 }, { key: "te_h", label: "TEST", short: "TEST", color: C0 }] });
    var fl = [];
    codingJobs().forEach(function (j) { var at = ms(nowOf(j).at); arr(nowOf(j).in_flight).filter(isObj).forEach(function (u) { fl.push({ u: u, run: runName(j.id), start: ms(u.started_at) || (at && isNum(u.running_s) ? at - u.running_s * 1000 : null) }); }); });
    if (fl.length) defs.push({ group: "coding", id: "k-run", kind: "runbars", title: "Units in flight now, by time running", sub: "ticks every second", units: fl, color: C6 });
    defs.push({ group: "coding", id: "k-team", title: "Agents at work", sub: "Claude agents in flight, from the workflow journals", unit: "agents", fmt: "int", zero: true, step: true, series: [{ key: "team", label: "agents", color: C6 }] });

    var pv = g(st(), "model.preview.numbers");
    if (pv && arr(pv.measures).length) defs.push({ group: "model", id: "m-dev", kind: "intervals", title: "Preview model on DEV", sub: "cross-fitted on " + fInt(pv.n_papers) + " DEV-main papers, 95% intervals; never the paper's numbers", measures: arr(pv.measures).filter(isObj), color: C7, after: pv.after_choice });
    jobs().filter(function (j) { return j.source === "heartbeat"; }).forEach(function (j) {
      var b = nowOf(j).beat || {};
      defs.push({ group: "model", id: "b-" + j.id, title: "Heartbeat: " + str(j.label), sub: (str(b.step) ? "step " + str(b.step) + "; " : "") + (str(b.unit) || "done") + (isNum(b.total) ? " of " + fInt(b.total) : "") + "; since its count last started again", unit: str(b.unit), fmt: "int", step: true, series: [{ key: "b_" + j.id, label: str(b.unit) || "done", color: C7 }] });
    });

    defs.push({ group: "machine", id: "x-st", title: "Store lines with a text", sub: "the harvest's store, counted hourly", unit: "lines", fmt: "int", series: [{ key: "st", label: "lines with a text", color: C0 }] });
    defs.push({ group: "machine", id: "x-sl", title: "Store record lines", sub: "before de-duplication", unit: "lines", fmt: "int", series: [{ key: "sl", label: "record lines", color: C0 }] });
    defs.push({ group: "machine", id: "x-disk", title: "Free disk", sub: "the Mac", unit: "GB", fmt: "1", series: [{ key: "disk", label: "free", color: C0 }] });
    defs.push({ group: "machine", id: "x-run", title: "Must-run jobs up", sub: "of " + fInt(g(st(), "headline.must_total")), unit: "jobs", fmt: "int", zero: true, step: true, series: [{ key: "run", label: "running", color: C0 }] });
    defs.push({ group: "machine", id: "x-alerts", title: "Warnings and critical alerts", sub: "open each cycle", unit: "alerts", fmt: "int", zero: true, step: true, series: [{ key: "alerts", label: "alerts", color: SER }] });
    return defs;
  }
  var GROUPS = [
    { id: "harvest", title: "Harvest", crew: "harvest" }, { id: "core", title: "CORE lane", crew: "core" },
    { id: "s2", title: "Semantic Scholar", crew: "s2" }, { id: "coding", title: "Coding", crew: "coders" },
    { id: "model", title: "Model lab", crew: "lab" }, { id: "machine", title: "Machine, stores and alerts", crew: "relay" }
  ];
  function chartTable(d) {
    if (d.series) {
      var rows = [], base = d.series[0];
      var pts = {};
      d.series.forEach(function (s, si) { series(s.key).forEach(function (p) { (pts[p.t] = pts[p.t] || [])[si] = p.v; }); });
      var ts = Object.keys(pts).map(Number).sort(function (a, b) { return b - a; });
      var shown = ts.slice(0, 120);
      shown.forEach(function (t) { rows.push([fDayTime(t)].concat(d.series.map(function (s, si) { return fmtv(pts[t][si], d.fmt); }))); });
      return tableEl(["Time"].concat(d.series.map(function (s) { return s.label + (d.unit ? " (" + d.unit + ")" : ""); })), rows, shown.length < ts.length ? "The newest 120 of " + ts.length + " measurements in this window" : ts.length + " measurements in this window, newest first", d.series.map(function (s, i) { return i + 1; }));
    }
    if (d.kind === "rbars") return tableEl(["What", "Count"].concat(d.total ? ["Share"] : []), d.items.map(function (it) { return [it.label, fInt(it.value)].concat(d.total ? [fPct(100 * it.value / d.total)] : []); }), null, [1, 2]);
    if (d.kind === "columns") return tableEl(["Minute", "Requests"], d.vals.map(function (v, i) { var back = d.vals.length - 1 - i; return [back ? back + " min before the newest" : "the newest", fInt(v)]; }), null, [1]);
    if (d.kind === "intervals") return tableEl(["Measure", "Value", "95% interval"], d.measures.map(function (m) { return [str(m.k), fShare(m.v), isNum(m.lo) ? fShare(m.lo) + " to " + fShare(m.hi) : "–"]; }), null, [1]);
    if (d.kind === "lanes") return tableEl(["Lane", "Items", "Texts", "Requests", "Last"], d.lanes.map(function (l) { return [str(l.id), fInt(l.items_10m), fInt(l.texts_10m), fInt(l.requests_10m), laneLast(l)]; }), "Last 10 minutes", [1, 2, 3]);
    if (d.kind === "runbars") return tableEl(["Unit", "Run", "Running"], d.units.map(function (x) { return [str(x.u.batch) + " " + str(x.u.coder), x.run, x.start ? fDur((Date.now() - x.start) / 1000) : fDur(x.u.running_s)]; }), null, [2]);
    return h("p", { "class": "chart-empty" }, "No table for this chart.");
  }
  function laneLast(l) {
    var L = isObj(l.last) ? l.last : null;
    if (!L) return "–";
    return [str(L.method), str(L.outcome)].filter(Boolean).join(" → ") + (str(L.detail) ? " (" + str(L.detail) + ")" : "");
  }
  function drawDef(d, holder) {
    if (d.series) {
      var t1 = genMs() || Date.now(), t0 = windowStart();
      var ser = d.series.map(function (s) { return { label: s.label, short: s.short, color: s.color, pts: series(s.key) }; }).filter(function (s, i) { return i === 0 || s.pts.length; });
      lineChart(holder, { series: ser, t0: t0, t1: t1, fmt: d.fmt, unit: d.unit, zero: d.zero, band: d.band, yMax: d.yMax, step: d.step, endLabels: d.endLabels && ser.length > 1, proj: d.proj, title: d.title, height: 150 });
      return;
    }
    clear(holder);
    if (d.kind === "columns") {
      var W = Math.max(220, Math.floor(holder.clientWidth || 300));
      holder.appendChild(columnsSvg(d.vals, W, 110, d.color, function (i) { var back = d.vals.length - 1 - i; return back ? back + " min before the newest whole minute" : "the newest whole minute"; }, "int", d.unit));
      var ax = h("div", { "class": "legend", style: "justify-content:space-between" }, h("span", null, "10 min ago"), h("span", null, "newest"));
      holder.appendChild(ax);
    } else if (d.kind === "rbars") holder.appendChild(rbars(d.items, d.color, "int", d.total));
    else if (d.kind === "intervals") holder.appendChild(intervalsChart(d));
    else if (d.kind === "lanes") holder.appendChild(lanesEl(d));
    else if (d.kind === "runbars") holder.appendChild(runbarsEl(d));
  }
  function intervalsChart(d) {   // one row per measure: its name and value as text, then the 95% interval on a shared scale
    var lo = 0.6, hi = 1.0;
    d.measures.forEach(function (m) { var a = isNum(m.lo) ? m.lo : m.v; if (isNum(a)) lo = Math.min(lo, Math.floor(a * 10) / 10); });
    function P(v) { return 100 * (clamp(v, lo, hi) - lo) / (hi - lo); }
    var wrap = h("div", { "class": "ivals" });
    wrap.style.setProperty("--crew", d.color);
    var ticks = [];
    for (var t = lo; t <= hi + 1e-9; t += 0.1) ticks.push(Math.round(t * 10) / 10);
    d.measures.forEach(function (m) {
      var track = h("div", { "class": "ival-track", "aria-hidden": "true" });
      ticks.forEach(function (t) { var gl = h("i", { "class": "ival-grid" }); gl.style.left = P(t) + "%"; track.appendChild(gl); });
      if (isNum(m.lo) && isNum(m.hi)) { var bar = h("span", { "class": "ival-bar" }); bar.style.left = P(m.lo) + "%"; bar.style.width = Math.max(0.6, P(m.hi) - P(m.lo)) + "%"; track.appendChild(bar); }
      if (isNum(m.v)) { var dot = h("span", { "class": "ival-dot" }); dot.style.left = P(m.v) + "%"; track.appendChild(dot); }
      var row = h("div", { "class": "ival", tabindex: "0", "aria-label": str(m.k) + ": " + fShare(m.v) + (isNum(m.lo) ? ", 95% interval " + fShare(m.lo) + " to " + fShare(m.hi) : "") },
        h("div", { "class": "ival-top" }, h("span", { "class": "ival-k" }, str(m.k)), h("b", null, fShare(m.v)), isNum(m.lo) ? h("span", { "class": "ival-ci" }, fShare(m.lo) + "–" + fShare(m.hi)) : null), track);
      hoverTip(row, function () { return [tipRow(fShare(m.v), str(m.k), d.color), tipNote(isNum(m.lo) ? "95% interval " + fShare(m.lo) + " to " + fShare(m.hi) : "no interval")]; });
      wrap.appendChild(row);
    });
    var axis = h("div", { "class": "ival-axis", "aria-hidden": "true" });
    ticks.forEach(function (t) { var tl = h("span", null, Math.round(t * 100) + "%"); tl.style.left = P(t) + "%"; axis.appendChild(tl); });
    wrap.appendChild(axis);
    if (isObj(d.after) && isNum(d.after.v)) wrap.appendChild(h("p", { "class": "chart-sub" }, str(d.after.k) + ": " + fShare(d.after.v) + (isNum(d.after.sd) ? " (sd " + fShare(d.after.sd) + ")" : "")));
    return wrap;
  }
  function lanesEl(d) {   // one row per lane: archive.org and each PDF worker (fixed method and outcome words only)
    var t = h("table", { "class": "tbl lanes-tbl" });
    t.appendChild(h("caption", null, "Last 10 minutes; the last column ticks from each lane's newest item."));
    var hr = h("tr");
    ["Lane", "Items", "Texts", "Requests", "Last: method → outcome", "Seen"].forEach(function (x, i) { hr.appendChild(h("th", { scope: "col", "class": i >= 1 && i <= 3 ? "n" : null }, x)); });
    t.appendChild(h("thead", null, hr));
    var tb = h("tbody");
    d.lanes.forEach(function (l) {
      var lastAt = isObj(l.last) ? ms(l.last.at) : null;
      var dot = h("span", { "class": "lane-dot" });
      var sub = l.kind === "archive" ? (isNum(l.lanes) ? fInt(l.lanes) + " lanes" : "") : (isNum(l.group_papers) ? fInt(l.group_papers) + " papers in its group" : "");
      var row = h("tr", { tabindex: "0" },
        h("td", null, dot, h("span", { "class": "lane-id" }, str(l.id)), sub ? h("span", { "class": "muted" }, " · " + sub) : null),
        h("td", { "class": "n" }, fInt(l.items_10m)), h("td", { "class": "n" }, fInt(l.texts_10m)), h("td", { "class": "n" }, fInt(l.requests_10m)),
        h("td", { "class": "out" }, laneLast(l)), h("td", { "class": "n" }, lastAt ? h("span", { "data-ago": lastAt }, fAgo(lastAt)) : "–"));
      hoverTip(row, function () { return [tipT(str(l.id) + ", last 10 minutes"), tipRow(fInt(l.items_10m), "items", d.color), tipRow(fInt(l.texts_10m), "texts"), tipRow(fInt(l.requests_10m), "requests"), tipNote("Last: " + laneLast(l) + (lastAt ? ", " + fAgo(lastAt) : ""))]; });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return h("div", { "class": "tbl-wrap" }, t);
  }
  function runbarsEl(d) {
    var box = h("div", { "class": "rbars" });
    d.units.slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); }).forEach(function (x) {
      var tr = h("span"); tr.setAttribute("data-run-bar", x.start || "");
      var row = h("div", { "class": "rbar", tabindex: "0" }, h("span", { "class": "rbar-label" }, x.run + " " + str(x.u.batch) + " " + str(x.u.coder)),
        h("span", { "class": "rbar-val", "data-clock-since": x.start || "" }, x.start ? fClock((Date.now() - x.start) / 1000) : fDur(x.u.running_s)), h("span", { "class": "rbar-track" }, tr));
      row.style.setProperty("--crew", d.color);
      hoverTip(row, function () { return [tipRow(x.start ? fDur((Date.now() - x.start) / 1000) : fDur(x.u.running_s), "running", d.color), tipNote(x.run + " unit " + str(x.u.unit) + ", stage " + str(x.u.stage))]; });
      box.appendChild(row);
    });
    return box;
  }
  function renderCharts() {
    var box = clear($("charts"));
    S.charts = [];
    var defs = chartDefs();
    GROUPS.forEach(function (gr) {
      var mine = defs.filter(function (d) { return d.group === gr.id; });
      if (!mine.length) return;
      var c = CREW_BY[gr.crew];
      var grid = h("div", { "class": "mgrid" });
      mine.forEach(function (d) {
        var holder = h("div", { "class": "chart" });
        var hasData = !d.series || d.series.some(function (s) { return series(s.key).length; });
        if (d.series && !hasData && !S.merged.length) return;
        if (d.series && !d.series.some(function (s) { return S.merged.some(function (p) { return isNum(p[s.key]); }); })) return;   // a key this data never carries
        var tblOn = !!S.ui.tables[d.id];
        var btn = h("button", { type: "button", "class": "tbl-btn", "aria-pressed": tblOn ? "true" : "false" }, "Table");
        var tblBox = h("div", { hidden: !tblOn });
        var now = h("div", { "class": "chart-now" });
        if (d.series) {
          var lastV = series(d.series[0].key).slice(-1)[0];
          if (lastV) now.appendChild(h("span", { "class": "v" }, fmtv(lastV.v, d.fmt)));
          if (lastV && d.unit) now.appendChild(h("span", { "class": "u" }, d.unit));
          var dl = deltaEl(d.series[0].key, null, d.fmt);
          if (dl) now.appendChild(dl);
        }
        var card = h("figure", { "class": "card chart-card" + (d.wide ? " wide" : ""), id: "ch-" + d.id, style: "margin:0" },
          h("div", { "class": "card-head" }, h("div", null, h("figcaption", { "class": "chart-title" }, d.title), d.sub ? h("div", { "class": "chart-sub" }, d.sub) : null), btn),
          now.childNodes.length ? now : null);
        if (d.series && d.series.length > 1) {
          var lg = h("div", { "class": "legend" });
          d.series.forEach(function (s) { var i = h("i"); i.style.setProperty("--k", s.color); lg.appendChild(h("span", null, i, s.label)); });
          card.appendChild(lg);
        }
        holder.hidden = tblOn;
        card.appendChild(holder);
        card.appendChild(tblBox);
        if (d.foot) arr(d.foot).forEach(function (f) { if (f) card.appendChild(h("p", { "class": "chart-sub" }, estChip(), " " + f)); });
        btn.addEventListener("click", function () {
          var on = btn.getAttribute("aria-pressed") !== "true";
          S.ui.tables[d.id] = on;
          btn.setAttribute("aria-pressed", on ? "true" : "false");
          holder.hidden = on; tblBox.hidden = !on;
          if (on) { clear(tblBox); tblBox.appendChild(chartTable(d)); } else drawDef(d, holder);
        });
        if (tblOn) tblBox.appendChild(chartTable(d));
        grid.appendChild(card);
        S.charts.push({ d: d, holder: holder });
      });
      if (!grid.childNodes.length) return;
      box.appendChild(h("div", { "class": "mgroup" }, h("div", { "class": "mgroup-head" }, crewDot(c), gr.title), grid));
    });
    if (!box.childNodes.length) box.appendChild(h("p", { "class": "placeholder" }, S.status ? "No measurements yet: the history is empty." : "Measurements show once a status loads."));
    requestAnimationFrame(function () { S.charts.forEach(function (c) { if (!c.holder.hidden) drawDef(c.d, c.holder); }); });
    var sub = $("meas-sub");
    var pts = S.merged.length;
    setText(sub, "Every lane and job, measured each cycle (" + fInt(pts) + " points; trends cover " + (S.range ? rangeWord().replace(/^in /, "the last ") : "all the history") + "). Hover or tap a chart for exact values; each chart has a table view.");
  }

  // ------------------------------------------------------------------ grids (canvas, one cell per unit, pass or window)
  function cellsBlock(label, countText, n, stateAt, describe, colors, maxH) {
    var canvas = h("canvas", { "class": "cells", role: "img", "aria-label": label + ": " + countText, tabindex: "0" });
    var block = h("div", { "class": "cells-block" }, h("div", { "class": "cells-head" }, h("span", null, label), h("b", null, countText)), canvas);
    var C = { canvas: canvas, n: n, stateAt: stateAt, describe: describe, colors: colors, maxH: maxH || 180, geom: null };
    S.cells.push(C);
    canvas.addEventListener("pointermove", function (ev) {
      var i = cellIndex(C, ev);
      if (i === null) { tipHide(); return; }
      tipShow(describe(i), ev.clientX, ev.clientY);
    });
    canvas.addEventListener("pointerleave", tipHide);
    canvas.addEventListener("focus", function () { var r = canvas.getBoundingClientRect(); tipShow([tipNote(label + ": " + countText)], r.left + 10, r.top + 10); });
    canvas.addEventListener("blur", tipHide);
    return block;
  }
  function cellIndex(C, ev) {
    var gm = C.geom; if (!gm) return null;
    var r = C.canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    var col = Math.floor(x / gm.pitch), row = Math.floor(y / gm.pitch);
    if (col < 0 || col >= gm.cols || row < 0) return null;
    var i = row * gm.cols + col;
    return i < C.n ? i : null;
  }
  function drawCells(C, blinkOnly) {
    var cv = C.canvas, W = Math.floor(cv.clientWidth || cv.parentNode.clientWidth || 300);
    if (!W) return;
    var n = C.n, sizes = [12, 10, 8, 7, 6, 5, 4, 3, 2], s = 2, gap = 0, cols, rows;
    for (var k = 0; k < sizes.length; k++) {
      var sz = sizes[k], gp = sz >= 5 ? 2 : sz >= 3 ? 1 : 0, pitch = sz + gp;
      cols = Math.max(1, Math.floor((W + gp) / pitch)); rows = Math.ceil(n / cols);
      if (rows * pitch <= C.maxH || k === sizes.length - 1) { s = sz; gap = gp; break; }
    }
    var pitch2 = s + gap;
    cols = Math.max(1, Math.floor((W + gap) / pitch2)); rows = Math.ceil(n / cols);
    var Hh = rows * pitch2 - gap, dpr = window.devicePixelRatio || 1;
    if (!blinkOnly || !C.geom || C.geom.W !== W) {
      cv.style.height = Hh + "px";
      cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    }
    C.geom = { cols: cols, pitch: pitch2, s: s, W: W };
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var col = {};
    Object.keys(C.colors).forEach(function (k) { var v = C.colors[k]; col[k] = /^--/.test(v) ? cssVar(v) : v; });
    var surface = cssVar("--surface"), blinkOn = Math.floor(Date.now() / 1000) % 2 === 0 || REDUCED.matches;
    for (var i = 0; i < n; i++) {
      var stt = C.stateAt(i);
      if (blinkOnly && stt !== "fly") continue;
      var x = (i % cols) * pitch2, y = Math.floor(i / cols) * pitch2;
      ctx.clearRect(x, y, s, s);
      if (stt === "done") { ctx.fillStyle = col.done; ctx.fillRect(x, y, s, s); }
      else if (stt === "fly") {
        ctx.fillStyle = surface; ctx.fillRect(x, y, s, s);
        ctx.fillStyle = col.fly;
        if (s >= 5) { var b = s >= 8 ? 2 : 1.5; ctx.fillRect(x, y, s, b); ctx.fillRect(x, y + s - b, s, b); ctx.fillRect(x, y, b, s); ctx.fillRect(x + s - b, y, b, s); if (blinkOn) { ctx.fillRect(x + s / 2 - 1.5, y + s / 2 - 1.5, 3, 3); } }
        else { ctx.globalAlpha = blinkOn ? 1 : 0.4; ctx.fillRect(x, y, s, s); ctx.globalAlpha = 1; }
      } else if (stt === "wait") { ctx.fillStyle = col.done; ctx.globalAlpha = 0.22; ctx.fillRect(x, y, s, s); ctx.globalAlpha = 1; }
      else if (stt === "pause") { ctx.fillStyle = col.todo; ctx.fillRect(x, y, s, s); ctx.fillStyle = col.done; ctx.globalAlpha = 0.5; ctx.fillRect(x, y + s / 2 - 0.75, s, 1.5); ctx.globalAlpha = 1; }
      else { ctx.fillStyle = col.todo; ctx.fillRect(x, y, s, s); }
    }
  }
  function legendCells(items) {
    var lg = h("div", { "class": "cells-legend" });
    items.forEach(function (it) { var i = h("i", { "class": it.cls || null }); i.style.setProperty("--k", it.color); lg.appendChild(h("span", null, i, it.label)); });
    return lg;
  }
  function renderGrids() {
    var box = clear($("grid-cards"));
    S.cells = [];
    var any = false;
    // coding units: one cell per unit, by stage (cells in order final, in flight, to do; not batch order)
    codingJobs().forEach(function (j) {
      var stages = arr(j.stages).filter(function (x) { return isObj(x) && isNum(x.total); });
      if (!stages.length) return;
      any = true;
      var fl = arr(nowOf(j).in_flight).filter(isObj);
      var p = isObj(j.progress) ? j.progress : {};
      var card = h("div", { "class": "card" }, h("div", { "class": "card-head" }, crewDot(CREW_BY.coders), h("h3", { "class": "card-title" }, str(j.label) || j.id),
        h("span", { "class": "card-note" }, fInt(p.done) + " of " + fInt(p.total) + " units final" + (fl.length ? ", " + fl.length + " in flight" : ""))));
      stages.forEach(function (sg) {
        var mine = fl.filter(function (u) { return u.stage === sg.stage; });
        var done = isNum(sg.done) ? sg.done : 0, nfly = Math.min(mine.length, Math.max(0, sg.total - done));
        var waiting = sg.ready === false;
        card.appendChild(cellsBlock("stage " + str(sg.stage) + (waiting ? " (waits: " + str(sg.wait || "not ready") + ")" : ""), fInt(done) + " of " + fInt(sg.total) + (nfly ? ", " + nfly + " in flight" : ""), sg.total,
          function (i) { return i < done ? "done" : i < done + nfly ? "fly" : waiting ? "wait" : "todo"; },
          function (i) {
            if (i < done) return [tipT("stage " + str(sg.stage)), tipRow("final", "unit " + (i + 1) + " of " + sg.total, "var(--c6)")];
            if (i < done + nfly) { var u = mine[i - done]; return [tipT("stage " + str(sg.stage) + ", in flight"), tipRow(str(u.batch) + " " + str(u.coder), "running " + fDur(isNum(u.running_s) ? u.running_s : null), "var(--c6)")]; }
            return [tipT("stage " + str(sg.stage)), tipRow(waiting ? "waiting" : "to do", "unit " + (i + 1) + " of " + sg.total), waiting ? tipNote(str(sg.wait)) : tipNote(fInt(sg.batches) + " batches, " + fInt(sg.n_coders) + " coder(s)" + (sg.adjudicated ? " and an adjudicator" : ""))];
          }, { done: "--c6", fly: "--ink", todo: "--inset-2" }, 120));
      });
      card.appendChild(legendCells([{ label: "final", color: "var(--c6)" }, { label: "in flight", color: "var(--ink)", cls: "fly" }, { label: "to do", color: "var(--inset-2)", cls: "todo" }, { label: "waits for an earlier stage", color: "color-mix(in srgb, var(--c6) 25%, var(--surface))" }]));
      card.appendChild(h("p", { "class": "chart-sub" }, "Cells are in the order final, in flight, to do (not batch order): the status counts units per stage; it names only the units in flight."));
      box.appendChild(card);
    });
    // journal passes
    var ps = g(nowOf(job("harvest")), "passes");
    if (isObj(ps) && isNum(ps.planned)) {
      any = true;
      var rp = arr(nowOf(job("harvest")).running_passes).filter(isObj);
      var d0 = ps.done || 0, r0 = ps.running || 0, p0 = ps.paused || 0, w0 = Math.max(0, ps.planned - d0 - r0 - p0);
      var card2 = h("div", { "class": "card" }, h("div", { "class": "card-head" }, crewDot(CREW_BY.harvest), h("h3", { "class": "card-title" }, "Journal passes"), h("span", { "class": "card-note" }, fInt(d0) + " of " + fInt(ps.planned) + " done")));
      card2.appendChild(cellsBlock("one cell per journal pass", fInt(d0) + " done, " + fInt(r0) + " running, " + fInt(w0) + " waiting" + (p0 ? ", " + fInt(p0) + " paused" : ""), ps.planned,
        function (i) { return i < d0 ? "done" : i < d0 + r0 ? "fly" : i < d0 + r0 + p0 ? "pause" : "todo"; },
        function (i) {
          if (i < d0) return [tipRow("done", "pass " + (i + 1) + " of " + ps.planned, "var(--c1)")];
          if (i < d0 + r0) { var q = rp[i - d0] || {}; return [tipT("running"), tipRow(str(q.id) || "a pass", str(q.mode) ? "mode " + str(q.mode) : "", "var(--c1)"), tipNote(fInt(q.pages) + " pages, " + fInt(q.records) + " records, " + fInt(q.abstracts) + " abstracts; running " + fDurShort(q.running_s))]; }
          if (i < d0 + r0 + p0) return [tipRow("paused", "pass " + (i + 1))];
          return [tipRow("waiting", "pass " + (i + 1) + " of " + ps.planned)];
        }, { done: "--c1", fly: "--ink", todo: "--inset-2" }, 140));
      card2.appendChild(legendCells([{ label: "done", color: "var(--c1)" }, { label: "running", color: "var(--ink)", cls: "fly" }, { label: "waiting", color: "var(--inset-2)", cls: "todo" }]));
      card2.appendChild(h("p", { "class": "chart-sub" }, "Journals are not named here. Beside the passes, the gaps queue holds " + fInt(g(job("harvest") || {}, "queue.left")) + " papers."));
      box.appendChild(card2);
    }
    // CORE windows
    var w = g(nowOf(job("core")), "window");
    if (isObj(w) && isNum(w.of) && isNum(w.n)) {
      any = true;
      var dn = Math.max(0, w.n - 1), cur = job("core").state === "running" ? 1 : 0;
      var card3 = h("div", { "class": "card" }, h("div", { "class": "card-head" }, crewDot(CREW_BY.core), h("h3", { "class": "card-title" }, "CORE windows"), h("span", { "class": "card-note" }, fInt(dn) + " of " + fInt(w.of) + " done")));
      card3.appendChild(cellsBlock("one cell per window of " + fInt(w.size) + " papers", fPct(100 * dn / w.of) + " done; window " + fInt(w.n) + (cur ? " now" : " next"), w.of,
        function (i) { return i < dn ? "done" : i === dn ? (cur ? "fly" : "todo") : "todo"; },
        function (i) {
          var first = i * (w.size || 20) + 1;
          return [tipT("window " + fInt(i + 1) + " of " + fInt(w.of)), tipRow(i < dn ? "done" : i === dn ? (cur ? "being looked up" : "next") : "to do", "papers #" + fInt(first) + " to #" + fInt(first + (w.size || 20) - 1), "var(--c2)")];
        }, { done: "--c2", fly: "--ink", todo: "--inset-2" }, 200));
      card3.appendChild(legendCells([{ label: "done", color: "var(--c2)" }, { label: "now", color: "var(--ink)", cls: "fly" }, { label: "to do", color: "var(--inset-2)", cls: "todo" }]));
      var core = job("core"), eta = core && isObj(core.eta) ? ms(core.eta.at) : null;
      if (eta) card3.appendChild(h("p", { "class": "chart-sub" }, estChip(), " the last window at this pace: about " + fDay(eta) + " (" + str(core.eta.basis) + ")"));
      box.appendChild(card3);
    }
    // the beta checklist and the phases' steps, as cells too
    var phases = arr(st().phases).filter(isObj);
    if (phases.length) {
      any = true;
      var card4 = h("div", { "class": "card" }, h("div", { "class": "card-head" }, crewDot(null), h("h3", { "class": "card-title" }, "Steps of the five phases"), h("span", { "class": "card-note" }, phases.reduce(function (a, p) { return a + (p.steps_done || 0); }, 0) + " of " + phases.reduce(function (a, p) { return a + (p.steps_total || 0); }, 0) + " done")));
      phases.forEach(function (p) {
        var stp = arr(p.steps).filter(isObj);
        card4.appendChild(cellsBlock("Phase " + p.n + " · " + str(p.name), fInt(p.steps_done) + " of " + fInt(p.steps_total) + " done", stp.length,
          function (i) { var s0 = stp[i].status; return s0 === "done" ? "done" : s0 === "running" ? "fly" : s0 === "next" ? "wait" : "todo"; },
          function (i) { var s0 = stp[i]; return [tipT("Phase " + p.n + ": " + str(s0.status)), tipRow(str(s0.name), "", "var(--c0)"), s0.needs ? tipNote("Needs: " + str(s0.needs)) : tipNote(str(s0.detail))]; },
          { done: "--ink-2", fly: "--ink", todo: "--inset-2" }, 40));
      });
      card4.appendChild(legendCells([{ label: "done", color: "var(--ink-2)" }, { label: "running", color: "var(--ink)", cls: "fly" }, { label: "next", color: "color-mix(in srgb, var(--ink-2) 25%, var(--surface))" }, { label: "later", color: "var(--inset-2)", cls: "todo" }]));
      box.appendChild(card4);
    }
    if (!any) box.appendChild(h("p", { "class": "placeholder" }, S.status ? "This status carries nothing to draw as cells." : "The grids show once a status loads."));
    requestAnimationFrame(function () { S.cells.forEach(function (C) { drawCells(C); }); });
  }

  // ------------------------------------------------------------------ mission map
  function stepIcon(status) {
    var s = sv("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" });
    if (status === "done") s.appendChild(sv("path", { d: "M3 8.5l3 3L13 4.5", "class": "ic-done" }));
    else if (status === "running") s.appendChild(sv("circle", { cx: 8, cy: 8, r: 5, "class": "ic-run" }));
    else if (status === "next") s.appendChild(sv("circle", { cx: 8, cy: 8, r: 5, "class": "ic-next" }));
    else s.appendChild(sv("circle", { cx: 8, cy: 8, r: 3, "class": "ic-later" }));
    return s;
  }
  var STEP_WORD = { done: "done", running: "running", next: "next", later: "later" };
  function renderMap() {
    var box = clear($("phases"));
    var phases = arr(st().phases).filter(isObj);
    if (!phases.length) { box.appendChild(h("li", { "class": "placeholder" }, S.status ? "This status has no phases." : "The mission map shows once a status loads.")); clear($("releases")); return; }
    phases.forEach(function (p) {
      var li = h("li", { "class": "card phase" + (p.is_focus ? " focus" : "") });
      var frac = isNum(p.steps_total) && p.steps_total ? p.steps_done / p.steps_total : null;
      li.appendChild(h("div", { "class": "phase-top" }, h("span", { "class": "phase-n" }, "Phase " + p.n + (p.is_focus ? " · focus" : "")), light(p.status === "running" ? "running" : p.status === "done" ? "done" : p.status === "next" ? "waiting" : "idle", null, STEP_WORD[p.status] ? STEP_WORD[p.status][0].toUpperCase() + STEP_WORD[p.status].slice(1) : "–")));
      li.appendChild(h("div", { "class": "phase-name" }, str(p.name)));
      var m = h("div", { "class": "meter thin" }); var sp = h("span"); sp.style.width = (isNum(frac) ? 100 * frac : 0) + "%"; m.appendChild(sp); m.style.setProperty("--meter", "var(--ink-2)");
      li.appendChild(h("div", { "class": "bar-row" }, h("div", { "class": "bar-top" }, h("span", null, "steps done"), h("b", null, fInt(p.steps_done) + " of " + fInt(p.steps_total))), m));
      if (isObj(p.estimate)) li.appendChild(h("div", { "class": "phase-est", title: "Assumes: " + str(p.estimate.assumes) }, estChip(), rangeText(p.estimate)));
      li.appendChild(h("p", { "class": "phase-goal" }, str(p.goal)));
      var steps = h("ul", { "class": "steps" });
      arr(p.steps).filter(isObj).forEach(function (s) {
        var row = h("li", { "class": "step " + str(s.status) }, stepIcon(s.status), h("span", { "class": "step-name" }, str(s.name), h("span", { "class": "sr-only" }, " (" + (STEP_WORD[s.status] || s.status) + ")")));
        var lv = isObj(s.live) ? s.live : null, pr = lv && isObj(lv.progress) ? lv.progress : null;
        if (pr && isNum(pr.pct) && s.status !== "done") {
          var mm = h("div", { "class": "meter thin" }); var sp2 = h("span"); sp2.style.width = clamp(pr.pct, 0, 100) + "%"; mm.appendChild(sp2); mm.style.setProperty("--meter", crewVar(crewOf(s.job)));
          row.appendChild(mm);
          row.appendChild(h("span", { "class": "step-detail" }, fInt(pr.done) + " of " + fInt(pr.total) + " " + str(pr.unit) + " (" + fPct(pr.pct) + ")" + (lv && isObj(lv.eta) && ms(lv.eta.at) ? ", about " + fDay(ms(lv.eta.at)) + " (estimate)" : "")));
        } else if (s.status !== "done" && (s.needs || s.detail)) row.appendChild(h("span", { "class": "step-detail" }, s.status === "running" ? str(s.detail) : "Needs: " + (str(s.needs) || str(s.detail))));
        steps.appendChild(row);
      });
      li.appendChild(steps);
      box.appendChild(li);
    });
    var rel = clear($("releases"));
    ["beta", "v1"].forEach(function (k) {
      var r = st()[k];
      if (!isObj(r)) return;
      var cl = arr(r.checklist).filter(isObj), done = cl.filter(function (c) { return c.done || c.auto_met; }).length;
      var card = h("div", { "class": "card" }, h("div", { "class": "card-head" }, h("h3", { "class": "card-title" }, (str(r.version) || k) + " · " + str(r.name)), h("span", { "class": "card-note" }, done + " of " + cl.length + " done")));
      card.appendChild(h("p", { "class": "phase-goal", style: "margin-bottom:8px" }, str(r.definition)));
      if (isObj(r.estimate)) card.appendChild(h("p", { "class": "phase-est", style: "margin-bottom:8px" }, estChip(), rangeText(r.estimate), h("span", { "class": "muted" }, " Assumes: " + str(r.estimate.assumes))));
      var list = h("ul", { "class": "checklist" });
      cl.forEach(function (c) {
        var ok = c.done || c.auto_met;
        list.appendChild(h("li", { "class": "check" + (ok ? " ok" : "") }, stepIcon(ok ? "done" : "next"), h("span", null, str(c.text), c.auto && c.auto_met && !c.done ? h("span", { "class": "muted" }, " (measured by the collector)") : null, h("span", { "class": "sr-only" }, ok ? " (done)" : " (not yet)"))));
      });
      card.appendChild(list);
      rel.appendChild(card);
    });
  }

  // ------------------------------------------------------------------ crew
  function renderCrew() {
    var box = clear($("crew-grid"));
    var s = st(), tm = isObj(s.team) ? s.team : {};
    var hb = jobs().filter(function (j) { return j.source === "heartbeat"; }).map(function (j) { return j.id; });
    CREW.forEach(function (c) {
      var ids = c.id === "lab" ? c.jobs.concat(hb) : c.jobs;
      var js = ids.map(job).filter(Boolean);
      var card = h("div", { "class": "card crew-card" });
      var lead = js[0];
      var stateEl = null;
      if (c.id === "keeper") { var sup = g(keepalive().k, "supervisor") || {}; stateEl = svLight(isObj(sup) ? sup : {}, true); }
      else if (c.id === "pi") stateEl = light("running", null, "Reading this page");
      else if (lead) { var active = js.filter(function (j) { return ["running", "pairing", "serving", "training"].indexOf(j.state) >= 0; })[0]; var L = active || lead; stateEl = light(str(L.state) || "unknown", L.health, null, L.state === "running"); }
      card.appendChild(h("div", { "class": "crew-top" }, avatar(c), h("div", null, h("div", { "class": "crew-name" }, c.name), h("div", { "class": "crew-sub" }, js.map(function (j) { return str(j.label); }).join(" · ") || (c.id === "keeper" ? "launchd supervisor on the Mac" : c.id === "pi" ? "Principal investigator" : ""))), h("span", { style: "margin-left:auto" }, stateEl)));
      card.appendChild(h("p", { "class": "crew-role" }, c.role));
      if (c.id === "coders") {
        var fl = 0; codingJobs().forEach(function (j) { fl += arr(nowOf(j).in_flight).length; });
        card.appendChild(h("p", { "class": "crew-now" }, fl ? fl + " coding unit(s) in flight now; " + fInt(tm.agents_in_flight) + " agents at work in all." : "No coding unit in flight now."));
        card.appendChild(h("div", { "class": "crew-stats" }, codingJobs().map(function (j) { var p = isObj(j.progress) ? j.progress : {}; return h("span", null, runName(j.id) + " ", h("b", null, fInt(p.done) + "/" + fInt(p.total))); })));
      } else if (c.id === "keeper") {
        var k = keepalive().k, cnt = isObj(k.counts) ? k.counts : null;
        card.appendChild(h("p", { "class": "crew-now" }, cnt ? fInt(cnt.running) + " of " + fInt(cnt.jobs) + " kept-alive jobs running; auto-restart on for " + fInt(cnt.auto_restart_on) + "." : "Its status is not in this data yet."));
      } else if (c.id === "pi") {
        var nn = g(s, "notes.count");
        card.appendChild(h("p", { "class": "crew-now" }, isNum(nn) ? fInt(nn) + " open note(s) to the team." : "Leaves notes for the team (see Talk to the team)."));
      } else if (lead) {
        card.appendChild(h("p", { "class": "crew-now" }, str(nowOf(lead).step) || str(lead.line)));
        var stats = h("div", { "class": "crew-stats" });
        if (isNum(lead.uptime_s) && lead.running) stats.appendChild(h("span", null, "on duty ", h("b", null, fDurShort(lead.uptime_s))));
        var la = ms(lead.last_activity);
        if (la) stats.appendChild(h("span", null, "last activity ", h("b", { "data-ago": la }, fAgo(la))));
        if (isObj(lead.rate) && isNum(lead.rate.last60)) stats.appendChild(h("span", null, "pace ", h("b", null, f1(lead.rate.last60)), " " + str(lead.rate.unit) + " (60 min)"));
        if (isObj(lead.progress) && isNum(lead.progress.pct)) stats.appendChild(h("span", null, h("b", null, fPct(lead.progress.pct)), " of " + str(lead.progress.unit)));
        card.appendChild(stats);
      }
      box.appendChild(card);
    });
  }

  // ------------------------------------------------------------------ mission log
  var KINDS = [["all", "Everything"], ["milestone", "Milestones"], ["startstop", "Starts and stops"], ["progress", "Progress"], ["note", "Notes"], ["updater", "Updater"], ["alert", "Alerts"]];
  function kindMatch(e, k) {
    if (k === "all") return true;
    if (k === "startstop") return e.kind === "start" || e.kind === "stop";
    return e.kind === k;
  }
  function renderLog() {
    var f = clear($("log-filters"));
    KINDS.forEach(function (k) {
      var b = h("button", { type: "button", "class": "btn sm", "aria-pressed": S.ui.logKind === k[0] ? "true" : "false" }, k[1]);
      b.addEventListener("click", function () { S.ui.logKind = k[0]; S.ui.logShown = 20; renderLog(); });
      f.appendChild(b);
    });
    var sel = h("select", { id: "log-crew", "aria-label": "Crew member", "class": "btn sm" });
    sel.appendChild(h("option", { value: "all" }, "All crew"));
    CREW.forEach(function (c) { var o = h("option", { value: c.id }, c.name); if (S.ui.logCrew === c.id) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { S.ui.logCrew = sel.value; S.ui.logShown = 20; renderLog(); });
    f.appendChild(sel);
    var list = clear($("log-list"));
    var ev = events().filter(function (e) { return kindMatch(e, S.ui.logKind) && (S.ui.logCrew === "all" || (crewOf(e.job) || {}).id === S.ui.logCrew); });
    var base = S.baseline && S.baseline.gen ? ms(S.baseline.gen) : null;
    if (!ev.length) list.appendChild(h("li", { "class": "log-item" }, h("span"), h("span"), h("span", { "class": "placeholder" }, S.status ? "Nothing in the log for this filter." : "The log shows once a status loads.")));
    ev.slice(0, S.ui.logShown).forEach(function (e) {
      var t = ms(e.t), c = crewOf(e.job);
      list.appendChild(h("li", { "class": "log-item k-" + str(e.kind) + (base && t > base ? " fresh" : "") },
        h("span", { "class": "log-time" }, fTime(t), h("small", { "data-ago": t }, fAgo(t))), crewDot(c),
        h("span", { "class": "log-text" }, h("span", { "class": "log-kind" }, str(e.kind)), labelled(e.job, e.text))));
    });
    var more = clear($("log-more"));
    if (ev.length > S.ui.logShown) {
      var b2 = h("button", { type: "button", "class": "btn" }, "Show " + Math.min(20, ev.length - S.ui.logShown) + " more (" + (ev.length - S.ui.logShown) + " left)");
      b2.addEventListener("click", function () { S.ui.logShown += 20; renderLog(); });
      more.appendChild(b2);
    }
  }

  // ------------------------------------------------------------------ the live ticker
  function renderTicker() {
    var tr = clear($("ticker-track"));
    var items = [];
    events().slice(0, 14).forEach(function (e) { items.push({ t: ms(e.t), c: crewOf(e.job), text: labelled(e.job, e.text) }); });
    arr(nowOf(job("harvest")).lanes).filter(isObj).forEach(function (l) { if (isObj(l.last) && ms(l.last.at)) items.push({ t: ms(l.last.at), c: CREW_BY.harvest, text: "Harvest " + str(l.id) + ": " + laneLast(l) }); });
    codingJobs().forEach(function (j) { arr(nowOf(j).in_flight).filter(isObj).forEach(function (u) { var st0 = ms(u.started_at); items.push({ t: st0, c: CREW_BY.coders, text: runName(j.id) + " " + str(u.batch) + " " + str(u.coder) + " started coding" }); }); });
    var cw = g(nowOf(job("core")), "window");
    if (isObj(cw) && ms(nowOf(job("core")).at)) items.push({ t: ms(nowOf(job("core")).at), c: CREW_BY.core, text: "CORE window " + fInt(cw.n) + " of " + fInt(cw.of) + ": papers #" + fInt(cw.first) + " to #" + fInt(cw.last) });
    items = items.filter(function (x) { return isNum(x.t); }).sort(function (a, b) { return b.t - a.t; }).slice(0, 18);
    if (!items.length) { tr.appendChild(h("span", { "class": "tk" }, S.status ? "No events yet." : "Waiting for the first status…")); tr.classList.remove("run"); return; }
    function build(hidden) {
      var frag = document.createDocumentFragment();
      items.forEach(function (x) {
        var dot = h("span", { "class": "dot" }); dot.style.setProperty("--crew", crewVar(x.c));
        var el = h("span", { "class": "tk" }, dot, h("time", { "data-ago": x.t }, fAgo(x.t)), h("b", null, x.text));
        if (hidden) el.setAttribute("aria-hidden", "true");
        frag.appendChild(el);
      });
      return frag;
    }
    tr.appendChild(build(false));
    if (!REDUCED.matches) {
      tr.appendChild(build(true));
      tr.classList.add("run");
      requestAnimationFrame(function () { var w = tr.scrollWidth / 2; tr.style.setProperty("--dur", Math.max(30, Math.round(w / 45)) + "s"); });
    } else tr.classList.remove("run");
  }

  // ------------------------------------------------------------------ since you last checked, milestones, badges
  function snapVals() {
    var cov = coverageLow();
    return { c_done: g(job("core") || {}, "progress.done"), c_txt: g(job("core") || {}, "found.with_text"), h_left: g(job("harvest") || {}, "queue.left"),
      s1: g(job("coding_s1") || {}, "progress.done"), te: g(job("coding_test") || {}, "progress.done"), st: g(st(), "collection.store.with_text"), low: cov ? cov.low : null };
  }
  function readVisit() { try { var v = JSON.parse(localStorage.getItem(CFG.visitKey) || "null"); return isObj(v) ? v : null; } catch (e) { return null; } }
  function saveVisit() { try { localStorage.setItem(CFG.visitKey, JSON.stringify({ gen: st().generated_at, seenAt: Date.now(), v: snapVals() })); } catch (e) {} }
  var SINCE_ROWS = [["low", "Papers with a text (lower bound)", "up"], ["c_done", "CORE papers looked up", "up"], ["c_txt", "CORE papers that got a text", "up"], ["h_left", "Harvest gaps queue", "down"], ["s1", "Silver S1 units final", "up"], ["te", "TEST units final", "up"], ["st", "Store lines with a text", "up"]];
  function renderSince() {
    var box = clear($("since"));
    var b = S.baseline;
    if (!S.status) { box.appendChild(h("p", { "class": "placeholder" }, "Shows once a status loads.")); return; }
    if (!b) { box.appendChild(h("p", { "class": "placeholder" }, "This is your first visit on this browser (or its storage is off). Next time, this card shows what changed since now.")); setText("since-note", ""); return; }
    var bt = ms(b.gen) || b.seenAt;
    setText("since-note", "since " + fDayTime(bt));
    var now = snapVals(), list = h("div", { "class": "since-list" }), anyChange = false;
    SINCE_ROWS.forEach(function (r) {
      var a = isObj(b.v) ? b.v[r[0]] : null, c = now[r[0]];
      if (!isNum(a) || !isNum(c)) return;
      var d = c - a;
      if (d) anyChange = true;
      var cls = "delta" + (d && ((d > 0) === (r[2] === "up")) ? " good" : d ? " bad" : "");
      list.appendChild(h("div", { "class": "since-row" }, h("span", null, r[1]), h("b", { "class": cls }, d ? fSigned(d) : "no change")));
    });
    var newEv = events().filter(function (e) { return ms(e.t) > bt; });
    list.appendChild(h("div", { "class": "since-row" }, h("span", null, "New log entries"), h("b", null, fInt(newEv.length))));
    var ms_ = newEv.filter(function (e) { return e.kind === "milestone"; });
    box.appendChild(list);
    if (ms_.length) { box.appendChild(h("h4", { "class": "mini-h" }, "New milestones")); var ul = h("ul", { "class": "ms-list" }); ms_.forEach(function (e) { ul.appendChild(h("li", { "class": "ms" }, icon("flag"), h("span", null, labelled(e.job, e.text)), h("small", null, fDayTime(ms(e.t))))); }); box.appendChild(ul); }
    if (!anyChange && !newEv.length) box.appendChild(h("p", { "class": "placeholder" }, "Nothing changed since then."));
  }
  function estimateDone(id) {   // an estimate whose work is already finished is not "coming up"
    function fin(jid) { var j = job(jid); if (!j) return false; var p = isObj(j.progress) ? j.progress : null; return j.state === "finished" || (p && isNum(p.done) && isNum(p.total) && p.total > 0 && p.done >= p.total); }
    if (id === "s2") return fin("s2");
    if (id === "s1") return fin("coding_s1");
    if (id === "test") return fin("coding_test");
    if (id === "collection") return fin("harvest") && fin("core");
    if (id === "beta") { var b = st().beta; return isObj(b) && arr(b.checklist).length > 0 && b.done_count >= arr(b.checklist).length; }
    return false;
  }
  function renderMilestones() {
    var ul = clear($("ms-list"));
    var m = events().filter(function (e) { return e.kind === "milestone"; }).slice(0, 10);
    if (!m.length) ul.appendChild(h("li", { "class": "placeholder" }, "No milestone in the newest log entries."));
    m.forEach(function (e) { var t = ms(e.t); ul.appendChild(h("li", { "class": "ms" }, icon("flag"), h("span", null, str(e.text)), h("small", null, fDayTime(t) + ", ", h("span", { "data-ago": t }, fAgo(t))))); });
    var nx = clear($("ms-next"));
    var est = arr(st().estimates).filter(function (e) { return isObj(e) && !estimateDone(e.id); }).map(function (e) { return { e: e, a: ymdMs(e.from), b: ymdMs(e.to, true) }; }).filter(function (x) { return x.b && x.b >= Date.now() - 86400e3; }).sort(function (x, y) { return (x.a || 0) - (y.a || 0); });
    if (!est.length) nx.appendChild(h("li", { "class": "placeholder" }, "No upcoming estimates in this status."));
    est.forEach(function (x) {
      var li = h("li", { "class": "ms", title: "Assumes: " + str(x.e.assumes) }, icon("clock"), h("span", null, h("b", null, str(x.e.what)), " · " + rangeText(x.e)), h("small", null, x.a && x.a > Date.now() ? "the window opens " + fUntil(x.a) + " (estimate)" : "inside the estimated window now"));
      nx.appendChild(li);
    });
  }
  function badgeList() {
    var s = st(), out = [];
    function b(id, ok, name, sub, crew, glyph) { out.push({ id: id, ok: !!ok, name: name, sub: sub, crew: crew, glyph: glyph }); }
    var dv = codingTotals("coding_dev"), s1 = codingTotals("coding_s1"), te = codingTotals("coding_test"), core = job("core");
    var cd = core && isObj(core.progress) ? core.progress.done : null;
    b("dev", dv && dv.done === dv.total && isNum(dv.total), "DEV complete", dv ? fInt(dv.total) + " units" : "", CREW_BY.coders, "check");
    b("preview", g(s, "model.preview.exists"), "Preview model built", "tags can be tried now", CREW_BY.lab, "flask");
    b("s2", (job("s2") || {}).state === "finished", "Semantic Scholar read", "420 parts, paired", CREW_BY.s2, "diver");
    b("openalex", (job("openalex") || {}).state === "finished", "OpenAlex paired", "the whole snapshot", CREW_BY.openalex, "map");
    b("faculty", (job("faculty") || {}).state === "finished", "Repositories read", "faculty scholarship", CREW_BY.faculty, "library");
    b("core25", isNum(cd) && cd >= 25000, "25,000 CORE lookups", isNum(cd) ? fInt(cd) + " so far" : "", CREW_BY.core, "scout");
    b("core100", isNum(cd) && cd >= 100000, "100,000 CORE lookups", isNum(cd) ? fInt(cd) + " so far" : "", CREW_BY.core, "scout");
    b("s1q", s1 && isNum(s1.done) && s1.done >= 0.25 * s1.total, "S1 a quarter coded", s1 ? fInt(s1.done) + " of " + fInt(s1.total) : "", CREW_BY.coders, "tag");
    b("s1h", s1 && isNum(s1.done) && s1.done >= 0.5 * s1.total, "S1 half coded", s1 ? fInt(s1.done) + " of " + fInt(s1.total) : "", CREW_BY.coders, "tag");
    b("s1all", s1 && isNum(s1.done) && s1.done >= s1.total, "Silver S1 coded", "training labels ready", CREW_BY.coders, "star");
    b("test", te && isNum(te.done) && te.done >= 100, "100 TEST units", te ? fInt(te.done) + " of " + fInt(te.total) : "", CREW_BY.coders, "tag");
    var ps = g(nowOf(job("harvest")), "passes");
    b("passes", isObj(ps) && ps.done >= ps.planned, "Every journal pass done", isObj(ps) ? fInt(ps.done) + " of " + fInt(ps.planned) : "", CREW_BY.harvest, "harvest");
    var sup = g(keepalive().k, "supervisor.state");
    b("keeper", sup === "running", "Supervisor on duty", "restarts what stops", CREW_BY.keeper, "shield");
    b("beta", g(s, "beta.done_count") >= arr(g(s, "beta.checklist")).length && arr(g(s, "beta.checklist")).length, "Beta v0.9", "the owner's audit opens", null, "bolt");
    return out;
  }
  function renderBadges() {
    var box = clear($("badges"));
    if (!S.status) return;
    badgeList().forEach(function (b) {
      var ic = h("span", { "class": "badge-ic", "aria-hidden": "true" }, icon(b.glyph));
      ic.style.setProperty("--crew", crewVar(b.crew));
      box.appendChild(h("div", { "class": "badge" + (b.ok ? "" : " locked"), title: b.ok ? "Earned" : "Not yet" }, ic, h("b", null, b.name), h("small", null, (b.ok ? "" : "not yet · ") + b.sub)));
    });
  }

  // ------------------------------------------------------------------ talk to the team (the page takes no commands)
  function safeUrl(u, pathPrefix) {
    try {
      var x = new URL(u);
      if (x.protocol !== "https:" || CFG.allowHosts.indexOf(x.hostname.toLowerCase()) < 0) return null;
      if (x.hostname === "github.com" && !/^\/nathanreitinger(\/|$)/i.test(x.pathname)) return null;
      if (x.hostname === "huggingface.co" && !/^\/nathanreitinger(\/|$)/i.test(x.pathname)) return null;
      if (pathPrefix && x.pathname.toLowerCase().indexOf(pathPrefix.toLowerCase()) !== 0) return null;
      return x.href;
    } catch (e) { return null; }
  }
  function renderNotes() {
    var box = clear($("notes-body"));
    var n = isObj(st().notes) ? st().notes : null;
    box.appendChild(h("p", { "class": "notes-lead" }, "This page cannot take commands or start anything. To tell the team something, leave a note: it becomes an issue in this page's public GitHub repository, and Claude asks you in the Claude app before acting on it."));
    if (!n) {
      box.appendChild(h("p", { "class": "notes-how" }, S.status ? "The notes channel is not in this data yet (it arrives with the v2 updater). Until then, tell Claude in the Claude app." : "Shows once a status loads."));
      return;
    }
    var every = isNum(n.every_s) ? fDurShort(n.every_s) : "5 min";
    box.appendChild(h("ol", { "class": "notes-steps" },
      h("li", null, h("b", null, "Leave a note. "), "GitHub opens a new issue in this page's public repository; sign in as nathanReitinger."),
      h("li", null, h("b", null, "The Mac reads it. "), "It reads the open notes every " + every + ". Only notes opened by nathanReitinger are read; anything anyone else writes there is ignored."),
      h("li", null, h("b", null, "Claude asks you first. "), "A note passes the same safety check as this page, then goes to Claude's inbox on the Mac. Claude never acts on it by itself: it asks you in the Claude app to confirm."),
      h("li", null, h("b", null, "Close it when done. "), "The repository is public, so a note never holds passwords, keys or private details.")));
    var act = h("div", { "class": "notes-actions" });
    var nn = isObj(n.new_note) ? n.new_note : {}, base = safeUrl(str(nn.url), "/nathanReitinger/lawrank-progress/issues");
    if (base) {
      var href = base + (base.indexOf("?") < 0 ? "?" : "&") + "title=" + encodeURIComponent(str(nn.title)) + "&body=" + encodeURIComponent(str(nn.body));
      act.appendChild(h("a", { "class": "btn primary", href: href, target: "_blank", rel: "noopener noreferrer" }, icon("note"), "Leave a note (opens GitHub)"));
    }
    var lu = safeUrl(str(g(n, "list.url")), "/nathanReitinger/lawrank-progress/issues");
    if (lu) act.appendChild(h("a", { "class": "btn", href: lu, target: "_blank", rel: "noopener noreferrer" }, "See every note"));
    var ra = ms(n.read_at);
    act.appendChild(h("span", { "class": "muted", style: "font-size:12.5px" }, ra ? h("span", null, "The Mac read the notes ", h("span", { "data-ago": ra }, fAgo(ra)), n.read_ok === false ? " (it failed; it tries again)" : "") : "The Mac has not read the notes yet."));
    box.appendChild(act);
    var items = arr(n.items).filter(isObj);
    if (items.length) {
      items.forEach(function (it) {
        var t = ms(it.at), u = safeUrl(str(it.url), "/nathanReitinger/lawrank-progress/issues");
        box.appendChild(h("div", { "class": "note-item" }, h("b", null, "Note #" + fInt(it.number) + ": " + str(it.title)), it.text ? h("p", null, str(it.text)) : null,
          h("small", null, t ? fDayTime(t) : "", u ? h("span", null, " · ", h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, "on GitHub")) : null)));
      });
    } else box.appendChild(h("p", { "class": "placeholder" }, "No open notes." + (isNum(n.withheld) && n.withheld ? " " + n.withheld + " note(s) failed the safety check and are not shown." : "")));
  }

  // ------------------------------------------------------------------ links and footer
  function renderLinks() {
    var box = clear($("links-body"));
    var links = arr(st().links).filter(isObj);
    var pub = h("ul", { "class": "link-list" }), loc = h("ul", { "class": "link-list" });
    links.forEach(function (l) {
      if (l.url) { var u = safeUrl(str(l.url)); if (u) pub.appendChild(h("li", null, h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, str(l.label)), h("small", null, new URL(u).host + new URL(u).pathname))); }
      else if (l.local) loc.appendChild(h("li", { "class": "link-local" }, h("b", null, str(l.label)), h("code", null, str(l.local)), l.how ? h("small", null, str(l.how)) : null));
    });
    if (!pub.childNodes.length) pub.appendChild(h("li", null, h("a", { href: "https://github.com/nathanReitinger/lawrank-progress", target: "_blank", rel: "noopener noreferrer" }, "Progress page source"), h("small", null, "github.com/nathanReitinger/lawrank-progress")));
    box.appendChild(h("div", { "class": "card" }, h("div", { "class": "card-head" }, h("h3", { "class": "card-title" }, "On the web")), pub));
    box.appendChild(h("div", { "class": "card" }, h("div", { "class": "card-head" }, h("h3", { "class": "card-title" }, "On the Mac only"), h("span", { "class": "card-note" }, "no link: text to use at the Mac")), loc.childNodes.length ? loc : h("p", { "class": "placeholder" }, "None listed.")));
  }
  function renderFoot() {
    var box = clear($("foot"));
    var s = st(), c = isObj(s.collector) ? s.collector : {};
    var srcWord = S.src === "live" ? "the live branch (GitHub API)" : S.src === "pages" ? "the copy beside this page" : S.src === "local" ? "local-data.js on this Mac" : "–";
    box.appendChild(h("p", null, h("b", null, "This page only reads."), " It cannot start, stop or change anything on the Mac; the supervisor and the runbook commands do that. Data: ", srcWord, ", written ", genMs() ? fDayTime(genMs()) : "–", "."));
    var pairs = [["schema", str(s.schema) || "–"], ["collector", c.version ? "v" + str(c.version) + (c.mode ? ", " + str(c.mode) + " cycle" : "") + (isNum(c.seconds) ? ", " + f2(c.seconds) + " s" : "") + (isNum(c.max_rss_mb) ? ", " + f1(c.max_rss_mb) + " MB" : "") : "–"],
      ["history points", fInt(S.merged.length)], ["live channel", S.live.state + (isNum(S.live.remaining) ? " (GitHub allows " + S.live.remaining + " more reads this hour)" : "")],
      ["the copy beside this page", S.pages.gen ? "written " + fDayTime(ms(S.pages.gen)) : (S.pages.err || "not read yet")]];
    box.appendChild(kvList(pairs, true));
    var um = arr(s.unmeasured).filter(isObj);
    if (um.length) { box.appendChild(h("h4", { "class": "mini-h" }, "Not measured")); box.appendChild(kvList(um.map(function (u) { return [str(u.what), str(u.why)]; }), true)); }
    var errs = arr(c.errors);
    if (errs.length) { box.appendChild(h("h4", { "class": "mini-h" }, "Collector errors this cycle")); errs.forEach(function (e) { box.appendChild(h("p", { "class": "line-quote" }, str(e))); }); }
    box.appendChild(h("p", { "class": "muted" }, "Law Tags Mission Control v2 · numbers marked estimate are estimates · times in your time zone."));
  }

  // ------------------------------------------------------------------ the ticking clock (every second)
  function pollSeconds() { var p = g(st(), "live.poll_s"); return isNum(p) ? Math.max(60, p) : CFG.pollS; }
  function tick() {
    var pill = $("pulse"), fr = freshness(), age = dataAge();
    pill.setAttribute("data-state", fr);
    setText("pulse-word", { live: "Live", late: "Late", stale: "Stale", error: "No data", loading: "Loading", undated: "Undated" }[fr]);
    setText("pulse-age", age === null ? "–" : "data " + fClock(age) + " old");
    var src = S.src === "live" ? "live branch" : S.src === "pages" ? "Pages copy" : S.src === "local" ? "this Mac" : "";
    var nextIn = nextCheckIn();
    setText("pulse-src", (src ? "from the " + src : "") + (nextIn !== null ? (src ? " · " : "") + "next check " + (nextIn <= 0 ? "now" : "in " + nextIn + " s") : ""));
    pill.setAttribute("title", age === null ? "" : "Written " + fDayTime(genMs()) + "; " + (fr === "live" ? "fresh" : fr === "late" ? "later than its usual cycle" : "stale: the updater may have stopped"));
    document.querySelectorAll("[data-ago]").forEach(function (el) { var t = +el.getAttribute("data-ago"); if (t) setText(el, fAgo(t)); });
    document.querySelectorAll("[data-until]").forEach(function (el) { var t = +el.getAttribute("data-until"); if (t) setText(el, fUntil(t)); });
    document.querySelectorAll("[data-clock-since]").forEach(function (el) { var t = +el.getAttribute("data-clock-since"); if (t) setText(el, fClock((Date.now() - t) / 1000)); });
    document.querySelectorAll("[data-dur-since]").forEach(function (el) { var t = +el.getAttribute("data-dur-since"); if (t) setText(el, fDurShort((Date.now() - t) / 1000)); });
    document.querySelectorAll("[data-ago-min]").forEach(function (el) { var t = +el.getAttribute("data-ago-min"); if (t && el._raf == null) setText(el, fInt((Date.now() - t) / 60000)); });
    var pb = $("pollbar"), nx = nextAt();
    if (pb) {
      pb.parentNode.setAttribute("data-state", fr);
      var w = nx && S.lastCheck && nx > S.lastCheck ? clamp(100 * (Date.now() - S.lastCheck) / (nx - S.lastCheck), 0, 100) : 0;
      var old = parseFloat(pb.style.width) || 0;
      pb.style.transition = w < old || REDUCED.matches ? "none" : "";
      pb.style.width = w.toFixed(2) + "%";
    }
    tickUnits();
    if (!REDUCED.matches) S.cells.forEach(function (C) { if (C.geom) drawCells(C, true); });
    if (fr !== S._lastFr) { S._lastFr = fr; renderAlerts(); renderKaStrip(); renderRunbook(); }
  }
  function nextAt() {   // when this page checks for new data next
    var t = Math.min(S.pages.next || Infinity, WANT_LIVE && S.live.state !== "limited" ? (S.live.next || Infinity) : Infinity);
    return isFinite(t) ? t : null;
  }
  function nextCheckIn() {
    if (document.hidden) return null;
    var t = nextAt();
    return t ? Math.max(0, Math.round((t - Date.now()) / 1000)) : null;
  }

  // ------------------------------------------------------------------ fetching
  function parseJSON(txt) {
    if (!txt || !String(txt).trim()) throw new Error("status.json is empty");
    var o;
    try { o = JSON.parse(txt); } catch (e) { throw new Error("status.json is not valid JSON"); }
    if (!isObj(o)) throw new Error("status.json holds no status");
    return o;
  }
  function parseHistory(text) {
    return String(text || "").split("\n").map(function (l) {
      l = l.trim();
      if (!l) return null;
      try { var o = JSON.parse(l); return isObj(o) && ms(o.t) !== null ? o : null; } catch (e) { return null; }
    }).filter(Boolean);
  }
  function fetchPagesStatus(i) {
    i = i || 0;
    if (i >= CFG.bases.length) return Promise.reject(new Error("status.json was not found beside this page"));
    var base = CFG.bases[i];
    return fetch(base + "status.json", { cache: "no-cache" }).then(function (r) {
      if (r.status === 404) return fetchPagesStatus(i + 1);
      if (!r.ok) throw new Error("status.json answered " + r.status);
      return r.text().then(function (t) { return { base: base, status: parseJSON(t) }; });
    }, function (err) { if (i + 1 < CFG.bases.length) return fetchPagesStatus(i + 1); throw err; });
  }
  function pollPages() {
    S.pages.next = Date.now() + CFG.pagesS * 1000;
    var start = S.pages.base === null ? 0 : Math.max(0, CFG.bases.indexOf(S.pages.base));
    return fetchPagesStatus(start).then(function (res) {
      S.pages.base = res.base; S.pages.err = null; S.pages.at = Date.now();
      var changed = res.status.generated_at !== S.pages.gen;
      S.pages.gen = res.status.generated_at || null;
      var p = (changed || !S.hist.length || Date.now() >= S.histNext) ? fetchHistory() : Promise.resolve();
      return p.then(function () { offer(res.status, "pages"); });
    }).catch(function (e) {
      S.pages.err = e && e.message ? e.message : "could not read the copy beside this page";
      if (!S.status) { S.error = S.pages.err + "."; renderAll(); }
    });
  }
  function fetchHistory() {
    S.histNext = Date.now() + CFG.historyS * 1000;
    var base = S.pages.base === null ? "" : S.pages.base;
    return fetch(base + "history.jsonl", { cache: "no-cache" }).then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) {
      var rows = parseHistory(t);
      if (rows.length) { S.hist = rows; mergeHistory(); }
    }, function () {});
  }
  function liveUrl() { return "https://api.github.com/repos/" + CFG.repo + "/contents/" + CFG.liveFile + "?ref=" + CFG.liveRef; }
  function pollLive() {
    if (!WANT_LIVE) return Promise.resolve();
    var L = S.live;
    if (L.state === "limited" && L.reset && Date.now() < L.reset) { L.next = L.reset + 2000; return Promise.resolve(); }
    var hdrs = { Accept: "application/vnd.github.raw" };
    if (L.etag) hdrs["If-None-Match"] = L.etag;
    L.next = Date.now() + pollSeconds() * 1000;
    return fetch(liveUrl(), { headers: hdrs, cache: "no-store", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
      var rem = r.headers.get("X-RateLimit-Remaining"), rst = r.headers.get("X-RateLimit-Reset");
      L.remaining = rem !== null && rem !== "" && isFinite(+rem) ? +rem : L.remaining;
      L.reset = rst && isFinite(+rst) ? +rst * 1000 : L.reset;
      if (r.status === 304) { L.state = "ok"; L.fails = 0; L.at = Date.now(); return null; }
      if (r.status === 404) { L.state = "absent"; L.next = Date.now() + 10 * 60e3; return null; }
      if (r.status === 403 || r.status === 429) { L.state = "limited"; L.next = (L.reset && L.reset > Date.now() ? L.reset : Date.now() + 15 * 60e3) + 2000; return null; }
      if (!r.ok) throw new Error("the live channel answered " + r.status);
      var tag = r.headers.get("ETag");
      return r.text().then(function (t) {
        var o = parseJSON(t);
        L.etag = tag || null; L.state = "ok"; L.fails = 0; L.at = Date.now(); L.gen = o.generated_at || null;
        offer(o, "live");
      });
    }).then(function () {
      if (isNum(L.remaining) && L.remaining <= 3 && L.reset) { L.state = "limited"; L.next = L.reset + 2000; }
    }).catch(function (e) {
      L.fails += 1; L.err = e && e.message ? e.message : "network error";
      if (L.state !== "absent") L.state = "error";
      L.next = Date.now() + Math.min(10 * 60e3, pollSeconds() * 1000 * Math.pow(2, Math.min(4, L.fails)));
    });
  }
  function loadLocalFile() {
    function one(src) {
      return new Promise(function (resolve, reject) {
        var old = $("local-data"); if (old) old.parentNode.removeChild(old);
        window.__PROGRESS_LOCAL__ = undefined;
        var sc = document.createElement("script");
        sc.id = "local-data"; sc.src = src + "?t=" + Date.now();
        sc.onload = function () { var d = window.__PROGRESS_LOCAL__; if (d && isObj(d.status)) resolve(d); else reject(new Error("local-data.js has no status")); };
        sc.onerror = function () { reject(new Error("local-data.js was not found: run the collector first")); };
        document.head.appendChild(sc);
      });
    }
    S.pages.next = Date.now() + CFG.pagesS * 1000;
    return one("local-data.js").catch(function () { return one("../site/local-data.js"); }).then(function (d) {
      S.hist = arr(d.history).filter(function (p) { return isObj(p) && ms(p.t) !== null; }); mergeHistory();
      offer(d.status, "local");
    }).catch(function (e) { S.error = e.message + "."; renderAll(); });
  }
  function mergeHistory() {
    var map = {};
    S.hist.forEach(function (p) { map[p.t] = p; });
    arr(st().recent).forEach(function (p) { if (isObj(p) && ms(p.t) !== null) map[p.t] = p; });
    var out = Object.keys(map).map(function (k) { var p = map[k]; p._t = ms(p.t); return p; });
    out.sort(function (a, b) { return a._t - b._t; });
    S.merged = out;
  }
  function offer(status, src) {
    var g1 = ms(status.generated_at), cur = genMs();
    if (S.status && isNum(cur) && isNum(g1) && g1 < cur) return;            // older than what is shown
    if (S.status && g1 === cur && S.src === "live" && src !== "live") return; // same data, keep the live source
    var isNew = !S.status || g1 !== cur;
    if (S.status && !isNew && src === S.src) return;
    S.prev = S.status; S.status = status; S.src = src; S.error = null;
    mergeHistory();
    if (S.baseline === undefined) S.baseline = readVisit();
    renderAll();
    if (isNew && S.prev) {
      var pill = $("pulse"); if (pill && !REDUCED.matches) { pill.classList.remove("flash"); void pill.offsetWidth; pill.classList.add("flash"); }
      announce("New data: written " + fTime(genMs()) + ".");
    }
    saveVisit();
  }
  var schedTimer = null;
  function schedule() {
    clearTimeout(schedTimer);
    schedTimer = setTimeout(loop, 5000);
  }
  function loop(force) {
    if (document.hidden && !force) { schedule(); return; }
    var now = Date.now(), jobsP = [];
    if (location.protocol === "file:") { if (force || now >= S.pages.next) jobsP.push(loadLocalFile()); }
    else {
      if (force || now >= S.pages.next) jobsP.push(pollPages());
      if (WANT_LIVE && (force || now >= S.live.next)) jobsP.push(pollLive());
    }
    if (jobsP.length) S.lastCheck = now;
    Promise.all(jobsP).then(schedule, schedule);
  }

  // ------------------------------------------------------------------ render everything (only what changed)
  function sig(name, val) { var s = JSON.stringify(val); if (S.sig[name] === s) return false; S.sig[name] = s; return true; }
  function renderAll() {
    // every section's signature carries the data's time, whether a status is loaded at all, and the load error
    var s = st(), gen = [s.generated_at || null, S.status ? 1 : 0, S.error || ""].join("|"), key = [gen, S.range, S.merged.length, S.src, S.live.state];
    renderHead();
    if (sig("alerts", [gen, s.alerts, freshness(), S.error, s.keepalive])) renderAlerts();
    if (sig("runbook", [gen, s.keepalive, (job("harvest") || {}).running, (job("core") || {}).running, (job("updater") || {}).running])) { renderRunbook(); renderKaStrip(); }
    if (sig("hero", key)) renderHero();
    if (sig("ready", [gen])) renderReadiness();
    if (sig("stats", key)) renderStats();
    renderWhere();
    if (sig("flight", [gen])) renderFlight();
    if (sig("jobs", [gen, s.keepalive])) renderJobs();
    if (sig("charts", key)) renderCharts();
    if (sig("grids", [gen])) renderGrids();
    if (sig("map", [gen])) renderMap();
    if (sig("crew", [gen, s.keepalive])) renderCrew();
    if (sig("log", [gen])) renderLog();
    if (sig("ticker", [gen])) renderTicker();
    if (sig("since", [gen])) { renderSince(); renderMilestones(); renderBadges(); }
    if (sig("notes", [gen, s.notes])) renderNotes();
    if (sig("links", [gen])) renderLinks();
    renderFoot();
    tick();
    S.firstRender = !S.status;
  }

  // ------------------------------------------------------------------ theme, range, resize, startup
  function themeLabel() {
    var t = document.documentElement.getAttribute("data-theme") || "auto", b = $("theme");
    b.textContent = t === "auto" ? "Auto" : t === "dark" ? "Dark" : "Light";
    b.setAttribute("aria-label", "Color theme: " + (t === "auto" ? "follows the system" : t) + ". Press to change.");
  }
  function redrawVisuals() {
    S.charts.forEach(function (c) { if (!c.holder.hidden) drawDef(c.d, c.holder); });
    S.cells.forEach(function (C) { drawCells(C); });
    S.sig.hero = null; renderHero();
    S.sig.stats = null; renderStats();
  }
  function init() {
    try { var r = localStorage.getItem(CFG.rangeKey); if (r !== null && isFinite(+r)) S.range = +r; } catch (e) {}
    document.querySelectorAll("#range .seg").forEach(function (b) {
      b.setAttribute("aria-pressed", +b.getAttribute("data-range") === S.range ? "true" : "false");
      b.addEventListener("click", function () {
        S.range = +b.getAttribute("data-range");
        try { localStorage.setItem(CFG.rangeKey, String(S.range)); } catch (e) {}
        document.querySelectorAll("#range .seg").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        renderAll();
      });
    });
    $("theme").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") || "auto", nx = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
      if (nx === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", nx);
      try { if (nx === "auto") localStorage.removeItem(CFG.themeKey); else localStorage.setItem(CFG.themeKey, nx); } catch (e) {}
      themeLabel(); redrawVisuals();
    });
    themeLabel();
    if (DARKQ.addEventListener) DARKQ.addEventListener("change", redrawVisuals);
    $("refresh").addEventListener("click", function () { S.pages.next = 0; S.live.next = Math.max(S.live.next || 0, 0); loop(true); });
    var rt = null, lastW = window.innerWidth;
    window.addEventListener("resize", function () {
      if (Math.abs(window.innerWidth - lastW) < 8) return;
      lastW = window.innerWidth;
      clearTimeout(rt); rt = setTimeout(redrawVisuals, 180);
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) loop(Date.now() - Math.max(S.pages.at, S.live.at) > 30000); });
    renderAll();
    renderRunbook();
    renderKaStrip();
    setInterval(tick, 1000);
    loop(true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
