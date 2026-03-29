const { Trading212Client, Trading212RequestError } = require("../tools/trading212/trading212_client");

const PIE_WRITE_DELAY_MS = 5_500;


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function buildTemporaryPieName(prefix) {
  return `${prefix}-${Date.now()}`;
}


function chooseInstrumentShares(instruments = []) {
  const preferredTickers = ["AAPL_US_EQ", "MSFT_US_EQ", "GOOG_US_EQ", "AMZN_US_EQ"];
  const chosen = [];

  if (instruments.length === 0) {
    return {
      AAPL_US_EQ: 0.5,
      MSFT_US_EQ: 0.5,
    };
  }

  for (const ticker of preferredTickers) {
    const match = instruments.find((instrument) => instrument.ticker === ticker);
    if (match) {
      chosen.push(match.ticker);
    }
    if (chosen.length === 2) {
      break;
    }
  }

  if (chosen.length < 2) {
    for (const instrument of instruments) {
      if ((instrument.type === "STOCK" || instrument.type === "ETF") && !chosen.includes(instrument.ticker)) {
        chosen.push(instrument.ticker);
      }
      if (chosen.length === 2) {
        break;
      }
    }
  }

  if (chosen.length < 2) {
    throw new Error("Unable to find two suitable instruments for demo pie tests.");
  }

  return {
    [chosen[0]]: 0.5,
    [chosen[1]]: 0.5,
  };
}


async function main() {
  const environment = process.argv[2] || process.env.T212_ENV || "demo";
  if (environment !== "demo" && environment !== "paper") {
    throw new Error("Demo write test only supports the demo/paper environment.");
  }

  const client = new Trading212Client({ environment });
  const instrumentShares = chooseInstrumentShares();
  const createName = buildTemporaryPieName("copilot-demo-pie");
  const duplicateName = buildTemporaryPieName("copilot-demo-pie-copy");
  const createdResources = [];

  try {
    const created = await client.createPie({
      name: createName,
      instrumentShares,
      dividendCashAction: "TO_ACCOUNT_CASH",
      goal: 1000,
    });

    const createdPieId = created.settings?.id;
    if (!createdPieId) {
      throw new Error("Pie creation succeeded but no pie id was returned.");
    }
    createdResources.push(createdPieId);

    const updated = await client.updatePie(createdPieId, {
      name: `${createName}-updated`,
      instrumentShares,
      dividendCashAction: "TO_ACCOUNT_CASH",
      goal: 1500,
    });

    const icon = updated.settings?.icon || created.settings?.icon || "Coins";
    let duplicatedPieId = null;
    let duplicateResult = null;

    try {
      duplicateResult = await client.duplicatePie(createdPieId, {
        name: duplicateName,
        icon,
      });
      duplicatedPieId = duplicateResult.settings?.id || null;
      if (duplicatedPieId) {
        createdResources.push(duplicatedPieId);
      }
    } catch (error) {
      duplicateResult = {
        ok: false,
        statusCode: error instanceof Trading212RequestError ? error.statusCode : null,
        error: error.message,
      };
    }

    console.log(JSON.stringify({
      environment,
      ok: true,
      createdPieId,
      duplicatePieId: duplicatedPieId,
      instrumentShares,
      duplicateResult,
    }, null, 2));
  } finally {
    for (const pieId of createdResources.reverse()) {
      try {
        await client.deletePie(pieId);
        await sleep(PIE_WRITE_DELAY_MS);
      } catch (error) {
        console.error(JSON.stringify({
          cleanup: false,
          pieId,
          error: error.message,
        }, null, 2));
      }
    }
  }
}


main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
  }, null, 2));
  process.exitCode = 1;
});