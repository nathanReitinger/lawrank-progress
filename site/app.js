/* Mission control for the law review subject-tags project.
   Reads status.json and history.jsonl (beside this page, else in ../site/; opened from disk: local-data.js) and
   draws the page. Every value from the data reaches the page through textContent or a computed number, never as
   HTML. No external code, and no network beyond those two files. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ settings
  var CFG = {
    refreshMs: 120000,           // re-read status.json every 2 minutes while the page is visible
    staleMin: 30,                // a stale banner after 30 minutes without a newer status
    oldMin: 360,                 // the banner turns red after 6 hours
    cycleMin: 10,                // the updater writes a new status about every 10 minutes
    missionStart: "2026-11-03",  // day 1 of the mission; project.started in the status wins when present
    visitKey: "lawtags-mc-visit-1",
    themeKey: "progress-theme",
    bases: ["", "../site/"]      // where status.json lives: beside this page, or in the published site folder
  };

  var S = {
    status: null, history: [], base: null, gen: null, loadedAt: 0, lastTry: 0, error: null, rendered: false,
    baseline: undefined,         // the previous visit (null on a first visit); fixed for this page view
    storage: true, since: null, lastEarned: null, celebrated: {},
    ui: { open: {}, logKind: "all", logCrew: "all", logShown: 16 },
    charts: []
  };
  function mq(q) { return window.matchMedia ? window.matchMedia(q) : { matches: false }; }
  var REDUCED = mq("(prefers-reduced-motion: reduce)");
  var WIDE = mq("(min-width: 1000px)");

  // ------------------------------------------------------------------ DOM helpers
  function $(id) { return document.getElementById(id); }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function add(el, c) {
    if (c === null || c === undefined || c === false || c === "") return el;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); return el; }
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    return el;
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }
  function setText(id, text) { var el = $(id); if (el && el.textContent !== text) el.textContent = text; }
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function g(o, path) {
    var p = path.split(".");
    for (var i = 0; i < p.length; i++) {
      if (o === null || o === undefined || typeof o !== "object") return undefined;
      o = o[p[i]];
    }
    return o;
  }
  function clamp01(x) { return isNum(x) ? Math.max(0, Math.min(1, x)) : 0; }
  function detailsEl(key, defaultOpen, cls) {
    var d = h("details", { "class": cls || null, "data-key": key });
    d.open = Object.prototype.hasOwnProperty.call(S.ui.open, key) ? !!S.ui.open[key] : !!defaultOpen;
    return d;
  }
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (d && d.getAttribute && d.getAttribute("data-key")) {
      S.ui.open[d.getAttribute("data-key")] = d.open;
      if (d.open) requestAnimationFrame(drawCharts);
    }
  }, true);

  // ------------------------------------------------------------------ numbers, times, dates
  var NF = new Intl.NumberFormat(undefined);
  var NF1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var EN = new Intl.NumberFormat("en-US");   // only to match the collector's own wording in event texts
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function numv(x) { return isNum(x) ? x : null; }
  function n(x) { return isNum(x) ? NF.format(Math.round(x)) : "–"; }
  function n1(x) { return isNum(x) ? (Number.isInteger(x) ? NF.format(x) : NF1.format(x)) : "–"; }
  function sgn(x) {
    if (!isNum(x)) return "–";
    var r = Math.round(x);
    return (r > 0 ? "+" : r < 0 ? "−" : "±") + NF.format(Math.abs(r));
  }
  function pct(x, digits) {
    if (!isNum(x)) return "–";
    var d = digits === undefined ? 1 : digits;
    return x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
  }
  function share(x) { return isNum(x) ? pct(100 * x) : "–"; }
  function short(x) { return x >= 1000 && x % 1000 === 0 ? NF.format(x / 1000) + "k" : NF.format(x); }
  function ms(t) {
    if (typeof t !== "string" || !t) return null;
    var v = Date.parse(t);
    return isNaN(v) ? null : v;
  }
  function relMs(v) {
    if (v === null || v === undefined) return "unknown";
    var d = (Date.now() - v) / 1000, fut = d < 0, out;
    d = Math.abs(d);
    if (d < 60) return fut ? "in under a minute" : "just now";
    if (d < 3600) out = Math.round(d / 60) + " min";
    else if (d < 36 * 3600) {
      var hh = Math.floor(d / 3600), mn = Math.round((d - hh * 3600) / 60);
      if (mn === 60) { hh += 1; mn = 0; }
      out = hh + " h" + (hh < 10 && mn ? " " + mn + " min" : "");
    } else out = Math.round(d / 86400) + " days";
    return fut ? "in " + out : out + " ago";
  }
  var YEAR = new Date().getFullYear();
  function when(v) {
    if (v === null || v === undefined) return "";
    var d = new Date(v), o = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (d.getFullYear() !== YEAR) o.year = "numeric";
    return d.toLocaleString(undefined, o);
  }
  function dayOf(v) {
    if (v === null || v === undefined) return "";
    var d = new Date(v), o = { month: "short", day: "numeric" };
    if (d.getFullYear() !== YEAR) o.year = "numeric";
    return d.toLocaleDateString(undefined, o);
  }
  function clockOf(v) { return new Date(v).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  function weekdayOf(v) { return new Date(v).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); }
  function ymdParts(str) { return typeof str === "string" ? /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(str) : null; }
  function ymd(str) {
    var m = ymdParts(str);
    if (!m) return typeof str === "string" ? str : "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, 12));
    var o = m[3] ? { month: "short", day: "numeric", timeZone: "UTC" } : { month: "short", year: "numeric", timeZone: "UTC" };
    if (m[3] && +m[1] !== YEAR) o.year = "numeric";
    return d.toLocaleDateString(undefined, o);
  }
  function ymdMs(str, endOf) {   // a date-only string as a local time (noon, or the end of that day or month)
    var m = ymdParts(str);
    if (!m) return null;
    if (!m[3]) return endOf ? new Date(+m[1], +m[2], 0, 23, 59).getTime() : new Date(+m[1], +m[2] - 1, 1, 12).getTime();
    return new Date(+m[1], +m[2] - 1, +m[3], endOf ? 23 : 12, endOf ? 59 : 0).getTime();
  }
  function range(e) {
    if (!isObj(e)) return "";
    var a = ymd(e.from), b = ymd(e.to);
    return a === b ? a : a + " – " + b;
  }
  function countdown(e) {
    if (!isObj(e)) return "";
    var a = ymdMs(e.from), b = ymdMs(e.to, true);
    if (a === null || b === null) return "";
    var now = Date.now(), da = Math.ceil((a - now) / 864e5), db = Math.ceil((b - now) / 864e5);
    if (db < 0) return "past its estimate";
    if (da <= 0) return "due any day now";
    return da === db ? "in " + da + " days" : "in " + da + "–" + db + " days";
  }
  function midnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function sinceWord(d) {
    if (!d) return "";
    if (!d.partial) return "today";
    return d.from >= midnight() ? "since " + clockOf(d.from) : "since " + when(d.from);
  }

  // ------------------------------------------------------------------ the data
  function st() { return isObj(S.status) ? S.status : {}; }
  function jobs() { return arr(st().jobs).filter(isObj); }
  function job(id) {
    var l = jobs();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function events() {
    return arr(st().events).filter(function (e) { return isObj(e) && ms(e.t) !== null && typeof e.text === "string"; });
  }
  function estimate(id) {
    return arr(st().estimates).filter(function (e) { return isObj(e) && e.id === id; })[0] || null;
  }
  function step(id) {
    var out = null;
    arr(st().phases).forEach(function (p) { arr(p && p.steps).forEach(function (x) { if (isObj(x) && x.id === id) out = x; }); });
    return out;
  }
  function firstSentence(s) {
    if (typeof s !== "string") return "";
    var i = s.indexOf(". ");
    return i > 0 ? s.slice(0, i + 1) : s;
  }
  function rateValue(j, label) {   // a count from a job's rates list, by its label
    var r = arr(j && j.rates).filter(function (x) { return isObj(x) && x.label === label; })[0];
    return r ? numv(r.value) : null;
  }
  function coreFound() {   // papers the CORE lane found a text for
    var c = job("core");
    if (!c) return null;
    if (isNum(g(c, "found.with_text"))) return c.found.with_text;
    var d = arr(c.details).filter(function (x) { return isObj(x) && x.k === "matched"; })[0];
    var m = d && typeof d.v === "string" ? /\(([\d,]+) with a text/.exec(d.v) : null;
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }
  function s2Found() {
    var j = job("s2");
    if (!j) return null;
    if (isObj(j.found) && (isNum(j.found.with_abstract) || isNum(j.found.with_full_text))) {
      return { abstracts: numv(j.found.with_abstract), full: numv(j.found.with_full_text) };
    }
    var out = { abstracts: null, full: null };
    arr(j.details).forEach(function (d) {
      if (!isObj(d) || typeof d.v !== "string") return;
      var m = /([\d,]+) papers kept/.exec(d.v);
      if (!m) return;
      var v = Number(m[1].replace(/,/g, ""));
      if (d.k === "abstract parts") out.abstracts = v;
      if (d.k === "full-text parts") out.full = v;
    });
    return out.abstracts === null && out.full === null ? null : out;
  }
  function coverage() {   // the measured count, plus the CORE lane's finds since (a lower bound)
    var s = st(), cov = g(s, "collection.coverage");
    var goal = numv(g(cov, "papers")) || numv(g(s, "collection.paper_list.papers")) || numv(g(s, "project.paper_list.papers"));
    if (!isObj(cov) || !isNum(cov.with_text) || !goal) return { goal: goal, known: false };
    var core = coreFound();
    var lb = cov.with_text + (isNum(core) ? core : 0);
    return { goal: goal, known: true, measured: cov.with_text, core: core, lb: lb, left: Math.max(0, goal - lb),
      at: ms(cov.measured_at), how: cov.how };
  }
  function unitsNow() {
    var t = 0, any = false;
    ["coding_s1", "coding_test", "coding_dev"].forEach(function (id) {
      var d = g(job(id), "progress.done");
      if (isNum(d)) { t += d; any = true; }
    });
    return any ? t : null;
  }

  // history.jsonl: one point per update
  function series(key) {
    var out = [];
    S.history.forEach(function (p) {
      if (!isObj(p)) return;
      var t = ms(p.t), v = p[key];
      if (t !== null && isNum(v)) out.push({ t: t, v: v });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  function seriesOf(fn) {
    var out = [];
    S.history.forEach(function (p) {
      if (!isObj(p)) return;
      var t = ms(p.t), v = fn(p);
      if (t !== null && isNum(v)) out.push({ t: t, v: v });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  function unitSeries() {
    return seriesOf(function (p) { return isNum(p.s1) && isNum(p.te) && isNum(p.dv) ? p.s1 + p.te + p.dv : null; });
  }
  function deltaFrom(sr, t0) {   // change from the last point at or before t0 (else the first point) to the newest
    if (!sr.length) return null;
    var last = sr[sr.length - 1], base = null;
    for (var i = 0; i < sr.length; i++) { if (sr[i].t <= t0) base = sr[i]; else break; }
    var partial = !base;
    if (!base) base = sr[0];
    return { d: last.v - base.v, from: base.t, partial: partial, last: last };
  }

  // ------------------------------------------------------------------ icons (16 px) and crew glyphs (24 px)
  var ICONS = {
    check: { p: ["M3.5 8.5 6.5 11.5 12.5 4.5"] },
    dash: { p: ["M4 8H12"] },
    arrow: { p: ["M3.5 8H11.5", "M8.5 4.5 12 8 8.5 11.5"] },
    pause: { p: ["M5.5 3.5V12.5", "M10.5 3.5V12.5"] },
    alert: { p: ["M8 2.5 14 13.5H2Z", "M8 6.5V9.7", "M8 11.6V11.7"] },
    info: { c: [[8, 8, 6.2]], p: ["M8 7.2V11.5", "M8 4.8V4.9"] },
    flag: { p: ["M4 14V2.5", "M4 3H11.5L10 5.8 11.5 8.5H4"] },
    play: { p: ["M5 3.5 12 8 5 12.5Z"] },
    stop: { p: ["M4.5 4.5H11.5V11.5H4.5Z"] },
    up: { p: ["M4 12 12 4", "M6 4H12V10"] },
    down: { p: ["M4 4 12 12", "M12 6V12H6"] },
    note: { p: ["M2.5 3.5H13.5V10.5H7.5L4.5 13.5V10.5H2.5Z"] },
    relay: { p: ["M13 8A5 5 0 1 1 11.5 4.5", "M13 2.5V5.5H10"] },
    lock: { p: ["M4.5 7.5H11.5V13.5H4.5Z", "M6 7.5V5.5A2 2 0 0 1 10 5.5V7.5"] },
    chev: { p: ["M4 6 8 10 12 6"] },
    star: { p: ["M8 2 9.8 5.8 14 6.3 10.9 9.2 11.7 13.3 8 11.2 4.3 13.3 5.1 9.2 2 6.3 6.2 5.8Z"] },
    pin: { p: ["M8 14.5C8 14.5 3.5 10 3.5 6.5A4.5 4.5 0 0 1 12.5 6.5C12.5 10 8 14.5 8 14.5Z"], c: [[8, 6.5, 1.6]] },
    dot: { c: [[8, 8, 3]], fill: true }
  };
  function icon(name, cls) {
    var d = ICONS[name] || ICONS.dash;
    var el = sv("svg", { viewBox: "0 0 16 16", "class": "ico" + (cls ? " " + cls : ""), "aria-hidden": "true", focusable: "false" });
    (d.c || []).forEach(function (c) { el.appendChild(sv("circle", { cx: c[0], cy: c[1], r: c[2], fill: d.fill ? "currentColor" : "none" })); });
    (d.p || []).forEach(function (p) { el.appendChild(sv("path", { d: p })); });
    return el;
  }
  var GLYPHS = {
    harvest: { p: ["M12 21V7.5", "M12 13.5 7.4 6.8", "M12 13.5 16.6 6.8", "M9.3 16.5H14.7"], c: [[12, 5, 1.8], [6.8, 5.2, 1.6], [17.2, 5.2, 1.6]] },
    scout: { c: [[7, 15.5, 3.6], [17, 15.5, 3.6]], p: ["M10.6 15H13.4", "M4.2 13 6.5 6H9.5L10.6 12.5", "M19.8 13 17.5 6H14.5L13.4 12.5"] },
    diver: { c: [[12, 11.5, 8], [12, 10.8, 3.6]], p: ["M6.5 19.5H17.5", "M4 11.5H2.5", "M21.5 11.5H20"] },
    map: { p: ["M3 6.5 9 4.5 15 6.5 21 4.5V17.5L15 19.5 9 17.5 3 19.5Z", "M9 4.5V17.5", "M15 6.5V19.5"] },
    library: { p: ["M3 9.5 12 4.5 21 9.5", "M5.5 10.5V17", "M9.8 10.5V17", "M14.2 10.5V17", "M18.5 10.5V17", "M3.5 20H20.5"] },
    tag: { p: ["M3.5 12.2V4.5H11.2L20.5 13.8 13.8 20.5Z"], c: [[7.8, 8.8, 1.6]] },
    flask: { p: ["M9 3.5H15", "M10.2 3.5V9.2L5 18A2 2 0 0 0 6.8 21H17.2A2 2 0 0 0 19 18L13.8 9.2V3.5", "M7.6 15H16.4"] },
    star: { p: ["M12 3.2 14.6 8.6 20.5 9.4 16.2 13.4 17.3 19.3 12 16.4 6.7 19.3 7.8 13.4 3.5 9.4 9.4 8.6Z"] },
    antenna: { c: [[12, 11.5, 1.6]], p: ["M12 13V21", "M8.5 21H15.5", "M8.6 8.1A4.8 4.8 0 0 1 15.4 8.1", "M5.8 5.3A8.8 8.8 0 0 1 18.2 5.3"] },
    rank: { p: ["M5 6.5H19", "M5 11.5H15", "M5 16.5H10.5"] },
    lstm: { p: ["M3 10H8V15H3Z", "M10 10H14V15H10Z", "M16 10H21V15H16Z", "M8 12.5H10", "M14 12.5H16", "M5.5 10V7H18.5V10"] },
    gan: { c: [[9, 12, 5.2], [15, 12, 5.2]] },
    graph: { c: [[6, 7, 2.2], [18, 7, 2.2], [12, 17.5, 2.2]], p: ["M8.2 7H15.8", "M7.1 9 10.9 15.6", "M16.9 9 13.1 15.6"] },
    trophy: { p: ["M8 4.5H16V10A4 4 0 0 1 8 10Z", "M8 6.5H5.5A2.5 2.5 0 0 0 8 10", "M16 6.5H18.5A2.5 2.5 0 0 1 16 10", "M12 14V17.5", "M8.5 20H15.5", "M10 17.5H14"] },
    flag: { p: ["M6 21V3.5", "M6 4.5H17L15 8 17 11.5H6"] },
    check: { p: ["M5 12.5 10 17.5 19.5 7"] },
    book: { p: ["M3.5 6C6.5 4.5 9.5 4.5 12 6.5 14.5 4.5 17.5 4.5 20.5 6V18.5C17.5 17 14.5 17 12 19 9.5 17 6.5 17 3.5 18.5Z", "M12 6.5V19"] },
    stack: { p: ["M4 7.5 12 3.5 20 7.5 12 11.5Z", "M4 12 12 16 20 12", "M4 16.5 12 20.5 20 16.5"] }
  };
  function glyph(name) {
    var d = GLYPHS[name] || GLYPHS.star;
    var el = sv("svg", { viewBox: "0 0 24 24", "class": "glyph", "aria-hidden": "true", focusable: "false" });
    (d.c || []).forEach(function (c) { el.appendChild(sv("circle", { cx: c[0], cy: c[1], r: c[2] })); });
    (d.p || []).forEach(function (p) { el.appendChild(sv("path", { d: p })); });
    return el;
  }

  // ------------------------------------------------------------------ the crew
  var CREW = [
    { id: "harvest", slot: 1, glyph: "harvest", name: "The Harvester", short: "Harvester", job: "harvest",
      sub: "Journal harvest · Phase 1",
      role: "Reads the journals' own sites, school repositories and Wayback copies, one polite request at a time per site." },
    { id: "core", slot: 2, glyph: "scout", name: "The CORE Scout", short: "CORE Scout", job: "core",
      sub: "CORE lane · Phase 1",
      role: "Looks up every paper still without a text in CORE, the open-access aggregator." },
    { id: "s2", slot: 3, glyph: "diver", name: "The Diver", short: "Diver", job: "s2",
      sub: "Semantic Scholar datasets · Phase 1",
      role: "Reads the Semantic Scholar bulk datasets offline, part by part, then pairs what it kept with our list." },
    { id: "openalex", slot: 4, glyph: "map", name: "The Cartographer", short: "Cartographer", job: "openalex",
      sub: "OpenAlex snapshot · Phase 1",
      role: "Paired the OpenAlex works snapshot with our paper list." },
    { id: "faculty", slot: 5, glyph: "library", name: "The Librarian", short: "Librarian", job: "faculty",
      sub: "Faculty repositories · Phase 1",
      role: "Read the schools' faculty-scholarship repositories." },
    { id: "coders", slot: 6, glyph: "tag", name: "The Coders", short: "Coders", job: "coding_s1",
      sub: "Claude coding runs · Phase 2",
      role: "Independent Claude agents who code the subject labels, one coding workflow per five-hour usage window." },
    { id: "lab", slot: 7, glyph: "flask", name: "The Model Lab", short: "Model Lab", job: "preview",
      sub: "Architectures and the preview model · Phase 3",
      role: "Built and tested our four architectures and the preview model; trains the contest once silver S1 is coded." },
    { id: "pi", slot: 0, glyph: "star", name: "The PI", short: "PI", job: null,
      sub: "Principal investigator · every phase",
      role: "Sets the course, keeps the keep-alives running, and opens the audit when the v0.9 beta lands." },
    { id: "relay", slot: 0, glyph: "antenna", name: "The Relay", short: "Relay", job: "updater",
      sub: "This page's updater",
      role: "Every 10 minutes it collects the numbers, scans them for anything private, and publishes this page." }
  ];
  var CREW_BY = {};
  CREW.forEach(function (c) { CREW_BY[c.id] = c; });
  var JOB_CREW = { harvest: "harvest", store: "harvest", core: "core", s2: "s2", openalex: "openalex",
    faculty: "faculty", coding_s1: "coders", coding_test: "coders", coding_dev: "coders", coding: "coders",
    preview: "lab", model: "lab", updater: "relay", machine: "relay", note: "pi" };
  function crewOfJob(id) { return CREW_BY[JOB_CREW[id]] || null; }
  function crewVar(c) { return "var(--c" + (c ? c.slot : 0) + ")"; }
  function avatar(c, small) {
    var el = h("span", { "class": "avatar" + (small ? " sm" : ""), "aria-hidden": "true" }, glyph(c ? c.glyph : "star"));
    el.style.setProperty("--crew", crewVar(c));
    return el;
  }
  function crewDot(c) {
    var el = h("span", { "class": "dot", "aria-hidden": "true" });
    el.style.setProperty("--crew", crewVar(c));
    return el;
  }

  // status lights: always a dot or an icon plus a word
  var LIGHTS = {
    running: ["go", "Running"], serving: ["go", "Serving"], pairing: ["go", "Pairing"], training: ["go", "Training"],
    coding: ["go", "Coding"], waiting: ["wait", "Waiting"], restarting: ["wait", "Restarting"],
    building: ["wait", "Being built"], stopped: ["stop", "Stopped"], finished: ["done", "Finished"],
    built: ["done", "Built"], done: ["done", "Done"], paused: ["rest", "Paused"], idle: ["rest", "Idle"],
    ondeck: ["rest", "On deck"], unknown: ["unknown", "Unknown"]
  };
  function lightFor(state, health, label) {
    var m = LIGHTS[state] || LIGHTS.unknown, cls = m[0];
    if (health === "critical" && cls !== "done") cls = "stop";
    else if (health === "warn" && (cls === "rest" || cls === "go")) cls = "wait";
    return { cls: cls, label: label || m[1], state: state };
  }
  function lightEl(L) {
    var el = h("span", { "class": "light " + L.cls });
    if (L.cls === "done") el.appendChild(icon("check"));
    else if (L.state === "paused") el.appendChild(icon("pause"));
    else if (L.cls === "unknown") el.appendChild(icon("info"));
    else el.appendChild(h("i", { "aria-hidden": "true" }));
    add(el, L.label);
    return el;
  }
  function estTag(text) { return h("span", { "class": "est" }, text || "estimate"); }

  // ------------------------------------------------------------------ small figures
  function meter(done, total, label, sub) {
    var p = total > 0 ? Math.max(0, Math.min(100, (100 * done) / total)) : 0;
    var txt = n(done) + " of " + n(total) + (label ? " " + label : "");
    return h("div", { "class": "meter" },
      h("div", { "class": "meter-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": p.toFixed(1), "aria-valuetext": txt + " (" + pct(p) + ")", "aria-label": label || "progress" },
        h("div", { "class": "meter-fill" + (done > 0 ? "" : " zero"), style: "width:" + p.toFixed(2) + "%" })),
      h("div", { "class": "meter-label" },
        h("span", null, h("b", null, n(done)), " of " + n(total) + (label ? " " + label : "")),
        h("span", null, pct(p) + (sub ? " · " + sub : ""))));
  }
  function minimeter(frac) {
    var f = clamp01(frac);
    return h("div", { "class": "minimeter", "aria-hidden": "true" },
      f > 0 ? h("span", { style: "width:" + (100 * f).toFixed(1) + "%" }) : null);
  }
  function ring(frac, top, sub, label) {
    var size = 92, sw = 9, r = (size - sw) / 2, C = 2 * Math.PI * r, f = clamp01(frac);
    var svg = sv("svg", { viewBox: "0 0 " + size + " " + size, "aria-hidden": "true", focusable: "false" },
      sv("circle", { "class": "ring-track", cx: size / 2, cy: size / 2, r: r }),
      f > 0 ? sv("circle", { "class": "ring-fill", cx: size / 2, cy: size / 2, r: r,
        "stroke-dasharray": (C * f).toFixed(2) + " " + C.toFixed(2) }) : null);
    return h("div", { "class": "ring", role: "img", "aria-label": label },
      svg, h("div", { "class": "ring-center", "aria-hidden": "true" }, h("b", null, top), sub ? h("span", null, sub) : null));
  }
  function tableView(key, caption, headers, rows) {
    var det = detailsEl("tbl-" + key, false, "tbl");
    var tb = h("tbody");
    rows.forEach(function (r) {
      add(tb, h("tr", null, r.map(function (c, i) { return h("td", { "class": i > 0 ? "r" : null }, c); })));
    });
    add(det, [h("summary", null, "Show as a table"),
      h("div", { "class": "tbl-wrap" }, h("table", null, h("caption", { "class": "sr-only" }, caption),
        h("thead", null, h("tr", null, headers.map(function (x, i) { return h("th", { scope: "col", "class": i > 0 ? "r" : null }, x); }))),
        tb))]);
    return det;
  }

  // charts are drawn after the page is laid out, at the width they get (and again when it changes)
  function chartHolder(cls) {
    var holder = h("div", { "class": "chart" + (cls ? " " + cls : "") });
    var tip = h("div", { "class": "tip", hidden: true, "aria-hidden": "true" });
    holder.appendChild(tip);
    return { holder: holder, tip: tip };
  }
  function drawCharts() {
    S.charts = S.charts.filter(function (c) { return document.body.contains(c.el); });
    S.charts.forEach(function (c) {
      var w = Math.floor(c.el.clientWidth);
      if (w < 40 || c.w === w) return;
      c.w = w;
      try { c.draw(w); } catch (e) { if (window.console) console.error("chart", e); }
    });
  }
  function showTip(tip, W, x, y, parts) {
    clear(tip);
    add(tip, parts);
    tip.hidden = false;
    tip.style.left = Math.max(70, Math.min(W - 70, x)) + "px";
    tip.style.top = Math.max(0, y - 8) + "px";
  }

  function sparkline(key, pts, opts) {
    var wrap = h("div", { "class": "spark" });
    if (pts.length < 2) {
      add(wrap, h("p", { "class": "spark-empty" }, "The trend line appears after a few updates (one point every 10 minutes)."));
      return wrap;
    }
    var c = chartHolder();
    add(wrap, c.holder);
    S.charts.push({ el: c.holder, draw: function (W) { drawSpark(c.holder, c.tip, pts, opts, W); } });
    add(wrap, h("div", { "class": "spark-cap", "aria-hidden": "true" }, h("span", null, when(pts[0].t)), h("span", null, "now")));
    add(wrap, tableView(key, opts.label, ["Time", opts.unit || "Value"],
      pts.slice(-12).reverse().map(function (p) { return [when(p.t), (opts.fmt || n)(p.v)]; })));
    return wrap;
  }
  function drawSpark(holder, tip, pts, opts, W) {
    var old = holder.querySelector("svg");
    if (old) holder.removeChild(old);
    var H = opts.height || 64, P = 6, fmt = opts.fmt || n;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t, lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    function X(t) { return P + (W - 2 * P) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0)); }
    function Y(v) { return H - P - (H - 2 * P) * (v - lo) / (hi - lo); }
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join(" ");
    var first = pts[0], last = pts[pts.length - 1];
    var summary = opts.label + ": " + fmt(first.v) + " at " + when(first.t) + ", " + fmt(last.v) + " at " + when(last.t) +
      " (" + pts.length + " points). The arrow keys move along the line; the table below has the values.";
    var cross = sv("line", { "class": "cross", x1: 0, x2: 0, y1: 2, y2: H - 2, visibility: "hidden" });
    var hl = sv("circle", { "class": "enddot", r: 4, cx: 0, cy: 0, visibility: "hidden" });
    var svg = sv("svg", { "class": "spark-svg", width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img",
        "aria-label": summary, tabindex: "0" },
      sv("line", { "class": "baseline", x1: P, x2: W - P, y1: H - 0.5, y2: H - 0.5 }),
      sv("path", { "class": "area", d: d + " L" + X(last.t).toFixed(1) + " " + (H - 1) + " L" + X(first.t).toFixed(1) + " " + (H - 1) + " Z" }),
      sv("path", { "class": "line", d: d }),
      cross,
      sv("circle", { "class": "enddot", cx: X(last.t).toFixed(1), cy: Y(last.v).toFixed(1), r: 4 }),
      hl);
    holder.insertBefore(svg, tip);
    var idx = pts.length - 1;
    function show(i) {
      idx = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[idx], x = X(p.t), y = Y(p.v);
      cross.setAttribute("x1", x.toFixed(1)); cross.setAttribute("x2", x.toFixed(1)); cross.setAttribute("visibility", "visible");
      hl.setAttribute("cx", x.toFixed(1)); hl.setAttribute("cy", y.toFixed(1)); hl.setAttribute("visibility", "visible");
      showTip(tip, W, x, y, [h("b", null, fmt(p.v)), " " + (opts.unit || ""), h("br"), when(p.t)]);
    }
    function hide() { tip.hidden = true; cross.setAttribute("visibility", "hidden"); hl.setAttribute("visibility", "hidden"); }
    function nearest(ev) {
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      var x = (ev.clientX - r.left) * (W / r.width), best = 0, bd = Infinity;
      for (var i = 0; i < pts.length; i++) { var dd = Math.abs(X(pts[i].t) - x); if (dd < bd) { bd = dd; best = i; } }
      show(best);
    }
    svg.addEventListener("pointermove", nearest);
    svg.addEventListener("pointerdown", nearest);
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", function () { show(pts.length - 1); });
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", function (ev) {
      var k = ev.key;
      if (k === "ArrowLeft") show(idx - 1);
      else if (k === "ArrowRight") show(idx + 1);
      else if (k === "Home") show(0);
      else if (k === "End") show(pts.length - 1);
      else if (k === "Escape") { hide(); return; }
      else return;
      ev.preventDefault();
    });
  }

  // ------------------------------------------------------------------ crew models: one per teammate
  function deltaRow(parts, since) {   // [{v, label}] -> "+312 papers · +243 texts (since 12:02 PM)"
    var out = [];
    parts.forEach(function (p, i) {
      if (i) out.push(" · ");
      out.push(h("b", null, p.v), " " + p.label);
    });
    if (since && since !== "today") out.push(h("span", { "class": "tiny" }, " (" + since + ")"));
    return out;
  }
  function etaRow(j) {
    if (!j || !isObj(j.eta) || ms(j.eta.at) === null) return null;
    var t = ms(j.eta.at);
    return [h("b", null, dayOf(t)), " (" + relMs(t) + ")", estTag()];
  }
  function finishedRow(t) { return t ? [h("b", null, dayOf(t)), " · resting"] : "Finished"; }
  function factsFrom(j) {
    return arr(j && j.details).filter(isObj).map(function (d) {
      var v = typeof d.v === "string" && /^\d{4}-\d\d-\d\dT/.test(d.v) ? when(ms(d.v)) : d.v;
      return [String(d.k), String(v)];
    });
  }

  var MODELS = {
    harvest: function (m) {
      var j = job("harvest");
      if (!j) return;
      m.light = lightFor(j.state, j.health);
      var t0 = midnight(), dq = deltaFrom(series("h_left"), t0), dt = deltaFrom(series("st"), t0), parts = [];
      if (dq) parts.push({ v: sgn(dq.d), label: "in the gaps queue" });
      if (dt) parts.push({ v: sgn(dt.d), label: "store lines with a text" });
      if (parts.length) m.rows.push(["Today", deltaRow(parts, sinceWord(dq || dt))]);
      var r = j.rate;
      if (isObj(r) && (isNum(r.last60) || isNum(r.last10))) {
        m.rows.push(["Pace", [h("b", null, n1(isNum(r.last60) ? r.last60 : r.last10)), " " + (r.unit || "") + (isNum(r.last60) ? " over the last hour" : " over 10 minutes")]]);
      }
      var e = etaRow(j);
      if (e) m.rows.push(["Finish", e]);
      m.line = j.line; m.lineAt = j.line_at;
      m.spark = { key: "h_left", label: "Papers left in the gaps queue", unit: "papers left" };
      var q = isObj(j.queue) ? j.queue : {};
      if (isNum(q.left)) m.facts.push(["Gaps queue", n(q.left) + " papers left"]);
      if (isNum(q.done_this_run)) m.facts.push(["This run", n(q.done_this_run) + " tried, " + n(q.texts_this_run) + " texts found"]);
      if (isNum(q.skipped_for_now) && q.skipped_for_now) m.facts.push(["Skipped for now", n(q.skipped_for_now)]);
      m.facts = m.facts.concat(factsFrom(j));
      if (isObj(j.eta) && j.eta.basis) m.facts.push(["Finish estimate", dayOf(ms(j.eta.at)) + ", from " + j.eta.basis]);
      if (isObj(j.eta_alt) && j.eta_alt.basis) m.facts.push(["Second estimate", dayOf(ms(j.eta_alt.at)) + ", from " + j.eta_alt.basis]);
    },
    core: function (m) {
      var j = job("core");
      if (!j) return;
      m.light = lightFor(j.state, j.health);
      var t0 = midnight(), dd = deltaFrom(series("c_done"), t0), dt = deltaFrom(series("c_txt"), t0), parts = [];
      if (dd) parts.push({ v: sgn(dd.d), label: "looked up" });
      if (dt) parts.push({ v: sgn(dt.d), label: "texts found" });
      if (parts.length) m.rows.push(["Today", deltaRow(parts, sinceWord(dd))]);
      var r = j.rate;
      if (isObj(r) && (isNum(r.last60) || isNum(r.last10))) {
        m.rows.push(["Pace", [h("b", null, n1(isNum(r.last60) ? r.last60 : r.last10)), " " + (r.unit || "") + (isNum(r.last60) ? " over the last hour" : " over 10 minutes")]]);
      }
      var e = etaRow(j);
      if (e) m.rows.push(["Finish", e]);
      m.line = j.line; m.lineAt = j.line_at;
      m.spark = { key: "c_done", label: "Papers looked up in CORE", unit: "papers" };
      var pr = j.progress, found = coreFound();
      if (isObj(pr) && isNum(pr.done)) m.facts.push(["Looked up", n(pr.done) + " of " + n(pr.total) + " papers"]);
      if (isNum(found)) m.facts.push(["Texts found", n(found) + " papers"]);
      m.facts = m.facts.concat(factsFrom(j));
      if (isObj(j.eta) && j.eta.basis) m.facts.push(["Finish estimate", dayOf(ms(j.eta.at)) + ", from " + j.eta.basis]);
    },
    s2: function (m) {
      var j = job("s2");
      if (!j) return;
      m.light = lightFor(j.state, j.health);
      var dp = deltaFrom(series("s2_parts"), midnight());
      if (dp && dp.d > 0) m.rows.push(["Today", deltaRow([{ v: sgn(dp.d), label: "dataset parts read" }], sinceWord(dp))]);
      var f = s2Found();
      if (f) m.rows.push(["Haul", [h("b", null, n(f.abstracts)), " abstracts · ", h("b", null, n(f.full)), " full texts"]]);
      if (j.state === "finished") m.rows.push(["Done", finishedRow(ms(j.last_activity))]);
      else {
        var e = etaRow(j);
        if (e) m.rows.push(["Finish", e]);
        else if (isObj(j.estimate)) m.rows.push(["Finish", [h("b", null, range(j.estimate)), estTag()]]);
      }
      m.line = j.line; m.lineAt = j.line_at || j.last_activity;
      m.spark = { key: "s2_parts", label: "Dataset parts read", unit: "parts" };
      m.facts = factsFrom(j);
    },
    openalex: function (m) {
      var j = job("openalex"), oa = g(st(), "collection.openalex");
      if (!j && !isObj(oa)) return;
      m.light = lightFor(j ? j.state : "finished", j ? j.health : "ok");
      if (isObj(oa)) {
        m.rows.push(["Haul", [h("b", null, n(oa.with_text)), " papers with a text, ", h("b", null, n(oa.with_abstract)), " of them abstracts"]]);
        m.rows.push(["Done", finishedRow(ms(oa.at))]);
        m.facts.push(["Records paired", n(oa.paired)]);
        m.facts.push(["Papers with a PDF link", n(oa.with_pdf)]);
        m.facts.push(["Papers with anything", n(oa.with_any)]);
      }
      m.line = j && j.line; m.lineAt = isObj(oa) ? oa.at : null;
      m.facts = m.facts.concat(factsFrom(j));
    },
    faculty: function (m) {
      var j = job("faculty"), sp = step("p1-faculty");
      if (!j) return;
      m.light = lightFor(j.state, j.health);
      var side = arr(g(st(), "collection.side_stores")).filter(function (x) { return isObj(x) && x.source === "faculty"; })[0];
      if (side) m.rows.push(["Haul", [h("b", null, n(side.lines)), " records from " + n(side.files) + " repositories"]]);
      if (j.state === "finished") m.rows.push(["Done", finishedRow(ms(j.last_activity))]);
      if (sp && sp.detail) m.facts.push(["Summary", sp.detail]);
      m.line = j.line; m.lineAt = j.last_activity;
      m.facts = m.facts.concat(factsFrom(j));
    },
    coders: function (m) {
      var s1 = job("coding_s1"), te = job("coding_test"), dv = job("coding_dev");
      if (!s1 && !te && !dv) return;
      var stS = s1 ? s1.state : "unknown";
      var label = stS === "running" ? "Coding" : stS === "idle" ? "Between windows" : null;
      m.light = lightFor(stS === "running" ? "coding" : stS, s1 ? s1.health : null, label);
      var du = deltaFrom(unitSeries(), midnight());
      if (du) m.rows.push(["Today", deltaRow([{ v: sgn(du.d), label: "coding units" }], sinceWord(du))]);
      var day = 0, anyDay = false;
      [s1, te, dv].forEach(function (j) { var v = rateValue(j, "units (last 24 h)"); if (isNum(v)) { day += v; anyDay = true; } });
      if (anyDay) m.rows.push(["Pace", [h("b", null, n(day)), " units in the last 24 hours"]]);
      if (s1 && isObj(s1.estimate)) m.rows.push(["Finish", ["Silver S1 ", h("b", null, range(s1.estimate)), estTag()]]);
      m.line = s1 && s1.line; m.lineAt = s1 && s1.last_activity;
      m.spark = { key: "s1", label: "Silver S1 units done", unit: "units" };
      [["Silver S1", s1], ["TEST (sealed)", te], ["DEV", dv]].forEach(function (x) {
        var j = x[1];
        if (!j) return;
        var pr = isObj(j.progress) ? j.progress : {};
        m.facts.push([x[0], n(pr.done) + " of " + n(pr.total) + " units · " + (LIGHTS[j.state] || LIGHTS.unknown)[1].toLowerCase()]);
      });
      arr(s1 && s1.notes).forEach(function (t) { if (typeof t === "string") m.notes.push(t); });
    },
    lab: function (m) {
      var pv = job("preview"), M = isObj(st().model) ? st().model : {}, c = isObj(M.contest) ? M.contest : {};
      if (c.training_now) m.light = lightFor("training", "ok");
      else if (pv) m.light = lightFor(pv.state, pv.health, pv.state === "built" ? "Preview built" : null);
      var today = events().filter(function (e) { return (e.job === "preview" || e.job === "model") && ms(e.t) >= midnight(); });
      if (today.length) m.rows.push(["Today", [h("b", null, firstSentence(today[0].text)), " (" + clockOf(ms(today[0].t)) + ")"]]);
      if (isObj(M.tests) && isNum(M.tests.passed)) m.rows.push(["Tests", [h("b", null, n(M.tests.passed)), " passing (last run " + dayOf(ms(M.tests.as_of)) + ")"]]);
      var tr = estimate("training");
      if (tr) m.rows.push(["Next", ["Contest training ", h("b", null, range(tr)), estTag()]]);
      m.line = pv && pv.line; m.lineAt = pv && pv.last_activity;
      if (typeof c.status === "string") m.facts.push(["The contest", c.status]);
      m.facts.push(["Training runs", n(c.runs) + " runs, " + n(c.checkpoints) + " checkpoints"]);
      var nb = g(M, "preview.numbers");
      if (isObj(nb) && arr(nb.measures).length) {
        var lead = arr(nb.measures)[0];
        if (isObj(lead)) m.facts.push(["Preview on DEV", share(lead.v) + " " + (lead.k || "") + " (" + n(nb.n_papers) + " papers)"]);
      }
      m.facts = m.facts.concat(factsFrom(pv));
    },
    pi: function (m) {
      var hd = st().headline || {}, b = st().beta;
      var auditOpen = isObj(b) && arr(b.checklist).some(function (it) { return isObj(it) && /audit/i.test(it.text || "") && it.done; });
      m.light = lightFor(auditOpen ? "running" : "ondeck", "ok", auditOpen ? "Auditing" : "On deck");
      var notes = events().filter(function (e) { return e.kind === "note" && ms(e.t) >= midnight(); });
      m.rows.push(["Today", notes.length ? [h("b", null, n(notes.length)), " note" + (notes.length === 1 ? "" : "s") + " to the log"] : "No notes to the log yet today"]);
      if (isNum(hd.must_up) && isNum(hd.must_total)) {
        m.rows.push(["Watch", [h("b", null, n(hd.must_up) + " of " + n(hd.must_total)), " must-run jobs up"]]);
      }
      if (isObj(b) && isObj(b.estimate)) m.rows.push(["Next", ["Open the audit: ", h("b", null, range(b.estimate)), estTag()]]);
      if (isObj(b)) {
        arr(b.checklist).filter(function (it) { return isObj(it) && !it.done; }).slice(0, 6).forEach(function (it, i) {
          m.facts.push([i ? "" : "Left for the beta", it.text]);
        });
      }
      var notesAll = events().filter(function (e) { return e.kind === "note"; });
      if (notesAll.length) { m.line = notesAll[0].text; m.lineAt = notesAll[0].t; }
    },
    relay: function (m) {
      var j = job("updater");
      if (!j) return;
      m.light = lightFor(j.state, j.health);
      var pts = S.history.filter(function (p) { return isObj(p) && ms(p.t) >= midnight(); }).length;
      m.rows.push(["Today", [h("b", null, n(pts)), " updates published"]]);
      var gen = ms(st().generated_at);
      if (gen) m.rows.push(["Next", ["About ", h("b", null, clockOf(gen + CFG.cycleMin * 60000)), " (every " + CFG.cycleMin + " minutes)"]]);
      m.line = j.line; m.lineAt = j.last_activity;
      m.spark = { key: "run", label: "Must-run jobs running", unit: "jobs" };
      m.facts = factsFrom(j);
    }
  };
  function crewModel(c) {
    var m = { light: lightFor("unknown"), rows: [], facts: [], notes: [], line: null, lineAt: null, spark: null };
    try { MODELS[c.id](m, c); } catch (e) { if (window.console) console.error("crew " + c.id, e); }
    if (!m.rows.length) m.rows.push(["Status", "Not in this status file"]);
    return m;
  }

  // ------------------------------------------------------------------ the telemetry band
  function renderBar() {
    var s = st(), hd = isObj(s.headline) ? s.headline : {};
    var sentence = typeof hd.sentence === "string" ? hd.sentence : "";
    var first = firstSentence(sentence), rest = sentence.slice(first.length).trim();
    setText("mc-sentence", first || "This status file has no headline yet.");
    setText("mc-subsentence", rest);

    var up = clear($("mc-crew-up")), note = clear($("mc-crew-note"));
    var known = isNum(hd.must_up) && isNum(hd.must_total) && hd.must_total > 0;
    if (known) {
      var all = hd.must_up === hd.must_total;
      add(up, lightEl(lightFor(all ? "running" : "stopped", all ? "ok" : "critical", n(hd.must_up) + " of " + n(hd.must_total) + " up")));
    } else add(up, "–");
    var al = arr(s.alerts).filter(function (a) { return isObj(a) && (a.severity === "warn" || a.severity === "critical"); });
    add(note, (known ? "jobs that must keep running" : "") + (al.length ? (known ? " · " : "") + n(al.length) + " to check" : ""));

    var b = isObj(s.beta) ? s.beta : null;
    setText("mc-next-name", b ? (b.version || "Beta") + " " + (b.name || "").toLowerCase() : "–");
    var nw = clear($("mc-next-when"));
    if (b && isObj(b.estimate)) {
      add(nw, [range(b.estimate), estTag(), " " + countdown(b.estimate)]);
      if (isNum(b.done_count)) add(nw, " · " + n(b.done_count) + " of " + n(arr(b.checklist).length) + " done");
    }
    tickClock();
    tick();
  }

  function missionStartMs() {   // local midnight of day 1
    var s = g(st(), "project.started"), v = ymdMs(typeof s === "string" ? s : "");
    if (v === null) v = ymdMs(CFG.missionStart);
    return v - 12 * 3600000;
  }
  function tickClock() {
    var start = missionStartMs();
    if (!isNum(start)) return;
    var e = Math.max(0, Date.now() - start), days = Math.floor(e / 864e5);
    setText("mc-day", "Day " + (days + 1));
    var rest = e - days * 864e5, hh = Math.floor(rest / 3600000), mn = Math.floor((rest % 3600000) / 60000), ss = Math.floor((rest % 60000) / 1000);
    function two(x) { return (x < 10 ? "0" : "") + x; }
    setText("mc-clock", "T+ " + days + "d " + two(hh) + ":" + two(mn) + (REDUCED.matches ? "" : ":" + two(ss)));
    setText("mc-since-start", "since " + dayOf(start + 12 * 3600000));
    // the live-feed countdown
    var nc = $("mc-next-check");
    if (nc && S.status) {
      if (document.visibilityState === "hidden") setText("mc-next-check", "Paused while this tab is hidden");
      else {
        var left = Math.max(0, Math.round((S.lastTry + CFG.refreshMs - Date.now()) / 1000));
        setText("mc-next-check", "Checking again in " + Math.floor(left / 60) + ":" + two(left % 60));
      }
    }
  }

  function tick() {   // relative times, the live pulse and the stale banner (every 15 seconds)
    Array.prototype.forEach.call(document.querySelectorAll("[data-rel]"), function (el) {
      var v = Number(el.getAttribute("data-rel"));
      if (isNum(v)) el.textContent = relMs(v);
    });
    var s = S.status, banner = $("banner");
    var pulse = $("mc-pulse");
    if (!s) {
      clear(banner);
      if (S.error) add(banner, h("div", { "class": "banner critical" }, icon("alert"), h("p", null, S.error)));
      return;
    }
    var gen = ms(s.generated_at), age = gen === null ? null : (Date.now() - gen) / 60000;
    setText("mc-updated", gen === null ? "Time unknown" : "Updated " + relMs(gen));
    var cls = age === null ? "" : age < 15 ? "fresh" : age < CFG.staleMin ? "late" : age < CFG.oldMin ? "stale" : "old";
    if (pulse) pulse.className = "pulse " + cls + (pulse.classList.contains("flash") ? " flash" : "");
    var msg = null, level = "warn";
    if (S.error) {
      msg = [h("b", null, "Could not refresh just now. "), S.error + " Showing the numbers from " + when(gen) + "; trying again in 2 minutes."];
    } else if (gen === null) {
      msg = [h("b", null, "No time stamp. "), "This status file does not say when it was written, so how old these numbers are is not known."];
    } else if (age > CFG.staleMin) {
      level = age > CFG.oldMin ? "critical" : "warn";
      msg = [h("b", null, "These numbers are " + relMs(gen).replace(" ago", "") + " old. "),
        "The updater on the PI's Mac may have paused, or the Mac is asleep. The jobs themselves may still be running; this page picks up the next update by itself."];
    }
    var key = msg ? level + "|" + (S.error || "") + "|" + Math.round(age || 0) : "";
    if (banner.getAttribute("data-key") !== key) {
      banner.setAttribute("data-key", key);
      clear(banner);
      if (msg) add(banner, h("div", { "class": "banner " + level }, icon("alert"), h("p", null, msg)));
    }
  }

  // ------------------------------------------------------------------ needs attention
  function renderAlerts() {
    var list = clear($("alerts")), alerts = arr(st().alerts).filter(isObj);
    $("alerts-sec").hidden = !alerts.length;
    var word = { critical: "Needs attention", warn: "Check", info: "Note" };
    alerts.forEach(function (a) {
      var c = crewOfJob(a.job);
      add(list, h("li", { "class": a.severity || "info" },
        icon(a.severity === "info" ? "info" : "alert"),
        h("div", null,
          h("span", { "class": "sev" }, (word[a.severity] || "Note") + ":"),
          c ? c.name + ". " : "", a.text || "",
          a.since ? h("span", { "class": "tiny" }, " Since ", h("span", { "data-rel": String(ms(a.since)) }, relMs(ms(a.since))), ".") : null,
          a.until ? h("span", { "class": "tiny" }, " Until " + when(ms(a.until)) + ".") : null)));
    });
  }

  // ------------------------------------------------------------------ since you last checked
  function nowVals() {
    var states = {};
    jobs().forEach(function (j) { if (typeof j.id === "string" && typeof j.state === "string") states[j.id] = j.state; });
    return { v: 1, gen: st().generated_at || null, st: numv(g(st(), "collection.store.with_text")), ctxt: coreFound(),
      units: unitsNow(), states: states, badges: earnedIds() };
  }
  function snapshot() { var v = nowVals(); v.seenAt = Date.now(); return v; }
  function readVisit() {
    try {
      var raw = window.localStorage.getItem(CFG.visitKey);
      S.storage = true;
      if (!raw) return null;
      var v = JSON.parse(raw);
      return isObj(v) && v.v === 1 ? v : null;
    } catch (e) { S.storage = false; return null; }
  }
  function saveVisit() {
    try { window.localStorage.setItem(CFG.visitKey, JSON.stringify(snapshot())); } catch (e) { S.storage = false; }
  }
  function diff(a, b) { return isNum(a) && isNum(b) ? a - b : null; }
  function computeSince() {
    var prev = S.baseline || null, cur = nowVals(), out = { first: !prev, prev: prev, cur: cur };
    var t0 = prev ? (ms(prev.gen) || prev.seenAt || 0) : midnight();
    out.t0 = t0;
    out.events = events().filter(function (e) { return ms(e.t) > t0; });
    out.milestones = out.events.filter(function (e) { return e.kind === "milestone"; });
    out.changes = [];
    if (prev) {
      out.texts = [diff(cur.st, prev.st), diff(cur.ctxt, prev.ctxt)];
      out.units = diff(cur.units, prev.units);
      out.newBadges = cur.badges.filter(function (id) { return arr(prev.badges).indexOf(id) < 0; });
      var ps = isObj(prev.states) ? prev.states : {};
      CREW.forEach(function (c) {
        if (!c.job || !ps[c.job] || !cur.states[c.job] || ps[c.job] === cur.states[c.job]) return;
        out.changes.push(c.name + " is now " + (LIGHTS[cur.states[c.job]] || LIGHTS.unknown)[1].toLowerCase() +
          " (was " + (LIGHTS[ps[c.job]] || LIGHTS.unknown)[1].toLowerCase() + ").");
      });
      out.sameData = prev.gen && prev.gen === cur.gen;
    } else {
      var a = deltaFrom(series("st"), t0), b = deltaFrom(series("c_txt"), t0), u = deltaFrom(unitSeries(), t0);
      out.texts = [a ? a.d : null, b ? b.d : null];
      out.units = u ? u.d : null;
      out.from = a ? a : u;
      out.newBadges = badgeList().filter(function (x) { return x.earned && x.at && x.at >= t0; }).map(function (x) { return x.id; });
    }
    return out;
  }
  function renderSince() {
    var box = clear($("since-body"));
    var sc = S.since = computeSince();
    var card = h("div", { "class": "card since-card" });
    var head = h("div", { "class": "since-top" });
    if (sc.first) {
      add(head, [h("h3", null, "Welcome aboard"),
        h("p", { "class": "tiny" }, S.storage ? "Your first check-in on this device. Here is today so far; next time, this shows what changed while you were away."
          : "This browser does not keep your last visit (a private window, or storage is off), so here is today so far.")]);
    } else {
      add(head, [h("h3", null, sc.sameData ? "You are up to date" : "Welcome back"),
        h("p", { "class": "tiny" }, "Last check-in ", h("span", { "data-rel": String(sc.prev.seenAt) }, relMs(sc.prev.seenAt)),
          " (" + when(sc.prev.seenAt) + ")" + (sc.sameData ? ". No new update since then; the next one lands within about " + CFG.cycleMin + " minutes." : "."))]);
    }
    add(card, head);
    var tx = sc.texts || [null, null], tsum = (isNum(tx[0]) ? tx[0] : 0) + (isNum(tx[1]) ? tx[1] : 0);
    var anyT = isNum(tx[0]) || isNum(tx[1]);
    var span = sc.first ? (sc.from && sc.from.partial ? sinceWord(sc.from) : "today") : "since your visit";
    var kpis = h("div", { "class": "kpis" });
    function kpi(label, value, foot) {
      return h("div", { "class": "kpi" }, h("p", { "class": "kpi-label" }, label), h("p", { "class": "kpi-value" }, value), foot ? h("p", { "class": "kpi-foot" }, foot) : null);
    }
    add(kpis, kpi("New texts", anyT ? sgn(tsum) : "–",
      [CREW_BY.harvest.short + " " + sgn(tx[0]) + " store lines · " + CREW_BY.core.short + " " + sgn(tx[1]) + " papers"]));
    add(kpis, kpi("Coding units", sgn(sc.units), "silver S1, TEST and DEV, " + span));
    var mcount = sc.milestones.length + (sc.newBadges || []).length;
    add(kpis, kpi("Milestones", n(mcount), n(sc.milestones.length) + " in the log, " + n((sc.newBadges || []).length) + " new badges"));
    add(kpis, kpi("Log entries", n(sc.events.length), span));
    add(card, kpis);

    var hl = h("ul", { "class": "highlights" });
    var all = badgeList(), byId = {};
    all.forEach(function (b) { byId[b.id] = b; });
    (sc.newBadges || []).slice(0, 4).forEach(function (id) {
      var b = byId[id];
      if (b) add(hl, h("li", null, icon("star"), h("span", null, h("span", { "class": "new-tag" }, "Badge"), b.title + (b.desc ? ": " + b.desc : ""))));
    });
    sc.milestones.slice(0, 4).forEach(function (e) {
      add(hl, h("li", null, icon("flag"), h("span", null, e.text, h("span", { "class": "tiny" }, " · " + when(ms(e.t))))));
    });
    sc.changes.slice(0, 3).forEach(function (t) { add(hl, h("li", null, icon("info"), h("span", null, t))); });
    if (hl.firstChild) add(card, hl);
    else if (!sc.first && !sc.sameData) add(card, h("p", { "class": "tiny", style: "margin-top:10px" }, "No milestone since then: steady work, counted above."));

    var actions = h("div", { "class": "since-actions" });
    if (sc.events.length) add(actions, h("a", { href: "#log", onclick: function () { S.ui.logKind = sc.first ? "all" : "new"; S.ui.logShown = 16; renderLog(); } }, "Read the " + n(sc.events.length) + " log entries"));
    if (!sc.first && S.storage) {
      add(actions, h("button", { type: "button", "class": "linkbtn", id: "since-reset", onclick: function () {
        S.baseline = snapshot();
        renderSince(); renderLog(); renderBadges();
        var b = $("since-reset");
        if (b) b.focus();
      } }, "Start counting from now"));
    }
    if (actions.firstChild) add(card, actions);
    add(box, card);
    if (mcount > 0 && !S.celebrated.since) {
      S.celebrated.since = true;
      celebrate(card);
    }
  }

  // ------------------------------------------------------------------ the mission map
  function nodeRing(frac) {
    var size = 50, sw = 5, r = (size - sw) / 2, C = 2 * Math.PI * r, f = clamp01(frac);
    return sv("svg", { viewBox: "0 0 50 50", "aria-hidden": "true", focusable: "false" },
      sv("circle", { "class": "ring-track", cx: 25, cy: 25, r: r }),
      f > 0 ? sv("circle", { "class": "ring-fill", cx: 25, cy: 25, r: r, "stroke-dasharray": (C * f).toFixed(2) + " " + C.toFixed(2) }) : null);
  }
  var STEP_ICON = { done: "check", running: "dot", next: "arrow", later: "dash" };
  var STEP_WORD = { done: "Done", running: "Running now", next: "Next", later: "Later" };
  function renderMap() {
    var box = clear($("map-body"));
    var s = st(), phases = arr(s.phases).filter(isObj);
    if (!phases.length) {
      add(box, h("p", { "class": "placeholder" }, "The roadmap is not in this status file, so the phases cannot be drawn."));
      return;
    }
    var focus = g(s, "headline.focus_phase");
    var ol = h("ol", { "class": "journey" });
    phases.forEach(function (ph) {
      var steps = arr(ph.steps).filter(isObj);
      var done = isNum(ph.steps_done) ? ph.steps_done : steps.filter(function (x) { return x.status === "done"; }).length;
      var total = isNum(ph.steps_total) ? ph.steps_total : steps.length;
      var isFocus = !!ph.is_focus || (focus && ph.id === focus);
      var isBeta = ph.id === "p4", isV1 = ph.id === "p5";
      var status = typeof ph.status === "string" ? ph.status : "later";
      var li = h("li", { "class": "leg is-" + status + (isFocus ? " is-focus" : "") + (isBeta ? " is-checkpoint" : "") + (isV1 ? " is-finish" : ""),
        "aria-current": isFocus ? "step" : null });
      var node = h("div", { "class": "node", "aria-hidden": "true" }, nodeRing(total ? done / total : 0),
        h("span", { "class": "node-n" }, String(isNum(ph.n) ? ph.n : "")));
      if (isBeta || isV1) { var fg = glyph(isBeta ? "flag" : "trophy"); fg.setAttribute("class", "glyph flag"); add(node, fg); }
      var body = h("div", { "class": "leg-body" });
      var kick = h("p", { "class": "leg-kicker" }, "Phase " + (isNum(ph.n) ? ph.n : "?"));
      if (isFocus) add(kick, h("span", { "class": "here" }, icon("pin"), "You are here"));
      else if (isBeta) add(kick, h("span", null, "· checkpoint"));
      add(body, [kick, h("h3", null, ph.name || "")]);
      var sl = status === "running" ? lightFor("running", "ok", "Under way") : status === "done" ? lightFor("done") :
        lightFor(status === "next" ? "ondeck" : "idle", "ok", status === "next" ? "Next" : "Later");
      var meta = h("div", { "class": "leg-meta" }, lightEl(sl), h("span", null, n(done) + " of " + n(total) + " steps"));
      add(body, meta);
      if (isObj(ph.estimate)) add(body, h("div", { "class": "leg-meta" }, h("span", null, "Est. ", h("b", null, range(ph.estimate))), estTag()));
      if (isBeta && isObj(s.beta)) add(body, h("div", { "class": "leg-meta" }, h("span", null, n(s.beta.done_count) + " of " + n(arr(s.beta.checklist).length) + " checklist items done")));
      var det = detailsEl("steps-" + ph.id, isFocus);
      add(det, h("summary", null, isFocus ? "Steps" : "Show the steps"));
      if (ph.goal) add(det, h("p", { "class": "leg-goal" }, ph.goal));
      var ul = h("ol", { "class": "steps" });
      steps.forEach(function (x) {
        var stt = typeof x.status === "string" ? x.status : "later";
        var live = isObj(x.live) ? x.live : null, pr = live && isObj(live.progress) ? live.progress : null;
        var ic = icon(STEP_ICON[stt] || "dash", "st-" + stt);
        add(ul, h("li", { "class": stt }, ic, h("div", null,
          h("span", { "class": "sr-only" }, (STEP_WORD[stt] || stt) + ": "),
          h("div", { "class": "step-name" }, x.name || ""),
          x.detail ? h("div", { "class": "step-detail" }, x.detail) : null,
          pr && isNum(pr.total) && pr.total > 0 && stt === "running" ? h("div", null, minimeter(pr.done / pr.total),
            h("div", { "class": "step-needs" }, n(pr.done) + " of " + n(pr.total) + " " + (pr.unit || "") + " (" + pct(100 * pr.done / pr.total) + ")")) : null,
          x.needs && stt !== "done" ? h("div", { "class": "step-needs" }, "Needs: " + x.needs) : null)));
      });
      add(det, ul);
      add(body, det);
      add(li, [node, body]);
      add(ol, li);
    });
    add(box, ol);

    // the next checkpoint: the beta, then v1.0
    var grid = h("div", { "class": "grid2", style: "margin-top:16px" });
    [s.beta, s.v1].forEach(function (b, i) {
      if (!isObj(b)) return;
      var items = arr(b.checklist).filter(isObj);
      var card = h("div", { "class": "card checkpoint" });
      add(card, h("div", { "class": "checkpoint-head" },
        h("h3", null, (i === 0 ? "Next checkpoint: " : "Then: ") + (b.version || "") + " " + (b.name || "").toLowerCase()),
        h("span", { "class": "tiny" }, n(b.done_count) + " of " + n(items.length) + " done")));
      if (b.definition) add(card, h("p", { "class": "small muted", style: "margin-top:6px" }, b.definition));
      if (isObj(b.estimate)) {
        add(card, h("p", { "class": "small", style: "margin-top:8px" }, "Rough date ", h("b", null, range(b.estimate)), estTag(), " " + countdown(b.estimate)));
        if (b.estimate.assumes) add(card, h("p", { "class": "tiny", style: "margin-top:4px" }, "Assumes: " + b.estimate.assumes));
      }
      add(card, minimeter(items.length ? (b.done_count || 0) / items.length : 0));
      var ul = h("ul", { "class": "checklist" });
      items.forEach(function (it) {
        add(ul, h("li", { "class": it.done ? "ok" : "todo" }, icon(it.done ? "check" : "dash"), h("div", null,
          h("span", { "class": "sr-only" }, it.done ? "Done: " : "Not yet: "), it.text || "",
          it.auto ? h("div", { "class": "auto" }, it.auto_met ? "Checked from the numbers: met." : "Checked from the numbers at every update.") : null)));
      });
      var det = detailsEl("check-" + (b.version || i), i === 0);
      add(det, [h("summary", { "class": "tiny" }, "Checklist"), ul]);
      add(card, det);
      add(grid, card);
    });
    if (grid.firstChild) add(box, grid);
  }

  // ------------------------------------------------------------------ the crew roster
  function renderCrew() {
    var box = clear($("crew-body"));
    CREW.forEach(function (c) {
      var m = crewModel(c), key = "crew-" + c.id, open = !!S.ui.open[key];
      var card = h("article", { "class": "card crew-card", "aria-labelledby": "crew-name-" + c.id });
      var panelId = "crew-panel-" + c.id;
      var btn = h("button", { type: "button", "class": "crew-head", id: "crew-btn-" + c.id, "aria-expanded": open ? "true" : "false", "aria-controls": panelId },
        avatar(c),
        h("span", { "class": "crew-name", id: "crew-name-" + c.id }, c.name),
        lightEl(m.light),
        h("span", { "class": "crew-job" }, c.sub),
        icon("chev", "chev"));
      add(card, [btn, h("p", { "class": "crew-role" }, c.role)]);
      var dl = h("dl", { "class": "crew-stats" });
      m.rows.forEach(function (r) { add(dl, h("div", null, h("dt", null, r[0]), h("dd", null, r[1]))); });
      add(card, dl);
      var panel = h("div", { "class": "crew-panel", id: panelId, hidden: !open });
      if (m.line) {
        var lt = ms(m.lineAt);
        add(panel, [h("p", { "class": "panel-label" }, "Latest status line"),
          h("p", { "class": "statusline" }, m.line, lt ? h("time", { datetime: new Date(lt).toISOString() }, when(lt)) : null)]);
      }
      if (m.spark) {
        var pts = series(m.spark.key);
        add(panel, [h("p", { "class": "panel-label" }, m.spark.label + " · trend"), sparkline(c.id + "-" + m.spark.key, pts, m.spark)]);
      }
      if (m.facts.length) {
        var kv = h("dl", { "class": "kv" });
        m.facts.forEach(function (f) { add(kv, [h("dt", null, f[0]), h("dd", null, f[1])]); });
        add(panel, [h("p", { "class": "panel-label" }, "Details"), kv]);
      }
      m.notes.forEach(function (t) { add(panel, h("p", { "class": "tiny" }, t)); });
      add(card, panel);
      btn.addEventListener("click", function () {
        var now = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", now ? "true" : "false");
        panel.hidden = !now;
        S.ui.open[key] = now;
        if (now) requestAnimationFrame(drawCharts);
      });
      add(box, card);
    });
  }

  // ------------------------------------------------------------------ collection
  function queueTile(c, label, value, unit, sr) {
    var card = h("div", { "class": "card" });
    add(card, h("p", { "class": "tile-label" }, avatar(c, true), label));
    add(card, h("p", { "class": "tile-value" }, n(value), " ", h("small", null, unit)));
    var d = sr.length ? deltaFrom(sr, Date.now() - 6 * 3600000) : null;
    if (d && d.last && d.from < d.last.t) {
      var cls = d.d < 0 ? "good" : d.d > 0 ? "bad" : "flat";
      add(card, h("p", { "class": "delta " + cls }, icon(d.d < 0 ? "down" : d.d > 0 ? "up" : "dash"),
        sgn(d.d) + " " + (d.partial ? sinceWord(d) : "in the last 6 hours")));
    }
    add(card, sparkline("q-" + c.id, sr, { label: label, unit: unit }));
    return card;
  }
  function renderCollection() {
    var box = clear($("collection-body")), s = st(), col = isObj(s.collection) ? s.collection : {};
    var cv = coverage(), pl = isObj(col.paper_list) ? col.paper_list : {};
    var hero = h("div", { "class": "card" });
    if (cv.known) {
      var pm = 100 * cv.measured / cv.goal, pc = isNum(cv.core) ? 100 * cv.core / cv.goal : 0, pleft = Math.max(0, 100 - pm - pc);
      add(hero, [h("h3", null, "Papers with a text"),
        h("p", { "class": "tiny", style: "margin-top:8px" }, "At least"),
        h("p", { "class": "hero-fig" }, n(cv.lb)),
        h("p", { "class": "hero-cap" }, pct(100 * cv.lb / cv.goal) + " of the " + n(cv.goal) + " papers on our list" +
          (isNum(pl.journals) ? " (" + n(pl.journals) + " journals)" : "") + ". That is " + n(cv.measured) + " counted on " + dayOf(cv.at) +
          (isNum(cv.core) ? ", plus " + n(cv.core) + " papers the CORE Scout has found a text for since. Every paper it searches had no text at that count, so the two add up." : "."))]);
      var seg = h("div", { "class": "seg", role: "group", "aria-label": "Papers with a text: " + n(cv.measured) + " counted on " + dayOf(cv.at) +
        (isNum(cv.core) ? ", " + n(cv.core) + " found since by the CORE Scout" : "") + ", at most " + n(cv.left) + " still without one, of " + n(cv.goal) + "." });
      var c = chartHolder();
      var parts = [["p-measured", pm, "Counted on " + dayOf(cv.at), cv.measured], ["p-core", pc, "Found since by the CORE Scout", cv.core],
        ["p-left", pleft, "No text yet (at most)", cv.left]];
      parts.forEach(function (p) {
        if (!(p[1] > 0)) return;
        var el = h("div", { "class": "seg-part " + p[0], style: "flex:" + p[1].toFixed(4) + " 1 0", tabindex: "0",
          "aria-label": p[2] + ": " + n(p[3]) + " (" + pct(p[1]) + ")" });
        if (p[1] >= 11) add(el, p[0] === "p-left" ? pct(p[1]) + " to go" : pct(p[1]));
        function show() {
          var hr = c.holder.getBoundingClientRect(), r = el.getBoundingClientRect();
          showTip(c.tip, hr.width, r.left - hr.left + r.width / 2, r.top - hr.top, [h("b", null, n(p[3])), " papers · " + pct(p[1]), h("br"), p[2]]);
        }
        el.addEventListener("pointerenter", show);
        el.addEventListener("focus", show);
        el.addEventListener("pointerleave", function () { c.tip.hidden = true; });
        el.addEventListener("blur", function () { c.tip.hidden = true; });
        add(seg, el);
      });
      c.holder.insertBefore(seg, c.tip);
      add(hero, c.holder);
      add(hero, h("ul", { "class": "legend" },
        h("li", null, h("span", { "class": "sw p-measured" }), "Counted on " + dayOf(cv.at)),
        isNum(cv.core) ? h("li", null, h("span", { "class": "sw p-core" }), "Found since by the CORE Scout") : null,
        h("li", null, h("span", { "class": "sw p-left" }), "No text yet")));
      var hq = g(job("harvest"), "queue.texts_this_run"), sf = s2Found();
      add(hero, h("p", { "class": "tiny", style: "margin-top:10px" }, "Not added yet, because they may repeat papers already counted: " +
        (isNum(hq) ? "the Harvester's " + n(hq) + " texts from its gaps queue this run" : "the Harvester's new finds") +
        (sf && isNum(sf.abstracts) ? " and the Diver's " + n(sf.abstracts) + " abstracts" : "") +
        ". The exact count is made again when the collection ends."));
      add(hero, tableView("coverage", "Papers with a text", ["Part", "Papers", "Share"], [
        ["Counted on " + dayOf(cv.at), n(cv.measured), pct(pm)],
        ["Found since by the CORE Scout", n(cv.core), pct(pc)],
        ["No text yet (at most)", n(cv.left), pct(pleft)],
        ["The paper list", n(cv.goal), "100%"]]));
    } else {
      add(hero, [h("h3", null, "Papers with a text"), h("p", { "class": "placeholder" }, "The measured count is not in this status file yet.")]);
    }
    add(box, hero);

    // each crew member's haul
    var haul = h("div", { "class": "card", style: "margin-top:12px" });
    add(haul, [h("h3", null, "Each crew member's haul"),
      h("p", { "class": "tiny" }, "In each one's own unit. They overlap: one paper can have a text from several sources, which is why the haul adds up to more than the count above.")]);
    var ul = h("ul", { "class": "haul" });
    function row(c, what) { add(ul, h("li", null, avatar(c, true), h("span", { "class": "who" }, c.name), h("span", { "class": "what" }, what))); }
    var sto = isObj(col.store) ? col.store : {}, oa = isObj(col.openalex) ? col.openalex : null;
    if (isNum(sto.with_text)) row(CREW_BY.harvest, [h("b", null, n(sto.with_text)), " record lines with a text in the main store, of " + n(sto.lines) + " (before de-duplication)"]);
    var cf = coreFound();
    if (isNum(cf)) row(CREW_BY.core, [h("b", null, n(cf)), " papers with a text, each one newly covered"]);
    var sf2 = s2Found();
    if (sf2) row(CREW_BY.s2, [h("b", null, n(sf2.abstracts)), " papers with an abstract and ", h("b", null, n(sf2.full)), " with a full text"]);
    if (oa) row(CREW_BY.openalex, [h("b", null, n(oa.with_text)), " papers with a text, " + n(oa.with_abstract) + " of them abstracts"]);
    var fac = arr(col.side_stores).filter(function (x) { return isObj(x) && x.source === "faculty"; })[0];
    if (fac) row(CREW_BY.faculty, [h("b", null, n(fac.lines)), " records from " + n(fac.files) + " repositories"]);
    add(haul, ul);
    add(box, haul);

    // queues with their trend
    var tiles = h("div", { "class": "tiles", style: "margin-top:12px" });
    var hv = job("harvest"), co = job("core");
    if (hv && isObj(hv.queue) && isNum(hv.queue.left)) add(tiles, queueTile(CREW_BY.harvest, "The Harvester's gaps queue", hv.queue.left, "papers left", series("h_left")));
    if (co && isObj(co.progress) && isNum(co.progress.total) && isNum(co.progress.done)) {
      var tot = co.progress.total;
      add(tiles, queueTile(CREW_BY.core, "The CORE Scout's list", tot - co.progress.done, "papers to look up",
        series("c_done").map(function (p) { return { t: p.t, v: tot - p.v }; })));
    }
    if (tiles.firstChild) add(box, tiles);

    // finish lines
    var rows = [];
    function marks(j) {
      var out = [];
      if (j && isObj(j.eta) && ms(j.eta.at) !== null) out.push({ t: ms(j.eta.at), kind: "own", note: j.eta.basis || "" });
      if (j && isObj(j.eta_alt) && ms(j.eta_alt.at) !== null) out.push({ t: ms(j.eta_alt.at), kind: "alt", note: j.eta_alt.basis || "" });
      return out;
    }
    if (hv && hv.state !== "finished") rows.push({ crew: CREW_BY.harvest, label: "The Harvester (gaps queue)", marks: marks(hv) });
    if (co && co.state !== "finished") rows.push({ crew: CREW_BY.core, label: "The CORE Scout", marks: marks(co) });
    var est = estimate("collection");
    var band = est && ymdMs(est.from) !== null && ymdMs(est.to, true) !== null ? { a: ymdMs(est.from), b: ymdMs(est.to, true), label: "Roadmap: " + (est.what || "collection finishes") } : null;
    if (rows.some(function (r) { return r.marks.length; }) || band) {
      var fc = h("div", { "class": "card", style: "margin-top:12px" });
      add(fc, [h("h3", null, "Finish lines", estTag()),
        h("p", { "class": "tiny" }, "When each lane should empty its queue at its current pace, beside the roadmap's range. All of these are estimates and move with the pace.")]);
      add(fc, finishChart(rows, band));
      add(fc, h("ul", { "class": "finish-legend" },
        h("li", null, h("span", { "class": "dot", style: "--crew:var(--ink-2)" }), "from its current pace"),
        h("li", null, h("span", { "class": "ring-dot", style: "--crew:var(--ink-2)" }), "from the last hours' trend"),
        band ? h("li", null, h("span", { "class": "sw p-left" }), "the roadmap's range") : null));
      var trows = [];
      rows.forEach(function (r) { r.marks.forEach(function (mk) { trows.push([r.label, dayOf(mk.t) + " (" + relMs(mk.t) + ")", mk.note]); }); });
      if (band) trows.push([band.label, dayOf(band.a) + " – " + dayOf(band.b), est.assumes || ""]);
      add(fc, tableView("finish", "Finish-line estimates", ["Lane", "Date", "Basis"], trows));
      add(box, fc);
    }
  }
  function finishChart(rows, band) {
    var c = chartHolder("finish");
    S.charts.push({ el: c.holder, draw: function (W) { drawFinish(c.holder, c.tip, rows, band, W); } });
    return c.holder;
  }
  function drawFinish(holder, tip, rows, band, W) {
    var old = holder.querySelector("svg");
    if (old) holder.removeChild(old);
    var now = Date.now(), t0 = midnight(), tmax = now + 7 * 864e5;
    rows.forEach(function (r) { r.marks.forEach(function (mk) { tmax = Math.max(tmax, mk.t); }); });
    if (band) tmax = Math.max(tmax, band.b);
    var t1 = tmax + 3 * 864e5, L = 8, R = 14, top = 20, rowH = 46, axisH = 24;
    var H = top + (rows.length + (band ? 1 : 0)) * rowH + axisH;
    function X(t) { return L + (W - L - R) * (t - t0) / (t1 - t0); }
    var labels = [];
    rows.forEach(function (r) { r.marks.forEach(function (mk) { labels.push(r.label + " " + dayOf(mk.t)); }); });
    var svg = sv("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "Finish-line estimates: " + (labels.join("; ") || "none") + (band ? "; " + band.label + " " + dayOf(band.a) + " to " + dayOf(band.b) : "") + ". The table below has every date and its basis." });
    var span = (t1 - t0) / 864e5, stepDays = span <= 45 ? 7 : span <= 120 ? 14 : 30;
    for (var t = t0 + stepDays * 864e5; t < t1; t += stepDays * 864e5) {
      var x = X(t);
      svg.appendChild(sv("line", { "class": "gridline", x1: x, x2: x, y1: top - 4, y2: H - axisH }));
      var tx = sv("text", { x: x, y: H - 7, "text-anchor": "middle" });
      tx.textContent = dayOf(t);
      if (x > 24 && x < W - 24) svg.appendChild(tx);
    }
    svg.appendChild(sv("line", { "class": "baseline", x1: L, x2: W - R, y1: H - axisH + 0.5, y2: H - axisH + 0.5 }));
    var xn = X(now);
    svg.appendChild(sv("line", { "class": "today", x1: xn, x2: xn, y1: top - 10, y2: H - axisH }));
    var tt = sv("text", { x: xn + 4, y: top - 10 + 9 });
    tt.textContent = "today";
    svg.appendChild(tt);
    function hit(x, y, parts, label) {
      var el = sv("circle", { "class": "hit", cx: x, cy: y, r: 14, tabindex: "0", role: "img", "aria-label": label });
      function show() { showTip(tip, W, x, y - 6, parts); }
      el.addEventListener("pointerenter", show);
      el.addEventListener("pointerdown", show);
      el.addEventListener("focus", show);
      el.addEventListener("pointerleave", function () { tip.hidden = true; });
      el.addEventListener("blur", function () { tip.hidden = true; });
      return el;
    }
    var y = top;
    rows.forEach(function (r) {
      var lab = sv("text", { "class": "rowlabel", x: L, y: y + 12 });
      lab.textContent = r.label;
      svg.appendChild(lab);
      var ly = y + 28;
      svg.appendChild(sv("line", { "class": "gridline", x1: L, x2: W - R, y1: ly, y2: ly }));
      r.marks.slice().sort(function (a, b) { return a.kind === "alt" ? -1 : 1; }).forEach(function (mk) {
        var x = X(mk.t), col = "var(--c" + r.crew.slot + ")";
        var dot = mk.kind === "own" ? sv("circle", { "class": "mark-own", cx: x, cy: ly, r: 6.5, style: "fill:" + col })
          : sv("circle", { "class": "mark-alt", cx: x, cy: ly, r: 6, style: "stroke:" + col });
        svg.appendChild(dot);
        var txt = r.label + ": " + dayOf(mk.t) + ", " + relMs(mk.t) + " (" + (mk.kind === "own" ? "from its current pace" : "from the last hours' trend") + ")";
        svg.appendChild(hit(x, ly, [h("b", null, dayOf(mk.t)), " · " + relMs(mk.t), h("br"), r.label, h("br"), mk.note], txt));
      });
      if (!r.marks.length) {
        var nt = sv("text", { x: L, y: ly + 4 });
        nt.textContent = "no estimate this update";
        svg.appendChild(nt);
      }
      y += rowH;
    });
    if (band) {
      var lab2 = sv("text", { "class": "rowlabel", x: L, y: y + 12 });
      lab2.textContent = band.label;
      svg.appendChild(lab2);
      var x1 = X(band.a), x2 = X(band.b), by = y + 22;
      svg.appendChild(sv("rect", { "class": "band-est", x: x1, y: by, width: Math.max(4, x2 - x1), height: 12, rx: 6 }));
      if (x2 - x1 > 70) {
        var bt = sv("text", { "class": "band-text", x: (x1 + x2) / 2, y: by + 9.5, "text-anchor": "middle" });
        bt.textContent = "estimate";
        svg.appendChild(bt);
      }
      var hb = sv("rect", { "class": "hit", x: x1, y: by - 8, width: Math.max(24, x2 - x1), height: 28, tabindex: "0", role: "img",
        "aria-label": band.label + ": " + dayOf(band.a) + " to " + dayOf(band.b) + " (an estimate)" });
      function showB() { showTip(tip, W, (x1 + x2) / 2, by - 4, [h("b", null, dayOf(band.a) + " – " + dayOf(band.b)), h("br"), band.label]); }
      hb.addEventListener("pointerenter", showB);
      hb.addEventListener("pointerdown", showB);
      hb.addEventListener("focus", showB);
      hb.addEventListener("pointerleave", function () { tip.hidden = true; });
      hb.addEventListener("blur", function () { tip.hidden = true; });
      svg.appendChild(hb);
    }
    holder.insertBefore(svg, tip);
  }

  // ------------------------------------------------------------------ labels
  function renderLabels() {
    var box = clear($("labels-body")), s = st(), tx = g(s, "labels.taxonomy") || {};
    if (isObj(tx) && (isNum(tx.leaves) || tx.version)) {
      add(box, h("p", { "class": "taxo" },
        h("span", null, h("b", null, n(tx.leaves)), "subjects"),
        h("span", null, h("b", null, n(tx.groups)), "groups"),
        h("span", null, "taxonomy " + (tx.version || "") + (tx.date ? ", released " + ymd(tx.date) : ""))));
    }
    var runs = h("div", { "class": "runs" });
    var order = [["coding_dev", "DEV", "Chooses the model: three coders and an adjudicator per batch."],
      ["coding_s1", "Silver S1", "Training labels: one coder per paper."],
      ["coding_test", "TEST", "The final exam: sealed until the end, so only counts are shown."]];
    order.forEach(function (o) {
      var j = job(o[0]);
      if (!j) return;
      var pr = isObj(j.progress) ? j.progress : {}, frac = isNum(pr.total) && pr.total > 0 ? pr.done / pr.total : 0;
      var isNow = j.state === "running" || (o[0] === "coding_s1" && j.expected === "running");
      var card = h("div", { "class": "card" });
      var top = h("div", { "class": "run-top" },
        ring(frac, pct(100 * frac, frac > 0 && frac < 0.1 ? 1 : 0), "units", o[1] + ": " + n(pr.done) + " of " + n(pr.total) + " units (" + pct(100 * frac) + ")"),
        h("div", null,
          h("p", { "class": "run-name" }, o[1], " ", isNow && j.state !== "finished" ? h("span", { "class": "here" }, "Now") : null),
          h("p", { "class": "run-facts" }, h("b", null, n(pr.done)), " of " + n(pr.total) + " units"),
          h("p", { style: "margin-top:4px" }, lightEl(lightFor(j.state === "idle" ? "idle" : j.state, j.health, j.state === "idle" ? "Between windows" : null))),
          o[0] === "coding_test" ? h("p", { style: "margin-top:6px" }, h("span", { "class": "sealed" }, icon("lock"), "Sealed: counts only")) : null));
      add(card, top);
      add(card, h("p", { "class": "small muted", style: "margin-top:10px" }, o[2]));
      var day = rateValue(j, "units (last 24 h)");
      var facts = h("p", { "class": "tiny", style: "margin-top:6px" });
      if (isNum(day)) add(facts, n(day) + " units in the last 24 hours");
      if (j.last_activity) add(facts, (isNum(day) ? " · last unit " : "Last unit ") + relMs(ms(j.last_activity)));
      if (facts.firstChild) add(card, facts);
      if (o[0] === "coding_s1" && isNum(pr.total)) {
        var sp = step("p2-s1"), per = sp && typeof sp.needs === "string" ? /about (\d+) units a window/.exec(sp.needs) : null;
        if (per && pr.total > pr.done) {
          add(card, h("p", { "class": "tiny", style: "margin-top:4px" }, "About " + n1(Math.round(10 * (pr.total - pr.done) / Number(per[1])) / 10) +
            " more five-hour windows at about " + per[1] + " units a window", estTag()));
        }
      }
      if (isObj(j.estimate) && j.state !== "finished") add(card, h("p", { "class": "tiny", style: "margin-top:4px" }, "Done by ", h("b", null, range(j.estimate)), estTag()));
      var stg = h("div", { "class": "stages" });
      arr(j.stages).filter(isObj).forEach(function (sg) {
        add(stg, meter(sg.done || 0, sg.total || 0, "units, stage " + (sg.stage || "") + " (" + n(sg.batches) + " batches, " + n(sg.n_coders) +
          " coder" + (sg.n_coders === 1 ? "" : "s") + (sg.adjudicated ? " + adjudicator" : "") + ")", sg.ready === false ? "waits" : null));
      });
      if (stg.firstChild) {
        var det = detailsEl("stages-" + o[0], false);
        add(det, [h("summary", { "class": "tiny" }, "Stages"), stg]);
        add(card, det);
      }
      add(card, sparkline("lab-" + o[0], series(j.spark || ""), { label: o[1] + " units done", unit: "units", height: 48 }));
      add(runs, card);
    });
    add(box, runs);
  }

  // ------------------------------------------------------------------ model lab
  var ARCH_GLYPH = { clark: "rank", ulmfit: "lstm", gan: "gan", graph: "graph" };
  function renderLab() {
    var box = clear($("lab-body")), M = isObj(st().model) ? st().model : {};
    var grid = h("div", { "class": "arch-grid" });
    arr(M.architectures).filter(isObj).forEach(function (a) {
      add(grid, h("div", { "class": "card arch" },
        h("div", { "class": "arch-icon", "aria-hidden": "true" }, glyph(ARCH_GLYPH[a.id] || "flask")),
        h("h3", null, a.name || a.id || ""),
        h("p", null, a.about || ""),
        h("div", { "class": "chips" },
          a.built ? h("span", { "class": "chip ok" }, icon("check"), "Built and tested") : h("span", { "class": "chip" }, "Being built"),
          a.trained_on_real_labels ? h("span", { "class": "chip ok" }, icon("check"), "Trained, " + n(a.trained_runs) + " runs")
            : h("span", { "class": "chip" }, "Not trained on real labels yet"))));
    });
    if (grid.firstChild) add(box, grid);
    var t = M.tests, c = isObj(M.contest) ? M.contest : {};
    var two = h("div", { "class": "grid2", style: "margin-top:12px" });

    // the preview model
    var pv = isObj(M.preview) ? M.preview : {}, pj = job("preview") || {};
    var pcard = h("div", { "class": "card" });
    add(pcard, h("div", { "class": "checkpoint-head" }, h("h3", null, "Preview model"), lightEl(lightFor(pj.state || "unknown", pj.health))));
    add(pcard, h("p", { "class": "small muted", style: "margin-top:4px" },
      "A quick model on embeddings already on disk, so tags can be tried now. Never a contest entry. " +
      (pv.page_code ? "Its test page runs on the PI's Mac (localhost:" + (isNum(pv.port) ? pv.port : 8765) + ")." : "Its local test page is still being built.")));
    var nb = isObj(pv.numbers) ? pv.numbers : null;
    if (nb && arr(nb.measures).length) {
      add(pcard, h("p", { "class": "tiny", style: "margin-top:8px" }, "Cross-fitted estimates on " + n(nb.n_papers) + " DEV papers" +
        (nb.subset ? " (" + nb.subset + ")" : "") + ", with 95% intervals" + (nb.made ? ", measured " + dayOf(ms(nb.made)) : "") + ". Never the paper's numbers."));
      var ms_ = h("div", { "class": "measures" });
      var trows = [];
      arr(nb.measures).filter(isObj).forEach(function (m) {
        if (!isNum(m.v)) return;
        var lo = isNum(m.lo) ? m.lo : null, hi = isNum(m.hi) ? m.hi : null;
        add(ms_, h("div", { "class": "measure" },
          h("div", { "class": "measure-head" }, h("span", null, m.k || ""),
            h("span", null, h("b", null, share(m.v)), lo !== null && hi !== null ? h("span", { "class": "ci" }, share(lo) + "–" + share(hi)) : null)),
          h("div", { "class": "measure-track", "aria-hidden": "true" },
            h("div", { "class": "measure-fill", style: "width:" + (100 * clamp01(m.v)).toFixed(2) + "%" }),
            lo !== null && hi !== null ? h("div", { "class": "measure-ci", style: "left:" + (100 * clamp01(lo)).toFixed(2) + "%;width:" + (100 * Math.max(0, clamp01(hi) - clamp01(lo))).toFixed(2) + "%" }) : null)));
        trows.push([m.k || "", share(m.v), lo !== null ? share(lo) + " – " + share(hi) : ""]);
      });
      add(pcard, ms_);
      if (isObj(nb.after_choice) && isNum(nb.after_choice.v)) {
        add(pcard, h("p", { "class": "tiny", style: "margin-top:10px" }, (nb.after_choice.k || "After choosing") + ": ", h("b", null, share(nb.after_choice.v)),
          isNum(nb.after_choice.sd) ? " (sd " + share(nb.after_choice.sd) + ")" : "", isNum(nb.rows_tried) ? ", after " + n(nb.rows_tried) + " variants were tried." : "."));
      }
      add(pcard, tableView("preview", "Preview model on DEV", ["Measure", "Estimate", "95% interval"], trows));
    } else {
      add(pcard, h("p", { "class": "placeholder" }, "No preview numbers yet."));
    }
    add(two, pcard);

    // what happens next
    var nx = h("div", { "class": "card" });
    add(nx, h("h3", null, "What happens next"));
    add(nx, h("p", { "class": "tiny", style: "margin-top:4px" },
      (t && isNum(t.passed) ? n(t.passed) + " tests pass (last recorded run " + dayOf(ms(t.as_of)) + "). " : "") +
      "The contest: " + (c.status || "not started") + "; " + n(c.runs) + " training runs and " + n(c.checkpoints) + " checkpoints so far."));
    var pl = h("ol", { "class": "pipeline", style: "margin-top:10px" });
    ["p3-train", "p3-choose", "p3-tag"].forEach(function (id, i) {
      var x = step(id);
      if (!x) return;
      var e = i === 0 ? estimate("training") : null;
      add(pl, h("li", { "class": x.status === "running" ? "now" : null }, h("div", null,
        h("p", { "class": "p-title" }, x.name || id, x.status === "done" ? h("span", { "class": "est" }, "done") : null),
        x.needs ? h("p", { "class": "p-note" }, "Needs: " + x.needs) : null,
        e ? h("p", { "class": "p-note" }, range(e), estTag()) : null)));
    });
    var be = isObj(st().beta) ? st().beta : null;
    if (be) add(pl, h("li", null, h("div", null, h("p", { "class": "p-title" }, "Then the " + (be.version || "beta") + " beta"),
      isObj(be.estimate) ? h("p", { "class": "p-note" }, range(be.estimate), estTag()) : null)));
    add(nx, pl);
    add(two, nx);
    add(box, two);
  }

  // ------------------------------------------------------------------ mission log
  var KINDS = [
    { id: "all", label: "All" },
    { id: "new", label: "New since your visit" },
    { id: "milestone", label: "Milestones", k: ["milestone"] },
    { id: "startstop", label: "Starts and stops", k: ["start", "stop"] },
    { id: "progress", label: "Progress", k: ["progress"] },
    { id: "alert", label: "Alerts", k: ["alert"] },
    { id: "notes", label: "Notes and relay", k: ["note", "updater", "log"] }
  ];
  var KIND_ICON = { milestone: "flag", start: "play", stop: "stop", progress: "up", alert: "alert", note: "note", updater: "relay", log: "dot" };
  var KIND_WORD = { milestone: "Milestone", start: "Start", stop: "Stop", progress: "Progress", alert: "Alert", note: "Note", updater: "Relay", log: "Log entry" };
  function baselineT() { var b = S.baseline; return b ? (ms(b.gen) || b.seenAt || null) : null; }
  function renderLog() {
    var box = clear($("log-body")), evs = events(), bt = baselineT();
    if (!evs.length) { add(box, h("p", { "class": "placeholder" }, "No log entries in this status file yet.")); return; }
    if (S.ui.logKind === "new" && bt === null) S.ui.logKind = "all";
    function crewMatch(e) { if (S.ui.logCrew === "all") return true; var c = crewOfJob(e.job); return c ? c.id === S.ui.logCrew : S.ui.logCrew === "other"; }
    function kindMatch(e, kid) {
      if (kid === "all") return true;
      if (kid === "new") return bt !== null && ms(e.t) > bt;
      var k = KINDS.filter(function (x) { return x.id === kid; })[0];
      return k && k.k ? k.k.indexOf(e.kind) >= 0 : false;
    }
    var filters = h("div", { "class": "filters", role: "group", "aria-label": "Show log entries" });
    KINDS.forEach(function (k) {
      if (k.id === "new" && bt === null) return;
      var count = evs.filter(function (e) { return crewMatch(e) && kindMatch(e, k.id); }).length;
      if (!count && k.id !== "all" && k.id !== S.ui.logKind) return;
      add(filters, h("button", { type: "button", "class": "fbtn", "aria-pressed": S.ui.logKind === k.id ? "true" : "false", id: "log-f-" + k.id,
        onclick: function () { S.ui.logKind = k.id; S.ui.logShown = 16; renderLog(); var b = $("log-f-" + k.id); if (b) b.focus(); } },
        k.label, h("span", { "class": "count" }, n(count))));
    });
    var present = {};
    evs.forEach(function (e) { var c = crewOfJob(e.job); present[c ? c.id : "other"] = true; });
    var sel = h("select", { id: "log-crew" });
    add(sel, h("option", { value: "all" }, "Everyone"));
    CREW.forEach(function (c) { if (present[c.id]) add(sel, h("option", { value: c.id }, c.name)); });
    if (present.other) add(sel, h("option", { value: "other" }, "Others"));
    sel.value = S.ui.logCrew;
    if (sel.value !== S.ui.logCrew) { S.ui.logCrew = "all"; sel.value = "all"; }
    sel.addEventListener("change", function () { S.ui.logCrew = sel.value; S.ui.logShown = 16; renderLog(); var s2 = $("log-crew"); if (s2) s2.focus(); });
    add(filters, h("label", { "class": "crew-select", "for": "log-crew" }, "Crew", sel));
    add(box, filters);

    var list = evs.filter(function (e) { return crewMatch(e) && kindMatch(e, S.ui.logKind); });
    if (!list.length) { add(box, h("p", { "class": "placeholder" }, "Nothing matches these filters.")); return; }
    var shown = list.slice(0, S.ui.logShown), day = null, group = null, ol = null;
    var today = midnight(), yest = today - 864e5;
    shown.forEach(function (e) {
      var t = ms(e.t), dd = new Date(t); dd.setHours(0, 0, 0, 0);
      var dk = dd.getTime();
      if (dk !== day) {
        day = dk;
        group = h("div", { "class": "log-group" });
        add(group, h("h3", { "class": "log-day" }, dk === today ? "Today" : dk === yest ? "Yesterday" : weekdayOf(t)));
        ol = h("ol", { "class": "log" });
        add(group, ol);
        add(box, group);
      }
      var c = crewOfJob(e.job), kind = typeof e.kind === "string" ? e.kind : "log", isNew = bt !== null && t > bt;
      add(ol, h("li", { "class": "ev k-" + kind + (isNew ? " is-new" : "") },
        h("time", { datetime: new Date(t).toISOString(), title: when(t) }, clockOf(t)),
        h("span", { "class": "ev-icon", "aria-hidden": "true" }, icon(KIND_ICON[kind] || "dot")),
        h("div", { "class": "ev-body" },
          h("span", { "class": "sr-only" }, (KIND_WORD[kind] || "Log entry") + (isNew ? ", new" : "") + ". "),
          h("span", { "class": "ev-who" }, crewDot(c), c ? c.short : "Mission"),
          isNew ? h("span", { "class": "new-tag", "aria-hidden": "true" }, "New") : null,
          e.text)));
    });
    if (list.length > shown.length) {
      add(box, h("div", { "class": "log-more" }, h("button", { type: "button", "class": "btn", id: "log-more",
        onclick: function () { S.ui.logShown += 20; renderLog(); var b = $("log-more"); if (b) b.focus(); } },
        "Show " + n(Math.min(20, list.length - shown.length)) + " more (" + n(list.length - shown.length) + " older)")));
    }
  }

  // ------------------------------------------------------------------ badges
  function badgeList() {
    var s = st(), out = [];
    function B(o) { o.family = o.family || o.id; out.push(o); }
    function stepDone(id) { var x = step(id); return !!(x && x.status === "done"); }
    function evAt(rx) {
      var best = null;
      events().forEach(function (e) { if (rx.test(e.text)) { var t = ms(e.t); if (best === null || t < best) best = t; } });
      return best;
    }
    function esc(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    var pl = g(s, "collection.paper_list") || g(s, "project.paper_list") || {};
    var tx = g(s, "labels.taxonomy") || {};
    var fa = job("faculty"), oa = job("openalex"), oaf = g(s, "collection.openalex"), dv = job("coding_dev"), s2 = job("s2");
    var pv = job("preview"), up = job("updater"), s1 = job("coding_s1"), te = job("coding_test"), hv = job("harvest"), co = job("core");
    var tests = g(s, "model.tests") || {};
    if (step("p1-list")) B({ id: "list", crew: "pi", glyph: "book", title: "The paper list", desc: n(pl.papers) + " papers in " + n(pl.journals) + " journals", earned: stepDone("p1-list") });
    if (tx.version) B({ id: "taxonomy", crew: "coders", glyph: "tag", title: "Taxonomy " + tx.version, desc: n(tx.leaves) + " subjects in " + n(tx.groups) + " groups", earned: stepDone("p2-tax") || !!tx.leaves, at: ymdMs(tx.date) });
    if (step("p2-pilot")) B({ id: "pilot", crew: "coders", glyph: "check", title: "Pilot coded", desc: firstSentence((step("p2-pilot") || {}).detail || "").replace(/\.$/, ""), earned: stepDone("p2-pilot") });
    if (fa) B({ id: "faculty", crew: "faculty", glyph: "library", title: "Repositories read", desc: "Every faculty repository on the list", earned: fa.state === "finished", at: ms(fa.last_activity) });
    if (oa) B({ id: "openalex", crew: "openalex", glyph: "map", title: "OpenAlex paired", desc: isObj(oaf) ? n(oaf.with_abstract) + " abstracts" : "", earned: oa.state === "finished", at: isObj(oaf) ? ms(oaf.at) : null });
    if (step("p3-arch")) B({ id: "arch", crew: "lab", glyph: "flask", title: "Four architectures built", desc: isNum(tests.passed) ? n(tests.passed) + " tests passing" : "", earned: stepDone("p3-arch"), at: ms(tests.as_of) });
    if (dv && isObj(dv.progress)) B({ id: "dev", crew: "coders", glyph: "check", title: "DEV complete", desc: n(dv.progress.total) + " units, three coders and an adjudicator", earned: dv.progress.done >= dv.progress.total && dv.progress.total > 0, at: evAt(/DEV coding complete/), prog: { done: dv.progress.done, total: dv.progress.total } });
    if (s2 && isObj(s2.progress)) B({ id: "s2", crew: "s2", glyph: "diver", title: "Deep dive done", desc: "All " + n(s2.progress.total) + " dataset parts read", earned: s2.progress.done >= s2.progress.total && s2.progress.total > 0, at: evAt(/Semantic Scholar: all \d+ full-text parts read/), prog: { done: s2.progress.done, total: s2.progress.total } });
    if (pv) B({ id: "preview", crew: "lab", glyph: "flask", title: "Preview model built", desc: "Tags can be tried now", earned: pv.state === "built" || pv.state === "serving", at: evAt(/Preview model built/) });
    if (up) { var live = evAt(/first push to GitHub/); B({ id: "live", crew: "relay", glyph: "antenna", title: "Mission control on air", desc: "The progress page went public", earned: live !== null || up.state === "running", at: live }); }
    var cdone = numv(g(co, "progress.done")), ctot = numv(g(co, "progress.total"));
    if (isNum(cdone)) {
      [10000, 25000, 50000, 100000, 200000, 300000].forEach(function (t) {
        if (isNum(ctot) && t >= ctot) return;
        B({ id: "core-" + t, family: "core", crew: "core", glyph: "scout", title: "CORE " + short(t), desc: n(t) + " papers looked up", earned: cdone >= t,
          at: evAt(new RegExp("CORE lane: " + esc(EN.format(t)) + " papers looked up")), prog: { done: cdone, total: t } });
      });
      if (isNum(ctot)) B({ id: "core-all", family: "core", crew: "core", glyph: "scout", title: "Every lead checked", desc: "All " + n(ctot) + " papers looked up", earned: cdone >= ctot, prog: { done: cdone, total: ctot } });
    }
    var sp = isObj(s1 && s1.progress) ? s1.progress : null;
    if (sp && isNum(sp.total) && sp.total > 0) {
      [25, 50, 75, 100].forEach(function (q) {
        var need = Math.ceil(sp.total * q / 100);
        B({ id: "s1-" + q, family: "s1", crew: "coders", glyph: "tag", title: q < 100 ? "Silver S1 " + q + "%" : "Silver S1 coded",
          desc: n(need) + " of " + n(sp.total) + " units", earned: sp.done >= need, at: evAt(new RegExp("Silver S1 coding passed " + q + "%")), prog: { done: sp.done, total: need } });
      });
    }
    var cv = coverage();
    if (cv.known) {
      [210000, 250000, 300000, 400000, 500000].forEach(function (t) {
        if (t >= cv.goal) return;
        B({ id: "texts-" + t, family: "texts", crew: null, glyph: "book", title: short(t) + " with a text", desc: "Papers with a text, counted as on this page", earned: cv.lb >= t, prog: { done: cv.lb, total: t } });
      });
    }
    var q = isObj(hv && hv.queue) ? hv.queue : null, hp = isObj(hv && hv.progress) ? hv.progress : null;
    if (q && isNum(q.left) && hp && isNum(hp.total)) {
      [200000, 150000, 100000, 50000, 0].forEach(function (t) {
        if (t >= hp.total) return;
        B({ id: "gaps-" + t, family: "gaps", crew: "harvest", glyph: "harvest", title: t ? "Gaps queue under " + short(t) : "Gaps queue empty",
          desc: "The Harvester's queue of papers without a text", earned: t ? q.left < t : q.left === 0, prog: { done: hp.total - q.left, total: hp.total - t } });
      });
    }
    var stw = numv(g(s, "collection.store.with_text"));
    if (isNum(stw)) {
      [150000, 175000, 200000, 250000].forEach(function (t) {
        B({ id: "store-" + t, family: "store", crew: "harvest", glyph: "stack", title: short(t) + " store texts", desc: "Record lines with a text in the main store", earned: stw >= t, prog: { done: stw, total: t } });
      });
    }
    function autoMet(b, key) { var it = arr(b && b.checklist).filter(function (x) { return isObj(x) && x.auto === key; })[0]; return !!(it && (it.done || it.auto_met)); }
    function itemDone(b, rx) { var it = arr(b && b.checklist).filter(function (x) { return isObj(x) && rx.test(x.text || ""); })[0]; return !!(it && it.done); }
    var tp = isObj(te && te.progress) ? te.progress : null;
    if (te) B({ id: "test", crew: "coders", glyph: "check", title: "TEST coded", desc: "Sealed until the final score", earned: autoMet(s.v1, "test_complete"), prog: tp ? { done: tp.done, total: tp.total } : null });
    var c = g(s, "model.contest") || {};
    B({ id: "contest", crew: "lab", glyph: "flask", title: "Contest training started", desc: "The four architectures trained on silver S1", earned: (isNum(c.runs) && c.runs > 0) || !!c.training_now });
    B({ id: "winner", crew: "lab", glyph: "trophy", title: "Winner chosen", desc: "By the registered rule, on DEV", earned: itemDone(s.beta, /Winner chosen/i) });
    if (isObj(s.beta)) B({ id: "beta", crew: null, glyph: "flag", title: (s.beta.version || "") + " beta", desc: "The product the PI audits", earned: arr(s.beta.checklist).length > 0 && s.beta.done_count >= arr(s.beta.checklist).length, prog: { done: s.beta.done_count, total: arr(s.beta.checklist).length } });
    if (isObj(s.v1)) {
      B({ id: "collection", crew: "harvest", glyph: "stack", title: "Collection finished", desc: "The harvest and the CORE lane both done", earned: autoMet(s.v1, "collection_done") });
      B({ id: "v1", crew: null, glyph: "trophy", title: (s.v1.version || "") + " public release", desc: "TEST numbers, the paper, the public tags", earned: arr(s.v1.checklist).length > 0 && s.v1.done_count >= arr(s.v1.checklist).length, prog: { done: s.v1.done_count, total: arr(s.v1.checklist).length } });
    }
    return out;
  }
  function earnedIds() { return badgeList().filter(function (b) { return b.earned; }).map(function (b) { return b.id; }); }
  function badgeEl(b, fresh) {
    var c = b.crew ? CREW_BY[b.crew] : null;
    var el = h("div", { "class": "badge " + (b.earned ? "earned" : "locked") + (fresh ? " fresh glow" : "") });
    el.style.setProperty("--crew", c ? crewVar(c) : "var(--accent)");
    add(el, h("div", { "class": "hex", "aria-hidden": "true" },
      sv("svg", { "class": "hex-frame", viewBox: "0 0 52 56" }, sv("path", { "class": "hf", d: "M26 3 47 15V41L26 53 5 41V15Z" })),
      glyph(b.glyph)));
    add(el, h("p", { "class": "badge-title" }, fresh ? h("span", { "class": "new-tag" }, "New") : null, b.title));
    if (b.desc) add(el, h("p", { "class": "badge-desc" }, b.desc));
    if (b.earned) add(el, h("p", { "class": "badge-when" }, b.at ? "Earned " + dayOf(b.at) : "Earned"));
    else if (b.prog && isNum(b.prog.done) && isNum(b.prog.total) && b.prog.total > 0) {
      var f = clamp01(b.prog.done / b.prog.total);
      add(el, [h("p", { "class": "badge-when" }, h("span", { "class": "sr-only" }, "Not yet earned. "), pct(100 * f, 0) + " of the way · " + n(b.prog.done) + " of " + n(b.prog.total)), minimeter(f)]);
    } else add(el, h("p", { "class": "badge-when" }, "Not yet"));
    return el;
  }
  function renderBadges() {
    var box = clear($("badges-body")), all = badgeList();
    var fresh = {};
    if (S.since && S.since.newBadges) S.since.newBadges.forEach(function (id) { fresh[id] = true; });
    var earned = all.filter(function (b) { return b.earned; }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    var fams = {}, next = [], later = [];
    all.forEach(function (b) {
      if (b.earned || fams[b.family]) return;
      fams[b.family] = true;
      if (b.prog && isNum(b.prog.done) && isNum(b.prog.total) && b.prog.total > 0) next.push(b); else later.push(b);
    });
    next.sort(function (a, b) { return (b.prog.done / b.prog.total) - (a.prog.done / a.prog.total); });
    var groups = h("div", { "class": "badge-groups" });
    if (earned.length) {
      var g1 = h("div", null, h("h3", null, "Earned (" + n(earned.length) + ")"));
      var gr = h("div", { "class": "badge-grid" });
      earned.forEach(function (b) { add(gr, badgeEl(b, !!fresh[b.id])); });
      add(g1, gr);
      add(groups, g1);
    }
    if (next.length) {
      var g2 = h("div", null, h("h3", null, "Next up"));
      var gr2 = h("div", { "class": "badge-grid" });
      next.slice(0, 8).forEach(function (b) { add(gr2, badgeEl(b, false)); });
      add(g2, gr2);
      add(groups, g2);
    }
    if (later.length) {
      add(groups, h("div", null, h("h3", null, "Further along the map"),
        h("div", { "class": "later" }, later.map(function (b) { return h("span", null, b.title); }))));
    }
    add(box, groups);
    if (!earned.length && !next.length) add(box, h("p", { "class": "placeholder" }, "Badges appear once the status has numbers."));
  }

  // ------------------------------------------------------------------ links and footer
  function renderLinks() {
    var box = clear($("links-body"));
    var pub = h("ul", { "class": "linklist" }), loc = h("ul", { "class": "linklist" });
    arr(st().links).filter(isObj).forEach(function (l) {
      if (typeof l.url === "string" && /^https:\/\/[^\s"'<>]+$/.test(l.url)) {
        add(pub, h("li", null, h("a", { href: l.url, rel: "noopener noreferrer" }, l.label || l.url)));
      } else if (typeof l.local === "string") {
        add(loc, h("li", null, h("span", null, l.label || ""), h("span", { "class": "how" }, h("code", null, l.local)), l.how ? h("span", { "class": "how" }, l.how) : null));
      }
    });
    add(box, [h("div", { "class": "card" }, h("h3", null, "Public"), pub.firstChild ? pub : h("p", { "class": "tiny" }, "None in this status file.")),
      h("div", { "class": "card" }, h("h3", null, "On the PI's Mac"), h("p", { "class": "tiny" }, "Not reachable from the web; paths are relative to the project folder."),
        loc.firstChild ? loc : h("p", { "class": "tiny" }, "None in this status file."))]);
  }
  function renderFooter() {
    var f = clear($("footer")), s = st(), c = isObj(s.collector) ? s.collector : {};
    add(f, h("p", null, "This page is public. It shows progress facts only: counts, rates, phases and dates. It never shows paper texts, labels, keys, addresses or local paths."));
    var gen = ms(s.generated_at);
    if (gen) {
      add(f, h("p", null, "Status written " + when(gen) + " by a read-only collector" + (isNum(c.seconds) ? " (" + n1(c.seconds) + " s, " + n1(c.max_rss_mb) + " MB)" : "") +
        "; " + n(c.history_points) + " points of history. The page checks for a new status every 2 minutes; a new one arrives about every " + CFG.cycleMin + " minutes."));
    }
    var mach = isObj(s.machine) ? s.machine : {};
    if (isNum(mach.memory_pct) || isNum(mach.disk_free_gb)) {
      add(f, h("p", null, "The Mac: " + (isNum(mach.memory_pct) ? "memory " + n1(mach.memory_pct) + "% (the harvest aims at 90-95%)" : "") +
        (isNum(mach.disk_free_gb) ? ", " + n1(mach.disk_free_gb) + " GB of disk free" : "") + "."));
    }
    var um = arr(s.unmeasured).filter(isObj);
    if (um.length) add(f, [h("p", null, "Not measured this time:"), h("ul", null, um.map(function (u) { return h("li", null, (u.what || "") + ": " + (u.why || "")); }))]);
    if (arr(c.errors).length) add(f, h("p", null, "Collector notes: " + arr(c.errors).join("; ")));
    add(f, h("p", null, "Mission day 1 was " + dayOf(missionStartMs() + 12 * 3600000) + ". Schema: " + (s.schema || "unknown") + "."));
  }

  // ------------------------------------------------------------------ celebration
  function celebrate(el) {
    if (el) el.classList.add("glow");
    return;  // the owner (2026-11-14): no confetti
    var cv = $("confetti");
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext("2d"), dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr; cv.hidden = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var css = getComputedStyle(document.documentElement), cols = [];
    for (var i = 1; i <= 7; i++) cols.push(css.getPropertyValue("--c" + i).trim() || "#2a78d6");
    var P = [];
    for (var k = 0; k < 90; k++) {
      P.push({ x: W * (0.2 + 0.6 * Math.random()), y: -10 - 40 * Math.random(), vx: (Math.random() - 0.5) * 7, vy: 2 + 4 * Math.random(),
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, w: 5 + 5 * Math.random(), hgt: 3 + 4 * Math.random(), c: cols[k % cols.length] });
    }
    var t0 = performance.now();
    function frame(now) {
      var t = now - t0;
      ctx.clearRect(0, 0, W, H);
      P.forEach(function (p) {
        p.vy += 0.12; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, 1 - t / 2600);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.hgt / 2, p.w, p.hgt);
        ctx.restore();
      });
      if (t < 2600) requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, W, H); cv.hidden = true; }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ render everything
  function render() {
    S.charts = [];
    var focusId = document.activeElement && document.activeElement.id;
    [renderBar, renderAlerts, renderSince, renderMap, renderCrew, renderCollection, renderLabels, renderLab, renderLog,
      renderBadges, renderLinks, renderFooter].forEach(function (fn) {
      try { fn(); } catch (e) { if (window.console) console.error(fn.name, e); }
    });
    document.body.classList.remove("is-loading");
    if (focusId && $(focusId) && document.activeElement !== $(focusId)) { try { $(focusId).focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    requestAnimationFrame(drawCharts);
  }

  // ------------------------------------------------------------------ loading
  function parseHistory(text) {
    return String(text || "").split("\n").map(function (l) {
      l = l.trim();
      if (!l) return null;
      try { var o = JSON.parse(l); return isObj(o) ? o : null; } catch (e) { return null; }
    }).filter(Boolean);
  }
  function fetchStatus(i) {
    if (i >= CFG.bases.length) return Promise.reject(new Error("status.json was not found beside this page or in ../site/"));
    var base = CFG.bases[i];
    return fetch(base + "status.json?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (r.status === 404) return fetchStatus(i + 1);
      if (!r.ok) throw new Error("status.json answered " + r.status);
      return r.text().then(function (txt) { return { base: base, text: txt }; });
    }, function (err) {
      if (i + 1 < CFG.bases.length) return fetchStatus(i + 1);
      throw err;
    });
  }
  function parseStatus(txt) {
    if (!txt || !String(txt).trim()) throw new Error("status.json is empty");
    var o;
    try { o = JSON.parse(txt); } catch (e) { throw new Error("status.json is not valid JSON"); }
    if (!isObj(o)) throw new Error("status.json holds no status");
    return o;
  }
  function loadLocal() {
    function one(src) {
      return new Promise(function (resolve, reject) {
        var old = $("local-data");
        if (old) old.parentNode.removeChild(old);
        window.__PROGRESS_LOCAL__ = undefined;
        var sc = document.createElement("script");
        sc.id = "local-data";
        sc.src = src + "?t=" + Date.now();
        sc.onload = function () { var d = window.__PROGRESS_LOCAL__; if (d && isObj(d.status)) resolve(d); else reject(new Error("local-data.js has no status")); };
        sc.onerror = function () { reject(new Error("local-data.js not found: run the collector first")); };
        document.head.appendChild(sc);
      });
    }
    return one("local-data.js").catch(function () { return one("../site/local-data.js"); });
  }
  function load() {
    S.lastTry = Date.now();
    var p;
    if (location.protocol === "file:") {
      p = loadLocal().then(function (d) { return { status: d.status, history: arr(d.history) }; });
    } else {
      var start = S.base === null ? 0 : Math.max(0, CFG.bases.indexOf(S.base));
      p = fetchStatus(start).then(function (res) {
        var status = parseStatus(res.text);
        S.base = res.base;
        if (S.status && status.generated_at && status.generated_at === S.gen && S.history.length) return { status: status, history: null };
        return fetch(res.base + "history.jsonl?t=" + Date.now(), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.text() : ""; })
          .then(parseHistory, function () { return []; })
          .then(function (hist) { return { status: status, history: hist }; });
      });
    }
    return p.then(function (res) { accept(res.status, res.history); }).catch(function (e) {
      S.error = (e && e.message ? e.message : "unknown error") + ".";
      if (!S.status) {
        setText("mc-sentence", "The status could not be loaded.");
        setText("mc-subsentence", "Reason: " + S.error + " The page tries again every 2 minutes.");
        document.body.classList.remove("is-loading");
        ["since-body", "map-body", "crew-body", "collection-body", "labels-body", "lab-body", "log-body", "badges-body"].forEach(function (id) {
          var el = clear($(id));
          if (el) add(el, h("p", { "class": "placeholder" }, "Nothing to show until a status loads."));
        });
      }
      tick();
    });
  }
  function accept(status, history) {
    var prevGen = S.gen, prevEarned = S.lastEarned;
    var changed = !S.rendered || (status.generated_at || null) !== prevGen;
    S.status = status;
    if (history) S.history = history;
    S.gen = status.generated_at || null;
    S.loadedAt = Date.now();
    S.error = null;
    if (S.baseline === undefined) S.baseline = readVisit();
    if (changed) {
      render();
      S.rendered = true;
      var earnedNow = earnedIds();
      if (prevGen !== undefined && prevGen !== null && prevEarned) {
        // new data while the page is open: flash the pulse, and celebrate a fresh milestone or badge
        var pulse = $("mc-pulse");
        if (pulse && !REDUCED.matches) { pulse.classList.add("flash"); setTimeout(function () { pulse.classList.remove("flash"); }, 2600); }
        var pt = ms(prevGen);
        var fresh = events().some(function (e) { return e.kind === "milestone" && pt !== null && ms(e.t) > pt; }) ||
          earnedNow.some(function (id) { return prevEarned.indexOf(id) < 0; });
        if (fresh) celebrate(document.querySelector(".since-card"));
      }
      S.lastEarned = earnedNow;
      saveVisit();
    } else {
      tick();
    }
  }

  // ------------------------------------------------------------------ theme
  function themeLabel() {
    var t = document.documentElement.getAttribute("data-theme") || "auto";
    var b = $("theme");
    if (!b) return;
    b.textContent = "Theme: " + t;
    b.setAttribute("aria-label", "Color theme: " + (t === "auto" ? "follows the system" : t) + ". Press to change.");
  }
  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme") || "auto";
    var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    if (next === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    try { if (next === "auto") localStorage.removeItem(CFG.themeKey); else localStorage.setItem(CFG.themeKey, next); } catch (e) { /* not kept */ }
    themeLabel();
  });
  themeLabel();

  // ------------------------------------------------------------------ start
  load();
  setInterval(tickClock, 1000);
  setInterval(tick, 15000);
  setInterval(function () { if (document.visibilityState !== "hidden") load(); }, CFG.refreshMs);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && Date.now() - S.lastTry > CFG.refreshMs) load();
  });
  var rz = null;
  window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(drawCharts, 150); });
})();
