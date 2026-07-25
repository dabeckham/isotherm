#!/usr/bin/env python3
"""Isotherm ingest bridge: MQTT (rtl_433 JSON) -> TimescaleDB.

Subscribes to the rtl_433 events topic, normalizes each decoded packet, stamps
it with an authoritative UTC instant plus the DST-aware offset of the collection
timezone, auto-registers new sensors, and writes one row per distinct reading
into the ``readings`` hypertable. Raw JSON is also appended to a daily JSONL log
so nothing is ever lost.
"""
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import paho.mqtt.client as mqtt
import psycopg2
import psycopg2.extras

MQTT_HOST = os.environ.get("MQTT_HOST", "broker")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_TOPIC = os.environ.get("MQTT_TOPIC", "isotherm/events")
STATION_ID = os.environ.get("STATION_ID", "sl-main")
TZ_NAME = os.environ.get("TZ_NAME", "America/Chicago")
RAW_DIR = Path(os.environ.get("RAW_DIR", "/data/raw"))

PG = dict(
    host=os.environ.get("PGHOST", "timescaledb"),
    port=int(os.environ.get("PGPORT", "5432")),
    user=os.environ.get("PGUSER", "isotherm"),
    password=os.environ.get("PGPASSWORD", "isotherm"),
    dbname=os.environ.get("PGDATABASE", "isotherm"),
)

COLLECT_TZ = ZoneInfo(TZ_NAME)

# rtl_433 repeats each packet several times per burst for reliability. We keep
# the last reported time per sensor and drop exact repeats.
_last_seen: dict[str, str] = {}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def connect_db():
    while True:
        try:
            conn = psycopg2.connect(**PG)
            conn.autocommit = True
            log(f"[db] connected {PG['host']}:{PG['port']}/{PG['dbname']}")
            return conn
        except Exception as e:  # noqa: BLE001
            log(f"[db] not ready ({e}); retry in 3s")
            time.sleep(3)


def offset_str(dt_utc: datetime) -> str:
    """DST-aware UTC offset of the collection tz for this instant, e.g. -05:00."""
    off = dt_utc.astimezone(COLLECT_TZ).utcoffset() or timezone.utc.utcoffset(dt_utc)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}"


def to_celsius(rec: dict):
    if "temperature_C" in rec:
        c = float(rec["temperature_C"])
        return c, round(c * 9 / 5 + 32, 2)
    if "temperature_F" in rec:
        f = float(rec["temperature_F"])
        return round((f - 32) * 5 / 9, 2), f
    return None, None


def sensor_key(rec: dict) -> str:
    parts = [str(rec.get("model", "unknown")), str(rec.get("id", "na"))]
    if rec.get("channel") not in (None, ""):
        parts.append(str(rec["channel"]))
    return "/".join(parts)


def guess_kind(rec: dict) -> str:
    model = str(rec.get("model", ""))
    dtype = str(rec.get("type", "")).upper()
    has_pressure = any(k in rec for k in
                       ("pressure_kPa", "pressure_PSI", "pressure_bar", "pressure_kpa"))
    # TPMS transmitters report a (tire) temperature too, so classify them FIRST.
    if dtype == "TPMS" or has_pressure:
        return "tpms"
    if "Security" in model or model.startswith("DSC"):
        return "security"
    if any(x in model for x in ("Remote", "Megacode", "Cardin", "Secplus", "Markisol")):
        return "remote"
    if "986" in model:
        return "fridge_freezer"
    has_t = "temperature_C" in rec or "temperature_F" in rec
    has_h = "humidity" in rec
    if has_t and has_h:
        return "temp_humidity"
    if has_t:
        return "temperature"
    return "other"


def append_raw(rec: dict):
    try:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        with open(RAW_DIR / f"isotherm-{day}.jsonl", "a") as fh:
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
    except Exception as e:  # noqa: BLE001
        log(f"[raw] write failed: {e}")


def store(conn, rec: dict):
    key = sensor_key(rec)
    stime = str(rec.get("time", ""))
    if stime and _last_seen.get(key) == stime:
        return  # burst repeat
    _last_seen[key] = stime

    at_utc = datetime.now(timezone.utc)
    tzoff = offset_str(at_utc)
    tc, tf = to_celsius(rec)
    append_raw(rec)

    dev_id = str(rec["id"]) if rec.get("id") is not None else None
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sensors (sensor_key, model, dev_id, channel, kind,
                                 first_seen, last_seen, last_station)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (sensor_key) DO UPDATE
              SET last_seen = EXCLUDED.last_seen,
                  last_station = EXCLUDED.last_station
            """,
            (key, rec.get("model"), dev_id, rec.get("channel"),
             guess_kind(rec), at_utc, at_utc, STATION_ID),
        )
        cur.execute(
            """
            INSERT INTO readings (at_utc, tz, tz_offset, sensor_key, station_id,
                                  model, temperature_c, temperature_f, humidity,
                                  battery_ok, rssi, snr, noise, freq_mhz,
                                  sensor_time, raw)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (at_utc, TZ_NAME, tzoff, key, STATION_ID, rec.get("model"),
             tc, tf, rec.get("humidity"), rec.get("battery_ok"),
             rec.get("rssi"), rec.get("snr"), rec.get("noise"), rec.get("freq"),
             rec.get("time"), psycopg2.extras.Json(rec)),
        )
    log(f"[rx] {key} {tc if tc is not None else 'n/a'}C "
        f"rssi={rec.get('rssi')} @ {at_utc.isoformat()} ({tzoff})")


def main():
    log(f"[isotherm] ingest start station={STATION_ID} tz={TZ_NAME} topic={MQTT_TOPIC}")
    conn = connect_db()

    def on_connect(client, userdata, flags, rc):
        log(f"[mqtt] connected rc={rc}; subscribing {MQTT_TOPIC}")
        client.subscribe(MQTT_TOPIC, qos=0)

    def on_message(client, userdata, msg):
        nonlocal conn
        try:
            rec = json.loads(msg.payload.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return
        if "model" not in rec:
            return
        try:
            store(conn, rec)
        except Exception as e:  # noqa: BLE001
            log(f"[db] insert failed ({e}); reconnecting")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = connect_db()

    client = mqtt.Client(client_id=f"isotherm-ingest-{STATION_ID}")
    client.on_connect = on_connect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    running = {"on": True}

    def _stop(*_):
        running["on"] = False
        try:
            client.disconnect()
        except Exception:  # noqa: BLE001
            pass

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    while running["on"]:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            client.loop_forever()
        except Exception as e:  # noqa: BLE001
            if not running["on"]:
                break
            log(f"[mqtt] connect failed ({e}); retry in 3s")
            time.sleep(3)


if __name__ == "__main__":
    main()
