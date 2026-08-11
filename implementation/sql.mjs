export const sql = String.raw`\set ON_ERROR_STOP on
SET client_min_messages TO warning;
SET timezone TO 'UTC';
SET datestyle TO 'ISO, YMD';

BEGIN;

DROP SCHEMA IF EXISTS coldchain CASCADE;
CREATE SCHEMA coldchain;

CREATE TABLE coldchain.shipments (
  release_id text PRIMARY KEY,
  shipment_id text NOT NULL UNIQUE,
  product_code text NOT NULL,
  sensor_id text NOT NULL,
  trip_start timestamptz NOT NULL,
  trip_end timestamptz NOT NULL,
  decision_cutoff timestamptz NOT NULL,
  CHECK (trip_start < trip_end),
  CHECK (trip_end <= decision_cutoff)
);

CREATE TABLE coldchain.temperature_readings (
  reading_id text PRIMARY KEY,
  shipment_id text NOT NULL REFERENCES coldchain.shipments(shipment_id),
  sensor_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  raw_temp_c numeric(8,3) NOT NULL,
  status text NOT NULL CHECK (status IN ('OK', 'FAULT'))
);

CREATE TABLE coldchain.calibration_events (
  calibration_id text PRIMARY KEY,
  sensor_id text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  offset_c numeric(8,3) NOT NULL,
  recorded_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (effective_to IS NULL OR effective_from < effective_to),
  CHECK (revoked_at IS NULL OR recorded_at < revoked_at)
);

CREATE TABLE coldchain.release_policy (
  product_code text PRIMARY KEY,
  min_temp_c numeric(8,3) NOT NULL,
  max_temp_c numeric(8,3) NOT NULL,
  expected_interval_min integer NOT NULL CHECK (expected_interval_min > 0),
  min_coverage_pct numeric(6,2) NOT NULL CHECK (min_coverage_pct BETWEEN 0 AND 100),
  max_excursion_minutes integer NOT NULL CHECK (max_excursion_minutes >= 0),
  episode_gap_minutes integer NOT NULL CHECK (episode_gap_minutes > 0),
  CHECK (min_temp_c < max_temp_c)
);

CREATE TABLE coldchain.hold_notices (
  hold_id text PRIMARY KEY,
  shipment_id text NOT NULL REFERENCES coldchain.shipments(shipment_id),
  hold_start timestamptz NOT NULL,
  hold_end timestamptz,
  reason_code text NOT NULL,
  CHECK (hold_end IS NULL OR hold_start < hold_end)
);

\copy coldchain.shipments FROM :'shipments_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy coldchain.temperature_readings FROM :'readings_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy coldchain.calibration_events FROM :'calibrations_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy coldchain.release_policy FROM :'policy_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy coldchain.hold_notices FROM :'holds_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

CREATE INDEX temperature_readings_scope_idx
  ON coldchain.temperature_readings (shipment_id, sensor_id, observed_at, received_at);
CREATE INDEX calibration_visibility_idx
  ON coldchain.calibration_events (sensor_id, effective_from, recorded_at, revoked_at);
CREATE INDEX hold_visibility_idx
  ON coldchain.hold_notices (shipment_id, hold_start, hold_end);

CREATE VIEW coldchain.reading_evaluation AS
SELECT
  s.release_id,
  s.shipment_id,
  s.product_code,
  s.sensor_id,
  s.decision_cutoff,
  r.reading_id,
  r.observed_at,
  r.received_at,
  r.raw_temp_c,
  c.calibration_id,
  c.offset_c,
  CASE WHEN c.calibration_id IS NULL THEN NULL
       ELSE round(r.raw_temp_c + c.offset_c, 3)
  END AS corrected_temp_c,
  p.min_temp_c,
  p.max_temp_c,
  p.expected_interval_min,
  p.min_coverage_pct,
  p.max_excursion_minutes,
  p.episode_gap_minutes
FROM coldchain.shipments s
JOIN coldchain.release_policy p ON p.product_code = s.product_code
JOIN coldchain.temperature_readings r
  ON r.shipment_id = s.shipment_id
 AND r.sensor_id = s.sensor_id
 AND r.status = 'OK'
 AND r.observed_at BETWEEN s.trip_start AND s.trip_end
 AND r.received_at <= s.decision_cutoff
LEFT JOIN LATERAL (
  SELECT ce.calibration_id, ce.offset_c
  FROM coldchain.calibration_events ce
  WHERE ce.sensor_id = r.sensor_id
    AND r.observed_at >= ce.effective_from
    AND (ce.effective_to IS NULL OR r.observed_at < ce.effective_to)
    AND ce.recorded_at <= s.decision_cutoff
    AND (ce.revoked_at IS NULL OR ce.revoked_at > s.decision_cutoff)
  ORDER BY ce.effective_from DESC, ce.recorded_at DESC, ce.calibration_id
  LIMIT 1
) c ON true;

CREATE VIEW coldchain.calibration_gaps AS
SELECT release_id, shipment_id, sensor_id, reading_id, observed_at, decision_cutoff
FROM coldchain.reading_evaluation
WHERE calibration_id IS NULL;

CREATE VIEW coldchain.excursion_episodes AS
WITH excursion_points AS (
  SELECT *,
    CASE
      WHEN lag(observed_at) OVER w IS NULL THEN 1
      WHEN extract(epoch FROM observed_at - lag(observed_at) OVER w) / 60.0 > episode_gap_minutes THEN 1
      ELSE 0
    END AS starts_new_episode
  FROM coldchain.reading_evaluation
  WHERE calibration_id IS NOT NULL
    AND (corrected_temp_c < min_temp_c OR corrected_temp_c > max_temp_c)
  WINDOW w AS (PARTITION BY release_id, shipment_id, sensor_id ORDER BY observed_at)
), grouped AS (
  SELECT *,
    sum(starts_new_episode) OVER (
      PARTITION BY release_id, shipment_id, sensor_id
      ORDER BY observed_at
      ROWS UNBOUNDED PRECEDING
    ) AS episode_no
  FROM excursion_points
)
SELECT
  release_id,
  shipment_id,
  sensor_id,
  episode_no,
  min(observed_at) AS episode_start,
  max(observed_at) AS episode_end,
  count(*)::integer * max(expected_interval_min) AS duration_minutes,
  max(corrected_temp_c)::numeric(8,3) AS peak_corrected_temp_c,
  max(max_temp_c)::numeric(8,3) AS max_temp_c,
  max(greatest(corrected_temp_c - max_temp_c, min_temp_c - corrected_temp_c, 0))::numeric(8,3) AS peak_deviation_c
FROM grouped
GROUP BY release_id, shipment_id, sensor_id, episode_no;

CREATE VIEW coldchain.release_decisions AS
WITH expected AS (
  SELECT
    s.*,
    p.min_coverage_pct,
    p.max_excursion_minutes,
    (floor(extract(epoch FROM (s.trip_end - s.trip_start)) / 60.0 / p.expected_interval_min)::integer + 1) AS expected_readings
  FROM coldchain.shipments s
  JOIN coldchain.release_policy p ON p.product_code = s.product_code
), reading_metrics AS (
  SELECT
    release_id,
    count(*)::integer AS eligible_readings,
    count(calibration_id)::integer AS evaluated_readings,
    count(*) FILTER (WHERE calibration_id IS NULL)::integer AS calibration_gap_count
  FROM coldchain.reading_evaluation
  GROUP BY release_id
), excursion_metrics AS (
  SELECT release_id, coalesce(sum(duration_minutes), 0)::integer AS excursion_minutes
  FROM coldchain.excursion_episodes
  GROUP BY release_id
), hold_metrics AS (
  SELECT s.release_id, count(h.hold_id)::integer AS active_hold_count
  FROM coldchain.shipments s
  LEFT JOIN coldchain.hold_notices h
    ON h.shipment_id = s.shipment_id
   AND h.hold_start <= s.decision_cutoff
   AND (h.hold_end IS NULL OR h.hold_end > s.decision_cutoff)
  GROUP BY s.release_id
), metrics AS (
  SELECT
    e.release_id,
    e.shipment_id,
    e.expected_readings,
    coalesce(r.eligible_readings, 0) AS eligible_readings,
    coalesce(r.evaluated_readings, 0) AS evaluated_readings,
    coalesce(r.calibration_gap_count, 0) AS calibration_gap_count,
    round(coalesce(r.eligible_readings, 0)::numeric * 100.0 / e.expected_readings, 2)::numeric(6,2) AS coverage_pct,
    coalesce(x.excursion_minutes, 0) AS excursion_minutes,
    h.active_hold_count,
    e.min_coverage_pct,
    e.max_excursion_minutes
  FROM expected e
  LEFT JOIN reading_metrics r USING (release_id)
  LEFT JOIN excursion_metrics x USING (release_id)
  JOIN hold_metrics h USING (release_id)
)
SELECT
  release_id,
  shipment_id,
  CASE
    WHEN active_hold_count > 0 THEN 'HOLD'
    WHEN calibration_gap_count > 0 THEN 'REVIEW'
    WHEN coverage_pct < min_coverage_pct THEN 'REVIEW'
    WHEN excursion_minutes > max_excursion_minutes THEN 'REVIEW'
    ELSE 'RELEASE'
  END AS decision,
  CASE
    WHEN active_hold_count > 0 THEN 'ACTIVE_HOLD'
    WHEN calibration_gap_count > 0 THEN 'CALIBRATION_GAP'
    WHEN coverage_pct < min_coverage_pct THEN 'COVERAGE_GAP'
    WHEN excursion_minutes > max_excursion_minutes THEN 'TEMP_EXCURSION'
    ELSE 'CLEAR'
  END AS primary_reason,
  expected_readings,
  eligible_readings,
  evaluated_readings,
  calibration_gap_count,
  coverage_pct,
  excursion_minutes,
  active_hold_count
FROM metrics;

\copy (SELECT release_id,shipment_id,decision,primary_reason,expected_readings,eligible_readings,evaluated_readings,calibration_gap_count,coverage_pct,excursion_minutes,active_hold_count FROM coldchain.release_decisions ORDER BY release_id) TO :'release_decisions_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy (SELECT release_id,shipment_id,sensor_id,reading_id,observed_at,decision_cutoff FROM coldchain.calibration_gaps ORDER BY release_id,observed_at,reading_id) TO :'calibration_gaps_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy (SELECT release_id,shipment_id,sensor_id,episode_no,episode_start,episode_end,duration_minutes,peak_corrected_temp_c,max_temp_c,peak_deviation_c FROM coldchain.excursion_episodes ORDER BY release_id,episode_start) TO :'excursion_episodes_file' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

COMMIT;
`;

export const deliveryReadme = `冷链放行复核交付说明

sql/coldchain_release_audit.sql用于在本地PostgreSQL17中导入五份业务输入，按放行截止时点选择可见校准版本，并生成放行结果、校准缺口和温度偏差分段。

exports/release_decisions.csv交给质量放行负责人处理运输批次。
exports/calibration_gaps.csv交给计量管理员补齐历史校准记录。
exports/excursion_episodes.csv交给冷链运营人员核对温度偏差时段。

使用psql17执行SQL时，需要通过变量传入五份输入文件和三份导出文件的本地路径。SQL会重建coldchain schema，输入文件保持只读。CSV行顺序不参与业务判断，release_id和reading_id用于稳定定位记录。
`;
