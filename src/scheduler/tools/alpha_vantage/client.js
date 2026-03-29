const { buildUrl, ensureEnv, normalizeArrayParam, pickDefined, requestJson } = require("../_shared/http");
const { reserveProviderUsage } = require("../provider_limits/usage_store");

const BASE_URL = "https://www.alphavantage.co/query";
const DAILY_LIMIT = 25;


class AlphaVantageClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("ALPHA_VANTAGE_API_KEY");
    this.timeout = timeout;
  }

  async query(functionName, params = {}) {
    const usageCheck = await reserveProviderUsage({
      provider: "alpha_vantage",
      windows: [{ periodType: "day", limitCount: DAILY_LIMIT }],
    });

    if (!usageCheck.allowed) {
      return null;
    }

    return requestJson(
      buildUrl(BASE_URL, "", { function: functionName, apikey: this.apiKey, ...pickDefined(params) }),
      { timeout: this.timeout }
    );
  }

  getQuote(symbol) {
    return this.query("GLOBAL_QUOTE", { symbol });
  }

  getCompanyOverview(symbol) {
    return this.query("OVERVIEW", { symbol });
  }

  getNewsSentiment({ tickers, topics, sort = "LATEST", limit = 10 } = {}) {
    return this.query("NEWS_SENTIMENT", {
      tickers: normalizeArrayParam(tickers),
      topics: normalizeArrayParam(topics),
      sort,
      limit,
    });
  }

  getTechnicalIndicator({ indicator = "SMA", symbol, interval = "daily", seriesType = "close", timePeriod = 20, outputsize = "compact" } = {}) {
    return this.query(indicator, {
      symbol,
      interval,
      series_type: seriesType,
      time_period: timePeriod,
      outputsize,
    });
  }
}


module.exports = { AlphaVantageClient };