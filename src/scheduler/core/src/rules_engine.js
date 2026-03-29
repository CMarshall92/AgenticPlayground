require("dotenv").config();

const { FinnhubClient } = require("../../tools/finnhub/client");
const { NewsDataClient } = require("../../tools/newsdata/client");
const { OpenInsiderClient } = require("../../tools/openinsider/client");
const { Trading212Client } = require("../../tools/trading212/trading212_client");
const { getEquityDataSnapshot, providerStatus } = require("../../tools/market_data/market_data_agent_tools");

const DEFAULT_RULES_ENGINE_NEWS_QUERIES = [
  "contract win",
  "regulatory approval",
  "acquisition",
  "resource discovery",
  "clinical trial",
  "plant opening",
];

const EXCLUDED_TICKER_TOKENS = new Set([
  "A",
  "AI",
  "ALL",
  "AND",
  "ARE",
  "AS",
  "AT",
  "BE",
  "BUT",
  "BY",
  "CEO",
  "CFO",
  "FOR",
  "FROM",
  "IN",
  "IS",
  "IT",
  "ITS",
  "NEW",
  "NOT",
  "NOW",
  "OF",
  "ON",
  "OR",
  "SEC",
  "THE",
  "TO",
  "USA",
  "USD",
  "WITH",
]);


function normalizeSymbol(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,5}$/.test(normalized)) {
    return null;
  }

  return normalized;
}


function parsePositiveInteger(rawValue, fallbackValue) {
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}


function parsePositiveNumber(rawValue, fallbackValue) {
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}


function uniqueSymbols(values = []) {
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}


function parseRulesEngineQueries(value) {
  if (!value) {
    return DEFAULT_RULES_ENGINE_NEWS_QUERIES;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : DEFAULT_RULES_ENGINE_NEWS_QUERIES;
}


function safeArray(value) {
  return Array.isArray(value) ? value : [];
}


function coerceArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return Object.values(value);
  }

  return [];
}


function parseMarketCapCandidate(value, { multiplyMillions = false } = {}) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(String(value).replace(/[$,]/g, "").trim());
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return multiplyMillions ? numeric * 1_000_000 : numeric;
}


function isLikelyCommonEquity(instrument) {
  const type = String(instrument?.type || "").toUpperCase();
  if (!type) {
    return true;
  }

  return !["ETF", "ETN", "ETC", "FUND", "CFD"].some((blocked) => type.includes(blocked));
}


function buildInstrumentIndex(instruments) {
  const index = new Map();

  for (const instrument of safeArray(instruments)) {
    const symbol = normalizeSymbol(instrument?.ticker);
    if (!symbol || !isLikelyCommonEquity(instrument)) {
      continue;
    }

    if (!index.has(symbol)) {
      index.set(symbol, instrument);
    }
  }

  return index;
}


function extractTickerTokens(text) {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = text.match(/\b[A-Z]{2,5}(?:\.[A-Z])?\b/g) || [];
  return uniqueSymbols(matches.filter((token) => !EXCLUDED_TICKER_TOKENS.has(token)));
}


function extractFinnhubSymbols(article) {
  const relatedSymbols = String(article?.related || "")
    .split(/[\s,|]+/)
    .map(normalizeSymbol)
    .filter(Boolean);

  return uniqueSymbols([
    ...relatedSymbols,
    ...extractTickerTokens(String(article?.headline || "")),
    ...extractTickerTokens(String(article?.summary || "")),
  ]);
}


function extractNewsDataSymbols(article) {
  const keywordValues = Array.isArray(article?.keywords)
    ? article.keywords
    : String(article?.keywords || "").split(/[\s,|]+/);

  return uniqueSymbols([
    ...extractTickerTokens(String(article?.title || "")),
    ...extractTickerTokens(String(article?.description || "")),
    ...extractTickerTokens(String(article?.content || "")),
    ...keywordValues.map(normalizeSymbol).filter(Boolean),
  ]);
}


