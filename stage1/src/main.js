/* ===================================================================
   KPI Card — a Tableau viz extension
   ===================================================================

   Two encoding shelves, read from the manifest by id:
     measure  a continuous measure — totalled for the big number
     date     a temporal field    — drives the timeline

   The card shows:
     - the measure's year-to-date total for the latest year in the data
     - the % change against the SAME Jan-to-month span of the prior year
     - a trend chart that always spans January to December, with the
       current year as a solid line and the prior year behind it as a
       lighter dotted line

   Always a calendar year. Never a rolling window.
   =================================================================== */

/* Flip to true to show the diagnostic strip inside Tableau, where there
   is no browser console. It reports what the extension actually received:
   encodings seen, columns matched, rows read, and the last render error. */
var DEBUG = false;

var VERSION = "v1.0.0";
var SETTINGS_KEY = "kpiCardConfig";

var MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN",
                    "JUL","AUG","SEP","OCT","NOV","DEC"];

var DEFAULT_CONFIG = {
  formatMode: "auto",     // auto | number | currency | percent
  currencySymbol: "$",
  decimals: "auto",       // auto | "0" | "1" | "2"
  abbreviate: true
};

/* Everything the last successful render worked out, kept so a resize can
   redraw the chart without re-reading the data. */
var model = null;
var config = Object.assign({}, DEFAULT_CONFIG);
var worksheet = null;
var rendering = false;
var rerenderQueued = false;
var debugLines = [];
var lastError = "";

/* ---------- tiny DOM helpers ---------- */

function $(id) { return document.getElementById(id); }

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

function note(msg) {
  debugLines.push(msg);
}

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ===================================================================
   Field matching — never by column position (ground rule 3)
   =================================================================== */

/* "SUM(Sales)" -> "sales", "YEAR([Order Date])" -> "order date" */
function baseName(name) {
  var s = String(name == null ? "" : name).trim();
  var prev;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_ ]*\((.*)\)$/, "$1").trim();
    s = s.replace(/^\[(.*)\]$/, "$1").trim();
  } while (s !== prev);
  return s.toLowerCase();
}

var NUMERIC_TYPES = ["float", "int"];
var DATE_TYPES = ["date", "date-time", "datetime"];

function findColumn(table, fieldName, typeFallback) {
  var target = baseName(fieldName);
  var cols = table.columns;
  var i;

  // 1. exact match on the underlying field name
  for (i = 0; i < cols.length; i++) {
    if (baseName(cols[i].fieldName) === target) return cols[i];
  }
  // 2. the field name appears inside the column name
  if (target) {
    for (i = 0; i < cols.length; i++) {
      if (String(cols[i].fieldName).toLowerCase().indexOf(target) !== -1) return cols[i];
    }
  }
  // 3. last resort: the only column of the right data type
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

/* Returns {y, m} or null. Parses a plain date string by hand so a
   timezone offset can never shift it into the previous month. */
function toYearMonth(dv) {
  if (!dv) return null;
  var v = dv.nativeValue;
  if (v === null || v === undefined || v === "") v = dv.value;
  if (v === null || v === undefined || v === "" || v === "%null%") return null;

  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return { y: v.getFullYear(), m: v.getMonth() };
  }

  var s = String(v);
  var m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) - 1 };

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);       // M/D/YYYY
  if (m) return { y: Number(m[3]), m: Number(m[1]) - 1 };

  var d = new Date(s);
  if (!isNaN(d.getTime())) return { y: d.getFullYear(), m: d.getMonth() };
  return null;
}

/* ===================================================================
   Number formatting — mirror Tableau (ground rule 4)
   Infer the display pattern from the column's own formattedValue
   samples instead of inventing one.
   =================================================================== */

function inferFormat(samples) {
  var fmt = {
    prefix: "", suffix: "", decimals: 0,
    isPercent: false, negParen: false
  };
  var seen = 0;

  for (var i = 0; i < samples.length && seen < 40; i++) {
    var s = samples[i];
    if (!s) continue;
    s = String(s).trim();
    if (!s || s === "%null%") continue;
    seen++;

    if (/^\(.*\)$/.test(s)) { fmt.negParen = true; s = s.slice(1, -1); }

    var lead = s.match(/^-?\s*([^\d\s.,+-]+)/);   // $, £, €, ¥, CAD …
    if (lead && !fmt.prefix) fmt.prefix = lead[1];

    if (/%\s*$/.test(s)) { fmt.isPercent = true; fmt.suffix = "%"; }
    else {
      var tail = s.match(/([A-Za-z]{1,3})\s*$/);   // K, M, USD …
      if (tail && !fmt.suffix && !fmt.isPercent) fmt.suffix = "";
    }

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

/* The headline: abbreviated to K/M/B but keeping the currency prefix,
   so Superstore Sales reads $85.2K rather than 85200. */
function formatHeadline(n, fmt) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (!config.abbreviate) return formatNumber(n, fmt);

  var scaled = fmt.isPercent ? n * 100 : n;
  var abs = Math.abs(scaled);
  if (abs < 1000) return formatNumber(n, fmt);

  var div = 1, suf = "";
  if (abs >= 1e12)      { div = 1e12; suf = "T"; }
  else if (abs >= 1e9)  { div = 1e9;  suf = "B"; }
  else if (abs >= 1e6)  { div = 1e6;  suf = "M"; }
  else                  { div = 1e3;  suf = "K"; }

  var v = scaled / div;
  var dec = 1;               // 85.2K, 204.7K, 1.4M — always one decimal
  var neg = v < 0;
  var body = Math.abs(v).toFixed(dec) + suf;

  var out = fmt.prefix + body + fmt.suffix;
  if (neg) out = fmt.negParen ? "(" + out + ")" : "-" + out;
  return out;
}

/* ===================================================================
   Settings
   =================================================================== */

function loadConfig() {
  config = Object.assign({}, DEFAULT_CONFIG);
  try {
    var raw = tableau.extensions.settings.get(SETTINGS_KEY);
    if (raw) Object.assign(config, JSON.parse(raw));
  } catch (e) {
    note("settings: could not parse saved config, using defaults");
  }
}

function saveConfig() {
  tableau.extensions.settings.set(SETTINGS_KEY, JSON.stringify(config));
  return tableau.extensions.settings.saveAsync();
}

function syncSettingsForm() {
  $("fmt-mode").value = config.formatMode;
  $("fmt-symbol").value = config.currencySymbol;
  $("fmt-decimals").value = String(config.decimals);
  $("fmt-abbrev").checked = !!config.abbreviate;
  toggleSymbolField();
}

function toggleSymbolField() {
  var f = $("fmt-symbol-field");
  if ($("fmt-mode").value === "currency") show(f); else hide(f);
}

function openSettings() {
  syncSettingsForm();
  show($("settings"));
  return Promise.resolve();
}

function closeSettings() { hide($("settings")); }

function wireSettings() {
  $("gear").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-cancel").addEventListener("click", closeSettings);
  $("fmt-mode").addEventListener("change", toggleSymbolField);

  $("settings-save").addEventListener("click", function () {
    config.formatMode = $("fmt-mode").value;
    config.currencySymbol = $("fmt-symbol").value || "$";
    config.decimals = $("fmt-decimals").value;
    config.abbreviate = $("fmt-abbrev").checked;
    saveConfig().then(function () {
      closeSettings();
      render();
    }).catch(function (e) {
      lastError = "saving settings: " + (e && e.message ? e.message : e);
      paintDebug();
      closeSettings();
    });
  });
}

/* ===================================================================
   Empty state
   =================================================================== */

function showEmpty(extraNote) {
  model = null;
  hide($("card"));
  $("empty-note").textContent = extraNote || "";
  show($("empty"));
  paintDebug();
}

/* ===================================================================
   Render
   =================================================================== */

function render() {
  // Coalesce bursts of events into one pass.
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
      note("current year " + model.currentYear +
           " through " + MONTHS_SHORT[model.lastMonth] +
           "; prior year " + (model.hasPrior ? model.priorYear : "none"));

      paintCard();
      paintDebug();
    });
}

/* ---------- aggregate into calendar months ---------- */

