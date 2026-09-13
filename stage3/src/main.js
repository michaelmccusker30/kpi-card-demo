/* ===================================================================
   KPI Card — a Tableau viz extension
   ===================================================================

   Two encoding shelves, read from the manifest by id:
     measure  a continuous measure — totalled for the big number
     date     a temporal field    — drives the timeline

   Everything else is configuration, held in the Tableau settings API so
   it travels with the workbook. One grain setting drives the whole card:
   the headline total, the comparison, and the buckets in the trend chart.

   The trend window is always the calendar year. Never rolling.
   =================================================================== */

/* Flip to true to show the diagnostic strip inside Tableau, where there
   is no browser console. It reports what the extension actually received:
   encodings seen, columns matched, rows read, and the last render error. */
var DEBUG = false;

var VERSION = "v2.1.0";
var SETTINGS_KEY = "kpiCardConfig";

var MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

var DEFAULT_CONFIG = {
  /* what the big number shows */
  metricMode: "latest",       // latest | ytd
  compareMode: "pop",         // pop | yoy
  grain: "month",             // day | week | month | quarter | year

  /* number format — Auto carries the field's own Tableau format forward.
     Abbreviation is OFF by default: the card's first job is to agree with
     Tableau exactly, and "$85.2K" cannot be checked against "$85,175". */
  formatMode: "auto",         // auto | number | currency | percent
  currencySymbol: "$",
  decimals: "auto",           // auto | "0" | "1" | "2" | "3"
  abbreviate: false,

  /* trend chart */
  showPrior: true,

  /* goal tracking — optional, off by default */
  goalOn: false,
  goalValue: null,
  goalDir: "higher",          // higher | lower
  goalStyle: "block",         // block | short | top

  /* appearance */
  layout: "stacked",          // stacked | side
  palette: "slate",
  font: "system"
};

/* The comparison each headline mode implies. Switching the headline in
   the panel moves the comparison with it; you can still override. */
var IMPLIED_COMPARE = { latest: "pop", ytd: "yoy" };

/* ===================================================================
   Palette tokens
   -------------------------------------------------------------------
   A palette is a full token set, not an accent colour. Every surface,
   rule and piece of text in the card — including the SVG the chart
   draws and the settings panel floating above it — reads one of these
   names, so a dark palette needs no special-casing anywhere.

   BASE is the light default. Each palette lists only what it changes.
   =================================================================== */

var BASE_TOKENS = {
  bg:      "#ffffff",   // the card's own ground
  surface: "#fbfcfe",   // raised panels, collapsed sections, button hover
  text:    "#0f172a",   // the big number and primary copy
  muted:   "#64748b",   // labels, secondary copy
  faint:   "#94a3b8",   // as-of line, stamps, disabled
  border:  "#e2e8f0",   // rules, input borders, the chart's zero line
  accent:  "#3b82f6",   // the current-year series, primary button
  "on-accent": "#ffffff",   // text that sits ON the accent, so it stays legible
  prior:   "#94a3b8",   // the prior-year series
  up:      "#16a34a",   // good — rising delta, goal met
  down:    "#dc2626",   // bad — falling delta, goal missed
  shadow:  "rgba(15, 23, 42, 0.20)",
  stamp:   "#cbd5e1"
};

var PALETTES = {
  slate: {
    name: "Slate & blue", dark: false,
    tokens: { accent: "#3b82f6", prior: "#94a3b8" }
  },
  ocean: {
    name: "Ocean", dark: false,
    tokens: { accent: "#0891b2", prior: "#7dd3fc" }
  },
  forest: {
    name: "Forest", dark: false,
    tokens: { accent: "#059669", prior: "#9ec5b4" }
  },
  ember: {
    name: "Ember", dark: false,
    tokens: { accent: "#ea580c", prior: "#f3c99b" }
  },
  violet: {
    name: "Violet", dark: false,
    tokens: { accent: "#7c3aed", prior: "#c4b5fd" }
  },
  graphite: {
    name: "Graphite", dark: false,
    tokens: { accent: "#334155", prior: "#cbd5e1" }
  },

  /* Corporate blue — a restrained, navy-led light theme for decks and
     exec dashboards. Cooler greys than Slate, and a deeper accent. */
  corporate: {
    name: "Corporate blue", dark: false,
    tokens: {
      bg:      "#ffffff",
      surface: "#f4f8fb",
      text:    "#0b2545",
      muted:   "#52708f",
      faint:   "#8aa2ba",
      border:  "#d7e2ec",
      accent:  "#1e4e8c",
      prior:   "#a8c3dd",
      up:      "#137a5f",
      down:    "#b3322c",
      shadow:  "rgba(11, 37, 69, 0.22)",
      stamp:   "#c3d4e3"
    }
  },

  /* Warm dark — a full dark theme. Because every token moves together,
     the chart, the tooltip and the settings panel come with it. */
  warmdark: {
    name: "Warm dark", dark: true,
    tokens: {
      bg:      "#1c1917",
      surface: "#292524",
      text:    "#fafaf9",
      muted:   "#a8a29e",
      faint:   "#78716c",
      border:  "#44403c",
      accent:  "#f59e0b",
      "on-accent": "#1c1917",   /* amber needs dark text, not white */
      prior:   "#8a7f76",
      up:      "#4ade80",
      down:    "#f87171",
      shadow:  "rgba(0, 0, 0, 0.55)",
      stamp:   "#57534e"
    }
  }
};

var FONTS = {
  system:    { name: "System",    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  tableau:   { name: "Tableau",   stack: '"Tableau Book", "Tableau Medium", "Benton Sans", -apple-system, "Segoe UI", Arial, sans-serif' },
  grotesk:   { name: "Grotesk",   stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  condensed: { name: "Condensed", stack: '"HelveticaNeue-CondensedBold", "Helvetica Neue Condensed", "Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", Arial, sans-serif' },
  rounded:   { name: "Rounded",   stack: '"SF Pro Rounded", "Varela Round", "Trebuchet MS", "Segoe UI", Verdana, sans-serif' },
  serif:     { name: "Serif",     stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  mono:      { name: "Mono",      stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' }
};

var GRAIN_NOUN = {
  day: "day", week: "week", month: "month", quarter: "quarter", year: "year"
};

/* State */
var model = null;
var config = Object.assign({}, DEFAULT_CONFIG);
var savedConfig = Object.assign({}, DEFAULT_CONFIG);  // what Close reverts to
var worksheet = null;
var rendering = false;
var rerenderQueued = false;
var debugLines = [];
var lastError = "";

/* ---------- tiny DOM helpers ---------- */

function $(id) { return document.getElementById(id); }
function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }
function note(msg) { debugLines.push(msg); }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

function paintDebug() {
  var el = $("debug");
  if (!el) return;
  if (!DEBUG) { hide(el); return; }
  var html = debugLines.map(escapeHtml).join("\n");
  if (lastError) {
    html += (html ? "\n" : "") + '<span class="debug-err">last error: ' +
            escapeHtml(lastError) + "</span>";
  }
  el.innerHTML = html;
  show(el);
}

/* ===================================================================
   Field names — never match by column position (ground rule 3)
   =================================================================== */

/* Strips aggregation wrappers and brackets but keeps the original case,
   so the label reads "Sales" rather than "SUM(SALES)". */
function cleanName(name) {
  var s = String(name == null ? "" : name).trim();
  var prev;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_ .]*\((.*)\)$/, "$1").trim();
    s = s.replace(/^\[(.*)\]$/, "$1").trim();
  } while (s !== prev);
  return s;
}

function baseName(name) { return cleanName(name).toLowerCase(); }

var NUMERIC_TYPES = ["float", "int"];
var DATE_TYPES = ["date", "date-time", "datetime"];

function findColumn(table, fieldName, typeFallback) {
  var target = baseName(fieldName);
  var cols = table.columns;
  var i;

  for (i = 0; i < cols.length; i++) {
    if (baseName(cols[i].fieldName) === target) return cols[i];
  }
  if (target) {
    for (i = 0; i < cols.length; i++) {
      if (String(cols[i].fieldName).toLowerCase().indexOf(target) !== -1) return cols[i];
    }
  }
  if (typeFallback) {
    var hits = cols.filter(function (c) {
      return typeFallback.indexOf(String(c.dataType).toLowerCase()) !== -1;
    });
    if (hits.length) return hits[0];
  }
  return null;
}

/* ===================================================================
   Value coercion
   =================================================================== */

function toNumber(dv) {
  if (!dv) return null;
  var v = dv.nativeValue;
  if (v === null || v === undefined || v === "") v = dv.value;
  if (v === null || v === undefined || v === "" || v === "%null%") return null;
  var n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9eE+\-.]/g, ""));
  return isFinite(n) ? n : null;
}

/* Does this string carry an explicit UTC offset or Z marker? */
function hasExplicitZone(s) {
  return /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
}

/* -------------------------------------------------------------------
   toDate — the single most important function in this file.

   Tableau hands back a date's nativeValue as a JavaScript Date built
   from the *UTC instant* of the calendar date: 1 Dec 2026 arrives as
   2026-12-01T00:00:00Z. Reading that with the LOCAL getters
   (getFullYear/getMonth/getDate) west of Greenwich walks it backwards
   into the previous day — and, for the first of a month, into the
   previous month. Every total then lands in the wrong bucket and the
   as-of line reads a day early.

   So: a real Date is read with the UTC getters. Strings that Tableau
   or the data source hand over as plain wall-clock text are parsed by
   hand, with no zone applied at all. Only a string carrying an explicit
   zone goes back through the UTC getters.

   The return value is always a LOCAL midnight Date, which every period
   function below then reads with local getters. One conversion at the
   boundary, local everywhere inside — never a mix.
   ------------------------------------------------------------------- */
function toDate(dv) {
  if (!dv) return null;
  var v = dv.nativeValue;
  if (v === null || v === undefined || v === "") v = dv.value;
  if (v === null || v === undefined || v === "" || v === "%null%") return null;

  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  }

  var s = String(v), m;

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                 // YYYY-MM-DD
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  m = s.match(/^(\d{4})-(\d{1,2})$/);                          // YYYY-MM
  if (m) return new Date(+m[1], +m[2] - 1, 1);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);               // M/D/YYYY
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);

  m = s.match(/^(\d{4})$/);                                    // YYYY
  if (m) return new Date(+m[1], 0, 1);

  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return hasExplicitZone(s)
    ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/* ===================================================================
   Periods — one grain runs the whole card
   -------------------------------------------------------------------
   A period is identified by its START date. From that we derive a key,
   the calendar year it sits in, and its ordinal slot within that year.
   Prior-year alignment is by (year - 1, same slot), which works the
   same way for every grain.

   Everything below reads LOCAL getters, which is safe because toDate
   has already normalised every date to local midnight.
   =================================================================== */

var DAY_MS = 86400000;

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInYear(y) { return isLeap(y) ? 366 : 365; }

function dayOfYear(d) {
  return Math.round((d - new Date(d.getFullYear(), 0, 1)) / DAY_MS) + 1;
}

/* Weeks start Sunday, matching Tableau's default. */
function weekStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}

function periodStart(d, grain) {
  switch (grain) {
    case "day":     return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    case "week":    return weekStart(d);
    case "quarter": return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
    case "year":    return new Date(d.getFullYear(), 0, 1);
    default:        return new Date(d.getFullYear(), d.getMonth(), 1);
  }
}

/* Slot within the calendar year. Collision-free at every grain: week
   starts are 7 days apart, so (dayOfYear - 1) / 7 never repeats. */
function slotOf(start, grain) {
  switch (grain) {
    case "day":     return dayOfYear(start) - 1;
    case "week":    return Math.floor((dayOfYear(start) - 1) / 7);
    case "quarter": return Math.floor(start.getMonth() / 3);
    case "year":    return 0;
    default:        return start.getMonth();
  }
}

function slotsInYear(y, grain) {
  switch (grain) {
    case "day":     return daysInYear(y);
    case "week":    return 53;
    case "quarter": return 4;
    case "year":    return 1;
    default:        return 12;
  }
}

function prevStart(start, grain) {
  var y = start.getFullYear(), m = start.getMonth(), d = start.getDate();
  switch (grain) {
    case "day":     return new Date(y, m, d - 1);
    case "week":    return new Date(y, m, d - 7);
    case "quarter": return new Date(y, m - 3, 1);
    case "year":    return new Date(y - 1, 0, 1);
    default:        return new Date(y, m - 1, 1);
  }
}

function periodKey(start) {
  return start.getFullYear() + "-" +
         String(start.getMonth() + 1).padStart(2, "0") + "-" +
         String(start.getDate()).padStart(2, "0");
}

/* "Dec 2026", "Q4 2026", "Week of Dec 21, 2026", "Dec 26, 2026", "2026" */
function periodLabel(start, grain) {
  var y = start.getFullYear(), m = start.getMonth(), d = start.getDate();
  switch (grain) {
    case "day":     return MONTHS_SHORT[m] + " " + d + ", " + y;
    case "week":    return "Week of " + MONTHS_SHORT[m] + " " + d + ", " + y;
    case "quarter": return "Q" + (Math.floor(m / 3) + 1) + " " + y;
    case "year":    return String(y);
    default:        return MONTHS_SHORT[m] + " " + y;
  }
}

