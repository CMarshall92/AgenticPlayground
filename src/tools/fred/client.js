const { buildUrl, ensureEnv, requestJson } = require("../_shared/http");

const BASE_URL = "https://api.stlouisfed.org/fred/";


class FredClient {
  constructor({ apiKey, timeout } = {}) {
    this.apiKey = apiKey || ensureEnv("FRED_API_KEY");
    this.timeout = timeout;
  }

  async get(path, params = {}) {
    return requestJson(buildUrl(BASE_URL, path, { api_key: this.apiKey, file_type: "json", ...params }), { timeout: this.timeout });
  }

  getSeriesInfo(seriesId) {
    return this.get("series", { series_id: seriesId });
  }

  getSeriesObservations(seriesId, { limit = 24, sortOrder = "desc", frequency, units } = {}) {
    return this.get("series/observations", {
      series_id: seriesId,
      limit,
      sort_order: sortOrder,
      frequency,
      units,
    });
  }

  searchSeries(searchText, { limit = 10, orderBy = "search_rank", sortOrder = "desc" } = {}) {
    return this.get("series/search", {
      search_text: searchText,
      limit,
      order_by: orderBy,
      sort_order: sortOrder,
    });
  }
}


module.exports = { FredClient };