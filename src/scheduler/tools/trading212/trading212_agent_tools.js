const { Trading212Client } = require("./trading212_client");


function createBrokerClient(options = {}) {
  return new Trading212Client(options);
}


async function safeCall(label, operation) {
  try {
    const value = await operation();
    return {
      label,
      ok: true,
      value,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      error: error.message,
      statusCode: typeof error.statusCode === "number" ? error.statusCode : null,
      payload: error.payload ?? null,
    };
  }
}


async function verifyTradableInstrument(ticker, options = {}) {
  const client = createBrokerClient(options);
  return client.verifyTradableInstrument(ticker, { exact: options.exact ?? true });
}


async function getTickerBrokerContext(ticker, options = {}) {
  const client = createBrokerClient(options);
  const [tradability, positions, pendingOrders] = await Promise.all([
    safeCall("tradability", () => client.verifyTradableInstrument(ticker, { exact: options.exact ?? true })),
    safeCall("positions", () => client.getPositions({ ticker })),
    safeCall("pendingOrders", () => client.getPendingOrders()),
  ]);

  const relevantPendingOrders = pendingOrders.ok
    ? pendingOrders.value.filter((order) => order.ticker === ticker || order.instrument?.ticker === ticker)
    : null;

  const heldPositions = positions.ok ? positions.value : null;
  const heldQuantity = heldPositions
    ? heldPositions.reduce((sum, position) => sum + Number(position.quantity || 0), 0)
    : null;

  return {
    ticker,
    environment: client.environment,
    tradability,
    positions: positions.ok
      ? {
          ok: true,
          count: heldPositions.length,
          totalQuantity: heldQuantity,
          items: heldPositions,
        }
      : positions,
    pendingOrders: pendingOrders.ok
      ? {
          ok: true,
          count: relevantPendingOrders.length,
          items: relevantPendingOrders,
        }
      : pendingOrders,
    rateLimit: client.lastRateLimit,
  };
}


async function getPortfolioBrokerContext(options = {}) {
  const client = createBrokerClient(options);
  return client.getPortfolioSnapshot({ includePendingOrders: options.includePendingOrders !== false });
}


async function buildBrokerRebalancePreview(targetWeights, options = {}) {
  const client = createBrokerClient(options);
  return client.buildRebalancePreview(targetWeights, { includePendingOrders: options.includePendingOrders !== false });
}


async function runCli() {
  const command = process.argv[2];
  const argument = process.argv[3];

  if (!command) {
    throw new Error("Missing command. Use one of: verify-instrument, ticker-context, portfolio-context, rebalance-preview.");
  }

  let result;

  if (command === "verify-instrument") {
    if (!argument) {
      throw new Error("verify-instrument requires a ticker argument.");
    }
    result = await verifyTradableInstrument(argument);
  } else if (command === "ticker-context") {
    if (!argument) {
      throw new Error("ticker-context requires a ticker argument.");
    }
    result = await getTickerBrokerContext(argument);
  } else if (command === "portfolio-context") {
    result = await getPortfolioBrokerContext();
  } else if (command === "rebalance-preview") {
    if (!argument) {
      throw new Error("rebalance-preview requires a JSON targetWeights argument.");
    }
    result = await buildBrokerRebalancePreview(JSON.parse(argument));
  } else {
    throw new Error(`Unsupported command '${command}'.`);
  }

  console.log(JSON.stringify(result, null, 2));
}


if (require.main === module) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}


module.exports = {
  buildBrokerRebalancePreview,
  createBrokerClient,
  getPortfolioBrokerContext,
  getTickerBrokerContext,
  verifyTradableInstrument,
};