/* The span label for a year-to-date window: "Jan–Dec 2025", "2025". */
function spanLabel(firstStart, lastStart, grain) {
  if (grain === "year") {
    return firstStart.getFullYear() === lastStart.getFullYear()
      ? String(lastStart.getFullYear())
      : firstStart.getFullYear() + "–" + lastStart.getFullYear();
  }
  var y = lastStart.getFullYear();
  if (grain === "quarter") {
    var q1 = Math.floor(firstStart.getMonth() / 3) + 1;
    var q2 = Math.floor(lastStart.getMonth() / 3) + 1;
    return q1 === q2 ? "Q" + q2 + " " + y : "Q" + q1 + "–Q" + q2 + " " + y;
  }
  var a = MONTHS_SHORT[firstStart.getMonth()];
  var b = MONTHS_SHORT[lastStart.getMonth()];
  return (a === b ? a : a + "–" + b) + " " + y;
}

/* ===================================================================
   Number formatting — mirror Tableau (ground rule 4)
   Infer the display pattern from the column's own formattedValue
   samples instead of inventing one. Auto is the default; the settings
   panel can override any part of it.
   =================================================================== */

function inferFormat(samples) {
  var fmt = { prefix: "", suffix: "", decimals: 0, isPercent: false, negParen: false };
  var seen = 0;

  for (var i = 0; i < samples.length && seen < 40; i++) {
    var s = samples[i];
    if (!s) continue;
    s = String(s).trim();
    if (!s || s === "%null%") continue;
    seen++;

    if (/^\(.*\)$/.test(s)) { fmt.negParen = true; s = s.slice(1, -1); }

    var lead = s.match(/^-?\s*([^\d\s.,+-]+)/);      // $, £, €, ¥ …
    if (lead && !fmt.prefix) fmt.prefix = lead[1];

    if (/%\s*$/.test(s)) { fmt.isPercent = true; fmt.suffix = "%"; }

    var digits = s.replace(/[^0-9.,]/g, "");
    var dot = digits.lastIndexOf(".");
    if (dot !== -1) {
      var dec = digits.length - dot - 1;
      if (dec <= 6 && dec > fmt.decimals) fmt.decimals = dec;
    }
  }

  if (seen === 0) fmt.decimals = 0;
  return fmt;
}

function effectiveFormat(inferred) {
  var f = {
    prefix: inferred.prefix,
    suffix: inferred.suffix,
    decimals: inferred.decimals,
    isPercent: inferred.isPercent,
    negParen: inferred.negParen
  };

  if (config.formatMode === "number") {
    f.prefix = ""; f.suffix = ""; f.isPercent = false;
  } else if (config.formatMode === "currency") {
    f.prefix = config.currencySymbol || "$"; f.suffix = ""; f.isPercent = false;
  } else if (config.formatMode === "percent") {
    f.prefix = ""; f.suffix = "%"; f.isPercent = true;
  }

  if (config.decimals !== "auto") f.decimals = Number(config.decimals);
  return f;
}

function groupDigits(intPart) {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatNumber(n, fmt, decimalsOverride) {
  if (n === null || n === undefined || !isFinite(n)) return "—";

  var scaled = fmt.isPercent ? n * 100 : n;
  var dec = decimalsOverride === undefined ? fmt.decimals : decimalsOverride;
  var neg = scaled < 0;
  var abs = Math.abs(scaled);

  var body = abs.toFixed(dec);
  var parts = body.split(".");
  body = groupDigits(parts[0]) + (parts[1] ? "." + parts[1] : "");

  var out = fmt.prefix + body + fmt.suffix;
  if (neg) out = fmt.negParen ? "(" + out + ")" : "-" + out;
  return out;
}

/* The headline format — used for the big number, the comparison value
   and the tooltips, so they all read the same way. */
function formatValue(n, fmt) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (!config.abbreviate) return formatNumber(n, fmt);

  var scaled = fmt.isPercent ? n * 100 : n;
  var abs = Math.abs(scaled);
  if (abs < 1000) return formatNumber(n, fmt);

  var div = 1, suf = "";
  if (abs >= 1e12)     { div = 1e12; suf = "T"; }
  else if (abs >= 1e9) { div = 1e9;  suf = "B"; }
  else if (abs >= 1e6) { div = 1e6;  suf = "M"; }
  else                 { div = 1e3;  suf = "K"; }

  var v = scaled / div;
  var neg = v < 0;
  var body = Math.abs(v).toFixed(1) + suf;

  var out = fmt.prefix + body + fmt.suffix;
  if (neg) out = fmt.negParen ? "(" + out + ")" : "-" + out;
  return out;
}

/* ===================================================================
   Settings — persisted through the Tableau settings API, so the
   configuration travels with the workbook.
   =================================================================== */

function loadConfig() {
  config = Object.assign({}, DEFAULT_CONFIG);
  try {
    var raw = tableau.extensions.settings.get(SETTINGS_KEY);
    if (raw) Object.assign(config, JSON.parse(raw));
  } catch (e) {
    note("settings: could not parse saved config, using defaults");
  }
  if (!PALETTES[config.palette]) config.palette = DEFAULT_CONFIG.palette;
  if (!FONTS[config.font]) config.font = DEFAULT_CONFIG.font;
  savedConfig = Object.assign({}, config);
  applyTheme();
}

function saveConfig() {
  tableau.extensions.settings.set(SETTINGS_KEY, JSON.stringify(config));
  savedConfig = Object.assign({}, config);
  return tableau.extensions.settings.saveAsync();
}

/* Resolve a palette id to its full token set. */
function tokensFor(paletteId) {
  var pal = PALETTES[paletteId] || PALETTES.slate;
  return Object.assign({}, BASE_TOKENS, pal.tokens);
}

/* Paint the token set onto the document element, so body and every
   floating layer inherit it — not just #root. */
function applyTheme(paletteId, fontId) {
  var pid = paletteId || config.palette;
  var fid = fontId || config.font;
  var pal = PALETTES[pid] || PALETTES.slate;
  var tok = tokensFor(pid);
  var f = FONTS[fid] || FONTS.system;
  var root = document.documentElement;

  Object.keys(tok).forEach(function (k) {
    root.style.setProperty("--" + k, tok[k]);
  });
  root.style.setProperty("--font", f.stack);
  root.classList.toggle("is-dark", !!pal.dark);
}

function fillOptions(sel, table) {
  sel.innerHTML = "";
  Object.keys(table).forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    o.textContent = table[k].name;
    sel.appendChild(o);
  });
}

function syncSettingsForm() {
  $("metric-mode").value = config.metricMode;
  $("compare-mode").value = config.compareMode;
  $("grain").value = config.grain;

  $("fmt-mode").value = config.formatMode;
  $("fmt-symbol").value = config.currencySymbol;
  $("fmt-decimals").value = String(config.decimals);
  $("fmt-abbrev").checked = !!config.abbreviate;

  $("trend-prior").checked = !!config.showPrior;

  $("goal-on").checked = !!config.goalOn;
  $("goal-value").value = (config.goalValue === null || config.goalValue === undefined)
    ? "" : String(config.goalValue);
  $("goal-dir").value = config.goalDir;
  $("goal-style").value = config.goalStyle;

  $("layout").value = config.layout;
  $("palette").value = config.palette;
  $("font").value = config.font;

  toggleSymbolField();
  toggleGoalFields();
  paintSectionStates();
}

