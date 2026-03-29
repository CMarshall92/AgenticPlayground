CREATE TABLE IF NOT EXISTS provider_usage_windows (
  provider TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('hour', 'day')),
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  limit_count INTEGER NOT NULL CHECK (limit_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, period_type, window_start)
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_windows_provider_updated_at
  ON provider_usage_windows (provider, updated_at DESC);

CREATE TABLE IF NOT EXISTS broker_instrument_universes (
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  instrument_count INTEGER NOT NULL DEFAULT 0 CHECK (instrument_count >= 0),
  instruments JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, environment)
);

CREATE INDEX IF NOT EXISTS idx_broker_instrument_universes_fetched_at
  ON broker_instrument_universes (fetched_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id BIGSERIAL PRIMARY KEY,
  cycle_name TEXT NOT NULL,
  run_type TEXT NOT NULL DEFAULT 'daily' CHECK (run_type IN ('daily', 'manual', 'adhoc', 'backfill')),
  trigger_source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_cycle_name
  ON pipeline_runs (cycle_name);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON pipeline_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status_started_at
  ON pipeline_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  file_path TEXT,
  content_json JSONB,
  content_markdown TEXT,
  content_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, artifact_type, artifact_key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_artifacts_run_id
  ON pipeline_artifacts (run_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_artifacts_type_key
  ON pipeline_artifacts (artifact_type, artifact_key);

CREATE TABLE IF NOT EXISTS pipeline_agent_outputs (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  source_prompt_path TEXT,
  report_path TEXT,
  content_markdown TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, agent_key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_agent_outputs_run_id
  ON pipeline_agent_outputs (run_id);

CREATE TABLE IF NOT EXISTS pipeline_final_reports (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  report_kind TEXT NOT NULL DEFAULT 'daily_summary',
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, report_kind)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_final_reports_run_id
  ON pipeline_final_reports (run_id);