/* Isotherm estate map. Leaflet + Esri satellite, estate GeoJSON overlays,
   live sensor markers/list from the API. */

const NEIGHBOR_CAMERA_ZONES = new Set(["Jarod Brandt", "Billie", "Alice", "Eric and Jen"]);

const AMBIENT = [[0,[24,95,165]],[32,[55,138,221]],[55,[29,158,117]],
                 [72,[176,178,169]],[82,[239,159,39]],[92,[216,90,48]],[100,[226,75,74]]];
const COLD = [[-20,[4,44,83]],[0,[12,68,124]],[20,[24,95,165]],[35,[55,138,221]],[45,[133,183,235]]];

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
const tempColor = (f, kind) => lerp(kind === "fridge_freezer" ? COLD : AMBIENT, f);

const CAT_STYLE = {
  fiber: { color: "#ff8c42", weight: 3 },
  cat5:  { color: "#4aa3ff", weight: 2, dashArray: "4 3" },
  power: { color: "#e24b4a", weight: 2 },
  water: { color: "#2bb3e0", weight: 2 },
  sewer: { color: "#9b7b4a", weight: 2 },
  gas:   { color: "#f4c430", weight: 2 },
};

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([30.4196, -95.557], 16);

// Base imagery, all served through this server: local drone tiles first, public
// imagery fetched + cached as fallback. The browser never calls a third party.
const baseLayer = id => L.tileLayer(`/tiles/${id}/{z}/{x}/{y}.png`, {
  maxZoom: 21, maxNativeZoom: 19,
  attribution: "Isotherm · self-hosted tiles (Esri / OSM fallback)",
});
const baseLayers = {
  "Estate (self-hosted)": baseLayer("estate"),
  "Satellite": baseLayer("satellite"),
  "Streets": baseLayer("streets"),
};
baseLayers["Estate (self-hosted)"].addTo(map);

const layers = {
  fiber: L.layerGroup().addTo(map),
  utility: L.layerGroup(),
  pedestals: L.layerGroup(),
  cameras: L.layerGroup(),
  homes: L.layerGroup().addTo(map),
  sensors: L.layerGroup().addTo(map),
};
L.control.layers(baseLayers, {
  "Fiber": layers.fiber, "Utilities (Cat5/power/water/…)": layers.utility,
  "Pedestals": layers.pedestals, "Cameras": layers.cameras,
  "Homes": layers.homes, "Sensors": layers.sensors,
}, { collapsed: false, position: "topright" }).addTo(map);

let sites = {};

fetch("/api/stations").then(r => r.json()).then(cfg => {
  (cfg.sites || []).forEach(s => { sites[s.id] = s; });
  if (cfg.estate_center) map.setView(cfg.estate_center, 16);
  (cfg.sites || []).forEach(s => {
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "", html: `<div class="site-label">${s.label}</div>`,
        iconSize: [0, 0], iconAnchor: [-8, 8] }),
    }).addTo(map);
    L.circleMarker([s.lat, s.lon], { radius: 6, color: "#38bda6", weight: 2,
      fillColor: "#38bda6", fillOpacity: .5 }).bindTooltip(`${s.label} — demarc`).addTo(map);
  });
});

fetch("/api/estate").then(r => r.json()).then(gj => {
  (gj.features || []).forEach(f => {
    const cat = f.properties.category, name = f.properties.name;
    const g = f.geometry;
    if (g.type === "LineString") {
      const latlngs = g.coordinates.map(c => [c[1], c[0]]);
      const st = CAT_STYLE[cat] || { color: "#888", weight: 2 };
      const line = L.polyline(latlngs, { ...st, opacity: .85 }).bindTooltip(name);
      line.addTo(cat === "fiber" ? layers.fiber : layers.utility);
    } else if (g.type === "Point") {
      const ll = [g.coordinates[1], g.coordinates[0]];
      if (cat === "pedestal") {
        L.circleMarker(ll, { radius: 3, color: "#c7d2dd", weight: 1, fillOpacity: .7 })
          .bindTooltip(name).addTo(layers.pedestals);
      } else if (cat === "camera") {
        L.circleMarker(ll, { radius: 4, color: "#b39ddb", weight: 1, fillColor: "#7e57c2", fillOpacity: .8 })
          .bindTooltip(name).addTo(layers.cameras);
      } else {
        const zone = NEIGHBOR_CAMERA_ZONES.has(name);
        L.circleMarker(ll, { radius: 5, weight: 2,
          color: zone ? "#7e57c2" : "#e6edf5",
          fillColor: zone ? "#4a3b66" : "#38506a", fillOpacity: .85 })
          .bindTooltip(zone ? `${name} — camera zone` : name).addTo(layers.homes);
      }
    }
  });
});