function toggleSymbolField() {
  if ($("fmt-mode").value === "currency") show($("fmt-symbol-field"));
  else hide($("fmt-symbol-field"));
}

function toggleGoalFields() {
  var on = $("goal-on").checked;
  $("goal-value").disabled = !on;
  $("goal-dir").disabled = !on;
  $("goal-style").disabled = !on;
}

var GOAL_STYLE_WORD = {
  block: "Bar beside the block",
  short: "Short bar",
  top:   "Bar across the top"
};

/* A one-word summary on each collapsed section, so nothing that is
   switched on stays invisible behind a closed disclosure. */
function paintSectionStates() {
  $("state-format").textContent =
    $("fmt-mode").value === "auto" ? "Auto" : $("fmt-mode").selectedOptions[0].textContent;
  $("state-trend").textContent = $("trend-prior").checked ? "Prior year on" : "Current year only";
  $("state-goal").textContent = $("goal-on").checked
    ? "On · " + (GOAL_STYLE_WORD[$("goal-style").value] || "")
    : "Off";
  $("state-look").textContent =
    ($("layout").value === "side" ? "Side by side" : "Stacked") + " · " +
    (PALETTES[$("palette").value] || PALETTES.slate).name;
}

function readForm() {
  var gv = parseFloat($("goal-value").value);
  return {
    metricMode: $("metric-mode").value,
    compareMode: $("compare-mode").value,
    grain: $("grain").value,

    formatMode: $("fmt-mode").value,
    currencySymbol: $("fmt-symbol").value || "$",
    decimals: $("fmt-decimals").value,
    abbreviate: $("fmt-abbrev").checked,

    showPrior: $("trend-prior").checked,

    goalOn: $("goal-on").checked,
    goalValue: isFinite(gv) ? gv : null,
    goalDir: $("goal-dir").value,
    goalStyle: $("goal-style").value,

    layout: $("layout").value,
    palette: $("palette").value,
    font: $("font").value
  };
}

/* ===================================================================
   The settings panel — a pop-out that floats above the viz.
   -------------------------------------------------------------------
   It is deliberately NOT inset into the card: a card can be two inches
   tall, and a form squeezed into that is unusable. The panel is its
   own floating layer — draggable by its header so it can be moved off
   whatever it is covering, resizable from its corner, and fitted with
   Apply so changes can be judged against the live card without
   committing them.
   =================================================================== */

var panelPlaced = false;

function panelBounds() {
  var p = $("settings");
  var maxW = Math.max(200, document.documentElement.clientWidth - 16);
  var maxH = Math.max(160, document.documentElement.clientHeight - 16);
  return { p: p, maxW: maxW, maxH: maxH };
}

/* Keep the panel inside the worksheet, whatever size Tableau gives us. */
function fitPanel() {
  var b = panelBounds(), p = b.p;
  if (!p || p.hidden) return;

  p.style.maxWidth = b.maxW + "px";
  p.style.maxHeight = b.maxH + "px";

  var w = p.offsetWidth, h = p.offsetHeight;
  var left = parseFloat(p.style.left);
  var top = parseFloat(p.style.top);
  if (!isFinite(left)) left = 0;
  if (!isFinite(top)) top = 0;

  p.style.left = clamp(left, 8, Math.max(8, b.maxW + 8 - w)) + "px";
  p.style.top = clamp(top, 8, Math.max(8, b.maxH + 8 - h)) + "px";
}

function placePanel() {
  var b = panelBounds(), p = b.p;
  /* Open on the right so the number block on the left stays readable. */
  p.style.width = Math.min(330, b.maxW) + "px";
  p.style.height = Math.min(430, b.maxH) + "px";
  p.style.left = Math.max(8, b.maxW + 8 - p.offsetWidth - 4) + "px";
  p.style.top = "8px";
  fitPanel();
}

function openSettings() {
  savedConfig = Object.assign({}, config);
  syncSettingsForm();
  show($("settings"));
  if (!panelPlaced) { placePanel(); panelPlaced = true; }
  else fitPanel();
  return Promise.resolve();
}

/* Close abandons anything applied but not saved. */
function closeSettings() {
  config = Object.assign({}, savedConfig);
  hide($("settings"));
  applyTheme();
  render();
}

function applySettings() {
  Object.assign(config, readForm());
  applyTheme();
  paintSectionStates();
  return render();
}

function wirePanelDrag() {
  var head = $("panel-head");
  var p = $("settings");
  var dragging = false, dx = 0, dy = 0;

  head.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button")) return;
    dragging = true;
    dx = e.clientX - parseFloat(p.style.left || 0);
    dy = e.clientY - parseFloat(p.style.top || 0);
    head.setPointerCapture(e.pointerId);
    head.classList.add("is-dragging");
  });

  head.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var b = panelBounds();
    p.style.left = clamp(e.clientX - dx, 8, Math.max(8, b.maxW + 8 - p.offsetWidth)) + "px";
    p.style.top = clamp(e.clientY - dy, 8, Math.max(8, b.maxH + 8 - p.offsetHeight)) + "px";
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    head.classList.remove("is-dragging");
    try { head.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
  }
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);
}

function wireSettings() {
  fillOptions($("palette"), PALETTES);
  fillOptions($("font"), FONTS);

  $("gear").addEventListener("click", openSettings);
  $("panel-x").addEventListener("click", closeSettings);
  $("settings-close").addEventListener("click", closeSettings);

  $("fmt-mode").addEventListener("change", function () {
    toggleSymbolField(); paintSectionStates();
  });
  $("goal-on").addEventListener("change", function () {
    toggleGoalFields(); paintSectionStates();
  });
  ["trend-prior", "layout", "palette", "goal-style"].forEach(function (id) {
    $(id).addEventListener("change", paintSectionStates);
  });

  /* The comparison follows the headline: latest period against the one
     before it, year to date against the same stretch of last year. Pick
     a different comparison afterwards and it sticks. */
  $("metric-mode").addEventListener("change", function () {
    $("compare-mode").value = IMPLIED_COMPARE[$("metric-mode").value] || "pop";
  });

  /* Palette and font preview live as you scroll the list — they cost
     nothing to paint and are the two settings you judge by eye. */
  ["palette", "font"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      applyTheme($("palette").value, $("font").value);
      if (model) drawChart();
    });
  });

  $("settings-apply").addEventListener("click", function () {
    applySettings();
  });

  $("settings-save").addEventListener("click", function () {
    Object.assign(config, readForm());
    applyTheme();
    saveConfig().then(function () {
      hide($("settings"));
      render();
    }).catch(function (e) {
      lastError = "saving settings: " + (e && e.message ? e.message : e);
      paintDebug();
      hide($("settings"));
      render();
    });
  });

  $("settings-reset").addEventListener("click", function () {
    config = Object.assign({}, DEFAULT_CONFIG);
    applyTheme();
    syncSettingsForm();
    render();
  });

  wirePanelDrag();
  window.addEventListener("resize", fitPanel);
}

