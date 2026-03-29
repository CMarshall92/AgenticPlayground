require("dotenv").config();

const { closePool, query } = require("./postgres");

const DEFAULT_TIMEOUT_MS = Number(process.env.DB_WAIT_TIMEOUT_MS || 60_000);
const DEFAULT_INTERVAL_MS = Number(process.env.DB_WAIT_INTERVAL_MS || 2_000);


async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function waitForDatabase() {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= DEFAULT_TIMEOUT_MS) {
    try {
      await query("SELECT 1 AS ok");
      console.log(JSON.stringify({ ok: true, waitedMs: Date.now() - startedAt }, null, 2));
      return;
    } catch (error) {
      await sleep(DEFAULT_INTERVAL_MS);
    }
  }

  throw new Error(`Database did not become available within ${DEFAULT_TIMEOUT_MS}ms.`);
}


waitForDatabase()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });