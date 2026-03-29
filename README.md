## Daily Pipeline Runner

This repo now includes a Postgres-backed daily pipeline runner and a UTC scheduler.

The daily runner does these steps:

1. Initializes the cycle folder under `src/output/<cycle>`.
2. Captures Trading 212 portfolio context and per-ticker broker context.
3. Captures market-data snapshots for configured equities and FRED series.
4. Optionally builds a rebalance preview when target weights are configured.
5. Persists all collected artifacts, report files, and a final dashboard summary into Postgres.

Current limitation:

- The runner does not yet execute the agent markdown prompts through a model automatically.
- Final narratives remain file-based/manual until an LLM execution layer is added.

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

Daily runner configuration:

- `PIPELINE_SYMBOLS` comma-separated ticker list such as `NVDA,SMCI,VRT`
- `PIPELINE_FRED_SERIES` comma-separated FRED series ids such as `DGS10,INDPRO`
- `PIPELINE_COMPANY_NAMES` optional JSON object keyed by ticker
- `PIPELINE_CIK_MAP` optional JSON object keyed by ticker
- `PIPELINE_TARGET_WEIGHTS` optional JSON object whose weights sum to `100`
- `PIPELINE_CYCLE_NAME` optional explicit cycle name override
- `PIPELINE_NEWS_LIMIT` optional per-provider news item limit

Scheduler configuration:

- `PIPELINE_RUN_HOUR_UTC` default `6`
- `PIPELINE_RUN_MINUTE_UTC` default `0`
- `PIPELINE_RUN_ON_START` set to `true` to run once immediately when the scheduler starts

## Commands

Initialize or refresh the database schema:

```bash
npm run db:init
```

Run one daily collection cycle immediately:

```bash
npm run pipeline:run-daily
```

Start the long-running UTC scheduler:

```bash
npm run pipeline:schedule
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