/* ===================================================================
   Empty state
   =================================================================== */

function showEmpty(extraNote) {
  model = null;
  hide($("card"));
  $("empty-note").textContent = extraNote || "";
  $("empty-note").hidden = !extraNote;
  show($("empty"));
  paintDebug();
}

/* ===================================================================
   Build the model
   -------------------------------------------------------------------
   Rows are aggregated into periods at the configured grain, once. The
   headline, the comparison and the chart buckets all read from that
   same aggregation, so the grain picker can never move one without
   moving the others.
   =================================================================== */

function buildModel(table, measureCol, dateCol, measureEnc) {
  var grain = config.grain;
  var mi = measureCol.index, di = dateCol.index;

  var byKey = {};        // "YYYY-MM-DD" of period start -> bucket
  var byYear = {};       // year -> { slot -> bucket }
  var samples = [];
  var usable = 0;
  var maxDate = null;    // the latest ROW date, for the as-of line

  for (var r = 0; r < table.data.length; r++) {
    var row = table.data[r];
    var d = toDate(row[di]);
    if (!d) continue;
    var n = toNumber(row[mi]);
    if (n === null) continue;

    if (!maxDate || d > maxDate) maxDate = d;

    var start = periodStart(d, grain);
    var key = periodKey(start);
    var b = byKey[key];
    if (!b) {
      b = byKey[key] = {
        start: start,
        year: start.getFullYear(),
        slot: slotOf(start, grain),
        sum: 0
      };
      if (!byYear[b.year]) byYear[b.year] = {};
      byYear[b.year][b.slot] = b;
    }
    b.sum += n;
    usable++;

    if (samples.length < 40 && row[mi] && row[mi].formattedValue) {
      samples.push(row[mi].formattedValue);
    }
  }

  if (!usable) return null;

  /* The latest period actually present in the data — not today's date,
     so the card still renders against older sample data. */
  var keys = Object.keys(byKey).sort();
  var latest = byKey[keys[keys.length - 1]];
  var year = latest.year;
  var priorYear = year - 1;

  var fmt = effectiveFormat(inferFormat(samples));
  var m = {
    label: cleanName(measureEnc.field.name) || "Measure",
    grain: grain,
    fmt: fmt,
    year: year,
    priorYear: priorYear,
    latest: latest,
    maxDate: maxDate,
    slots: slotsInYear(year, grain)
  };

  /* ---- the headline and what it is measured against ---- */

  if (config.metricMode === "ytd") {
    var firstSlotBucket = null, ytd = 0;
    for (var s = 0; s <= latest.slot; s++) {
      var bk = byYear[year] && byYear[year][s];
      if (bk) { ytd += bk.sum; if (!firstSlotBucket) firstSlotBucket = bk; }
    }
    m.headline = ytd;
    m.headlineLabel = spanLabel(firstSlotBucket ? firstSlotBucket.start
                                                : new Date(year, 0, 1),
                                latest.start, grain);
    m.asOfLabel = "Year to date · as of " + periodLabel(latest.start, grain);
    m.periodCount = latest.slot + 1;

    if (config.compareMode === "yoy") {
      var pr = 0, prAny = false, prFirst = null, prLast = null;
      for (var s2 = 0; s2 <= latest.slot; s2++) {
        var pb = byYear[priorYear] && byYear[priorYear][s2];
        if (pb) { pr += pb.sum; prAny = true; if (!prFirst) prFirst = pb; prLast = pb; }
      }
      m.baseline = prAny ? pr : null;
      m.baselineLabel = prAny ? spanLabel(prFirst.start, prLast.start, grain)
                              : String(priorYear);
      m.compareWord = "the same period last year";
    } else {
      /* The equal-length stretch immediately before this year began. */
      /* new Date(year,0,1) is a period start at every grain except week,
         where the year may open mid-week; step back from the real first slot. */
      var firstOfYear = (byYear[year] && byYear[year][0]) ? byYear[year][0].start
                                                         : new Date(year, 0, 1);
      var walk = prevStart(periodStart(firstOfYear, grain), grain);

      var sum = 0, any = false, last = walk, first = walk;
      for (var i = 0; i < m.periodCount; i++) {
        var wb = byKey[periodKey(walk)];
        if (wb) { sum += wb.sum; any = true; }
        first = walk;
        walk = prevStart(walk, grain);
      }
      m.baseline = any ? sum : null;
      m.baselineLabel = any ? spanLabel(first, last, grain) : "the preceding stretch";
      m.compareWord = "the preceding " + m.periodCount + " " +
                      GRAIN_NOUN[grain] + (m.periodCount === 1 ? "" : "s");
    }

  } else {
    m.headline = latest.sum;
    m.headlineLabel = periodLabel(latest.start, grain);
    m.asOfLabel = "As of " + m.headlineLabel;
    m.periodCount = 1;

    if (config.compareMode === "yoy") {
      var yb = byYear[priorYear] && byYear[priorYear][latest.slot];
      /* Year grain has no "same slot last year" — it is the year before. */
      if (grain === "year") yb = byKey[periodKey(prevStart(latest.start, grain))];
      m.baseline = yb ? yb.sum : null;
      m.baselineLabel = yb ? periodLabel(yb.start, grain)
                           : periodLabel(new Date(priorYear,
                                                  latest.start.getMonth(),
                                                  latest.start.getDate()), grain);
      m.compareWord = "the same " + GRAIN_NOUN[grain] + " last year";
    } else {
      var ps = prevStart(latest.start, grain);
      var pbk = byKey[periodKey(ps)];
      m.baseline = pbk ? pbk.sum : null;
      m.baselineLabel = periodLabel(ps, grain);
      m.compareWord = "the previous " + GRAIN_NOUN[grain];
    }
  }

  /* At a grain coarser than a day, say which day the data actually runs
     through — "Dec 2026 (data through Dec 30)" — so a part-finished
     period is never mistaken for a complete one. */
  if (grain !== "day" && maxDate) {
    m.asOfLabel += " · data through " +
                   MONTHS_SHORT[maxDate.getMonth()] + " " + maxDate.getDate();
  }

  m.pct = (m.baseline === null || m.baseline === 0)
    ? null
    : (m.headline - m.baseline) / Math.abs(m.baseline);

  /* ---- chart series: the calendar year, bucketed at this grain ----
     Year grain has no inside-the-year run, so it plots the years
     themselves instead — otherwise the chart would be a single point. */

  var curSeries = [], priorSeries = [], startsSeries = [];
  if (grain === "year") {
    var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });
    m.slots = years.length;
    m.yearsAxis = years;
    years.forEach(function (yy) {
      curSeries.push(byYear[yy][0] ? byYear[yy][0].sum : null);
      priorSeries.push(null);
      startsSeries.push(new Date(yy, 0, 1));
    });
    m.hasPriorSeries = false;
  } else {
    for (var k = 0; k < m.slots; k++) {
      var cb = byYear[year] && byYear[year][k];
      var pb2 = byYear[priorYear] && byYear[priorYear][k];
      curSeries.push(cb ? cb.sum : null);
      priorSeries.push(pb2 ? pb2.sum : null);
      startsSeries.push(cb ? cb.start : (pb2 ? new Date(year, pb2.start.getMonth(),
                                                        pb2.start.getDate()) : null));
    }
    m.hasPriorSeries = priorSeries.some(function (v) { return v !== null; });
  }

  m.curSeries = curSeries;
  m.priorSeries = priorSeries;
  m.startsSeries = startsSeries;

  /* ---- goal status: a light, not a meter ----
     `pctOfGoal` is the readout the panel promises. It is deliberately
     the raw ratio, not a capped progress figure: 112% of goal is worth
     seeing, and clamping it to 100% would hide the best months. */
  m.goal = null;
  if (config.goalOn && config.goalValue !== null && isFinite(config.goalValue)) {
    var beating = config.goalDir === "lower"
      ? m.headline <= config.goalValue
      : m.headline >= config.goalValue;
    m.goal = {
      value: config.goalValue,
      dir: config.goalDir,
      style: config.goalStyle,
      ok: beating,
      pctOfGoal: config.goalValue === 0 ? null : (m.headline / config.goalValue)
    };
  }

  return m;
}

