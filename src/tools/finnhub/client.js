const { buildUrl, ensureEnv, requestJson, toIsoDate, withQueryToken } = require("../_shared/http");

const BASE_URL = "https://finnhub.io/api/v1/";


class FinnhubClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("FINNHUB_API_KEY");
    this.timeout = timeout;
  }

  async get(path, params = {}) {
    return requestJson(buildUrl(BASE_URL, path, withQueryToken(params, "token", this.apiKey)), { timeout: this.timeout });
  }

  getQuote(symbol) {
    return this.get("quote", { symbol });
  }

  getCompanyProfile(symbol) {
    return this.get("stock/profile2", { symbol });
  }

  getBasicFinancials(symbol, metric = "all") {
    return this.get("stock/metric", { symbol, metric });
  }

  getCompanyNews({ symbol, from, to } = {}) {
    return this.get("company-news", {
      symbol,
      from: toIsoDate(from),
      to: toIsoDate(to),
    });
  }

  getNewsSentiment(symbol) {
    return this.get("news-sentiment", { symbol });
  }

  getMarketNews({ category = "general", limit = 10 } = {}) {
    return this.get("news", { category, minId: undefined, limit });
  }
}


module.exports = { FinnhubClient };