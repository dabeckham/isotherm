"""Isotherm web service: serves the map UI plus a small read API over TimescaleDB.

Endpoints:
  GET /                          -> map UI
  GET /api/stations              -> stations.yaml (sites, receivers, estate center)
  GET /api/estate                -> estate.geojson (fiber/utility/camera/home overlays)
  GET /api/sensors/latest        -> latest reading per sensor
  GET /api/sensors/<key>/history -> 5-minute buckets for a sensor over N hours
"""
import os
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import yaml
from flask import Flask, Response, jsonify, request, send_from_directory

CONFIG_DIR = os.environ.get("CONFIG_DIR", "/config")
PG = dict(
    host=os.environ.get("PGHOST", "timescaledb"),
    port=int(os.environ.get("PGPORT", "5432")),
    user=os.environ.get("PGUSER", "isotherm"),
    password=os.environ.get("PGPASSWORD", "isotherm"),
    dbname=os.environ.get("PGDATABASE", "isotherm"),
)

app = Flask(__name__, static_folder="static", static_url_path="/static")


def query(sql, args=()):
    conn = psycopg2.connect(**PG)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, args)
        return cur.fetchall()
    finally:
        conn.close()


def execute(sql, args=()):
    conn = psycopg2.connect(**PG)
    try:
        cur = conn.cursor()
        cur.execute(sql, args)
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


# Columns a client may set when naming/placing a sensor (whitelist).
ASSIGNABLE = ("friendly_name", "site", "building", "floor", "room",
              "lat", "lon", "floor_x", "floor_y", "floorplan_id")


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/healthz")
def healthz():
    return {"ok": True}


@app.route("/api/stations")
def stations():
    with open(os.path.join(CONFIG_DIR, "stations.yaml")) as fh:
        return jsonify(yaml.safe_load(fh))


@app.route("/api/estate")
def estate():
    path = os.path.join(CONFIG_DIR, "estate.geojson")
    if os.path.exists(path):
        with open(path) as fh:
            return Response(fh.read(), mimetype="application/json")
    return jsonify({"type": "FeatureCollection", "features": []})


@app.route("/api/sensors/latest")
def sensors_latest():
    rows = query(
        """SELECT sensor_key, station_id, model, temperature_c, temperature_f,
                  humidity, battery_ok, rssi, snr, at_utc, tz_offset,
                  friendly_name, site, room, kind, assigned, lat, lon
           FROM sensor_latest ORDER BY sensor_key"""
    )
    for r in rows:
        r["at_utc"] = r["at_utc"].isoformat() if r.get("at_utc") else None
    return jsonify(rows)


@app.route("/api/sensors/<path:key>/history")
def sensor_history(key):
    hours = max(1, min(int(request.args.get("hours", 24)), 720))
    rows = query(
        """SELECT time_bucket('5 minutes', at_utc) AS b,
                  avg(temperature_c) AS c, min(temperature_c) AS lo,
                  max(temperature_c) AS hi, avg(humidity) AS h
           FROM readings
           WHERE sensor_key = %s AND at_utc > now() - (%s || ' hours')::interval
           GROUP BY b ORDER BY b""",
        (key, hours),
    )
    for r in rows:
        r["b"] = r["b"].isoformat()
    return jsonify(rows)


@app.route("/api/sensors/<path:key>/assign", methods=["POST"])
def assign(key):
    data = request.get_json(force=True, silent=True) or {}
    cols = [c for c in ASSIGNABLE if c in data]
    if not cols:
        return jsonify({"error": "no assignable fields"}), 400
    vals = [data[c] for c in cols]
    if any(c in data for c in ("lat", "lon", "floor_x", "floor_y")):
        cols.append("assigned")
        vals.append(True)
    set_clause = ", ".join(f"{c} = %s" for c in cols)
    vals.append(key)
    n = execute(f"UPDATE sensors SET {set_clause} WHERE sensor_key = %s", vals)
    return jsonify({"ok": True, "updated": n})


@app.route("/api/sensors/<path:key>/unassign", methods=["POST"])
def unassign(key):
    execute(
        """UPDATE sensors SET assigned = false, lat = NULL, lon = NULL,
                              floor_x = NULL, floor_y = NULL
           WHERE sensor_key = %s""",
        (key,),
    )
    return jsonify({"ok": True})


@app.route("/history")
def history_page():
    return send_from_directory(app.static_folder, "history.html")


def _parse_iso(value, default):
    if not value:
        return default
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return default


@app.route("/api/sensors/<path:key>/series")
def series(key):
    now = datetime.now(timezone.utc)
    frm = _parse_iso(request.args.get("from"), now - timedelta(hours=24))
    to = _parse_iso(request.args.get("to"), now)
    span_h = max(0.1, (to - frm).total_seconds() / 3600)
    bucket = "5 minutes" if span_h <= 48 else ("1 hour" if span_h <= 24 * 35 else "1 day")
    rows = query(
        """SELECT time_bucket(%s::interval, at_utc) AS b,
                  avg(temperature_c) AS c, min(temperature_c) AS lo,
                  max(temperature_c) AS hi, avg(humidity) AS h
           FROM readings
           WHERE sensor_key = %s AND at_utc >= %s AND at_utc <= %s
           GROUP BY b ORDER BY b""",
        (bucket, key, frm, to),
    )
    for r in rows:
        r["b"] = r["b"].isoformat()
    return jsonify({"bucket": bucket, "from": frm.isoformat(),
                    "to": to.isoformat(), "points": rows})


@app.route("/api/sensors/<path:key>/calendar")
def calendar(key):
    days = max(7, min(int(request.args.get("days", 120)), 400))
    rows = query(
        """SELECT (time_bucket('1 day', at_utc, 'America/Chicago'))::date AS d,
                  avg(temperature_c) AS c, min(temperature_c) AS lo,
                  max(temperature_c) AS hi, count(*) AS n
           FROM readings
           WHERE sensor_key = %s AND at_utc > now() - (%s || ' days')::interval
           GROUP BY d ORDER BY d""",
        (key, days),
    )
    for r in rows:
        r["d"] = r["d"].isoformat()
    return jsonify(rows)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