/* ===================================================================
   Paint the number block
   =================================================================== */

function paintCard() {
  hide($("empty"));
  show($("card"));

  var card = $("card");
  card.classList.toggle("layout-side", config.layout === "side");
  card.classList.toggle("layout-stacked", config.layout !== "side");

  $("label").textContent = model.label;
  $("label").title = model.label;

  var headlineText = formatValue(model.headline, model.fmt);
  $("value").textContent = headlineText;
  /* The exact, unabbreviated figure is always one hover away, so the
     card can be checked against Tableau even with abbreviation on. */
  $("value").title = formatNumber(model.headline, model.fmt);

  /* The delta, coloured by direction — or by goal status when a goal is
     set, so the status bar and the delta always agree. */
  var deltaEl = $("delta");
  var arrowEl = deltaEl.querySelector(".delta-arrow");
  var textEl = deltaEl.querySelector(".delta-text");
  deltaEl.classList.remove("is-up", "is-down", "is-flat", "is-goal-ok", "is-goal-off");

  if (model.pct === null) {
    arrowEl.textContent = "";
    textEl.textContent = (model.baseline === null)
      ? "No data for " + model.baselineLabel + " to compare against"
      : "No change shown — " + model.baselineLabel + " totalled zero";
    deltaEl.classList.add("is-flat");
  } else {
    var up = model.pct > 0, down = model.pct < 0;
    arrowEl.textContent = up ? "▲" : (down ? "▼" : "▬");
    textEl.textContent = Math.abs(model.pct * 100).toFixed(1) + "% vs " + model.baselineLabel;
    if (model.goal) deltaEl.classList.add(model.goal.ok ? "is-goal-ok" : "is-goal-off");
    else deltaEl.classList.add(up ? "is-up" : (down ? "is-down" : "is-flat"));
  }

  /* What we are comparing against, and what it was worth. */
  $("context").textContent = (model.baseline === null)
    ? "Compared with " + model.compareWord
    : "vs " + model.compareWord + " · " + formatValue(model.baseline, model.fmt);

  $("asof").textContent = model.asOfLabel;

  paintGoal();

  $("stamp").textContent = VERSION;
  drawChart();
}

/* -------------------------------------------------------------------
   The goal indicator.

   Three placements, one rule: the bar is a SOLID status colour, never a
   proportional fill, and it belongs to the block it annotates — it never
   runs alongside the chart or down the height of the worksheet.

     block  a bar down the left of the whole number block
     short  a short bar beside just the number and the comparison
     top    a bar across the top of the number block

   The proportion lives in words instead, on the "% to goal" readout.
   ------------------------------------------------------------------- */
function paintGoal() {
  var block = $("block");
  var barBlock = $("statusbar");
  var barShort = $("statusbar-short");
  var gnote = $("goalnote");

  block.classList.remove("goal-block", "goal-short", "goal-top");

  if (!model.goal) {
    hide(barBlock);
    hide(barShort);
    hide(gnote);
    return;
  }

  var ok = model.goal.ok;
  var style = model.goal.style || "block";

  [barBlock, barShort].forEach(function (b) {
    b.classList.toggle("is-ok", ok);
    b.classList.toggle("is-off", !ok);
  });
  barBlock.classList.toggle("is-top", style === "top");

  if (style === "short") { hide(barBlock); show(barShort); }
  else { show(barBlock); hide(barShort); }

  block.classList.add("goal-" + style);

  /* The "% to goal" readout. */
  var pctText = (model.goal.pctOfGoal === null || !isFinite(model.goal.pctOfGoal))
    ? "—"
    : (model.goal.pctOfGoal * 100).toFixed(1) + "% to goal";

  gnote.textContent = pctText +
    " · target " + formatValue(model.goal.value, model.fmt) +
    " · " + (ok ? "on track" : "behind");
  gnote.classList.toggle("is-ok", ok);
  gnote.classList.toggle("is-off", !ok);
  show(gnote);
}

/* ===================================================================
   The trend chart
   -------------------------------------------------------------------
   Prior year is the filled area sitting behind; the current year is a
   clean line on top. The y-axis fits the data rather than starting at
   zero, so the lines fill the chart instead of floating above white
   space. A zero line appears only when the data actually crosses zero,
   and fills anchor to zero so a loss hangs below it.

   Every colour here comes from the palette token set — nothing is
   hard-coded, which is what lets a dark palette work without a second
   code path.
   =================================================================== */

var chartGeom = null;

