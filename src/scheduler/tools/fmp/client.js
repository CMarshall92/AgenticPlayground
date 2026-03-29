const { buildUrl, ensureEnv, normalizeArrayParam, requestJson } = require("../_shared/http");

const BASE_URL = "https://financialmodelingprep.com/api/v3/";


class FmpClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("FMP_API_KEY");
    this.timeout = timeout;
  }

  async get(path, params = {}) {
    return requestJson(buildUrl(BASE_URL, path, { apikey: this.apiKey, ...params }), { timeout: this.timeout });
  }

  getQuote(symbol) {
    return this.get(`quote/${symbol}`);
  }

  getProfile(symbol) {
    return this.get(`profile/${symbol}`);
  }

  getIncomeStatement(symbol, { limit = 4 } = {}) {
    return this.get(`income-statement/${symbol}`, { limit });
  }

  getRatios(symbol, { limit = 4 } = {}) {
    return this.get(`ratios/${symbol}`, { limit });
  }

  getStockNews({ tickers, limit = 10 } = {}) {
    return this.get("stock_news", { tickers: normalizeArrayParam(tickers), limit });
  }
}


module.exports = { FmpClient };