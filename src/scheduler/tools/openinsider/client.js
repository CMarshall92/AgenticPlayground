const { buildUrl, requestText } = require("../_shared/http");

const BASE_URL = "https://openinsider.com/";
const DEFAULT_HEADERS = {
  "User-Agent": "AgneticAnalysis/1.0 (+https://github.com/) data research",
};


function stripHtml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}


function parseTableRows(html, maxRows) {
  const rowMatches = Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).slice(1);
  const rows = [];
  for (const match of rowMatches) {
    const cells = Array.from(match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cell) => stripHtml(cell[1]));
    if (cells.length >= 8) {
      rows.push({
        filingDateTime: cells[1] || null,
        tradeDate: cells[2] || null,
        ticker: cells[3] || null,
        companyName: cells[4] || null,
        insiderName: cells[5] || null,
        title: cells[6] || null,
        tradeType: cells[7] || null,
        price: cells[8] || null,
        quantity: cells[9] || null,
        value: cells[12] || null,
      });
    }
    if (rows.length >= maxRows) {
      break;
    }
  }
  return rows;
}


class OpenInsiderClient {
  constructor({ timeout } = {}) {
    this.timeout = timeout;
  }

  async getLatestInsiderTrades({ symbol = "", insider = "", rows = 20, page = 1 } = {}) {
    const url = buildUrl(BASE_URL, "screener", {
      s: symbol,
      o: insider,
      pl: "",
      ph: "",
      ll: "",
      lh: "",
      fd: "0",
      td: "0",
      xp: "1",
      cnt: rows,
      page,
    });

    const html = await requestText(url, { timeout: this.timeout, headers: DEFAULT_HEADERS });
    return {
      url,
      rows: parseTableRows(html, rows),
      rawHtmlLength: html.length,
    };
  }
}


module.exports = { OpenInsiderClient };