function drawChart() {
  var host = $("chart");
  if (!host || !model) return;

  var w = host.clientWidth;
  var h = host.clientHeight;
  if (w < 10 || h < 10) { chartGeom = null; return; }

  var showPrior = config.showPrior && model.hasPriorSeries;
  var n = model.slots;

  var padL = 4, padR = 4, padT = 8, padB = 6;
  var innerW = w - padL - padR;
  var innerH = h - padT - padB;

  var all = [];
  var i;
  for (i = 0; i < n; i++) {
    if (model.curSeries[i] !== null) all.push(model.curSeries[i]);
    if (showPrior && model.priorSeries[i] !== null) all.push(model.priorSeries[i]);
  }
  if (!all.length) { host.innerHTML = ""; chartGeom = null; return; }

  var min = Math.min.apply(null, all);
  var max = Math.max.apply(null, all);

  /* A goal at period scale belongs in the domain so the line is always
     visible. A year-to-date goal is an order of magnitude above the
     buckets, so it is drawn only if it already falls inside the range —
     stretching the axis to reach it would flatten the trend. */
  var goalInDomain = model.goal && config.metricMode === "latest";
  if (goalInDomain) {
    min = Math.min(min, model.goal.value);
    max = Math.max(max, model.goal.value);
  }
  if (min === max) { min -= Math.abs(min || 1) * 0.1; max += Math.abs(max || 1) * 0.1; }

  var pad = (max - min) * 0.08;
  var lo = min - pad, hi = max + pad;

  var crossesZero = min < 0 && max > 0;
  if (crossesZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }

  var pal = PALETTES[config.palette] || PALETTES.slate;
  var tok = tokensFor(config.palette);
  var C_ACCENT = tok.accent, C_PRIOR = tok.prior;
  var C_BORDER = tok.border, C_UP = tok.up, C_DOWN = tok.down, C_BG = tok.bg;
  var areaAlpha = pal.dark ? 0.3 : 0.22;

  var denom = n > 1 ? n - 1 : 1;
  function x(idx) { return padL + (innerW * idx) / denom; }
  function y(v) { return padT + innerH - ((v - lo) / (hi - lo)) * innerH; }

  var baseY = crossesZero ? y(0) : padT + innerH;

  var svg = [];
  svg.push('<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
           '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trend by ' +
           GRAIN_NOUN[model.grain] + ' across ' + model.year + '">');

  if (crossesZero) {
    svg.push('<line x1="' + padL + '" y1="' + y(0).toFixed(1) + '" x2="' + (w - padR) +
             '" y2="' + y(0).toFixed(1) + '" stroke="' + C_BORDER + '" stroke-width="1"/>');
  }

  /* Prior year: the filled area, behind everything. */
  if (showPrior) {
    segments(model.priorSeries, n).forEach(function (seg) {
      if (seg.length < 2) {
        svg.push('<circle cx="' + x(seg[0].i).toFixed(1) + '" cy="' + y(seg[0].v).toFixed(1) +
                 '" r="2" fill="' + C_PRIOR + '" fill-opacity="0.6"/>');
        return;
      }
      svg.push('<path d="' + areaPath(seg, x, y, baseY) + '" fill="' + C_PRIOR +
               '" fill-opacity="' + areaAlpha + '"/>');
      svg.push('<path d="' + linePath(seg, x, y) + '" fill="none" stroke="' + C_PRIOR + '" ' +
               'stroke-width="1" stroke-opacity="0.7" stroke-linecap="round" stroke-linejoin="round"/>');
    });
  }

  /* Goal line, only when a goal is set. */
  if (model.goal && model.goal.value >= lo && model.goal.value <= hi) {
    var gy = y(model.goal.value).toFixed(1);
    svg.push('<line x1="' + padL + '" y1="' + gy + '" x2="' + (w - padR) + '" y2="' + gy +
             '" stroke="' + (model.goal.ok ? C_UP : C_DOWN) +
             '" stroke-width="1.25" stroke-dasharray="4 3" stroke-opacity="0.85"/>');
  }

  /* Current year: a clean line on top. */
  segments(model.curSeries, n).forEach(function (seg) {
    if (seg.length < 2) {
      svg.push('<circle cx="' + x(seg[0].i).toFixed(1) + '" cy="' + y(seg[0].v).toFixed(1) +
               '" r="2.6" fill="' + C_ACCENT + '"/>');
      return;
    }
    svg.push('<path d="' + linePath(seg, x, y) + '" fill="none" stroke="' + C_ACCENT + '" ' +
             'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
  });

  var pointCount = 0;
  for (i = 0; i < n; i++) if (model.curSeries[i] !== null) pointCount++;
  if (pointCount <= 24) {
    for (i = 0; i < n; i++) {
      if (model.curSeries[i] === null) continue;
      svg.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + y(model.curSeries[i]).toFixed(1) +
               '" r="2.4" fill="' + C_ACCENT + '"/>');
    }
  }

  /* Hover furniture, moved by the pointer handler rather than redrawn. */
  svg.push('<line id="hover-line" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + innerH) +
           '" stroke="' + C_BORDER + '" stroke-width="1" visibility="hidden"/>');
  svg.push('<circle id="hover-prior" r="3.2" fill="' + C_PRIOR + '" visibility="hidden"/>');
  svg.push('<circle id="hover-cur" r="3.8" fill="' + C_ACCENT + '" stroke="' + C_BG + '" ' +
           'stroke-width="1.5" visibility="hidden"/>');
  svg.push("</svg>");

  host.innerHTML = svg.join("");
  chartGeom = { x: x, y: y, n: n, padL: padL, innerW: innerW, showPrior: showPrior, w: w, h: h };
}

/* Break a series into runs of consecutive non-null points, so a missing
   bucket leaves a gap instead of a straight line across it. */