function fmtAgo(iso) {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const latlon = ll => ({ lat: +ll.lat.toFixed(7), lon: +ll.lng.toFixed(7) });
function assignSensor(key, body) {
  return fetch(`/api/sensors/${encodeURIComponent(key)}/assign`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(() => refresh()).catch(() => {});
}

let sensorMarks = {};

const ENV_KINDS = new Set(["temperature", "temp_humidity", "fridge_freezer"]);
const KIND_LABEL = { tpms: "TPMS · tire pressure", security: "Security contacts",
  remote: "Remotes / buttons", other: "Other 433" };

function renderSensors(rows) {
  const env = rows.filter(r => ENV_KINDS.has(r.kind));
  const other = rows.filter(r => !ENV_KINDS.has(r.kind));
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="n">${env.length}</div><div class="l">environmental</div></div>
    <div class="stat"><div class="n">${env.filter(r => r.assigned).length}</div><div class="l">placed</div></div>
    <div class="stat"><div class="n">${other.length}</div><div class="l">other 433</div></div>`;

  layers.sensors.clearLayers();
  sensorMarks = {};
  const box = document.getElementById("sensors");
  box.innerHTML = "";
  const sl = sites.SL || { lat: 30.4204, lon: -95.5612 };

  env.forEach((r, i) => {
    const f = r.temperature_f != null ? r.temperature_f
      : (r.temperature_c != null ? r.temperature_c * 9 / 5 + 32 : null);
    const col = f != null ? tempColor(f, r.kind) : "#556";
    const label = r.friendly_name || r.sensor_key;
    const cold = r.kind === "fridge_freezer";

    const card = document.createElement("div");
    card.className = "sensor";
    card.innerHTML = `
      <div class="row"><span class="dot" style="background:${col}"></span>
        <span class="name">${label}</span>
        <span class="temp">${f != null ? f.toFixed(1) + "°F" : "—"}</span></div>
      <div class="meta">
        ${r.humidity != null ? `<span>${Math.round(r.humidity)}% RH</span>` : ""}
        <span class="badge ${cold ? "cold" : ""}">${cold ? "cold-chain" : r.kind}</span>
        <span>${r.battery_ok ? "batt ok" : "batt low"}</span>
        <span>${r.rssi != null ? Math.round(r.rssi) + " dBm" : ""}</span>
        <span>${fmtAgo(r.at_utc)}</span></div>
      <canvas width="290" height="46"></canvas>`;
    card.onclick = () => loadHistory(r.sensor_key, card.querySelector("canvas"), r.kind);
    box.appendChild(card);
    const nameEl = card.querySelector(".name");
    nameEl.title = "click to rename";
    nameEl.onclick = ev => {
      ev.stopPropagation();
      const v = prompt("Name this sensor:", r.friendly_name || "");
      if (v !== null) assignSensor(r.sensor_key, { friendly_name: v.trim() });
    };
    loadHistory(r.sensor_key, card.querySelector("canvas"), r.kind);

    let lat = r.lat, lon = r.lon;
    if (lat == null || lon == null) {
      const ang = i * 2.399, rad = 0.00012 * (1 + i * 0.12);
      lat = sl.lat + Math.sin(ang) * rad; lon = sl.lon + Math.cos(ang) * rad;
    }
    const icon = L.divIcon({ className: "",
      html: `<div class="sensor-mark" style="background:${col}"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9] });
    const m = L.marker([lat, lon], { icon, draggable: true })
      .bindTooltip(`${label}: ${f != null ? f.toFixed(1) + "°F" : "—"}${r.assigned ? "" : " (drag to place)"}`,
        { direction: "top" });
    m.on("dragend", e => assignSensor(r.sensor_key, latlon(e.target.getLatLng())));
    m.addTo(layers.sensors);
    sensorMarks[r.sensor_key] = m;
  });

  renderOthers(other);
}

function renderOthers(rows) {
  document.getElementById("other-label").style.display = rows.length ? "" : "none";
  const box = document.getElementById("others");
  box.innerHTML = "";
  const groups = {};
  rows.forEach(r => (groups[r.kind] = groups[r.kind] || []).push(r));
  Object.keys(groups).sort().forEach(k => {
    const wrap = document.createElement("div");
    wrap.className = "ogroup";
    wrap.innerHTML = `<div class="okind">${KIND_LABEL[k] || k} · ${groups[k].length}</div>`;
    groups[k].forEach(r => {
      const row = document.createElement("div");
      row.className = "orow";
      row.innerHTML = `<span class="oname">${r.friendly_name || r.sensor_key}</span>
        <span class="oago">${fmtAgo(r.at_utc)}</span>`;
      row.querySelector(".oname").onclick = () => {
        const v = prompt("Name this device:", r.friendly_name || "");
        if (v !== null) assignSensor(r.sensor_key, { friendly_name: v.trim() });
      };
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  });
}

function loadHistory(key, canvas, kind) {
  fetch(`/api/sensors/${encodeURIComponent(key)}/history?hours=24`)
    .then(r => r.json()).then(rows => drawSpark(canvas, rows, kind))
    .catch(() => {});
}

function drawSpark(cv, rows, kind) {
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const pts = rows.filter(r => r.c != null).map(r => +r.c);
  if (pts.length < 2) return;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = (hi - lo) || 1;
  const x = i => (i / (pts.length - 1)) * (W - 2) + 1;
  const y = v => H - 4 - ((v - lo) / span) * (H - 8);
  ctx.beginPath();
  pts.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.strokeStyle = tempColor(pts[pts.length - 1] * 9 / 5 + 32, kind);
  ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = "#8ea1b5"; ctx.font = "10px system-ui";
  ctx.fillText(`${(lo * 9 / 5 + 32).toFixed(0)}–${(hi * 9 / 5 + 32).toFixed(0)}°F · 24h`, 2, 10);
}

function renderLegend() {
  const stops = [[0, "0"], [32, "32"], [55, "55"], [72, "72"], [82, "82"], [92, "92"], [100, "100+"]];
  const bar = stops.map(s => `<span style="background:${tempColor(s[0], "")}"></span>`).join("");
  const ticks = stops.map(s => `<span>${s[1]}</span>`).join("");
  document.getElementById("legend").innerHTML =
    `<div class="bar">${bar}</div><div class="ticks">${ticks}</div>
     <div>°F · fridge/freezer shown on a separate cold scale</div>`;
}

function refresh() {
  fetch("/api/sensors/latest").then(r => r.json()).then(renderSensors).catch(() => {});
}
renderLegend();
refresh();
setInterval(refresh, 15000);
