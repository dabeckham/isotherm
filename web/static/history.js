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

function load(key) { currentKey = key; loadCalendar(key); loadSeries(key); }

function loadSeries(key, from, to) {
  let url = `/api/sensors/${encodeURIComponent(key)}/series`;
  const qs = [];
  if (from) qs.push("from=" + encodeURIComponent(from));
  if (to) qs.push("to=" + encodeURIComponent(to));
  if (qs.length) url += "?" + qs.join("&");
  fetch(url).then(r => r.json()).then(drawChart).catch(() => {});
}

function drawChart(d) {
  const x = d.points.map(p => p.b);
  const avg = d.points.map(p => p.c != null ? +c2f(p.c).toFixed(2) : null);
  const lo = d.points.map(p => p.lo != null ? +c2f(p.lo).toFixed(2) : null);
  const hi = d.points.map(p => p.hi != null ? +c2f(p.hi).toFixed(2) : null);
  const traces = [
    { x, y: hi, mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x, y: lo, mode: "lines", fill: "tonexty", fillcolor: "rgba(120,150,180,.16)",
      line: { width: 0 }, showlegend: false, hoverinfo: "skip", name: "min–max" },
    { x, y: avg, mode: "lines", line: { color: "#38bda6", width: 2 }, name: "°F" },
  ];
  const layout = {
    paper_bgcolor: "#0f1319", plot_bgcolor: "#0f1319", font: { color: "#8ea1b5" },
    margin: { l: 46, r: 14, t: 8, b: 24 }, height: 430, showlegend: false,
    xaxis: {
      gridcolor: "#2a3543", rangeslider: { bgcolor: "#151b24", thickness: 0.08 },
      rangeselector: {
        bgcolor: "#1b2330", activecolor: "#38bda6", font: { color: "#e6edf5" },
        buttons: [
          { count: 1, label: "1d", step: "day", stepmode: "backward" },
          { count: 7, label: "7d", step: "day", stepmode: "backward" },
          { count: 30, label: "30d", step: "day", stepmode: "backward" },
          { step: "all", label: "all" },
        ],
      },
    },
    yaxis: { title: "°F", gridcolor: "#2a3543", zeroline: false },
  };
  Plotly.react("chart", traces, layout,
    { scrollZoom: true, responsive: true, displayModeBar: false });
}

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