function segments(series, n) {
  var out = [], cur = [];
  for (var i = 0; i < n; i++) {
    if (series[i] === null || series[i] === undefined) {
      if (cur.length) { out.push(cur); cur = []; }
    } else {
      cur.push({ i: i, v: series[i] });
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function linePath(seg, x, y) {
  return seg.map(function (p, k) {
    return (k ? "L" : "M") + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1);
  }).join(" ");
}

function areaPath(seg, x, y, baseY) {
  var d = linePath(seg, x, y);
  d += " L" + x(seg[seg.length - 1].i).toFixed(1) + " " + baseY.toFixed(1);
  d += " L" + x(seg[0].i).toFixed(1) + " " + baseY.toFixed(1) + " Z";
  return d;
}

/* ===================================================================
   Tooltips — the period and its value, current and prior, in the same
   format as the big number.
   =================================================================== */

function bucketLabel(i) {
  if (model.grain === "year") return String(model.yearsAxis[i]);
  var st = model.startsSeries[i];
  if (st) return periodLabel(st, model.grain);
  return "Slot " + (i + 1);
}

function nearestIndex(clientX) {
  var host = $("chart");
  if (!chartGeom || !host) return -1;
  var rect = host.getBoundingClientRect();
  var px = clientX - rect.left;
  var denom = chartGeom.n > 1 ? chartGeom.n - 1 : 1;
  var idx = Math.round(((px - chartGeom.padL) / chartGeom.innerW) * denom);
  if (idx < 0) idx = 0;
  if (idx > chartGeom.n - 1) idx = chartGeom.n - 1;
  return idx;
}

function moveHover(evt) {
  if (!model || !chartGeom) return;
  var idx = nearestIndex(evt.clientX);
  if (idx < 0) return;

  var cur = model.curSeries[idx];
  var pri = chartGeom.showPrior ? model.priorSeries[idx] : null;
  if (cur === null && pri === null) { hideHover(); return; }

  var svg = $("chart").querySelector("svg");
  if (!svg) return;
  var line = svg.querySelector("#hover-line");
  var dotC = svg.querySelector("#hover-cur");
  var dotP = svg.querySelector("#hover-prior");
  var cx = chartGeom.x(idx);

  if (line) {
    line.setAttribute("x1", cx.toFixed(1));
    line.setAttribute("x2", cx.toFixed(1));
    line.setAttribute("visibility", "visible");
  }
  if (dotC) {
    if (cur === null) dotC.setAttribute("visibility", "hidden");
    else {
      dotC.setAttribute("cx", cx.toFixed(1));
      dotC.setAttribute("cy", chartGeom.y(cur).toFixed(1));
      dotC.setAttribute("visibility", "visible");
    }
  }
  if (dotP) {
    if (pri === null) dotP.setAttribute("visibility", "hidden");
    else {
      dotP.setAttribute("cx", cx.toFixed(1));
      dotP.setAttribute("cy", chartGeom.y(pri).toFixed(1));
      dotP.setAttribute("visibility", "visible");
    }
  }

  var rows = '<div class="tip-head">' + escapeHtml(bucketLabel(idx)) + "</div>";
  if (model.grain === "year") {
    rows += '<div class="tip-row"><span class="tip-key"><i class="sw sw-cur"></i>Value</span>' +
            '<span class="tip-val">' + escapeHtml(formatValue(cur, model.fmt)) + "</span></div>";
  } else {
    rows += '<div class="tip-row"><span class="tip-key"><i class="sw sw-cur"></i>' +
            model.year + '</span><span class="tip-val">' +
            escapeHtml(formatValue(cur, model.fmt)) + "</span></div>";
    if (chartGeom.showPrior) {
      rows += '<div class="tip-row"><span class="tip-key"><i class="sw sw-pri"></i>' +
              model.priorYear + '</span><span class="tip-val">' +
              escapeHtml(formatValue(pri, model.fmt)) + "</span></div>";
    }
  }

  var tip = $("tip");
  tip.innerHTML = rows;
  show(tip);

  /* Keep the tooltip inside the chart area. */
  var wrapW = $("chart").clientWidth;
  var tw = tip.offsetWidth, th = tip.offsetHeight;
  var left = cx + 12;
  if (left + tw > wrapW) left = cx - tw - 12;
  if (left < 0) left = 0;

  var anchorY = cur !== null ? chartGeom.y(cur) : chartGeom.y(pri);
  var top = anchorY - th - 10;
  if (top < 0) top = anchorY + 12;

  tip.style.left = Math.round(left) + "px";
  tip.style.top = Math.round(top) + "px";
}

function hideHover() {
  hide($("tip"));
  var svg = $("chart").querySelector("svg");
  if (!svg) return;
  ["#hover-line", "#hover-cur", "#hover-prior"].forEach(function (sel) {
    var el = svg.querySelector(sel);
    if (el) el.setAttribute("visibility", "hidden");
  });
}

/* ===================================================================
   Render
   =================================================================== */

function render() {
  if (rendering) { rerenderQueued = true; return Promise.resolve(); }
  rendering = true;

  return doRender()
    .catch(function (err) {
      lastError = (err && err.message) ? err.message : String(err);
      note("render failed");
      showEmpty("Something went wrong reading the data. Turn on DEBUG in " +
                "src/main.js to see the details.");
    })
    .then(function () {
      rendering = false;
      if (rerenderQueued) { rerenderQueued = false; render(); }
    });
}

function doRender() {
  debugLines = [];
  lastError = "";

  return worksheet.getVisualSpecificationAsync().then(function (spec) {
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var encodings = (marks && marks.encodings) || [];

    note("encodings seen: " + (encodings.length
      ? encodings.map(function (e) {
          return e.id + "=" + (e.field ? e.field.name : "?");
        }).join(", ")
      : "(none)"));

    var measureEnc = null, dateEnc = null;
    encodings.forEach(function (e) {
      if (e.id === "measure") measureEnc = e;
      if (e.id === "date") dateEnc = e;
    });

    if (!measureEnc || !dateEnc) {
      var missing = [];
      if (!measureEnc) missing.push("Measure");
      if (!dateEnc) missing.push("Date");
      showEmpty("Still waiting on: " + missing.join(" and ") + ".");
      return;
    }

    return readAndDraw(measureEnc, dateEnc);
  });
}

function readAndDraw(measureEnc, dateEnc) {
  return worksheet
    .getSummaryDataReaderAsync(undefined, { ignoreSelection: true })
    .then(function (reader) {
      return reader.getAllPagesAsync().then(function (table) {
        return reader.releaseAsync().then(function () { return table; });
      });
    })
    .then(function (table) {
      note("columns: " + table.columns.map(function (c) {
        return c.fieldName + " [" + c.dataType + "]";
      }).join(", "));

      var measureCol = findColumn(table, measureEnc.field.name, NUMERIC_TYPES);
      var dateCol = findColumn(table, dateEnc.field.name, DATE_TYPES);

      note("matched: measure -> " + (measureCol ? measureCol.fieldName : "NOT FOUND") +
           ", date -> " + (dateCol ? dateCol.fieldName : "NOT FOUND"));
      note("rows read: " + table.data.length);

      if (!measureCol || !dateCol) {
        showEmpty("Could not match the shelf fields to the data columns. " +
                  "Turn on DEBUG in src/main.js to see what arrived.");
        return;
      }
      if (!table.data.length) {
        showEmpty("No rows came back — a filter may be excluding everything.");
        return;
      }

      var built = buildModel(table, measureCol, dateCol, measureEnc);
      if (!built) {
        showEmpty("No usable dates or values in the rows that came back.");
        return;
      }

      model = built;
      note("grain " + model.grain + " · mode " + config.metricMode +
           " · compare " + config.compareMode);
      note("first row date -> " + (model.maxDate ? periodKey(model.maxDate) : "?") +
           " (latest row, after UTC normalisation)");
      note("headline " + model.headlineLabel + " = " + model.headline +
           "; baseline " + model.baselineLabel + " = " + model.baseline);

      paintCard();
      paintDebug();
    });
}

/* ===================================================================
   Boot
   =================================================================== */

tableau.extensions.initializeAsync({ configure: openSettings })
  .then(function () {
    worksheet = tableau.extensions.worksheetContent.worksheet;

    loadConfig();
    wireSettings();

    worksheet.addEventListener(
      tableau.TableauEventType.SummaryDataChanged, render);
    tableau.extensions.settings.addEventListener(
      tableau.TableauEventType.SettingsChanged, function () {
        loadConfig();
        render();
      });

    var chart = $("chart");
    chart.addEventListener("mousemove", moveHover);
    chart.addEventListener("mouseleave", hideHover);

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { if (model) drawChart(); });
      ro.observe(chart);
    } else {
      window.addEventListener("resize", function () { if (model) drawChart(); });
    }

    return render();
  })
  .catch(function (err) {
    lastError = (err && err.message) ? err.message : String(err);
    var noteEl = $("empty-note");
    if (noteEl) {
      noteEl.hidden = false;
      noteEl.textContent = "The extension could not start up. " + lastError;
    }
    paintDebug();
  });
