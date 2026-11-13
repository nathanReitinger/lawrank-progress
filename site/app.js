/* Progress page: reads status.json and history.jsonl (or, opened from disk, local-data.js) and draws the page.
   Every value from the data goes into the page through textContent, never as HTML. No external code. */
(function () {
  "use strict";

  var REFRESH_MS = 120000;
  var STALE_MIN = 30;
  var state = { status: null, history: [], loadedAt: 0, error: null };

  // ------------------------------------------------------------------ small DOM helpers
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") el.setAttribute("style", v);
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(id) { return document.getElementById(id); }

  var SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }
  var ICONS = {
    check: "M3.5 8.5l3 3 6-7",
    dot: null,
    pause: "M5.5 3.5v9M10.5 3.5v9",
    clock: "M8 4.5V8l2.5 1.5",
    x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
    arrow: "M3.5 8h8M8.5 4.5L12 8l-3.5 3.5",
    dash: "M4 8h8",
    alert: "M8 2.5l6 11H2z M8 6.5v3.2 M8 11.6v.1",
    info: "M8 7.2v4.3 M8 4.8v.1",
    question: "M6 6.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.6 M8 11.6v.1"
  };
  function icon(name) {
    var svg = s("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" });
    if (name === "dot") {
      svg.appendChild(s("circle", { cx: "8", cy: "8", r: "4.2", fill: "currentColor", "class": "pulse" }));
      return svg;
    }
    if (name === "clock" || name === "info" || name === "question" || name === "x") {
      svg.appendChild(s("circle", { cx: "8", cy: "8", r: "6.2", fill: "none", stroke: "currentColor", "stroke-width": "1.6" }));
    }
    svg.appendChild(s("path", { d: ICONS[name] || ICONS.dash, fill: "none", stroke: "currentColor", "stroke-width": "1.8",
      "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return svg;
  }

  // ------------------------------------------------------------------ formatting
  var NF = new Intl.NumberFormat(undefined);
  function n(x) { return typeof x === "number" && isFinite(x) ? NF.format(Math.round(x)) : "?"; }
  function n1(x) {
    if (typeof x !== "number" || !isFinite(x)) return "?";
    return Number.isInteger(x) ? NF.format(x) : x.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }
  function pc(x) { return typeof x === "number" && isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%" : ""; }
  function share(x) {   // a share 0-1 as a percentage with one decimal
    return typeof x === "number" && isFinite(x) ? (100 * x).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%" : "?";
  }
  function ms(t) { var v = t ? Date.parse(t) : NaN; return isNaN(v) ? null : v; }
  function rel(t) {
    var v = ms(t); if (v === null) return "unknown";
    var d = (Date.now() - v) / 1000, future = d < 0; d = Math.abs(d);
    var out;
    if (d < 60) return future ? "in under a minute" : "just now";
    if (d < 3600) out = Math.round(d / 60) + " min";
    else if (d < 36 * 3600) { var hh = Math.floor(d / 3600), mm = Math.round((d - hh * 3600) / 60); out = hh + " h" + (hh < 10 && mm ? " " + mm + " min" : ""); }
    else out = Math.round(d / 86400) + " days";
    return future ? "in " + out : out + " ago";
  }
  function abs(t) {
    var v = ms(t); if (v === null) return "";
    return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  function day(t) {
    var v = ms(t); if (v === null) return "";
    return new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function ymd(str) {
    if (!str) return "";
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(str);
    if (!m) return str;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, 12));
    return m[3] ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
                : d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }
  function range(e) { return e ? ymd(e.from) + " – " + ymd(e.to) : ""; }
  function dur(sec) {
    if (typeof sec !== "number" || !isFinite(sec)) return "";
    if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + " min";
    if (sec < 48 * 3600) { var hh = Math.floor(sec / 3600); return hh + " h " + Math.round((sec - hh * 3600) / 60) + " min"; }
    return Math.floor(sec / 86400) + " days " + Math.round((sec % 86400) / 3600) + " h";
  }
  function timeEl(t, text) {
    return h("time", { datetime: t || "", title: abs(t) }, text || rel(t));
  }

  // ------------------------------------------------------------------ chips and states
  var STATE = {
    running: ["Running", "dot"], serving: ["Serving", "dot"], pairing: ["Pairing", "dot"],
    waiting: ["Waiting", "clock"], restarting: ["Restarting", "clock"], stopped: ["Stopped", "x"],
    finished: ["Finished", "check"], paused: ["Paused", "pause"], idle: ["Idle", "pause"],
    building: ["Being built", "clock"], built: ["Built", "check"], unknown: ["Unknown", "question"],
    done: ["Done", "check"], next: ["Next", "arrow"], later: ["Later", "dash"]
  };
  function chip(st, prefix) {
    var m = STATE[st] || [st || "unknown", "question"];
    return h("span", { "class": "chip s-" + (st || "unknown") }, icon(m[1]), (prefix || "") + m[0]);
  }
  function chipText(cls, iconName, text) {
    return h("span", { "class": "chip s-" + cls }, icon(iconName), text);
  }
  var HEALTH = { ok: ["Healthy", "check"], info: ["Note", "info"], warn: ["Check this", "alert"], critical: ["Needs attention", "alert"] };
  function health(hv) {
    var m = HEALTH[hv] || HEALTH.info;
    return h("span", { "class": "health h-" + (hv || "info") }, icon(m[1]), m[0]);
  }

  // ------------------------------------------------------------------ meters and sparklines
  function meter(done, total, label, sub, small) {
    var p = total > 0 ? Math.max(0, Math.min(100, (100 * done) / total)) : 0;
    var text = n(done) + " of " + n(total) + (label ? " " + label : "");
    return h("div", { "class": "meter" + (small ? " small-bar" : "") },
      h("div", { "class": "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": p.toFixed(1), "aria-valuetext": text + " (" + pc(p) + ")", "aria-label": label || "progress" },
        h("div", { "class": "fill", style: "width:" + p.toFixed(2) + "%" })),
      h("div", { "class": "label" }, h("span", null, h("b", null, n(done)), " of " + n(total) + (label ? " " + label : "")),
        h("span", null, pc(p) + (sub ? " · " + sub : ""))));
  }

  function sparkline(key, title, fmt) {
    var pts = state.history.filter(function (p) { return typeof p[key] === "number" && ms(p.t) !== null; })
      .map(function (p) { return { t: ms(p.t), v: p[key], iso: p.t }; });
    var wrap = h("div", { "class": "spark-wrap" });
    if (pts.length < 2) {
      wrap.appendChild(h("p", { "class": "tiny" }, "The trend line appears after a few updates (one point every 10 minutes)."));
      return wrap;
    }
    fmt = fmt || n;
    var W = 320, H = 56, P = 5;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (lo === hi) { lo -= 1; hi += 1; }
    function X(t) { return P + (W - 2 * P) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0)); }
    function Y(v) { return H - P - (H - 2 * P) * (v - lo) / (hi - lo); }
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join(" ");
    var last = pts[pts.length - 1], first = pts[0];
    var summary = title + ": " + fmt(first.v) + " at " + abs(first.iso) + ", " + fmt(last.v) + " at " + abs(last.iso) +
      " (" + pts.length + " points)";
    var cross = s("line", { "class": "cross", x1: "0", x2: "0", y1: String(P - 2), y2: String(H - P + 2), visibility: "hidden" });
    var svg = s("svg", { "class": "spark", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": summary, tabindex: "0" },
      s("line", { "class": "base", x1: String(P), x2: String(W - P), y1: String(H - P + 0.5), y2: String(H - P + 0.5) }),
      s("path", { "class": "area", d: d + " L" + X(last.t).toFixed(1) + " " + (H - P) + " L" + X(first.t).toFixed(1) + " " + (H - P) + " Z" }),
      s("path", { "class": "line", d: d }),
      cross,
      s("circle", { "class": "dot", cx: X(last.t).toFixed(1), cy: Y(last.v).toFixed(1), r: "4" }));
    var tip = h("div", { "class": "tip", hidden: true, "aria-hidden": "true" });
    var idx = pts.length - 1;
    function show(i) {
      idx = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[idx], x = X(p.t);
      cross.setAttribute("x1", x.toFixed(1)); cross.setAttribute("x2", x.toFixed(1)); cross.setAttribute("visibility", "visible");
      clear(tip); add(tip, [h("b", null, fmt(p.v)), " · " + abs(p.iso)]);
      tip.hidden = false;
      tip.style.left = Math.max(12, Math.min(88, (100 * x) / W)) + "%";
    }
    function hide() { tip.hidden = true; cross.setAttribute("visibility", "hidden"); }
    svg.addEventListener("pointermove", function (ev) {
      var r = svg.getBoundingClientRect(); if (!r.width) return;
      var t = t0 + ((ev.clientX - r.left) / r.width * W - P) / (W - 2 * P) * (t1 - t0);
      var best = 0, bd = Infinity;
      pts.forEach(function (p, i) { var dd = Math.abs(p.t - t); if (dd < bd) { bd = dd; best = i; } });
      show(best);
    });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", function () { show(pts.length - 1); });
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft") { show(idx - 1); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { show(idx + 1); ev.preventDefault(); }
      else if (ev.key === "Escape") hide();
    });
    add(wrap, [svg, tip, h("div", { "class": "spark-cap", "aria-hidden": "true" }, h("span", null, day(first.iso)),
      h("span", null, title))]);
    var rows = pts.slice(-12).reverse().map(function (p) {
      return h("tr", null, h("td", null, abs(p.iso)), h("td", { "class": "n" }, fmt(p.v)));
    });
    add(wrap, h("details", { "class": "more", "data-key": "table-" + key }, h("summary", null, "Show the last values as a table"),
      h("table", { "class": "history" }, h("thead", null, h("tr", null, h("th", { scope: "col" }, "Time"),
        h("th", { scope: "col" }, title))), h("tbody", null, rows))));
    return wrap;
  }

  var SPARK_TITLES = { h_left: "papers left in the gaps queue", c_done: "papers looked up", s2_parts: "parts read",
    s1: "units done", te: "units done", dv: "units done", st: "lines with a text", h_rpm: "requests a minute" };

  // ------------------------------------------------------------------ sections
  function jobLabel(id) {
    var j = (state.status.jobs || []).filter(function (x) { return x.id === id; })[0];
    if (j) return j.label;
    return { store: "Store", core: "CORE lane", machine: "This Mac", updater: "Updater", note: "Note" }[id] || id;
  }

  function renderHeader(st) {
    var p = st.project || {};
    $("kicker").textContent = "Progress page · updated every 10 minutes";
    $("title").textContent = (p.name || "Project") + ": progress";
    document.title = "Law Tags Progress";
    $("headline").textContent = (st.headline && st.headline.sentence) ||
      "This status file has no headline; it may be incomplete.";
    var hd = st.headline || {};
    var known = typeof hd.must_up === "number" && typeof hd.must_total === "number" && hd.must_total > 0;
    var allUp = known && hd.must_up === hd.must_total;
    clear($("musts"));
    add($("musts"), known ? [allUp ? icon("check") : icon("alert"),
      " " + n(hd.must_up) + " of " + n(hd.must_total) + " jobs that must keep running are running"]
      : [icon("question"), " Which jobs are running is not in this status file"]);
    $("musts").className = "health " + (known ? (allUp ? "h-ok" : "h-warn") : "h-info");
    tick();
  }

  function tick() {
    var st = state.status;
    if (!st) {   // nothing loaded yet: say why, if a load failed
      var b0 = clear($("banner"));
      if (state.error) add(b0, h("div", { "class": "banner critical" }, icon("alert"), h("p", null, state.error)));
      return;
    }
    var el = clear($("updated"));
    add(el, ["Updated ", timeEl(st.generated_at)]);
    var gen = ms(st.generated_at);
    var age = gen === null ? null : (Date.now() - gen) / 60000;
    var b = clear($("banner"));
    if (state.error) {
      add(b, h("div", { "class": "banner critical" }, icon("alert"), h("p", null, state.error)));
    } else if (age === null) {
      add(b, h("div", { "class": "banner warn" }, icon("alert"),
        h("p", null, "This status file has no time stamp, so how old these numbers are is not known.")));
    } else if (age > STALE_MIN) {
      add(b, h("div", { "class": "banner " + (age > 360 ? "critical" : "warn") }, icon("alert"),
        h("p", null, "These numbers are " + rel(st.generated_at).replace(" ago", "") + " old. The updater on the owner's Mac may have stopped, or the Mac is asleep; the jobs themselves may still be running.")));
    }
  }

  function renderAlerts(st) {
    var list = clear($("alerts")), alerts = st.alerts || [];
    $("alerts-sec").hidden = !alerts.length;
    var word = { critical: "Needs attention", warn: "Check", info: "Note" };
    alerts.forEach(function (a) {
      add(list, h("li", { "class": a.severity },
        icon(a.severity === "info" ? "info" : "alert"),
        h("div", null, h("span", { "class": "sev" }, (word[a.severity] || a.severity) + ":"),
          h("span", null, jobLabel(a.job) + ". " + a.text),
          a.since ? h("span", { "class": "tiny" }, " (since ", timeEl(a.since), ")") : null,
          a.until ? h("span", { "class": "tiny" }, " (until " + abs(a.until) + ", " + rel(a.until) + ")") : null)));
    });
  }

  function renderPhases(st) {
    var stepper = clear($("stepper")), box = clear($("phases"));
    (st.phases || []).forEach(function (ph) {
      var est = ph.estimate;
      add(stepper, h("li", { "class": ph.is_focus ? "is-focus" : null, "aria-current": ph.is_focus ? "step" : null },
        h("div", { "class": "num" }, "Phase " + ph.n, ph.is_focus ? h("span", { "class": "tag now", style: "margin-left:6px" }, "Focus") : null),
        h("div", { "class": "name" }, ph.name),
        chip(ph.status),
        h("div", { "class": "when" }, n(ph.steps_done) + " of " + n(ph.steps_total) + " steps done"),
        est ? h("div", { "class": "when" }, "Est. " + range(est)) : null));
      var steps = h("ul", { "class": "steps" });
      (ph.steps || []).forEach(function (sp) {
        var cur = sp.status === "running";
        var live = sp.live || null, pr = live && live.progress;
        var body = h("div", { "class": "step-body" },
          sp.detail ? h("div", null, sp.detail) : null,
          pr && pr.total ? meter(pr.done || 0, pr.total, pr.unit, null, true) : null,
          sp.needs ? h("div", { "class": "needs" }, "Needs: " + sp.needs) : null);
        var title = h("div", { "class": "step-title" }, h("strong", null, sp.name),
          cur && ph.is_focus ? h("span", { "class": "tag now" }, "Now") : null,
          live ? chip(live.state, "") : h("span", { "class": "tiny" }, (STATE[sp.status] || [sp.status])[0]));
        var ic = icon({ done: "check", running: "dot", next: "arrow", later: "dash" }[sp.status] || "dash");
        ic.setAttribute("class", "sicon st-" + sp.status);
        add(steps, h("li", { "class": cur ? "current" : null }, h("span", { "class": "sr-only" }, (STATE[sp.status] || [sp.status])[0] + ": "), ic, title, body));
      });
      var det = h("details", { "class": "phase" + (ph.is_focus ? " is-focus" : ""), "data-key": "phase-" + ph.id },
        h("summary", null, h("h3", null, "Phase " + ph.n + ": " + ph.name), chip(ph.status),
          h("span", { "class": "tiny" }, n(ph.steps_done) + " of " + n(ph.steps_total) + " steps done"),
          est ? h("span", { "class": "tiny" }, "Est. " + range(est), h("span", { "class": "est-badge" }, "estimate")) : null),
        h("p", { "class": "phase-goal" }, ph.goal || ""), steps);
      if (ph.is_focus) det.open = true;
      add(box, det);
    });
  }

  function figs(items) {
    var el = h("div", { "class": "figs" });
    items.forEach(function (it) { if (it) add(el, h("span", null, it)); });
    return el;
  }

  function jobCard(j) {
    var must = j.must_keep_running ? h("span", { "class": "tag must" }, "Must keep running")
      : (j.must_continue ? h("span", { "class": "tag must" }, "Must continue each window") : null);
    var card = h("article", { "class": "card", "aria-labelledby": "job-" + j.id },
      h("div", { "class": "card-head" }, h("h3", { id: "job-" + j.id }, j.label), chip(j.state)),
      h("div", { "class": "figs", style: "margin-top:6px" }, must, health(j.health),
        j.watcher_running === true ? h("span", { "class": "tiny" }, "keep-alive watching") :
        (j.watcher_running === false && j.must_keep_running ? h("span", { "class": "tiny" }, "no keep-alive") : null)),
      j.what ? h("p", { "class": "small muted" }, j.what) : null);
    var pr = j.progress;
    if (pr && pr.total) add(card, meter(pr.done || 0, pr.total, pr.unit, pr.since ? "since " + ymd(pr.since) : null));
    if (j.queue) {
      var q = j.queue;
      add(card, figs([h("span", null, h("b", null, n(q.left)), " " + q.unit),
        q.done_this_run != null ? n(q.done_this_run) + " tried this run (" + n(q.texts_this_run) + " texts)" : null,
        q.skipped_for_now ? n(q.skipped_for_now) + " skipped for now" : null]));
    }
    var r = j.rate;
    var bits = [];
    if (r && (r.last60 != null || r.last10 != null)) {
      bits.push(h("span", null, h("b", null, r.last60 != null ? n1(r.last60) : n1(r.last10)), " " + r.unit +
        (r.last60 != null ? " (last 60 min)" : " (last 10 min)") + (r.last60 != null && r.last10 != null ? ", " + n1(r.last10) + " (last 10 min)" : "")));
    }
    if (j.last_activity) bits.push(h("span", null, "Last activity ", timeEl(j.last_activity)));
    if (j.uptime_s) bits.push("Up " + dur(j.uptime_s));
    if (bits.length) add(card, figs(bits));
    var eta = [];
    if (j.eta) eta.push(h("span", null, "Finish estimate ", h("b", null, day(j.eta.at)), " (" + rel(j.eta.at) + ", from " + j.eta.basis + ")"));
    if (j.eta_alt) eta.push(h("span", null, "Or ", h("b", null, day(j.eta_alt.at)), " (from " + j.eta_alt.basis + ")"));
    if (j.estimate) eta.push(h("span", null, "Roadmap: " + range(j.estimate), h("span", { "class": "est-badge" }, "estimate")));
    if (eta.length) add(card, figs(eta));
    if (j.spark) add(card, sparkline(j.spark, SPARK_TITLES[j.spark] || j.spark));
    if (j.line) add(card, h("p", { "class": "statusline" }, j.line + (j.line_at ? "  (" + abs(j.line_at) + ")" : "")));
    if (j.stages && j.stages.length) {
      j.stages.forEach(function (sg) {
        add(card, meter(sg.done, sg.total, "units of stage " + sg.stage, sg.ready === false ? "waits" : null, true));
        if (sg.ready === false && sg.wait) add(card, h("p", { "class": "tiny" }, "Waits: " + sg.wait));
      });
    }
    if (j.details && j.details.length) {
      var dl = h("dl", { "class": "kv" });
      j.details.forEach(function (d) { add(dl, [h("dt", null, d.k), h("dd", null, /^\d{4}-\d\d-\d\dT/.test(d.v) ? abs(d.v) : d.v)]); });
      add(card, dl);
    }
    if (j.rates && j.rates.length) {
      var dl2 = h("dl", { "class": "kv" });
      j.rates.forEach(function (d) { if (d.value != null) add(dl2, [h("dt", null, d.label), h("dd", null, n(d.value))]); });
      add(card, h("details", { "class": "more", "data-key": "rates-" + j.id }, h("summary", null, "Counts behind the pace"), dl2));
    }
    if (j.notes && j.notes.length) add(card, h("ul", { "class": "notes" }, j.notes.map(function (x) { return h("li", null, x); })));
    if (j.kept_alive_by || j.check || j.stop) {
      var dl3 = h("dl", { "class": "kv" });
      if (j.kept_alive_by) add(dl3, [h("dt", null, "Kept going by"), h("dd", null, j.kept_alive_by)]);
      if (j.check) add(dl3, [h("dt", null, "Look at it"), h("dd", null, h("code", null, j.check))]);
      if (j.stop) add(dl3, [h("dt", null, "Stop it"), h("dd", null, h("code", null, j.stop))]);
      add(card, h("details", { "class": "more", "data-key": "how-" + j.id }, h("summary", null, "How it runs (on the owner's Mac)"), dl3));
    }
    return card;
  }

  function restingCard(j) {
    var pr = j.progress;
    return h("article", { "class": "card" },
      h("div", { "class": "card-head" }, h("h3", null, j.label), chip(j.state)),
      j.line ? h("p", { "class": "small muted" }, j.line) : null,
      pr && pr.total ? meter(pr.done || 0, pr.total, pr.unit, null, true) : null,
      j.last_activity ? h("p", { "class": "tiny" }, "Last activity ", timeEl(j.last_activity), " (" + abs(j.last_activity) + ")") : null);
  }

  function renderJobs(st) {
    var run = clear($("running")), rest = clear($("resting"));
    (st.jobs || []).forEach(function (j) {
      var resting = j.state === "finished" || j.state === "paused" || (j.state === "idle" && !j.must_continue);
      if (resting && !j.must_keep_running) add(rest, restingCard(j));
      else add(run, jobCard(j));
    });
    if (!rest.firstChild) add(rest, h("p", { "class": "empty" }, "Nothing finished or paused."));
  }

  var KIND_NAMES = { unknown: "abstract (site or feed record)", first_pages: "first pages", abstract_pdf: "abstract read from the PDF",
    abstract: "abstract", intro_pdf: "introduction from the PDF", excerpt: "excerpt", abstract_short: "short abstract" };

  function tile(label, value, foot, extra, textValue) {
    return h("div", { "class": "card tile" }, h("div", { "class": "label" }, label), h("div", { "class": "value" + (textValue ? " text" : "") }, value),
      foot ? h("div", { "class": "foot" }, foot) : null, extra || null);
  }

  function renderCollection(st) {
    var box = clear($("collection")), c = st.collection || {};
    var cov = c.coverage, pl = c.paper_list || {};
    var hero = h("div", { "class": "card" });
    if (cov) {
      add(hero, h("div", { "class": "hero" }, h("div", { "class": "big" }, pc(cov.pct)),
        h("p", { "class": "cap" }, "of the " + n(cov.papers) + " papers on the list had a usable text when last measured (" +
          day(cov.measured_at) + "): " + n(cov.with_text) + " papers; " + n(cov.without_text) + " still without one. Measured from " + cov.how + ".")));
      add(hero, meter(cov.with_text, cov.papers, "papers with a usable text", "measured " + day(cov.measured_at)));
    } else {
      add(hero, h("p", null, "Coverage of the paper list has not been measured yet."));
    }
    add(hero, h("p", { "class": "tiny" }, "The paper list: " + n(pl.papers) + " papers in " + n(pl.journals) + " journals. A new coverage count is made when the collection ends."));
    add(box, hero);

    var grid = h("div", { "class": "grid tight", style: "margin-top:12px" });
    var sto = c.store || {};
    add(grid, tile("Store record lines", n(sto.lines), "in " + n(sto.files) + " journal files; before de-duplication"));
    add(grid, tile("Lines with a text", n(sto.with_text), sto.lines ? pc(100 * sto.with_text / sto.lines) + " of the lines" : "",
      sparkline("st", "lines with a text")));
    (c.side_stores || []).forEach(function (sd) {
      var names = { faculty: "Faculty repositories", openalex: "OpenAlex", core: "CORE", s2: "Semantic Scholar" };
      add(grid, tile("Side store: " + (names[sd.source] || sd.source), n(sd.lines), n(sd.files) + " files" + (sd.newest ? "; newest " + rel(sd.newest) : "")));
    });
    var oa = c.openalex;
    if (oa) add(grid, tile("Papers with an OpenAlex abstract", n(oa.with_abstract), n(oa.with_text) + " with a text, " + n(oa.with_pdf) + " with a PDF link (" + day(oa.at) + ")"));
    add(box, grid);

    var kinds = sto.kinds || {}, keys = Object.keys(kinds).sort(function (a, b) { return kinds[b] - kinds[a]; });
    var total = keys.reduce(function (a, k) { return a + kinds[k]; }, 0);
    if (total) {
      var shown = keys.slice(0, 3), other = keys.slice(3).reduce(function (a, k) { return a + kinds[k]; }, 0);
      var parts = shown.map(function (k, i) { return { name: KIND_NAMES[k] || k, v: kinds[k], color: "var(--cat-" + (i + 1) + ")" }; });
      if (other) parts.push({ name: "other kinds", v: other, color: "var(--cat-other)" });
      var seg = h("div", { "class": "seg", role: "img", "aria-label": "Texts by kind: " + parts.map(function (p) { return p.name + " " + n(p.v); }).join(", ") });
      parts.forEach(function (p) {
        var share = 100 * p.v / total;
        var el = h("div", { "class": "part", style: "flex:" + p.v + " 1 0;background:" + p.color, title: p.name + ": " + n(p.v) + " (" + pc(share) + ")" });
        if (share >= 14) el.textContent = pc(share);
        add(seg, el);
      });
      add(box, h("div", { "class": "card", style: "margin-top:12px" }, h("h3", null, "Store lines with a text, by kind"), seg,
        h("ul", { "class": "legend" }, parts.map(function (p) {
          return h("li", null, h("span", { "class": "sw", style: "background:" + p.color }), p.name + ": " + n(p.v));
        })),
        h("p", { "class": "tiny" }, "Counted " + (c.counted_at ? rel(c.counted_at) : "") + " (the store is recounted at most hourly; only new lines are read). " + (sto.note || ""))));
    }
  }

  function renderLabels(st) {
    var box = clear($("labels")), L = st.labels || {}, tx = L.taxonomy || {};
    add(box, h("p", { "class": "small" }, h("b", null, "Taxonomy " + (tx.version || "")), ": " + n(tx.leaves) + " subjects in " + n(tx.groups) + " groups" + (tx.date ? " (released " + ymd(tx.date) + ")" : "") + "."));
    var grid = h("div", { "class": "grid" });
    (L.runs || []).forEach(function (id) {
      var j = (st.jobs || []).filter(function (x) { return x.id === id; })[0];
      if (!j) return;
      var pr = j.progress || {};
      var card = h("article", { "class": "card" + (j.state === "running" ? " focus" : "") },
        h("div", { "class": "card-head" }, h("h3", null, j.label), chip(j.state)),
        j.what ? h("p", { "class": "small muted" }, j.what) : null,
        pr.total ? meter(pr.done || 0, pr.total, "units", null) : h("p", { "class": "empty" }, "No plan read this cycle."));
      (j.stages || []).forEach(function (sg) {
        add(card, meter(sg.done, sg.total, "units, stage " + sg.stage + " (" + sg.batches + " batches, " + sg.n_coders + " coder" + (sg.n_coders > 1 ? "s" : "") + (sg.adjudicated ? " + adjudicator" : "") + ")", sg.ready === false ? "waits" : null, true));
      });
      if (j.last_activity) add(card, h("p", { "class": "tiny" }, "Last unit or file ", timeEl(j.last_activity)));
      if (j.estimate) add(card, h("p", { "class": "tiny" }, "Roadmap: " + range(j.estimate) + " — " + (j.estimate.assumes || "")));
      add(grid, card);
    });
    add(box, grid);
  }

  function renderModel(st) {
    var box = clear($("model")), M = st.model || {};
    var grid = h("div", { "class": "grid tight" });
    (M.architectures || []).forEach(function (a) {
      add(grid, h("article", { "class": "card" }, h("h3", null, a.name), h("p", { "class": "small muted" }, a.about),
        h("div", { "class": "figs" }, a.built ? chipText("done", "check", "Built and tested") : chipText("next", "arrow", "Not built"),
          a.trained_on_real_labels ? chipText("done", "check", "Trained") : h("span", { "class": "tiny" }, "Not yet trained on real labels"))));
    });
    add(box, grid);
    var g2 = h("div", { "class": "grid tight", style: "margin-top:12px" });
    var t = M.tests;
    add(g2, tile("Tests passing", t ? n(t.passed) : "?", t ? "last recorded run, " + day(t.as_of) : "no recorded run"));
    var c = M.contest || {};
    add(g2, tile("The contest", c.status || "?", n(c.runs) + " training runs logged; " + n(c.checkpoints) + " checkpoints", null, true));
    var pv = M.preview || {};
    var pj = (st.jobs || []).filter(function (x) { return x.id === "preview"; })[0] || {};
    add(box, g2);
    var pcard = h("article", { "class": "card", style: "margin-top:12px" },
      h("div", { "class": "card-head" }, h("h3", null, "Preview model (for trying tags now)"), chip(pj.state || "unknown")),
      h("p", { "class": "small muted" }, (pv.model_card ? "Model card written " + day(pv.model_card_at) + ". " : "No model card yet. ") +
        (pv.page_code ? "Its test page runs on the owner's Mac (localhost:" + (pv.port || 8765) + ")." : "Its local test page (localhost:" + (pv.port || 8765) + " on the owner's Mac) is still being built.")));
    var nb = pv.numbers;
    if (nb && nb.measures && nb.measures.length) {
      add(pcard, h("p", { "class": "small" }, "Cross-fitted estimates on " + n(nb.n_papers) + " DEV papers (" + (nb.subset || "DEV") + ")" +
        (nb.encoder ? ", encoder " + nb.encoder : "") + "; " + n(nb.rows_tried) + " variants tried" +
        (nb.made ? ", measured " + day(nb.made) : "") + ". 95% intervals in brackets. Preview numbers are never the paper's, and the preview is never a contest entry."));
      var dl = h("dl", { "class": "kv metrics" });
      nb.measures.forEach(function (m) {
        add(dl, [h("dt", null, m.k), h("dd", null, h("b", null, share(m.v)),
          m.lo != null && m.hi != null ? " (" + share(m.lo) + " to " + share(m.hi) + ")" : "")]);
      });
      if (nb.after_choice) {
        add(dl, [h("dt", null, nb.after_choice.k), h("dd", null, h("b", null, share(nb.after_choice.v)),
          nb.after_choice.sd != null ? " (sd " + share(nb.after_choice.sd) + ")" : "")]);
      }
      add(pcard, dl);
    } else if (pv.metrics && pv.metrics.length) {
      var dl2 = h("dl", { "class": "kv" });
      pv.metrics.forEach(function (m) { add(dl2, [h("dt", null, m.k), h("dd", null, typeof m.v === "number" ? (Number.isInteger(m.v) ? n(m.v) : m.v.toFixed(3)) : String(m.v))]); });
      add(pcard, [h("p", { "class": "tiny" }, "Preview numbers on DEV (" + day(pv.metrics_at) + "); never the paper's:"), dl2]);
    } else {
      add(pcard, h("p", { "class": "empty" }, "No preview numbers yet."));
    }
    add(box, pcard);
  }

  function checklist(b) {
    var ul = h("ul", { "class": "check" });
    (b.checklist || []).forEach(function (it) {
      add(ul, h("li", { "class": it.done ? "ok" : "todo" }, icon(it.done ? "check" : "dash"),
        h("div", null, h("span", { "class": "sr-only" }, it.done ? "Done: " : "Not yet: "), it.text,
          it.auto ? h("div", { "class": "auto" }, it.auto_met ? "Checked automatically: met." : "Checked automatically each update.") : null)));
    });
    return ul;
  }

  function renderBeta(st) {
    var box = clear($("beta"));
    var grid = h("div", { "class": "grid" });
    [st.beta, st.v1].forEach(function (b, i) {
      if (!b) return;
      add(grid, h("article", { "class": "card" + (i === 0 ? " focus" : "") },
        h("div", { "class": "card-head" }, h("h3", null, b.version + " — " + b.name),
          h("span", { "class": "tiny" }, n(b.done_count) + " of " + n((b.checklist || []).length) + " done")),
        h("p", { "class": "small" }, b.definition),
        b.estimate ? h("p", { "class": "small" }, "Rough date: ", h("b", null, range(b.estimate)), h("span", { "class": "est-badge" }, "estimate")) : null,
        b.estimate && b.estimate.assumes ? h("p", { "class": "tiny" }, "Assumes: " + b.estimate.assumes) : null,
        checklist(b)));
    });
    add(box, grid);
    var est = h("div", { "class": "est", style: "margin-top:12px" });
    (st.estimates || []).forEach(function (e) {
      add(est, h("div", { "class": "card" }, h("div", { "class": "small" }, e.what),
        h("div", { "class": "range" }, range(e), h("span", { "class": "est-badge" }, "estimate")),
        h("p", { "class": "tiny" }, e.assumes || "")));
    });
    add(box, [h("h3", { style: "margin-top:18px" }, "All rough dates"), est]);
  }

  function renderEvents(st) {
    var ol = clear($("events")), ev = st.events || [], more = clear($("events-more"));
    if (!ev.length) { add(ol, h("li", { "class": "empty" }, "No events yet.")); return; }
    function row(e) { return h("li", null, timeEl(e.t), h("div", null, h("span", { "class": "tag job" }, jobLabel(e.job)), " ", e.text)); }
    ev.slice(0, 12).forEach(function (e) { add(ol, row(e)); });
    if (ev.length > 12) {
      add(more, h("details", { "class": "more", "data-key": "events-older" },
        h("summary", null, "Show " + (ev.length - 12) + " older events"),
        h("ol", { "class": "events" }, ev.slice(12).map(row))));
    }
  }

  function renderLinks(st) {
    var box = clear($("links"));
    var pub = h("ul", { "class": "links" }), loc = h("ul", { "class": "links" });
    (st.links || []).forEach(function (l) {
      if (typeof l.url === "string" && /^https:\/\/[^\s"'<>]+$/.test(l.url)) {   // https links only
        add(pub, h("li", null, h("a", { href: l.url, rel: "noopener" }, l.label)));
      }
      else if (l.local) add(loc, h("li", null, h("strong", null, l.label), h("span", { "class": "how" }, h("code", null, l.local)),
        l.how ? h("span", { "class": "how" }, l.how) : null));
    });
    add(box, [h("div", { "class": "card" }, h("h3", null, "Public"), h("p", { "class": "tiny" }, "Open from anywhere."), pub),
      h("div", { "class": "card" }, h("h3", null, "On the owner's Mac"), h("p", { "class": "tiny" }, "Not reachable from the web; paths are relative to the project folder."), loc)]);
  }

  function renderFooter(st) {
    var f = clear($("footer")), c = st.collector || {};
    add(f, h("p", null, "This page is public. It shows progress facts only: counts, rates, phases and dates. It never shows paper texts, labels, keys, addresses or local paths."));
    if (st.generated_at) {
      add(f, h("p", null, "Generated " + abs(st.generated_at) + " by a read-only collector (" + n1(c.seconds) + " s, " + n1(c.max_rss_mb) + " MB); " + n(c.history_points) + " history points. Schema: " + (st.schema || "") + "."));
    }
    var mach = st.machine || {};
    if (mach.disk_free_gb != null || mach.memory_pct != null) {
      add(f, h("p", null, "The Mac: " + (mach.memory_pct != null ? "memory " + n1(mach.memory_pct) + "% (" + (mach.memory_source || "") + ")" : "") +
        (mach.disk_free_gb != null ? ", " + n1(mach.disk_free_gb) + " GB of disk free" : "") + "."));
    }
    if (st.unmeasured && st.unmeasured.length) {
      add(f, [h("p", null, "Not measured this cycle:"), h("ul", null, st.unmeasured.map(function (u) { return h("li", null, u.what + ": " + u.why); }))]);
    }
    if (c.errors && c.errors.length) add(f, h("p", null, "Collector notes: " + c.errors.join("; ")));
  }

  function render() {
    var st = state.status;
    if (!st) { tick(); return; }
    var opened = {};
    Array.prototype.forEach.call(document.querySelectorAll("details[data-key]"), function (d) {
      opened[d.getAttribute("data-key")] = d.open;
    });
    var sections = [renderHeader, renderAlerts, renderPhases, renderJobs, renderCollection, renderLabels, renderModel,
      renderBeta, renderEvents, renderLinks, renderFooter];
    sections.forEach(function (fn) {
      try { fn(st); } catch (e) { if (window.console) console.error(fn.name, e); }
    });
    Array.prototype.forEach.call(document.querySelectorAll("details[data-key]"), function (d) {
      var k = d.getAttribute("data-key");
      if (Object.prototype.hasOwnProperty.call(opened, k)) d.open = opened[k];
    });
    document.body.classList.remove("loading");
  }

  // ------------------------------------------------------------------ loading
  function parseHistory(text) {
    return text.split("\n").filter(function (l) { return l.trim(); }).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }

  function loadLocal() {
    return new Promise(function (resolve, reject) {
      var old = document.getElementById("local-data");
      if (old) old.parentNode.removeChild(old);
      var sc = document.createElement("script");
      sc.id = "local-data";
      sc.src = "local-data.js?t=" + Date.now();
      sc.onload = function () {
        var d = window.__PROGRESS_LOCAL__;
        if (d && d.status) resolve(d); else reject(new Error("local-data.js has no status"));
      };
      sc.onerror = function () { reject(new Error("local-data.js not found: run the collector first")); };
      document.head.appendChild(sc);
    });
  }

  function load() {
    var p;
    if (location.protocol === "file:") {
      p = loadLocal().then(function (d) { return [d.status, d.history || []]; });
    } else {
      var q = "?t=" + Date.now();
      p = Promise.all([
        fetch("status.json" + q, { cache: "no-store" }).then(function (r) {
          if (!r.ok) throw new Error("status.json answered " + r.status);
          return r.json();
        }),
        fetch("history.jsonl" + q, { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; })
          .then(parseHistory).catch(function () { return []; })
      ]);
    }
    return p.then(function (res) {
      if (!res[0] || typeof res[0] !== "object" || Array.isArray(res[0])) throw new Error("status.json holds no status");
      state.status = res[0]; state.history = Array.isArray(res[1]) ? res[1] : []; state.loadedAt = Date.now(); state.error = null;
      render();
    }).catch(function (e) {
      state.error = "Could not load the latest status (" + (e && e.message ? e.message : "unknown error") + ")." +
        (state.status ? " Showing the last numbers that loaded." : "");
      if (!state.status) { $("headline").textContent = "The status could not be loaded."; }
      tick();
    });
  }

  // ------------------------------------------------------------------ theme
  function themeLabel() {
    var t = document.documentElement.getAttribute("data-theme") || "auto";
    var b = $("theme");
    b.textContent = "Theme: " + t;
    b.setAttribute("aria-label", "Color theme: " + (t === "auto" ? "follows the system" : t) + ". Press to change.");
  }
  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme") || "auto";
    var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    if (next === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    try { if (next === "auto") localStorage.removeItem("progress-theme"); else localStorage.setItem("progress-theme", next); } catch (e) {}
    themeLabel();
  });
  themeLabel();

  document.body.classList.add("loading");
  load();
  setInterval(tick, 30000);
  setInterval(function () { if (document.visibilityState !== "hidden") load(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && Date.now() - state.loadedAt > REFRESH_MS) load();
  });
})();
