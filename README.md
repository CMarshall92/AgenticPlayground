## Daily Pipeline Runner

This repo now includes a Postgres-backed daily pipeline runner, an automatic LLM report-generation layer, a dashboard/API server, and a UTC scheduler.

The daily runner does these steps:

1. Initializes the cycle folder under `src/output/<cycle>`.
2. Captures Trading 212 portfolio context and per-ticker broker context.
3. Captures market-data snapshots for configured equities and FRED series.
4. Optionally builds a rebalance preview when target weights are configured.
5. Automatically generates the five agent reports when an OpenAI-compatible LLM is configured.
6. Persists collected artifacts, report files, authored agent outputs, and a final dashboard summary into Postgres.

Current limitation:

- Automatic report generation is limited to the configured `PIPELINE_SYMBOLS` universe and the captured data bundle for that run.
- If no LLM is configured, the data collection still runs but the report files remain manual/template-based.

## Required Environment Variables

Database:

- `DATABASE_URL`

Broker:

- `LIVE_T212_API_KEY`
- `LIVE_T212_API_SECRET`
- `DEMO_T212_API_KEY`
- `DEMO_T212_API_SECRET`
- `T212_ENV`

Market data as needed:

- `ALPHA_VANTAGE_API_KEY`
- `FMP_API_KEY`
- `FINNHUB_API_KEY`
- `FRED_API_KEY`
- `NEWSDATA_API_KEY`
- `SEC_USER_AGENT`
- `TIINGO_API_KEY`

LLM report generation:

- `LLM_ENABLED`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_BASE_URL`
- `LLM_TEMPERATURE`
- `LLM_MAX_OUTPUT_TOKENS`
- `LLM_CONTEXT_MAX_CHARS`

Daily runner configuration:

- `PIPELINE_SYMBOLS` comma-separated ticker list such as `NVDA,SMCI,VRT`
- `PIPELINE_FRED_SERIES` comma-separated FRED series ids such as `DGS10,INDPRO`
- `PIPELINE_COMPANY_NAMES` optional JSON object keyed by ticker
- `PIPELINE_CIK_MAP` optional JSON object keyed by ticker
- `PIPELINE_TARGET_WEIGHTS` optional JSON object whose weights sum to `100`
- `PIPELINE_CYCLE_NAME` optional explicit cycle name override
- `PIPELINE_NEWS_LIMIT` optional per-provider news item limit

Dashboard server:

- `DASHBOARD_HOST` default `0.0.0.0`
- `DASHBOARD_PORT` default `3000`

Scheduler configuration:

- `PIPELINE_RUN_HOUR_UTC` default `6`
- `PIPELINE_RUN_MINUTE_UTC` default `0`
- `PIPELINE_RUN_ON_START` set to `true` to run once immediately when the scheduler starts

Database wait helper:

- `DB_WAIT_TIMEOUT_MS` default `60000`
- `DB_WAIT_INTERVAL_MS` default `2000`

## Commands

Initialize or refresh the database schema:

```bash
npm run db:init
```

Run one daily collection cycle immediately:

```bash
npm run pipeline:run-daily
```

Run the dashboard/API server locally:

```bash
npm run dashboard
```

Start the long-running UTC scheduler:

```bash
npm run pipeline:schedule
```

Wait for the configured database before startup:

```bash
npm run db:wait
```

Syntax-check the current codebase:

```bash
npm run check
```

## Stored Postgres Data

The runner persists dashboard-oriented data into these tables:

- `pipeline_runs`
- `pipeline_artifacts`
- `pipeline_agent_outputs`
- `pipeline_final_reports`
- `provider_usage_windows`

This structure is meant to support a future dashboard that needs both raw JSON artifacts and markdown-oriented report content.

## Dashboard API

The built-in server exposes these endpoints:

- `GET /api/health`
- `GET /api/overview`
- `GET /api/runs?limit=20`
- `GET /api/runs/latest`
- `GET /api/runs/:id`
- `GET /api/runs/:id/artifacts`
- `GET /api/runs/:id/agent-outputs`
- `GET /api/runs/:id/final-reports`

The server also serves a browser dashboard at `/`.

## LLM Execution Layer

The report-generation layer uses an OpenAI-compatible Chat Completions API.

When `LLM_ENABLED=true` and the model credentials are configured, the runner will:

1. Read the numbered prompt files in `src/agents/`.
2. Build a bounded context bundle from broker data, market data, and prior agent outputs.
3. Generate authored markdown reports for:
   - Macro Strategist
   - Sector Analyst
   - Risk Manager
   - Portfolio Manager
   - YOLO Microcap Hunter
4. Write those markdown files into the cycle folder before persisting them to Postgres.

## Docker

Yes. The third step can be dockerized so it runs on any system with Docker.

This repo now includes:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

The compose setup starts three services:

1. `postgres` for a self-contained local database
2. `dashboard` for the API and browser UI on port `3000`
3. `scheduler` for the long-running daily runner

To start everything:

```bash
docker compose up --build
```

If you prefer Neon or another hosted Postgres instance, replace the `DATABASE_URL` in `docker-compose.yml` or remove the local `postgres` service and point both containers at the external database.
# AgententicPlaground
