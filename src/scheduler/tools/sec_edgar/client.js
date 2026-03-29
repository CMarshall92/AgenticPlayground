const { buildUrl, ensureEnv, requestJson } = require("../_shared/http");

const DATA_BASE_URL = "https://data.sec.gov/";
const FILES_BASE_URL = "https://www.sec.gov/";


function padCik(cik) {
  return String(cik).replace(/^0+/, "").padStart(10, "0");
}


class SecEdgarClient {
  constructor({ userAgent, timeout } = {}) {
    this.userAgent = userAgent || ensureEnv("SEC_USER_AGENT");
    this.timeout = timeout;
    this.headers = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    this.companyTickersCache = null;
  }

  async getCompanyTickers({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.companyTickersCache) {
      return this.companyTickersCache;
    }

    const result = await requestJson(buildUrl(FILES_BASE_URL, "files/company_tickers.json"), {
      timeout: this.timeout,
      headers: this.headers,
    });
    this.companyTickersCache = Object.values(result || {});
    return this.companyTickersCache;
  }

  async findCompanyByTicker(ticker) {
    const companies = await this.getCompanyTickers();
    return companies.find((company) => company.ticker === ticker) || null;
  }

  async resolveCik(cikOrTicker) {
    if (!cikOrTicker) {
      throw new Error("A CIK or ticker is required for SEC EDGAR calls.");
    }
    if (/^\d+$/.test(String(cikOrTicker))) {
      return padCik(cikOrTicker);
    }
    const company = await this.findCompanyByTicker(String(cikOrTicker).toUpperCase());
    if (!company) {
      throw new Error(`Unable to resolve CIK for ticker '${cikOrTicker}'.`);
    }
    return padCik(company.cik_str);
  }

  async getSubmissions(cikOrTicker) {
    const cik = await this.resolveCik(cikOrTicker);
    return requestJson(buildUrl(DATA_BASE_URL, `submissions/CIK${cik}.json`), {
      timeout: this.timeout,
      headers: this.headers,
    });
  }

  async getCompanyFacts(cikOrTicker) {
    const cik = await this.resolveCik(cikOrTicker);
    return requestJson(buildUrl(DATA_BASE_URL, `api/xbrl/companyfacts/CIK${cik}.json`), {
      timeout: this.timeout,
      headers: this.headers,
    });
  }
}


module.exports = { SecEdgarClient };