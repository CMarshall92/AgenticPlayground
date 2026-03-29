const {
  Trading212Client,
  Trading212RequestError,
} = require("../tools/trading212/trading212_client");


function summarizeValue(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      sampleKeys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 8) : [],
    };
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value.items)) {
      return {
        type: "paginated",
        count: value.items.length,
        nextPagePath: value.nextPagePath ?? null,
        sampleKeys: value.items[0] && typeof value.items[0] === "object" ? Object.keys(value.items[0]).slice(0, 8) : [],
      };
    }

    return {
      type: "object",
      keys: Object.keys(value).slice(0, 12),
    };
  }

  return {
    type: typeof value,
    value,
  };
}


async function runCheck(name, operation) {
  try {
    const value = await operation();
    return {
      endpoint: name,
      ok: true,
      summary: summarizeValue(value),
    };
  } catch (error) {
    const statusCode = error instanceof Trading212RequestError ? error.statusCode : null;
    return {
      endpoint: name,
      ok: false,
      statusCode,
      error: error.message,
    };
  }
}


async function main() {
  const environment = process.argv[2] || process.env.T212_ENV || "live";
  const client = new Trading212Client({ environment });

  const checks = [
    ["accountSummary", () => client.getAccountSummary()],
    ["accountCash", () => client.getAccountCash()],
    ["exchangesMetadata", () => client.getExchangesMetadata({ forceRefresh: true })],
    ["instrumentsMetadata", () => client.getAllInstruments({ forceRefresh: true })],
    ["positions", () => client.getPositions()],
    ["historicalOrders", () => client.getHistoricalOrders({ limit: 1 })],
    ["transactions", () => client.getTransactions({ limit: 1 })],
    ["dividends", () => client.getPaidOutDividends({ limit: 1 })],
    ["pies", () => client.getPies()],
  ];

  const results = [];
  for (const [name, operation] of checks) {
    results.push(await runCheck(name, operation));
  }

  const succeeded = results.filter((item) => item.ok).length;
  const failed = results.length - succeeded;

  console.log(JSON.stringify({
    environment,
    succeeded,
    failed,
    results,
  }, null, 2));

  if (failed > 0) {
    process.exitCode = 1;
  }
}


main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
  }, null, 2));
  process.exitCode = 1;
});