function buildModel(table, measureCol, dateCol, measureEnc) {
  var mi = measureCol.index, di = dateCol.index;
  var byYear = {};          // year -> Float64Array(12)
  var seen = {};            // year -> boolean[12], so 0 is distinct from "no data"
  var samples = [];
  var usable = 0;

  for (var r = 0; r < table.data.length; r++) {
    var row = table.data[r];
    var ym = toYearMonth(row[di]);
    if (!ym) continue;
    var n = toNumber(row[mi]);
    if (n === null) continue;

    if (!byYear[ym.y]) {
      byYear[ym.y] = new Float64Array(12);
      seen[ym.y] = [];
    }
    byYear[ym.y][ym.m] += n;
    seen[ym.y][ym.m] = true;
    usable++;

    if (samples.length < 40 && row[mi] && row[mi].formattedValue) {
      samples.push(row[mi].formattedValue);
    }
  }

  if (!usable) return null;

  // "Current" is the latest year present in the data, not today's year,
  // so the card still renders on older sample data.
  var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });
  var currentYear = years[years.length - 1];
  var priorYear = currentYear - 1;

  var cur = byYear[currentYear];
  var curSeen = seen[currentYear];
  var prior = byYear[priorYear] || null;
  var priorSeen = seen[priorYear] || [];

  var lastMonth = -1;
  for (var m = 0; m < 12; m++) if (curSeen[m]) lastMonth = m;
  if (lastMonth < 0) return null;

  // Year to date, and the SAME Jan-to-lastMonth span a year earlier.
  var curTotal = 0, priorTotal = 0, priorHasSpan = false;
  for (var k = 0; k <= lastMonth; k++) {
    if (curSeen[k]) curTotal += cur[k];
    if (prior && priorSeen[k]) { priorTotal += prior[k]; priorHasSpan = true; }
  }

  var pct = null;
  if (priorHasSpan && priorTotal !== 0) {
    pct = (curTotal - priorTotal) / Math.abs(priorTotal);
  }

  // Series for the chart: null means "no data in that month"
  var curSeries = [], priorSeries = [];
  for (var j = 0; j < 12; j++) {
    curSeries.push(curSeen[j] ? cur[j] : null);
    priorSeries.push(prior && priorSeen[j] ? prior[j] : null);
  }

  var inferred = inferFormat(samples);

  return {
    label: baseName(measureEnc.field.name) ? measureEnc.field.name : "Measure",
    currentYear: currentYear,
    priorYear: priorYear,
    lastMonth: lastMonth,
    curTotal: curTotal,
    priorTotal: priorTotal,
    hasPrior: priorHasSpan,
    pct: pct,
    curSeries: curSeries,
    priorSeries: priorSeries,
    fmt: effectiveFormat(inferred),
    rawFmt: inferred
  };
}

/* ---------- the text block ---------- */

function paintCard() {
  hide($("empty"));
  show($("card"));

  $("label").textContent = String(model.label).toUpperCase();
  $("label").title = String(model.label);
  $("value").textContent = formatHeadline(model.curTotal, model.fmt);

  var deltaEl = $("delta");
  var arrowEl = deltaEl.querySelector(".delta-arrow");
  var textEl = deltaEl.querySelector(".delta-text");
  deltaEl.classList.remove("is-up", "is-down", "is-flat");

  // "2022" for a full year, "Jan 2022" for a single month, else the span.
  var spanLabel;
  if (model.lastMonth === 11) {
    spanLabel = String(model.priorYear);
  } else if (model.lastMonth === 0) {
    spanLabel = titleCase(MONTHS_SHORT[0]) + " " + model.priorYear;
  } else {
    spanLabel = "Jan\u2013" + titleCase(MONTHS_SHORT[model.lastMonth]) +
                " " + model.priorYear;
  }

  if (model.pct === null) {
    arrowEl.textContent = "";
    textEl.textContent = model.hasPrior
      ? "No % change \u2014 " + spanLabel + " totalled zero"
      : "No " + model.priorYear + " data to compare against";
    deltaEl.classList.add("is-flat");
  } else {
    var up = model.pct > 0, down = model.pct < 0;
    arrowEl.textContent = up ? "▲" : (down ? "▼" : "▬");
    textEl.textContent = Math.abs(model.pct * 100).toFixed(1) + "% vs " + spanLabel;
    deltaEl.classList.add(up ? "is-up" : (down ? "is-down" : "is-flat"));
  }

  $("asof").textContent = "AS OF " + MONTHS_SHORT[model.lastMonth] + " " + model.currentYear;
  drawChart();
}