function createCandidateRecord(symbol, instrument, companyName = null) {
  return {
    symbol,
    instrument,
    companyName,
    mentionCount: 0,
    sourceTypes: new Set(),
    catalysts: new Set(),
    sourceNotes: [],
  };
}


function recordCandidate(candidateMap, symbol, instrument, details = {}) {
  if (!symbol || !instrument) {
    return;
  }

  const existing = candidateMap.get(symbol) || createCandidateRecord(symbol, instrument, details.companyName || instrument.name || null);
  existing.mentionCount += 1;
  if (details.sourceType) {
    existing.sourceTypes.add(details.sourceType);
  }
  if (details.catalyst) {
    existing.catalysts.add(details.catalyst);
  }
  if (existing.sourceNotes.length < 6) {
    existing.sourceNotes.push({
      sourceType: details.sourceType || null,
      title: details.title || null,
      query: details.query || null,
      url: details.url || null,
    });
  }
  candidateMap.set(symbol, existing);
}


async function safeCall(operation) {
  try {
    return await operation();
  } catch {
    return null;
  }
}


function extractMarketCap(snapshot) {
  const alphaOverview = snapshot?.providers?.alphaVantage?.value?.overview || {};
  const fmpProfile = coerceArray(snapshot?.providers?.fmp?.value?.profile)[0] || snapshot?.providers?.fmp?.value?.profile || {};
  const finnhubProfile = snapshot?.providers?.finnhub?.value?.profile || {};

  return (
    parseMarketCapCandidate(alphaOverview.MarketCapitalization)
    || parseMarketCapCandidate(fmpProfile.mktCap)
    || parseMarketCapCandidate(fmpProfile.marketCap)
    || parseMarketCapCandidate(finnhubProfile.marketCapitalization, { multiplyMillions: true })
    || parseMarketCapCandidate(finnhubProfile.marketCap)
  );
}


function extractCompanyName(snapshot, fallbackInstrument) {
  const fmpProfile = coerceArray(snapshot?.providers?.fmp?.value?.profile)[0] || snapshot?.providers?.fmp?.value?.profile || {};
  const finnhubProfile = snapshot?.providers?.finnhub?.value?.profile || {};
  const alphaOverview = snapshot?.providers?.alphaVantage?.value?.overview || {};

  return snapshot?.companyName
    || fmpProfile.companyName
    || fmpProfile.name
    || finnhubProfile.name
    || alphaOverview.Name
    || fallbackInstrument?.name
    || fallbackInstrument?.shortName
    || null;
}


function extractCik(snapshot) {
  const secSubmissions = snapshot?.providers?.secEdgar?.value?.submissions || {};
  return snapshot?.cik || secSubmissions.cik || null;
}


function extractNewsSignal(snapshot) {
  const fmpNews = safeArray(snapshot?.providers?.fmp?.value?.stockNews);
  const finnhubNews = safeArray(snapshot?.providers?.finnhub?.value?.companyNews);
  const tiingoNews = safeArray(snapshot?.providers?.tiingo?.value?.news);
  const alphaFeed = safeArray(snapshot?.providers?.alphaVantage?.value?.newsSentiment?.feed);
  const newsdataResults = safeArray(snapshot?.providers?.newsdata?.value?.results);

  return fmpNews.length + finnhubNews.length + tiingoNews.length + alphaFeed.length + newsdataResults.length;
}


function extractInsiderSignal(snapshot) {
  return safeArray(snapshot?.providers?.openinsider?.value?.rows).length;
}


function selectionBucket(marketCap, threshold) {
  if (!marketCap) {
    return "unknown";
  }
  if (marketCap <= threshold) {
    return "within_limit";
  }
  if (marketCap <= threshold * 2) {
    return "near_limit";
  }
  return "above_limit";
}


function candidateScore({ rawCandidate, marketCap, newsSignal, insiderSignal, threshold }) {
  const score =
    rawCandidate.mentionCount * 3
    + rawCandidate.sourceTypes.size * 4
    + Math.min(newsSignal, 8)
    + Math.min(insiderSignal, 5)
    + (marketCap && marketCap <= threshold ? 6 : 0)
    + (marketCap ? 2 : 0);

  return score;
}


