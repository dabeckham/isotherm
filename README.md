# Isotherm

**A 433 MHz environmental sensor network — from radio packets to a live, zoomable thermal map.**

Isotherm listens to inexpensive 433 MHz sensors (temperature, humidity, and more)
with a software-defined radio, decodes them with [`rtl_433`](https://github.com/merbanan/rtl_433),
and turns the stream into a time-series history you can explore: a multi-scale
map that zooms from a wide-area property view all the way down to individual
floorplans, interpolated heatmaps, weather-radar-style time-lapse playback, and a
calendar of scrollable, zoomable historical graphs.

It is built to be **multi-receiver from day one** — a large site needs more than
one radio, so every reading is tagged with the station that heard it.

```
   433 MHz sensors                 one receiver per property (tagged station_id)
   (Acurite, etc.)                       │
        ((( ))) ───────────────▶  RTL-SDR ──▶  rtl_433  ──▶  MQTT broker
                                                                  │
                                                                  ▼
                                                    ingest bridge (normalize,
                                                    UTC + DST-aware offset,
                                                    auto-register sensors)
                                                                  │
                                                                  ▼
                                                          TimescaleDB
                                                     (hypertable + continuous
                                                      aggregates)
                                                                  │
                                                                  ▼
                                                       API  ──▶  dashboard
                                                (map · heatmap · time-lapse ·
                                                 calendar history · alerts)
```

## Status

| Phase | Scope | State |
|------:|-------|-------|
| **1** | Capture → MQTT → TimescaleDB ingest, auto-registering sensors | **built** |
| 2 | REST/stream API + live multi-scale map (wide-area → floorplan) | planned |
| 3 | Interpolated heat field, time-lapse "weather radar", calendar history, alerts | planned |

## Hardware

- Any RTL-SDR / RTL2832U USB dongle (tested with an FC0012-tuner unit).
- No kernel driver blacklist is required — `librtlsdr` detaches the DVB driver
  on start and reattaches it on stop.
- 433 MHz has short outdoor range (~100–300 m). To cover a large site, run one
  receiver per building/property; each publishes to the same broker with its own
  `STATION_ID`.

## Quick start

```bash
git clone git@github.com:dabeckham/isotherm.git
cd isotherm
cp .env.example .env      # set STATION_ID, TZ_NAME, PGPASSWORD
docker compose up -d --build
```

Watch sensors being decoded and stored:

```bash
docker compose logs -f ingest
```

Query current values:

```bash
docker compose exec timescaledb psql -U isotherm -d isotherm -c \
  "SELECT sensor_key, temperature_c, humidity, at_utc, tz_offset FROM sensor_latest;"
```

The stack auto-starts on boot (`restart: unless-stopped`).

## Configuration

| Variable | Meaning |
|----------|---------|
| `STATION_ID` | Unique id for this receiver (e.g. `sl-main`). Tags every reading. |
| `TZ_NAME` | IANA collection timezone. Per-reading offsets are derived DST-aware. |
| `RTL_FREQ` | SDR center frequency (default `433.92M`). |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | Local TimescaleDB credentials. |

**Sensor placement** (which room/building/coordinates a sensor lives at) is kept
out of this repository. New sensors auto-register as *unassigned* on their first
packet; you name and place them via `config/sensors.yaml` (or, later, in the
dashboard). See `config/*.example.yaml`. Floorplan images and real coordinates
belong in git-ignored local config only.

## Data model

- **`readings`** — one hypertable row per decoded packet. Every row stores the
  absolute UTC instant **and** the collection timezone's DST-aware offset, so any
  view can reconstruct correct local time.
- **`sensors`** — registry of every transmitter seen (`model/id/channel`), with
  its assignment (name, site, room, map/floorplan position).
- **`stations`** — the receivers.
- **`readings_5m` / `readings_daily`** — continuous aggregates powering the live
  graphs, heat-field frames, time-lapse, and calendar.
- **`data/raw/*.jsonl`** — append-only raw capture; nothing is discarded.

## License

MIT — see [LICENSE](LICENSE).