function titleCase(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/* ---------- the trend chart ----------
   Always twelve slots, January to December. Current year solid, prior
   year behind it dotted. The y-axis fits the data's min-max with padding
   rather than starting at zero, so the line shows shape instead of
   collapsing into a ribbon. */

function drawChart() {
  var host = $("chart");
  if (!host || !model) return;

  var w = host.clientWidth;
  var h = host.clientHeight;
  if (w < 10 || h < 10) return;

  var padL = 3, padR = 3, padT = 6, padB = 4;
  var innerW = w - padL - padR;
  var innerH = h - padT - padB;

  var all = [];
  var i;
  for (i = 0; i < 12; i++) {
    if (model.curSeries[i] !== null) all.push(model.curSeries[i]);
    if (model.priorSeries[i] !== null) all.push(model.priorSeries[i]);
  }
  if (!all.length) { host.innerHTML = ""; return; }

  var min = Math.min.apply(null, all);
  var max = Math.max.apply(null, all);
  if (min === max) { min -= 1; max += 1; }

  var pad = (max - min) * 0.14;
  var lo = min - pad, hi = max + pad;

  var crossesZero = min < 0 && max > 0;
  if (crossesZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }

  function x(idx) { return padL + (innerW * idx) / 11; }
  function y(v) { return padT + innerH - ((v - lo) / (hi - lo)) * innerH; }

  // Fills anchor to zero when the series crosses it, so a loss hangs
  // below the line instead of reading as a tall block of gain.
  var baseY = crossesZero ? y(0) : padT + innerH;

  var svg = [];
  svg.push('<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
           '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Monthly trend, January to December">');

  svg.push('<defs><linearGradient id="curFill" x1="0" y1="0" x2="0" y2="1">' +
           '<stop offset="0%" stop-color="#3b82f6" stop-opacity="0.20"/>' +
           '<stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02"/>' +
           '</linearGradient></defs>');

  if (crossesZero) {
    svg.push('<line x1="' + padL + '" y1="' + y(0).toFixed(1) + '" x2="' + (w - padR) +
             '" y2="' + y(0).toFixed(1) + '" stroke="#e2e8f0" stroke-width="1"/>');
  }

  // Prior year first, so it sits behind.
  var priorSegs = segments(model.priorSeries);
  priorSegs.forEach(function (seg) {
    if (seg.length < 2) return;
    svg.push('<path d="' + areaPath(seg, x, y, baseY) + '" fill="#94a3b8" fill-opacity="0.10"/>');
    svg.push('<path d="' + linePath(seg, x, y) + '" fill="none" stroke="#cbd5e1" ' +
             'stroke-width="1.5" stroke-dasharray="3 3" stroke-linecap="round" ' +
             'stroke-linejoin="round"/>');
  });

  var curSegs = segments(model.curSeries);
  curSegs.forEach(function (seg) {
    if (seg.length < 2) return;
    svg.push('<path d="' + areaPath(seg, x, y, baseY) + '" fill="url(#curFill)"/>');
    svg.push('<path d="' + linePath(seg, x, y) + '" fill="none" stroke="#3b82f6" ' +
             'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
  });

  // Point markers on the current year, as in the reference card.
  var pointCount = 0;
  for (i = 0; i < 12; i++) if (model.curSeries[i] !== null) pointCount++;
  if (pointCount <= 24) {
    for (i = 0; i < 12; i++) {
      if (model.curSeries[i] === null) continue;
      svg.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + y(model.curSeries[i]).toFixed(1) +
               '" r="2.4" fill="#3b82f6"/>');
    }
  }

  svg.push("</svg>");
  host.innerHTML = svg.join("");
}

/* Break a 12-slot series into runs of consecutive non-null points, so a
   missing month leaves a gap instead of a straight line across it. */
function segments(series) {
  var out = [], cur = [];
  for (var i = 0; i < 12; i++) {
    if (series[i] === null) {
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
   Boot
   =================================================================== */

tableau.extensions.initializeAsync({ configure: openSettings })
  .then(function () {
    worksheet = tableau.extensions.worksheetContent.worksheet;

    loadConfig();
    wireSettings();

    // Stay live: re-render on data, filter, and settings changes.
    worksheet.addEventListener(
      tableau.TableauEventType.SummaryDataChanged, render);
    tableau.extensions.settings.addEventListener(
      tableau.TableauEventType.SettingsChanged, function () {
        loadConfig();
        render();
      });

    // Redraw the chart when the worksheet is resized.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { if (model) drawChart(); });
      ro.observe($("chart"));
    } else {
      window.addEventListener("resize", function () { if (model) drawChart(); });
    }

    return render();
  })
  .catch(function (err) {
    lastError = (err && err.message) ? err.message : String(err);
    var noteEl = $("empty-note");
    if (noteEl) {
      noteEl.textContent = "The extension could not start up. " + lastError;
    }
    paintDebug();
  });
