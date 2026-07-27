/* Isotherm device manager: rename devices and set where they live.
   Plain table, no libraries — every edit POSTs to /api/sensors/<key>/assign. */

const ENV = ["temperature", "temp_humidity", "fridge_freezer"];
const GROUPS = [
  ["Environmental sensors", r => ENV.includes(r.kind)],
  ["TPMS · tire pressure", r => r.kind === "tpms"],
  ["Security contacts", r => r.kind === "security"],
  ["Remotes / buttons", r => r.kind === "remote"],
  ["Other", r => !r.kind || r.kind === "other"],
];

let sites = [];

const esc = s => String(s == null ? "" : s).replace(/"/g, "&quot;");
const c2f = c => c * 9 / 5 + 32;

function fmtAgo(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function reading(r) {
  if (r.kind === "tpms") return "tire";
  const f = r.temperature_f != null ? r.temperature_f
    : (r.temperature_c != null ? c2f(r.temperature_c) : null);
  if (f == null) return "—";
  return f.toFixed(1) + "°F" + (r.humidity != null ? " · " + Math.round(r.humidity) + "%" : "");
}

function assign(key, body) {
  fetch(`/api/sensors/${encodeURIComponent(key)}/assign`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function row(r) {
  const tr = document.createElement("tr");
  const isEnv = ENV.includes(r.kind);
  const opts = ['<option value="">—</option>']
    .concat(sites.map(s => `<option value="${s}"${r.site === s ? " selected" : ""}>${s}</option>`))
    .join("");
  tr.innerHTML = `
    <td><span class="sd" style="background:${isEnv ? "#38bda6" : "#4a5a6a"}"></span></td>
    <td><input class="ri name" placeholder="${esc(r.sensor_key)}" value="${esc(r.friendly_name)}"></td>
    <td class="mono">${r.sensor_key}</td>
    <td>${reading(r)}</td>
    <td class="muted">${r.battery_ok == null ? "" : (r.battery_ok ? "ok" : "low")}</td>
    <td class="muted">${r.rssi != null ? Math.round(r.rssi) : ""}</td>
    <td class="muted">${fmtAgo(r.at_utc)}</td>
    <td><select class="ri site">${opts}</select></td>
    <td><input class="ri room" placeholder="room" value="${esc(r.room)}"></td>`;
  const nm = tr.querySelector(".name");
  nm.onchange = () => assign(r.sensor_key, { friendly_name: nm.value.trim() });
  const si = tr.querySelector(".site");
  si.onchange = () => assign(r.sensor_key, { site: si.value });
  const rm = tr.querySelector(".room");
  rm.onchange = () => assign(r.sensor_key, { room: rm.value.trim() });
  return tr;
}

function render(rows) {
  document.getElementById("count").textContent = rows.length + " devices";
  const box = document.getElementById("tables");
  box.innerHTML = "";
  GROUPS.forEach(([title, pred]) => {
    const g = rows.filter(pred);
    if (!g.length) return;
    const sec = document.createElement("div");
    sec.className = "tgroup";
    sec.innerHTML = `<div class="section-label">${title} · ${g.length}</div>`;
    const tbl = document.createElement("table");
    tbl.className = "stbl";
    tbl.innerHTML = "<thead><tr><th></th><th>name</th><th>device</th><th>reading</th>" +
      "<th>batt</th><th>sig</th><th>seen</th><th>site</th><th>room</th></tr></thead>";
    const tb = document.createElement("tbody");
    g.forEach(r => tb.appendChild(row(r)));
    tbl.appendChild(tb);
    sec.appendChild(tbl);
    box.appendChild(sec);
  });
}

Promise.all([
  fetch("/api/stations").then(r => r.json()).catch(() => ({})),
  fetch("/api/sensors/latest").then(r => r.json()),
]).then(([st, rows]) => {
  sites = (st.sites || []).map(s => s.id);
  rows.sort((a, b) => a.sensor_key.localeCompare(b.sensor_key));
  render(rows);
}).catch(() => {
  document.getElementById("tables").innerHTML =
    '<div class="hint">Could not load devices.</div>';
});
