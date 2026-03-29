const { query } = require("./postgres");

let tableReadyPromise;

function normalizeJsonValue(value) {
  if (value == null) {
    return null;
  }

  return JSON.stringify(value);
}

async function ensureBrokerInstrumentUniverseTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = query(`
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
      )
    `).catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

async function upsertBrokerInstrumentUniverse({ provider, environment, instruments, metadata = {} } = {}) {
  if (!provider) {
    throw new Error("provider is required.");
  }
  if (!environment) {
    throw new Error("environment is required.");
  }
  if (!Array.isArray(instruments)) {
    throw new Error("instruments must be an array.");
  }

  await ensureBrokerInstrumentUniverseTable();

  const result = await query(
    `
      INSERT INTO broker_instrument_universes (
        provider,
        environment,
        instrument_count,
        instruments,
        metadata,
        fetched_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (provider, environment)
      DO UPDATE SET
        instrument_count = EXCLUDED.instrument_count,
        instruments = EXCLUDED.instruments,
        metadata = broker_instrument_universes.metadata || EXCLUDED.metadata,
        fetched_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `,
    [
      provider,
      environment,
      instruments.length,
      normalizeJsonValue(instruments),
      normalizeJsonValue(metadata),
    ]
  );

  return result.rows[0] || null;
}

async function getBrokerInstrumentUniverse({ provider, environment } = {}) {
  if (!provider) {
    throw new Error("provider is required.");
  }
  if (!environment) {
    throw new Error("environment is required.");
  }

  await ensureBrokerInstrumentUniverseTable();

  const result = await query(
    `
      SELECT *
      FROM broker_instrument_universes
      WHERE provider = $1
        AND environment = $2
      LIMIT 1
    `,
    [provider, environment]
  );

  return result.rows[0] || null;
}

module.exports = {
  getBrokerInstrumentUniverse,
  upsertBrokerInstrumentUniverse,
};
