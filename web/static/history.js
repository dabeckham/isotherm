/* Isotherm history view: calendar heatmap + zoomable/scrollable time-series. */

const AMBIENT = [[0,[24,95,165]],[32,[55,138,221]],[55,[29,158,117]],
                 [72,[176,178,169]],[82,[239,159,39]],[92,[216,90,48]],[100,[226,75,74]]];
function lerp(stops, v) {
  if (v <= stops[0][0]) return rgb(stops[0][1]);
  const last = stops[stops.length - 1];
  if (v >= last[0]) return rgb(last[1]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (v >= a && v <= b) {
      const t = (v - a) / (b - a);
      return rgb([0, 1, 2].map(k => Math.round(ca[k] + (cb[k] - ca[k]) * t)));
    }
  }
  return rgb(last[1]);
}
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const c2f = c => c * 9 / 5 + 32;
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
  "-" + String(d.getDate()).padStart(2, "0");

let currentKey = null;

fetch("/api/sensors/latest").then(r => r.json()).then(rows => {
  const env = rows.filter(r => ["temperature", "temp_humidity", "fridge_freezer"].includes(r.kind));
  const sel = document.getElementById("sensor");
  env.forEach(r => {
    const o = document.createElement("option");
    o.value = r.sensor_key;
    o.textContent = (r.friendly_name || r.sensor_key) + (r.kind === "fridge_freezer" ? " (cold)" : "");
    sel.appendChild(o);
  });
  sel.onchange = () => load(sel.value);
  if (env.length) load(env[0].sensor_key);
  else document.getElementById("calendar").innerHTML =
    '<div class="hint">No environmental sensors yet.</div>';
});

function load(key) { currentKey = key; renderPresets(); loadCalendar(key); loadSeries(key); }

function loadSeries(key, from, to) {
  let url = `/api/sensors/${encodeURIComponent(key)}/series`;
  const qs = [];
  if (from) qs.push("from=" + encodeURIComponent(from));
  if (to) qs.push("to=" + encodeURIComponent(to));
  if (qs.length) url += "?" + qs.join("&");
  fetch(url).then(r => r.json()).then(drawChart).catch(() => {});
}

let uplot = null;

function drawChart(d) {
  const xs = d.points.map(p => Math.floor(new Date(p.b).getTime() / 1000));
  const mn = d.points.map(p => p.lo != null ? +c2f(p.lo).toFixed(2) : null);
  const mx = d.points.map(p => p.hi != null ? +c2f(p.hi).toFixed(2) : null);
  const av = d.points.map(p => p.c != null ? +c2f(p.c).toFixed(2) : null);
  const el = document.getElementById("chart");
  const opts = {
    width: el.clientWidth || 900, height: 420,
    scales: { x: { time: true } },
    cursor: { drag: { x: true, y: false } },
    axes: [
      { stroke: "#8ea1b5", grid: { stroke: "#232c38" }, ticks: { stroke: "#232c38" } },
      { stroke: "#8ea1b5", grid: { stroke: "#232c38" }, ticks: { stroke: "#232c38" }, size: 52,
        values: (u, vals) => vals.map(v => v + "°") },
    ],
    series: [
      {},
      { label: "min", stroke: "rgba(130,160,190,.6)", width: 1, points: { show: false } },
      { label: "max", stroke: "rgba(130,160,190,.6)", width: 1, points: { show: false } },
      { label: "avg °F", stroke: "#38bda6", width: 2, points: { show: false } },
    ],
    bands: [{ series: [2, 1], fill: "rgba(120,150,180,.14)" }],
  };
  if (uplot) uplot.destroy();
  el.innerHTML = "";
  uplot = new uPlot(opts, [xs, mn, mx, av], el);
}

function rangeDays(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  loadSeries(currentKey, from.toISOString(), to.toISOString());
}

function renderPresets() {
  const box = document.getElementById("presets");
  if (!box || box.childElementCount) return;
  [["24h", 1], ["7d", 7], ["30d", 30], ["all", 400]].forEach(([label, days]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => rangeDays(days);
    box.appendChild(b);
  });
}

window.addEventListener("resize", () => {
  if (uplot) uplot.setSize({ width: document.getElementById("chart").clientWidth || 900, height: 420 });
});

function loadCalendar(key) {
  fetch(`/api/sensors/${encodeURIComponent(key)}/calendar?days=120`)
    .then(r => r.json()).then(renderCal).catch(() => {});
}

function renderCal(days) {
  const box = document.getElementById("calendar");
  box.innerHTML = "";
  const map = {};
  days.forEach(d => (map[d.d] = d));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - 119);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday
  const grid = document.createElement("div");
  grid.className = "cal-grid";
  let withData = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const iso = ymd(d);
    const rec = map[iso];
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (rec && rec.c != null) {
      withData++;
      cell.style.background = lerp(AMBIENT, c2f(rec.c));
      cell.title = `${iso}: avg ${c2f(rec.c).toFixed(0)}°F (${c2f(rec.lo).toFixed(0)}–${c2f(rec.hi).toFixed(0)})`;
      cell.style.cursor = "pointer";
      const day = new Date(d);
      cell.onclick = () => {
        const to = new Date(day); to.setDate(to.getDate() + 1);
        loadSeries(currentKey, day.toISOString(), to.toISOString());
      };
    } else {
      cell.title = iso;
    }
    grid.appendChild(cell);
  }
  box.appendChild(grid);
  if (!withData) {
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = "Only a little history so far — the calendar fills in day by day.";
    box.appendChild(note);
  }
}
