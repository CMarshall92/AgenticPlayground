const { buildUrl, ensureEnv, normalizeArrayParam, requestJson, toIsoDate } = require("../_shared/http");
const { reserveProviderUsage } = require("../provider_limits/usage_store");

const BASE_URL = "https://api.tiingo.com/tiingo/";
const HOURLY_LIMIT = 50;
const DAILY_LIMIT = 1000;


class TiingoClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("TIINGO_API_KEY");
    this.timeout = timeout;
    this.headers = {
      Authorization: `Token ${this.apiKey}`,
      Accept: "application/json",
    };
  }

  async get(path, params = {}) {
    const usageCheck = await reserveProviderUsage({
      provider: "tiingo",
      windows: [
        { periodType: "hour", limitCount: HOURLY_LIMIT },
        { periodType: "day", limitCount: DAILY_LIMIT },
      ],
    });

    if (!usageCheck.allowed) {
      return null;
    }

    return requestJson(buildUrl(BASE_URL, path, params), { timeout: this.timeout, headers: this.headers });
  }

  getNews({ tickers, tags, limit = 10, startDate, endDate, source } = {}) {
    return this.get("news", {
      tickers: normalizeArrayParam(tickers),
      tags: normalizeArrayParam(tags),
      limit,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      source,
    });
  }

  getDailyPrices(symbol, { startDate, endDate, resampleFreq = "daily" } = {}) {
    return this.get(`daily/${symbol}/prices`, {
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      resampleFreq,
    });
  }
}


module.exports = { TiingoClient };