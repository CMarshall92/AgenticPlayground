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

- Step 1 now runs a pre-discovery screen across the full eligible broker universe, ranking names with broker metadata first and then overlaying cheap price-action data on a capped shortlist before any news intersection.
- Step 2 now runs a lightweight screening pass across the discovered candidate pool before the expensive full snapshot stage, using cheap price-action, volume, and broker-metadata signals.
- Fresh Trading 212 instrument metadata is persisted into Postgres whenever the broker call succeeds, and later runs can fall back to the latest stored universe if Trading 212 is temporarily rate-limited.
- This is still not a full exchange-wide fundamental or price-volume screen yet; that comes in the next phase.
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

Rules Engine Configurations

- `RULES_ENGINE_CANDIDATE_LIMIT` optional number of names the rules engine carries into deeper analysis
- `RULES_ENGINE_RAW_LIMIT` optional number of raw candidates the rules engine enriches before final selection
- `RULES_ENGINE_ENABLE_UNIVERSE_SCREENING` enables the stage-1 pre-discovery screen across the full eligible broker universe
- `RULES_ENGINE_INCLUDE_UNIVERSE_SCREEN_SEEDS` injects the top stage-1 screened names into candidate discovery before news and insider intersection
- `RULES_ENGINE_UNIVERSE_SHORTLIST_LIMIT` size of the stage-1 screened shortlist that is allowed into downstream discovery
- `RULES_ENGINE_UNIVERSE_PRICE_SCREEN_LIMIT` capped subset of the full eligible universe that receives cheap price-action overlay during stage 1
- `RULES_ENGINE_SCREENING_LIMIT` optional size of the broader step-2 screening pool before deep enrichment
- `RULES_ENGINE_ENABLE_LIGHTWEIGHT_SCREENING` enables the step-2 lightweight screening pass
- `RULES_ENGINE_SCREENING_LOOKBACK_DAYS` lookback window for lightweight price and volume screening
- `RULES_ENGINE_SCREENING_MOMENTUM_DAYS` momentum window used inside the lightweight screening pass
- `RULES_ENGINE_MIN_MARKET_CAP` optional microcap floor used after enrichment to avoid nano-cap and subscale names
- `RULES_ENGINE_MAX_MARKET_CAP` optional microcap ceiling used by the rules engine when filtering smaller-cap candidates
- `RULES_ENGINE_ALLOW_UNKNOWN_MARKET_CAP` whether names with unresolved market cap can survive filtering
- `RULES_ENGINE_INCLUDE_NEAR_LIMIT` whether names above the cap but inside the near-limit multiplier can survive filtering
- `RULES_ENGINE_NEAR_LIMIT_MULTIPLIER` multiple applied to `RULES_ENGINE_MAX_MARKET_CAP` for near-limit names
- `RULES_ENGINE_INSIDER_ROWS` optional number of insider-trade rows the rules engine ingests per run
- `RULES_ENGINE_INCLUDE_SEED_SYMBOLS` whether `PIPELINE_SYMBOLS` are injected into candidate discovery as seeds
- `RULES_ENGINE_ENABLE_MARKET_NEWS` enable Finnhub market-news sourcing
- `RULES_ENGINE_ENABLE_NEWSDATA` enable NewsData query sourcing
- `RULES_ENGINE_ENABLE_OPENINSIDER` enable OpenInsider sourcing
- `RULES_ENGINE_NEWS_PROFILE` one of `general_mixed`, `contract_heavy`, `regulatory_heavy`, `resource_heavy`, or `biotech_heavy`
- `RULES_ENGINE_NEWS_QUERIES` optional comma-separated query list used by the rules engine for broad news scanning
- `RULES_ENGINE_MARKET_NEWS_LIMIT_MULTIPLIER` multiplier applied to `PIPELINE_NEWS_LIMIT` for Finnhub market-news pulls
- `RULES_ENGINE_MARKET_SCOPE_PROFILE` one of `global`, `us_only`, or `us_uk_europe`
- `RULES_ENGINE_ALLOWED_INSTRUMENT_TYPES` comma-separated instrument types allowed into the eligible universe
- `RULES_ENGINE_ALLOWED_CURRENCIES` optional currency allowlist
- `RULES_ENGINE_ALLOWED_ISIN_COUNTRY_PREFIXES` optional ISIN-country allowlist; by default the `us_uk_europe` profile includes the US, UK, and major European markets
- `RULES_ENGINE_EXCLUDED_ISIN_COUNTRY_PREFIXES` optional ISIN-country blocklist
- `RULES_ENGINE_ALLOWED_SCHEDULE_IDS` optional Trading 212 schedule-id allowlist
- `RULES_ENGINE_EXCLUDED_SCHEDULE_IDS` optional Trading 212 schedule-id blocklist
- `RULES_ENGINE_REQUIRE_EXTENDED_HOURS` require `extendedHours=true` in broker metadata
- `RULES_ENGINE_MIN_MAX_OPEN_QUANTITY` minimum Trading 212 `maxOpenQuantity` threshold
- `RULES_ENGINE_MIN_INSTRUMENT_AGE_DAYS` minimum days since the instrument was added to broker metadata
- `RULES_ENGINE_EXCLUDED_SYMBOL_PATTERNS` optional ticker-pattern blocklist
- `RULES_ENGINE_EXCLUDED_NAME_PATTERNS` optional name-pattern blocklist; defaults are now biased toward excluding SPACs, shells, funds, depositary receipts, and similar low-quality structures
- `RULES_ENGINE_WEIGHT_MENTION_COUNT` scoring weight for repeated candidate mentions
- `RULES_ENGINE_WEIGHT_SOURCE_DIVERSITY` scoring weight for source diversity across discovery inputs
- `RULES_ENGINE_WEIGHT_NEWS_SIGNAL` scoring weight for downstream news intensity
- `RULES_ENGINE_WEIGHT_INSIDER_SIGNAL` scoring weight for downstream insider activity
- `RULES_ENGINE_WEIGHT_SCREENING_STAGE` weight applied to the step-2 screening score inside final ranking
- `RULES_ENGINE_WEIGHT_WITHIN_MARKET_CAP` bonus weight for names inside the market-cap limit
- `RULES_ENGINE_WEIGHT_HAS_MARKET_CAP` bonus weight when market cap can be resolved
- `RULES_ENGINE_WEIGHT_SCREEN_PRICE_MOMENTUM` weight for positive price momentum in the step-2 screening pass
- `RULES_ENGINE_WEIGHT_SCREEN_VOLUME_SURGE` weight for unusual volume expansion in the step-2 screening pass
- `RULES_ENGINE_WEIGHT_SCREEN_LIQUIDITY` weight for broker-liquidity proxy in the step-2 screening pass
- `RULES_ENGINE_WEIGHT_SCREEN_INSTRUMENT_AGE` weight for older, more established broker-listed instruments in the step-2 screening pass
- `RULES_ENGINE_WEIGHT_SCREEN_INSIDER_SOURCE` bonus for discovery candidates that came from insider activity
- `RULES_ENGINE_WEIGHT_SCREEN_SEED_SOURCE` bonus for discovery candidates that came from configured seed symbols
- `RULES_ENGINE_MAX_NEWS_SCORE` cap for the news-signal contribution
- `RULES_ENGINE_MAX_INSIDER_SCORE` cap for the insider-signal contribution
- `RULES_ENGINE_MAX_SCREEN_PRICE_MOMENTUM_PCT` cap used to normalize price momentum in the step-2 screening pass
- `RULES_ENGINE_MAX_SCREEN_VOLUME_MULTIPLE` cap used to normalize volume surge in the step-2 screening pass
- `RULES_ENGINE_MAX_SCREEN_LIQUIDITY_LOG` cap used to normalize broker-liquidity proxy in the step-2 screening pass
- `RULES_ENGINE_MAX_SCREEN_INSTRUMENT_AGE_DAYS` cap used to normalize broker instrument age in the step-2 screening pass
- `RULES_ENGINE_UNIVERSE_SAMPLE_SIZE` number of eligible-universe rows included in the rules-engine summary sample

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