function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    symbol: candidate.symbol,
    companyName: candidate.companyName,
    marketCap: candidate.marketCap,
    selectionBucket: candidate.selectionBucket,
    score: candidate.score,
    tradable: true,
    instrument: candidate.instrument
      ? {
          ticker: candidate.instrument.ticker || null,
          name: candidate.instrument.name || candidate.instrument.shortName || null,
          type: candidate.instrument.type || null,
          currencyCode: candidate.instrument.currencyCode || null,
        }
      : null,
    sourceTypes: [...candidate.sourceTypes],
    catalystSignals: [...candidate.catalysts],
    mentionCount: candidate.mentionCount,
    newsSignal: candidate.newsSignal,
    insiderSignal: candidate.insiderSignal,
    sourceNotes: candidate.sourceNotes,
  }));
}


async function runRulesEngineSelection({
  seedSymbols = [],
  maxCandidates,
  rawCandidateLimit,
  maxMarketCap,
  newsLimit,
  insiderRows,
  queryTerms,
} = {}) {
  const settings = {
    maxCandidates: parsePositiveInteger(maxCandidates ?? process.env.RULES_ENGINE_CANDIDATE_LIMIT, 10),
    rawCandidateLimit: parsePositiveInteger(rawCandidateLimit ?? process.env.RULES_ENGINE_RAW_LIMIT, 18),
    maxMarketCap: parsePositiveNumber(maxMarketCap ?? process.env.RULES_ENGINE_MAX_MARKET_CAP, 500_000_000),
    newsLimit: parsePositiveInteger(newsLimit ?? process.env.PIPELINE_NEWS_LIMIT, 5),
    insiderRows: parsePositiveInteger(insiderRows ?? process.env.RULES_ENGINE_INSIDER_ROWS, 40),
    queryTerms: queryTerms || parseRulesEngineQueries(process.env.RULES_ENGINE_NEWS_QUERIES),
  };

  const availability = providerStatus();
  const brokerClient = new Trading212Client();
  const instrumentIndex = buildInstrumentIndex(await brokerClient.getAllInstruments());
  const candidateMap = new Map();
  const normalizedSeedSymbols = uniqueSymbols(seedSymbols);

  for (const symbol of normalizedSeedSymbols) {
    const instrument = instrumentIndex.get(symbol);
    if (instrument) {
      recordCandidate(candidateMap, symbol, instrument, {
        sourceType: "seed_symbols",
        catalyst: "watchlist seed",
      });
    }
  }

  if (availability.finnhub) {
    const client = new FinnhubClient();
    const marketNews = await safeCall(() => client.getMarketNews({ category: "general", limit: settings.newsLimit * 4 }));
    for (const article of safeArray(marketNews)) {
      for (const symbol of extractFinnhubSymbols(article)) {
        const instrument = instrumentIndex.get(symbol);
        if (!instrument) {
          continue;
        }

        recordCandidate(candidateMap, symbol, instrument, {
          sourceType: "finnhub_market_news",
          title: article.headline || null,
          url: article.url || null,
          catalyst: "market news",
        });
      }
    }
  }

  if (availability.newsdata) {
    const client = new NewsDataClient();
    for (const query of settings.queryTerms) {
      const newsResponse = await safeCall(() => client.getLatestNews({ query, category: "business", language: "en" }));
      const articles = safeArray(newsResponse?.results);
      for (const article of articles) {
        for (const symbol of extractNewsDataSymbols(article)) {
          const instrument = instrumentIndex.get(symbol);
          if (!instrument) {
            continue;
          }

          recordCandidate(candidateMap, symbol, instrument, {
            sourceType: "newsdata_query",
            title: article.title || null,
            url: article.link || null,
            query,
            catalyst: query,
          });
        }
      }
    }
  }

  const insiderClient = new OpenInsiderClient();
  const insiderResponse = await safeCall(() => insiderClient.getLatestInsiderTrades({ rows: settings.insiderRows }));
  for (const row of safeArray(insiderResponse?.rows)) {
    const symbol = normalizeSymbol(row?.ticker);
    const instrument = instrumentIndex.get(symbol);
    if (!symbol || !instrument) {
      continue;
    }

    recordCandidate(candidateMap, symbol, instrument, {
      sourceType: "openinsider",
      title: row.companyName || null,
      catalyst: row.tradeType || "insider activity",
    });
  }

  const rawCandidates = [...candidateMap.values()].sort((left, right) => {
    if (right.sourceTypes.size !== left.sourceTypes.size) {
      return right.sourceTypes.size - left.sourceTypes.size;
    }

    return right.mentionCount - left.mentionCount;
  });

  const enrichedCandidates = [];
  for (const rawCandidate of rawCandidates.slice(0, settings.rawCandidateLimit)) {
    const snapshot = await safeCall(() => getEquityDataSnapshot({
      symbol: rawCandidate.symbol,
      companyName: rawCandidate.instrument?.name || rawCandidate.companyName || undefined,
      newsLimit: settings.newsLimit,
    }));

    const marketCap = snapshot ? extractMarketCap(snapshot) : null;
    const companyName = snapshot ? extractCompanyName(snapshot, rawCandidate.instrument) : rawCandidate.instrument?.name || rawCandidate.companyName || null;
    const cik = snapshot ? extractCik(snapshot) : null;
    const newsSignal = snapshot ? extractNewsSignal(snapshot) : 0;
    const insiderSignal = snapshot ? extractInsiderSignal(snapshot) : 0;
    const score = candidateScore({
      rawCandidate,
      marketCap,
      newsSignal,
      insiderSignal,
      threshold: settings.maxMarketCap,
    });

    enrichedCandidates.push({
      ...rawCandidate,
      companyName,
      cik,
      marketCap,
      selectionBucket: selectionBucket(marketCap, settings.maxMarketCap),
      newsSignal,
      insiderSignal,
      score,
    });
  }

  enrichedCandidates.sort((left, right) => {
    const leftEligible = left.selectionBucket === "within_limit" ? 1 : left.selectionBucket === "unknown" ? 0 : -1;
    const rightEligible = right.selectionBucket === "within_limit" ? 1 : right.selectionBucket === "unknown" ? 0 : -1;
    if (rightEligible !== leftEligible) {
      return rightEligible - leftEligible;
    }
    return right.score - left.score;
  });

  const selectedCandidates = enrichedCandidates
    .filter((candidate) => candidate.selectionBucket !== "above_limit")
    .slice(0, settings.maxCandidates);

  const selectedSymbols = selectedCandidates.map((candidate) => candidate.symbol);
  const companyNames = Object.fromEntries(selectedCandidates.filter((candidate) => candidate.companyName).map((candidate) => [candidate.symbol, candidate.companyName]));
  const cikMap = Object.fromEntries(selectedCandidates.filter((candidate) => candidate.cik).map((candidate) => [candidate.symbol, candidate.cik]));

  const sourceBreakdown = Object.fromEntries(
    [...candidateMap.values()]
      .flatMap((candidate) => [...candidate.sourceTypes])
      .reduce((map, sourceType) => {
        map.set(sourceType, (map.get(sourceType) || 0) + 1);
        return map;
      }, new Map())
      .entries()
  );

  return {
    generatedAt: new Date().toISOString(),
    providerAvailability: availability,
    seedSymbols: normalizedSeedSymbols,
    queryTerms: settings.queryTerms,
    config: settings,
    rawCandidateCount: rawCandidates.length,
    selectedSymbols,
    companyNames,
    cikMap,
    candidates: summarizeCandidates(selectedCandidates),
    discardedCandidates: summarizeCandidates(enrichedCandidates.filter((candidate) => !selectedSymbols.includes(candidate.symbol)).slice(0, settings.maxCandidates)),
    sourceBreakdown,
  };
}


module.exports = {
  runRulesEngineSelection,
};