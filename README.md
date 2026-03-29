## Daily Pipeline Runner

This repo now includes a Postgres-backed daily pipeline runner, an automatic LLM report-generation layer, and a UTC scheduler.

The daily runner does these steps:

1. Initializes the cycle folder under `src/output/<cycle>`.
2. In `micro_cap_agents` mode, the rules engine builds a tradable candidate universe from market news, insider activity, and Trading 212 instruments.
3. Captures Trading 212 portfolio context and per-ticker broker context.
4. Captures market-data snapshots for the selected equities and configured FRED series.
5. Optionally builds a rebalance preview when target weights are configured.
6. Automatically generates the five agent reports when an OpenAI-compatible LLM is configured.
7. Persists collected artifacts, report files, authored agent outputs, and a final pipeline summary into Postgres.

Current limitation:

- Broad microcap discovery is still heuristics-based. It uses broker-tradable instruments plus market news and insider activity to build a candidate set before pulling deeper equity snapshots.
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

- `PIPELINE_SYMBOL_MODE` one of `rules_engine`, `configured`, or `auto`; `rules_engine` is the default for `micro_cap_agents`
- `PIPELINE_SYMBOLS` optional comma-separated seed/watchlist ticker list used by rules-engine mode, or the full universe in configured mode
- `PIPELINE_FRED_SERIES` comma-separated FRED series ids such as `DGS10,INDPRO`
- `PIPELINE_COMPANY_NAMES` optional JSON object keyed by ticker
- `PIPELINE_CIK_MAP` optional JSON object keyed by ticker
- `PIPELINE_TARGET_WEIGHTS` optional JSON object whose weights sum to `100`; primarily useful when you already know the portfolio targets
- `PIPELINE_CYCLE_NAME` optional explicit cycle name override
- `PIPELINE_NEWS_LIMIT` optional per-provider news item limit
- `RULES_ENGINE_CANDIDATE_LIMIT` optional number of names the rules engine carries into deeper analysis
- `RULES_ENGINE_RAW_LIMIT` optional number of raw candidates the rules engine enriches before final selection
- `RULES_ENGINE_MAX_MARKET_CAP` optional maximum market cap used by the rules engine when filtering smaller-cap candidates
- `RULES_ENGINE_INSIDER_ROWS` optional number of insider-trade rows the rules engine ingests per run
- `RULES_ENGINE_NEWS_QUERIES` optional comma-separated query list used by the rules engine for broad news scanning

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
node src/db/init_db.js
```

Run one daily collection cycle immediately:

```bash
npm run pipeline
```

Start the long-running UTC scheduler:

```bash
npm run scheduler
```

Wait for the configured database before startup:

```bash
node src/db/wait_for_db.js
```

Syntax-check the current codebase:

```bash
node --check src/scheduler/core/daily_runner.js
```

## Stored Postgres Data

The runner persists pipeline state into these tables:

- `pipeline_runs`
- `pipeline_artifacts`
- `pipeline_agent_outputs`
- `pipeline_final_reports`
- `provider_usage_windows`

This structure retains both raw JSON artifacts and markdown-oriented report content for auditability, downstream automation, and future integrations.

## LLM Execution Layer

The report-generation layer uses an OpenAI-compatible Chat Completions API.

When `LLM_ENABLED=true` and the model credentials are configured, the runner will:

1. Read the numbered prompt files in `src/scheduler/agents/micro_cap_agents/`.
2. Build a bounded context bundle from the rules engine artifact, broker data, market data, and prior agent outputs.
3. Generate authored markdown reports for:
   - Microcap Trend Scanner
   - Microcap Universe Scout
   - Investment Standards Reviewer
   - Microcap Portfolio Manager
   - Microcap Catalyst Hunter
4. Write those markdown files into the cycle folder before persisting them to Postgres.

## Docker

The scheduler flow can be containerized so it runs on any system with Docker.

This repo now includes:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

The compose setup starts two services:

1. `postgres` for a self-contained local database
2. `scheduler` for the long-running daily runner

To start everything:

```bash
docker compose up --build
```

The container image now defaults to `npm run scheduler`.

If you want to execute a single cycle instead of the long-running scheduler, override the container command with `npm run pipeline`.

If you prefer Neon or another hosted Postgres instance, replace the `DATABASE_URL` in `docker-compose.yml` or remove the local `postgres` service and point both containers at the external database.

# AgententicPlaground
