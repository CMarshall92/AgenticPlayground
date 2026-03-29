const { AlphaVantageClient } = require("../alpha_vantage/client");
const { FmpClient } = require("../fmp/client");
const { FinnhubClient } = require("../finnhub/client");
const { FredClient } = require("../fred/client");
const { NewsDataClient } = require("../newsdata/client");
const { OpenInsiderClient } = require("../openinsider/client");
const { SecEdgarClient } = require("../sec_edgar/client");
const { TiingoClient } = require("../tiingo/client");


function sanitizeProviderValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value : null;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, nestedValue]) => [key, sanitizeProviderValue(nestedValue)])
      .filter(([, nestedValue]) => nestedValue !== null);

    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  return value;
}


function providerStatus() {
  return {
    alphaVantage: Boolean(process.env.ALPHA_VANTAGE_API_KEY),
    fmp: Boolean(process.env.FMP_API_KEY),
    finnhub: Boolean(process.env.FINNHUB_API_KEY),
    fred: Boolean(process.env.FRED_API_KEY),
    newsdata: Boolean(process.env.NEWSDATA_API_KEY),
    secEdgar: Boolean(process.env.SEC_USER_AGENT),
    tiingo: Boolean(process.env.TIINGO_API_KEY),
    openinsider: true,
  };
}


async function safeCall(label, operation) {
  try {
    const sanitizedValue = sanitizeProviderValue(await operation());
    if (sanitizedValue === null) {
      return null;
    }

    return { label, ok: true, value: sanitizedValue };
  } catch (error) {
    return { label, ok: false, error: error.message };
  }
}


function defaultNewsWindow() {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - 30);
  return { fromDate, toDate };
}


async function getEquityDataSnapshot({ symbol, companyName, cik, fromDate, toDate, newsLimit = 5 } = {}) {
  if (!symbol) {
    throw new Error("symbol is required.");
  }

  const window = {
    ...defaultNewsWindow(),
    fromDate: fromDate || defaultNewsWindow().fromDate,
    toDate: toDate || defaultNewsWindow().toDate,
  };

  const availability = providerStatus();
  const result = {
    symbol,
    companyName: companyName || null,
    cik: cik || null,
    generatedAt: new Date().toISOString(),
    availability,
    providers: {},
  };

  if (availability.alphaVantage) {
    const client = new AlphaVantageClient();
    const alphaVantageSnapshot = await safeCall("alphaVantage", async () => ({
      quote: await client.getQuote(symbol),
      overview: await client.getCompanyOverview(symbol),
      newsSentiment: await client.getNewsSentiment({ tickers: [symbol], limit: newsLimit }),
      sma20: await client.getTechnicalIndicator({ indicator: "SMA", symbol, timePeriod: 20 }),
    }));

    if (alphaVantageSnapshot) {
      result.providers.alphaVantage = alphaVantageSnapshot;
    }
  }

  if (availability.fmp) {
    const client = new FmpClient();
    const fmpSnapshot = await safeCall("fmp", async () => ({
      quote: await client.getQuote(symbol),
      profile: await client.getProfile(symbol),
      incomeStatement: await client.getIncomeStatement(symbol, { limit: 1 }),
      ratios: await client.getRatios(symbol, { limit: 1 }),
      stockNews: await client.getStockNews({ tickers: [symbol], limit: newsLimit }),
    }));

    if (fmpSnapshot) {
      result.providers.fmp = fmpSnapshot;
    }
  }

  if (availability.finnhub) {
    const client = new FinnhubClient();
    const finnhubSnapshot = await safeCall("finnhub", async () => ({
      quote: await client.getQuote(symbol),
      profile: await client.getCompanyProfile(symbol),
      basics: await client.getBasicFinancials(symbol),
      companyNews: await client.getCompanyNews({ symbol, from: window.fromDate, to: window.toDate }),
      newsSentiment: await client.getNewsSentiment(symbol),
    }));

    if (finnhubSnapshot) {
      result.providers.finnhub = finnhubSnapshot;
    }
  }

  if (availability.tiingo) {
    const client = new TiingoClient();
    const tiingoSnapshot = await safeCall("tiingo", async () => ({
      news: await client.getNews({ tickers: [symbol], limit: newsLimit, startDate: window.fromDate, endDate: window.toDate }),
      prices: await client.getDailyPrices(symbol, { startDate: window.fromDate, endDate: window.toDate }),
    }));

    if (tiingoSnapshot) {
      result.providers.tiingo = tiingoSnapshot;
    }
  }

  if (availability.newsdata) {
    const client = new NewsDataClient();
    const newsdataSnapshot = await safeCall("newsdata", async () => client.getLatestNews({ query: companyName || symbol }));
    if (newsdataSnapshot) {
      result.providers.newsdata = newsdataSnapshot;
    }
  }

  if (availability.secEdgar) {
    const client = new SecEdgarClient();
    const secEdgarSnapshot = await safeCall("secEdgar", async () => ({
      submissions: await client.getSubmissions(cik || symbol),
      companyFacts: await client.getCompanyFacts(cik || symbol),
    }));

    if (secEdgarSnapshot) {
      result.providers.secEdgar = secEdgarSnapshot;
    }
  }

  const insiderClient = new OpenInsiderClient();
  const openinsiderSnapshot = await safeCall("openinsider", async () => insiderClient.getLatestInsiderTrades({ symbol, rows: newsLimit }));
  if (openinsiderSnapshot) {
    result.providers.openinsider = openinsiderSnapshot;
  }

  return result;
}


async function getMacroDataSnapshot({ seriesIds = [], observationLimit = 24 } = {}) {
  if (!Array.isArray(seriesIds) || seriesIds.length === 0) {
    throw new Error("seriesIds must be a non-empty array.");
  }
  if (!providerStatus().fred) {
    throw new Error("FRED_API_KEY is required for macro data snapshots.");
  }

  const client = new FredClient();
  const series = {};
  for (const seriesId of seriesIds) {
    const snapshot = await safeCall(seriesId, async () => ({
      meta: await client.getSeriesInfo(seriesId),
      observations: await client.getSeriesObservations(seriesId, { limit: observationLimit }),
    }));

    if (snapshot) {
      series[seriesId] = snapshot;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    series,
  };
}


async function runCli() {
  const command = process.argv[2];
  const rawArg = process.argv[3];

  if (!command) {
    throw new Error("Missing command. Use one of: providers, equity-snapshot, macro-snapshot.");
  }

  let result;
  if (command === "providers") {
    result = providerStatus();
  } else if (command === "equity-snapshot") {
    if (!rawArg) {
      throw new Error("equity-snapshot requires a JSON argument.");
    }
    result = await getEquityDataSnapshot(JSON.parse(rawArg));
  } else if (command === "macro-snapshot") {
    if (!rawArg) {
      throw new Error("macro-snapshot requires a JSON argument.");
    }
    result = await getMacroDataSnapshot(JSON.parse(rawArg));
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
  getEquityDataSnapshot,
  getMacroDataSnapshot,
  providerStatus,
};