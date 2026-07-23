-- Isotherm schema: receivers (stations), sensor registry, readings hypertable,
-- and continuous aggregates that power the dashboard's heatmaps, time-lapse and
-- calendar views. Loaded once by the TimescaleDB image on first init.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Stations: the receivers. One RTL-SDR per property as coverage expands; each
-- reading is tagged with the station that heard it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
    station_id  text PRIMARY KEY,
    label       text,
    site        text,                    -- SL / LL / MR / PARSLEY ...
    lat         double precision,
    lon         double precision,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sensors: one row per distinct transmitter (model + id + channel). New
-- sensors auto-register on first packet as unassigned; the user later names
-- and places them (site/building/floor/room, map lat/lon, floorplan x/y).
-- Real placement data lives in git-ignored config, not in this repo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sensors (
    sensor_key    text PRIMARY KEY,       -- '<model>/<id>[/<channel>]'
    model         text NOT NULL,
    dev_id        text,
    channel       text,
    kind          text,                  -- temperature / temp_humidity / fridge_freezer / other
    friendly_name text,
    site          text,
    building      text,
    floor         text,
    room          text,
    lat           double precision,
    lon           double precision,
    floorplan_id  text,
    floor_x       double precision,      -- normalized 0..1 on the floorplan image
    floor_y       double precision,
    assigned      boolean NOT NULL DEFAULT false,
    first_seen    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz NOT NULL DEFAULT now(),
    last_station  text,
    meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Readings: one row per distinct received packet.
-- Per project rule, every row carries BOTH the absolute UTC instant AND the
-- DST-aware offset of the collection timezone, so any presentation layer can
-- reconstruct correct local time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readings (
    at_utc        timestamptz NOT NULL,          -- authoritative UTC (ingest clock)
    tz            text        NOT NULL DEFAULT 'America/Chicago',
    tz_offset     text        NOT NULL,          -- e.g. '-05:00' for THIS instant
    sensor_key    text        NOT NULL,
    station_id    text        NOT NULL,
    model         text,
    temperature_c double precision,
    temperature_f double precision,
    humidity      double precision,
    battery_ok    smallint,
    rssi          double precision,
    snr           double precision,
    noise         double precision,
    freq_mhz      double precision,
    sensor_time   text,                          -- rtl_433's own reported time
    raw           jsonb NOT NULL
);

SELECT create_hypertable('readings', 'at_utc',
    if_not_exists => TRUE,
    chunk_time_interval => INTERVAL '7 days');

CREATE INDEX IF NOT EXISTS readings_sensor_time_idx  ON readings (sensor_key, at_utc DESC);
CREATE INDEX IF NOT EXISTS readings_station_time_idx ON readings (station_id, at_utc DESC);

-- ---------------------------------------------------------------------------
-- Continuous aggregates
-- ---------------------------------------------------------------------------
-- 5-minute buckets per sensor: feeds live graphs, heat-field frames and the
-- time-lapse "weather radar" playback.
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_5m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '5 minutes', at_utc) AS bucket,
    sensor_key,
    station_id,
    avg(temperature_c) AS temp_c_avg,
    min(temperature_c) AS temp_c_min,
    max(temperature_c) AS temp_c_max,
    avg(humidity)      AS humidity_avg,
    count(*)           AS samples
FROM readings
GROUP BY bucket, sensor_key, station_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('readings_5m',
    start_offset      => INTERVAL '6 hours',
    end_offset        => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists     => TRUE);

-- Local-day rollup per sensor: feeds the calendar heatmap. Bucketed in the
-- collection timezone so day boundaries match wall-clock midnight.
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 day', at_utc, 'America/Chicago') AS day,
    sensor_key,
    avg(temperature_c) AS temp_c_avg,
    min(temperature_c) AS temp_c_min,
    max(temperature_c) AS temp_c_max,
    avg(humidity)      AS humidity_avg,
    count(*)           AS samples
FROM readings
GROUP BY day, sensor_key
WITH NO DATA;

SELECT add_continuous_aggregate_policy('readings_daily',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

-- Convenience view: latest reading per sensor (dashboard "current values").
CREATE OR REPLACE VIEW sensor_latest AS
SELECT DISTINCT ON (r.sensor_key)
    r.sensor_key, r.station_id, r.model,
    r.temperature_c, r.temperature_f, r.humidity, r.battery_ok,
    r.rssi, r.snr, r.at_utc, r.tz, r.tz_offset,
    s.friendly_name, s.site, s.room, s.kind, s.assigned, s.lat, s.lon
FROM readings r
LEFT JOIN sensors s USING (sensor_key)
ORDER BY r.sensor_key, r.at_utc DESC;
