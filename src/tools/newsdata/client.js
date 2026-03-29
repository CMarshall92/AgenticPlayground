const { buildUrl, ensureEnv, requestJson } = require("../_shared/http");

const BASE_URL = "https://newsdata.io/api/1/";


class NewsDataClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("NEWSDATA_API_KEY");
    this.timeout = timeout;
  }

  async get(path, params = {}) {
    return requestJson(buildUrl(BASE_URL, path, { apikey: this.apiKey, ...params }), { timeout: this.timeout });
  }

  getLatestNews({ query, category = "business", language = "en", country, sentiment, page } = {}) {
    return this.get("news", {
      q: query,
      category,
      language,
      country,
      sentiment,
      page,
    });
  }
}


module.exports = { NewsDataClient };