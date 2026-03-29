require("dotenv").config();

const { getBrokerInstrumentUniverse, upsertBrokerInstrumentUniverse } = require("../../../db/instrument_store");
const { FmpClient } = require("../../tools/fmp/client");
const { FinnhubClient } = require("../../tools/finnhub/client");
const { NewsDataClient } = require("../../tools/newsdata/client");
const { OpenInsiderClient } = require("../../tools/openinsider/client");
const { TiingoClient } = require("../../tools/tiingo/client");
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

const DEFAULT_EXCLUDED_NAME_PATTERNS = [
  "WARRANT",
  "RIGHT",
  "UNIT",
  "ACQUISITION CORP",
  "CAPITAL CORP",
  "HOLDINGS CORP",
  "BLANK CHECK",
  "SPAC",
  "SHELL",
  "ROYALTY",
  "TRUST",
  "FUND",
  "ETF",
  "ETN",
  "ADR",
  "GDR",
];

const RULES_ENGINE_NEWS_PROFILES = {
  general_mixed: DEFAULT_RULES_ENGINE_NEWS_QUERIES,
  contract_heavy: [
    "contract win",
    "new customer",
    "framework agreement",
    "purchase order",
    "commercial launch",
    "strategic partnership",
  ],
  regulatory_heavy: [
    "regulatory approval",
    "fda clearance",
    "ce mark",
    "permit approval",
    "license award",
    "government approval",
  ],
  resource_heavy: [
    "resource discovery",
    "drill results",
    "mineral resource",
    "feasibility study",
    "production update",
    "offtake agreement",
  ],
  biotech_heavy: [
    "clinical trial",
    "phase 2",
    "phase 3",
    "patient dosing",
    "trial results",
    "orphan drug",
  ],
};

const RULES_ENGINE_MARKET_SCOPE_PROFILES = {
  global: {
    allowedIsinCountryPrefixes: [],
    excludedIsinCountryPrefixes: [],
  },
  us_only: {
    allowedIsinCountryPrefixes: ["US"],
    excludedIsinCountryPrefixes: [],
  },
  us_uk_europe: {
    allowedIsinCountryPrefixes: [
      "US",
      "GB",
      "IE",
      "FR",
      "DE",
      "NL",
      "BE",
      "LU",
      "CH",
      "AT",
      "DK",
      "SE",
      "NO",
      "FI",
      "ES",
      "IT",
      "PT",
      "PL",
      "CZ",
      "HU",
      "GR",
    ],
    excludedIsinCountryPrefixes: [],
  },
};

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


function resolveBrokerSymbol(instrument) {
  const shortNameSymbol = normalizeSymbol(instrument?.shortName);
  if (shortNameSymbol) {
    return shortNameSymbol;
  }

  const brokerTicker = String(instrument?.ticker || "").trim().toUpperCase();
  if (!brokerTicker) {
    return null;
  }

  const simplifiedTicker = brokerTicker
    .replace(/_[A-Z]{2,}_EQ$/i, "")
    .replace(/_EQ$/i, "")
    .replace(/d_EQ$/i, "")
    .replace(/l_EQ$/i, "")
    .replace(/_US$/i, "")
    .replace(/_CA$/i, "")
    .replace(/_GB$/i, "")
    .trim();

  return normalizeSymbol(simplifiedTicker);
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


function parseBoolean(rawValue, fallbackValue) {
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}


function parseCsv(rawValue, fallbackValue = []) {
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  return String(rawValue)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}


function parseIntegerCsv(rawValue, fallbackValue = []) {
  return parseCsv(rawValue, fallbackValue)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
}


function normalizeForMatch(value) {
  return String(value || "").trim().toUpperCase();
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


function parseNewsProfile(rawValue) {
  const profile = String(rawValue || "general_mixed").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RULES_ENGINE_NEWS_PROFILES, profile)
    ? profile
    : "general_mixed";
}


function parseMarketScopeProfile(rawValue) {
  const profile = String(rawValue || "us_uk_europe").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RULES_ENGINE_MARKET_SCOPE_PROFILES, profile)
    ? profile
    : "us_uk_europe";
}


function buildNewsQueries(explicitQueries, profileName) {
  if (explicitQueries) {
    return parseRulesEngineQueries(explicitQueries);
  }

  return RULES_ENGINE_NEWS_PROFILES[profileName] || DEFAULT_RULES_ENGINE_NEWS_QUERIES;
}


function safeArray(value) {
  return Array.isArray(value) ? value : [];
}


function emitProgress(onProgress, payload) {
  if (typeof onProgress === "function") {
    onProgress(payload);
  }
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


function matchesAnyPattern(values, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  const normalizedValues = values.map(normalizeForMatch).filter(Boolean);
  const normalizedPatterns = patterns.map(normalizeForMatch).filter(Boolean);
  return normalizedValues.some((value) => normalizedPatterns.some((pattern) => value.includes(pattern)));
}


function buildRulesEngineSettings({
  maxCandidates,
  rawCandidateLimit,
  maxMarketCap,
  newsLimit,
  insiderRows,
  queryTerms,
} = {}) {
  const marketScopeProfile = parseMarketScopeProfile(process.env.RULES_ENGINE_MARKET_SCOPE_PROFILE);
  const scopeProfile = RULES_ENGINE_MARKET_SCOPE_PROFILES[marketScopeProfile] || RULES_ENGINE_MARKET_SCOPE_PROFILES.us_uk_europe;
  const newsProfile = parseNewsProfile(process.env.RULES_ENGINE_NEWS_PROFILE);

  return {
    maxCandidates: parsePositiveInteger(maxCandidates ?? process.env.RULES_ENGINE_CANDIDATE_LIMIT, 10),
    rawCandidateLimit: parsePositiveInteger(rawCandidateLimit ?? process.env.RULES_ENGINE_RAW_LIMIT, 18),
    enableUniverseScreening: parseBoolean(process.env.RULES_ENGINE_ENABLE_UNIVERSE_SCREENING, true),
    includeUniverseScreenSeeds: parseBoolean(process.env.RULES_ENGINE_INCLUDE_UNIVERSE_SCREEN_SEEDS, true),
    universeShortlistLimit: parsePositiveInteger(process.env.RULES_ENGINE_UNIVERSE_SHORTLIST_LIMIT, 60),
    universePriceScreenLimit: parsePositiveInteger(process.env.RULES_ENGINE_UNIVERSE_PRICE_SCREEN_LIMIT, 40),
    screeningLimit: Math.max(
      parsePositiveInteger(process.env.RULES_ENGINE_SCREENING_LIMIT, 30),
      parsePositiveInteger(rawCandidateLimit ?? process.env.RULES_ENGINE_RAW_LIMIT, 18)
    ),
    enableLightweightScreening: parseBoolean(process.env.RULES_ENGINE_ENABLE_LIGHTWEIGHT_SCREENING, true),
    screeningLookbackDays: parsePositiveInteger(process.env.RULES_ENGINE_SCREENING_LOOKBACK_DAYS, 30),
    screeningMomentumDays: parsePositiveInteger(process.env.RULES_ENGINE_SCREENING_MOMENTUM_DAYS, 20),
    minMarketCap: parsePositiveNumber(process.env.RULES_ENGINE_MIN_MARKET_CAP, 50_000_000),
    maxMarketCap: parsePositiveNumber(maxMarketCap ?? process.env.RULES_ENGINE_MAX_MARKET_CAP, 300_000_000),
    allowUnknownMarketCap: parseBoolean(process.env.RULES_ENGINE_ALLOW_UNKNOWN_MARKET_CAP, true),
    includeNearLimit: parseBoolean(process.env.RULES_ENGINE_INCLUDE_NEAR_LIMIT, true),
    nearLimitMultiple: parsePositiveNumber(process.env.RULES_ENGINE_NEAR_LIMIT_MULTIPLIER, 2),
    newsLimit: parsePositiveInteger(newsLimit ?? process.env.PIPELINE_NEWS_LIMIT, 5),
    insiderRows: parsePositiveInteger(insiderRows ?? process.env.RULES_ENGINE_INSIDER_ROWS, 40),
    newsProfile,
    queryTerms: queryTerms || buildNewsQueries(process.env.RULES_ENGINE_NEWS_QUERIES, newsProfile),
    includeSeedSymbols: parseBoolean(process.env.RULES_ENGINE_INCLUDE_SEED_SYMBOLS, true),
    enableMarketNews: parseBoolean(process.env.RULES_ENGINE_ENABLE_MARKET_NEWS, true),
    enableNewsData: parseBoolean(process.env.RULES_ENGINE_ENABLE_NEWSDATA, true),
    enableOpenInsider: parseBoolean(process.env.RULES_ENGINE_ENABLE_OPENINSIDER, true),
    marketNewsLimitMultiplier: parsePositiveInteger(process.env.RULES_ENGINE_MARKET_NEWS_LIMIT_MULTIPLIER, 4),
    marketScopeProfile,
    allowedInstrumentTypes: parseCsv(process.env.RULES_ENGINE_ALLOWED_INSTRUMENT_TYPES, ["STOCK"]).map((value) => value.toUpperCase()),
    allowedCurrencies: parseCsv(process.env.RULES_ENGINE_ALLOWED_CURRENCIES, []).map((value) => value.toUpperCase()),
    allowedIsinCountryPrefixes: parseCsv(
      process.env.RULES_ENGINE_ALLOWED_ISIN_COUNTRY_PREFIXES,
      scopeProfile.allowedIsinCountryPrefixes
    ).map((value) => value.toUpperCase()),
    excludedIsinCountryPrefixes: parseCsv(
      process.env.RULES_ENGINE_EXCLUDED_ISIN_COUNTRY_PREFIXES,
      scopeProfile.excludedIsinCountryPrefixes
    ).map((value) => value.toUpperCase()),
    allowedScheduleIds: parseIntegerCsv(process.env.RULES_ENGINE_ALLOWED_SCHEDULE_IDS, []),
    excludedScheduleIds: parseIntegerCsv(process.env.RULES_ENGINE_EXCLUDED_SCHEDULE_IDS, []),
    requireExtendedHours: parseBoolean(process.env.RULES_ENGINE_REQUIRE_EXTENDED_HOURS, false),
    minMaxOpenQuantity: parsePositiveNumber(process.env.RULES_ENGINE_MIN_MAX_OPEN_QUANTITY, 0),
    minInstrumentAgeDays: parsePositiveInteger(process.env.RULES_ENGINE_MIN_INSTRUMENT_AGE_DAYS, 0),
    excludedSymbolPatterns: parseCsv(process.env.RULES_ENGINE_EXCLUDED_SYMBOL_PATTERNS, []).map((value) => value.toUpperCase()),
    excludedNamePatterns: parseCsv(process.env.RULES_ENGINE_EXCLUDED_NAME_PATTERNS, DEFAULT_EXCLUDED_NAME_PATTERNS).map((value) => value.toUpperCase()),
    weightMentionCount: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_MENTION_COUNT, 3),
    weightSourceDiversity: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SOURCE_DIVERSITY, 4),
    weightNewsSignal: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_NEWS_SIGNAL, 1),
    weightInsiderSignal: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_INSIDER_SIGNAL, 1),
    weightScreeningStage: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREENING_STAGE, 1.5),
    weightWithinMarketCap: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_WITHIN_MARKET_CAP, 6),
    weightHasMarketCap: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_HAS_MARKET_CAP, 2),
    weightScreenPriceMomentum: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_PRICE_MOMENTUM, 4),
    weightScreenVolumeSurge: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_VOLUME_SURGE, 3),
    weightScreenLiquidity: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_LIQUIDITY, 2),
    weightScreenInstrumentAge: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_INSTRUMENT_AGE, 1),
    weightScreenInsiderSource: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_INSIDER_SOURCE, 2),
    weightScreenSeedSource: parsePositiveNumber(process.env.RULES_ENGINE_WEIGHT_SCREEN_SEED_SOURCE, 1),
    maxNewsScore: parsePositiveNumber(process.env.RULES_ENGINE_MAX_NEWS_SCORE, 8),
    maxInsiderScore: parsePositiveNumber(process.env.RULES_ENGINE_MAX_INSIDER_SCORE, 5),
    maxScreenPriceMomentumPct: parsePositiveNumber(process.env.RULES_ENGINE_MAX_SCREEN_PRICE_MOMENTUM_PCT, 40),
    maxScreenVolumeMultiple: parsePositiveNumber(process.env.RULES_ENGINE_MAX_SCREEN_VOLUME_MULTIPLE, 4),
    maxScreenLiquidityLog: parsePositiveNumber(process.env.RULES_ENGINE_MAX_SCREEN_LIQUIDITY_LOG, 6),
    maxScreenInstrumentAgeDays: parsePositiveInteger(process.env.RULES_ENGINE_MAX_SCREEN_INSTRUMENT_AGE_DAYS, 365),
    universeSampleSize: parsePositiveInteger(process.env.RULES_ENGINE_UNIVERSE_SAMPLE_SIZE, 50),
  };
}


function instrumentAgeDays(instrument) {
  if (!instrument?.addedOn) {
    return null;
  }

  const addedOn = new Date(instrument.addedOn);
  if (Number.isNaN(addedOn.getTime())) {
    return null;
  }

  const diffMs = Date.now() - addedOn.getTime();
  return Math.floor(diffMs / 86_400_000);
}


function evaluateUniverseRules(instrument, settings) {
  const reasons = [];
  const type = normalizeForMatch(instrument?.type);
  const currency = normalizeForMatch(instrument?.currencyCode);
  const isinPrefix = String(instrument?.isin || "").trim().slice(0, 2).toUpperCase();
  const scheduleId = Number.isInteger(instrument?.workingScheduleId) ? instrument.workingScheduleId : null;
  const maxOpenQuantity = Number(instrument?.maxOpenQuantity || 0);
  const ageDays = instrumentAgeDays(instrument);

  if (!isLikelyCommonEquity(instrument)) {
    reasons.push("not_common_equity");
  }

  if (settings.allowedInstrumentTypes.length > 0 && !settings.allowedInstrumentTypes.includes(type)) {
    reasons.push("instrument_type_filtered");
  }

  if (settings.allowedCurrencies.length > 0 && !settings.allowedCurrencies.includes(currency)) {
    reasons.push("currency_filtered");
  }

  if (settings.allowedIsinCountryPrefixes.length > 0 && !settings.allowedIsinCountryPrefixes.includes(isinPrefix)) {
    reasons.push("isin_country_filtered");
  }

  if (settings.excludedIsinCountryPrefixes.includes(isinPrefix)) {
    reasons.push("isin_country_blocked");
  }

  if (settings.allowedScheduleIds.length > 0 && !settings.allowedScheduleIds.includes(scheduleId)) {
    reasons.push("schedule_allowlist_filtered");
  }

  if (settings.excludedScheduleIds.includes(scheduleId)) {
    reasons.push("schedule_blocklist_filtered");
  }

  if (settings.requireExtendedHours && instrument?.extendedHours !== true) {
    reasons.push("extended_hours_required");
  }

  if (settings.minMaxOpenQuantity > 0 && (!Number.isFinite(maxOpenQuantity) || maxOpenQuantity < settings.minMaxOpenQuantity)) {
    reasons.push("max_open_quantity_too_low");
  }

  if (settings.minInstrumentAgeDays > 0 && (ageDays == null || ageDays < settings.minInstrumentAgeDays)) {
    reasons.push("instrument_too_new");
  }

  if (matchesAnyPattern([instrument?.ticker, instrument?.shortName], settings.excludedSymbolPatterns)) {
    reasons.push("symbol_pattern_filtered");
  }

  if (matchesAnyPattern([instrument?.name, instrument?.shortName], settings.excludedNamePatterns)) {
    reasons.push("name_pattern_filtered");
  }

  return {
    passed: reasons.length === 0,
    reasons,
    isinPrefix: isinPrefix || null,
    ageDays,
    maxOpenQuantity: Number.isFinite(maxOpenQuantity) ? maxOpenQuantity : null,
  };
}


function buildEligibleUniverse(instruments, settings) {
  const eligibleInstruments = [];
  const excludedReasonCounts = new Map();

  for (const instrument of safeArray(instruments)) {
    const symbol = resolveBrokerSymbol(instrument);
    if (!symbol) {
      excludedReasonCounts.set("invalid_symbol", (excludedReasonCounts.get("invalid_symbol") || 0) + 1);
      continue;
    }

    const evaluation = evaluateUniverseRules(instrument, settings);
    if (!evaluation.passed) {
      for (const reason of evaluation.reasons) {
        excludedReasonCounts.set(reason, (excludedReasonCounts.get(reason) || 0) + 1);
      }
      continue;
    }

    eligibleInstruments.push({
      symbol,
      brokerTicker: instrument.ticker,
      shortName: instrument.shortName || null,
      name: instrument.name || null,
      isin: instrument.isin || null,
      isinCountryPrefix: evaluation.isinPrefix,
      type: instrument.type || null,
      currencyCode: instrument.currencyCode || null,
      workingScheduleId: Number.isInteger(instrument.workingScheduleId) ? instrument.workingScheduleId : null,
      maxOpenQuantity: evaluation.maxOpenQuantity,
      extendedHours: instrument.extendedHours === true,
      addedOn: instrument.addedOn || null,
      ageDays: evaluation.ageDays,
      instrument,
    });
  }

  const eligibleIndex = new Map(eligibleInstruments.map((item) => [item.symbol, item.instrument]));
  const sample = eligibleInstruments.slice(0, settings.universeSampleSize).map((item) => ({
    symbol: item.symbol,
    shortName: item.shortName,
    name: item.name,
    type: item.type,
    currencyCode: item.currencyCode,
    workingScheduleId: item.workingScheduleId,
    maxOpenQuantity: item.maxOpenQuantity,
    extendedHours: item.extendedHours,
    addedOn: item.addedOn,
    ageDays: item.ageDays,
  }));

  return {
    eligibleInstruments,
    eligibleIndex,
    summary: {
      totalBrokerInstruments: safeArray(instruments).length,
      eligibleInstrumentCount: eligibleInstruments.length,
      excludedReasonCounts: Object.fromEntries(excludedReasonCounts.entries()),
      sampleEligibleInstruments: sample,
    },
  };
}


function buildInstrumentIndex(instruments) {
  const index = new Map();

  for (const instrument of safeArray(instruments)) {
    const symbol = resolveBrokerSymbol(instrument);
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


function parseFiniteNumber(value) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}


function average(values) {
  const numericValues = safeArray(values).filter((value) => Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}


function screeningWindowDates(lookbackDays) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - lookbackDays);
  return { startDate, endDate };
}


async function buildLightweightScreeningSnapshot({ symbol, settings, availability }) {
  const { startDate, endDate } = screeningWindowDates(settings.screeningLookbackDays);
  const snapshot = {};

  if (availability.tiingo) {
    const client = new TiingoClient();
    snapshot.tiingoPrices = await safeCall(() => client.getDailyPrices(symbol, {
      startDate,
      endDate,
      resampleFreq: "daily",
    }));
  }

  if (availability.finnhub) {
    const client = new FinnhubClient();
    snapshot.finnhubQuote = await safeCall(() => client.getQuote(symbol));
  }

  if (availability.fmp) {
    const client = new FmpClient();
    snapshot.fmpQuote = await safeCall(() => client.getQuote(symbol));
  }

  return snapshot;
}


function extractPriceActionMetrics(screeningSnapshot, settings) {
  const prices = safeArray(screeningSnapshot?.tiingoPrices)
    .map((entry) => ({
      close: parseFiniteNumber(entry?.close),
      volume: parseFiniteNumber(entry?.volume),
      date: entry?.date || null,
    }))
    .filter((entry) => Number.isFinite(entry.close));

  const latestPriceFromQuotes =
    parseFiniteNumber(screeningSnapshot?.finnhubQuote?.c)
    || parseFiniteNumber(coerceArray(screeningSnapshot?.fmpQuote)[0]?.price)
    || null;

  if (prices.length === 0) {
    return {
      latestPrice: latestPriceFromQuotes,
      momentumPct: null,
      latestVolume: null,
      averageVolume: null,
      volumeMultiple: null,
      observedPriceCount: 0,
    };
  }

  const latest = prices[prices.length - 1];
  const anchorIndex = Math.max(0, prices.length - 1 - settings.screeningMomentumDays);
  const anchor = prices[anchorIndex];
  const priorVolumes = prices.slice(Math.max(0, prices.length - 1 - settings.screeningMomentumDays), prices.length - 1)
    .map((entry) => entry.volume)
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageVolume = average(priorVolumes);

  return {
    latestPrice: latestPriceFromQuotes || latest.close,
    momentumPct: anchor?.close > 0 ? ((latest.close - anchor.close) / anchor.close) * 100 : null,
    latestVolume: Number.isFinite(latest.volume) ? latest.volume : null,
    averageVolume,
    volumeMultiple: averageVolume && latest.volume ? latest.volume / averageVolume : null,
    observedPriceCount: prices.length,
  };
}


function normalizeCappedPositive(value, cap) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(cap) || cap <= 0) {
    return 0;
  }

  return Math.min(value, cap) / cap;
}


function screeningCandidateScore({ rawCandidate, priceAction, settings }) {
  const liquidityLog = rawCandidate?.instrument?.maxOpenQuantity > 0
    ? Math.log10(Math.max(rawCandidate.instrument.maxOpenQuantity, 1))
    : 0;
  const ageDays = Number.isFinite(rawCandidate?.instrument?.ageDays) ? rawCandidate.instrument.ageDays : 0;
  const volumeExcess = Number.isFinite(priceAction?.volumeMultiple) ? Math.max(priceAction.volumeMultiple - 1, 0) : 0;

  let score =
    rawCandidate.mentionCount * settings.weightMentionCount
    + rawCandidate.sourceTypes.size * settings.weightSourceDiversity
    + normalizeCappedPositive(priceAction?.momentumPct, settings.maxScreenPriceMomentumPct) * settings.weightScreenPriceMomentum
    + normalizeCappedPositive(volumeExcess, Math.max(settings.maxScreenVolumeMultiple - 1, 1)) * settings.weightScreenVolumeSurge
    + normalizeCappedPositive(liquidityLog, settings.maxScreenLiquidityLog) * settings.weightScreenLiquidity
    + normalizeCappedPositive(ageDays, settings.maxScreenInstrumentAgeDays) * settings.weightScreenInstrumentAge;

  if (rawCandidate.sourceTypes.has("openinsider")) {
    score += settings.weightScreenInsiderSource;
  }

  if (rawCandidate.sourceTypes.has("seed_symbols")) {
    score += settings.weightScreenSeedSource;
  }

  return score;
}


async function runLightweightScreening(rawCandidates, settings, availability, { limit, fetchMarketData, onProgress, progressStage } = {}) {
  const screenedCandidates = [];
  const candidateLimit = Math.max(0, limit ?? settings.screeningLimit ?? safeArray(rawCandidates).length);
  const shouldFetchMarketData = fetchMarketData ?? settings.enableLightweightScreening;

  const candidates = safeArray(rawCandidates).slice(0, candidateLimit);
  for (const [index, rawCandidate] of candidates.entries()) {
    const screeningSnapshot = shouldFetchMarketData
      ? await buildLightweightScreeningSnapshot({ symbol: rawCandidate.symbol, settings, availability })
      : null;
    const priceAction = extractPriceActionMetrics(screeningSnapshot, settings);
    const screeningScore = screeningCandidateScore({ rawCandidate, priceAction, settings });

    screenedCandidates.push({
      ...rawCandidate,
      screeningScore,
      screeningSignals: {
        latestPrice: priceAction.latestPrice,
        momentumPct: priceAction.momentumPct,
        latestVolume: priceAction.latestVolume,
        averageVolume: priceAction.averageVolume,
        volumeMultiple: priceAction.volumeMultiple,
        observedPriceCount: priceAction.observedPriceCount,
        maxOpenQuantity: rawCandidate.instrument?.maxOpenQuantity ?? null,
        ageDays: rawCandidate.instrument?.ageDays ?? null,
      },
    });

    if ((index + 1 === candidates.length || (index + 1) % 5 === 0 || index === 0) && progressStage) {
      emitProgress(onProgress, {
        stage: progressStage,
        detail: `${rawCandidate.symbol} (${index + 1}/${candidates.length})`,
        completed: index + 1,
        total: candidates.length,
      });
    }
  }

  screenedCandidates.sort((left, right) => right.screeningScore - left.screeningScore);
  return screenedCandidates;
}


function createUniverseScreenCandidate(eligibleInstrument) {
  return {
    symbol: eligibleInstrument.symbol,
    instrument: {
      ...eligibleInstrument.instrument,
      maxOpenQuantity: eligibleInstrument.maxOpenQuantity,
      ageDays: eligibleInstrument.ageDays,
    },
    companyName: eligibleInstrument.name || eligibleInstrument.shortName || null,
    mentionCount: 0,
    sourceTypes: new Set(),
    catalysts: new Set(),
    sourceNotes: [],
  };
}


async function runUniverseScreening(eligibleInstruments, settings, availability, onProgress) {
  const universeCandidates = safeArray(eligibleInstruments).map(createUniverseScreenCandidate);
  emitProgress(onProgress, {
    stage: "universe_screen_metadata",
    detail: `Ranking ${universeCandidates.length} eligible names using broker metadata`,
    completed: 0,
    total: universeCandidates.length,
  });
  const metadataRankedCandidates = await runLightweightScreening(universeCandidates, settings, availability, {
    limit: universeCandidates.length,
    fetchMarketData: false,
    onProgress,
    progressStage: "universe_screen_metadata",
  });

  const priceScreenCandidates = settings.enableUniverseScreening
    ? await runLightweightScreening(
        metadataRankedCandidates,
        settings,
        availability,
        {
          limit: Math.min(metadataRankedCandidates.length, settings.universePriceScreenLimit),
          fetchMarketData: true,
          onProgress,
          progressStage: "universe_screen_prices",
        }
      )
    : metadataRankedCandidates.slice(0, settings.universeShortlistLimit);

  const shortlistedCandidates = priceScreenCandidates.slice(0, settings.universeShortlistLimit);
  const shortlistedSymbols = shortlistedCandidates.map((candidate) => candidate.symbol);

  return {
    metadataRankedCount: metadataRankedCandidates.length,
    priceScreenedCount: priceScreenCandidates.length,
    shortlistedCount: shortlistedCandidates.length,
    shortlistedSymbols,
    candidates: shortlistedCandidates,
  };
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


function selectionBucket(marketCap, minThreshold, maxThreshold, nearLimitMultiple) {
  if (!marketCap) {
    return "unknown";
  }
  if (marketCap < minThreshold) {
    return "below_floor";
  }
  if (marketCap <= maxThreshold) {
    return "within_limit";
  }
  if (marketCap <= maxThreshold * nearLimitMultiple) {
    return "near_limit";
  }
  return "above_limit";
}


function candidateScore({ rawCandidate, marketCap, newsSignal, insiderSignal, settings }) {
  const score =
    (rawCandidate.screeningScore || 0) * settings.weightScreeningStage
    + rawCandidate.mentionCount * settings.weightMentionCount
    + rawCandidate.sourceTypes.size * settings.weightSourceDiversity
    + Math.min(newsSignal, settings.maxNewsScore) * settings.weightNewsSignal
    + Math.min(insiderSignal, settings.maxInsiderScore) * settings.weightInsiderSignal
    + (marketCap && marketCap >= settings.minMarketCap && marketCap <= settings.maxMarketCap ? settings.weightWithinMarketCap : 0)
    + (marketCap ? settings.weightHasMarketCap : 0);

  return score;
}


function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    symbol: candidate.symbol,
    companyName: candidate.companyName,
    marketCap: candidate.marketCap,
    selectionBucket: candidate.selectionBucket,
    score: candidate.score,
    screeningScore: candidate.screeningScore || 0,
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
    screeningSignals: candidate.screeningSignals || null,
    newsSignal: candidate.newsSignal,
    insiderSignal: candidate.insiderSignal,
    sourceNotes: candidate.sourceNotes,
  }));
}


async function loadTrading212InstrumentUniverse() {
  const brokerClient = new Trading212Client();
  const provider = "trading212";
  const environment = brokerClient.environment;

  try {
    const instruments = await brokerClient.getAllInstruments({ forceRefresh: true });
    await upsertBrokerInstrumentUniverse({
      provider,
      environment,
      instruments,
      metadata: {
        source: "live_api",
        refreshedAt: new Date().toISOString(),
      },
    });

    return {
      instruments,
      source: "live_api",
      provider,
      environment,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const storedUniverse = await getBrokerInstrumentUniverse({ provider, environment });
    const storedInstruments = safeArray(storedUniverse?.instruments);

    if (storedInstruments.length > 0) {
      return {
        instruments: storedInstruments,
        source: "database_fallback",
        provider,
        environment,
        fetchedAt: storedUniverse?.fetched_at || storedUniverse?.fetchedAt || null,
        fallbackReason: error.message,
      };
    }

    throw error;
  }
}


async function runRulesEngineSelection({
  seedSymbols = [],
  maxCandidates,
  rawCandidateLimit,
  maxMarketCap,
  newsLimit,
  insiderRows,
  queryTerms,
  onProgress,
} = {}) {
  const settings = buildRulesEngineSettings({
    maxCandidates,
    rawCandidateLimit,
    maxMarketCap,
    newsLimit,
    insiderRows,
    queryTerms,
  });

  const availability = providerStatus();
  emitProgress(onProgress, {
    stage: "load_universe",
    detail: "Loading Trading 212 instrument universe",
  });
  const instrumentUniverse = await loadTrading212InstrumentUniverse();
  const allInstruments = instrumentUniverse.instruments;
  const { eligibleInstruments, eligibleIndex, summary: eligibleUniverseSummary } = buildEligibleUniverse(allInstruments, settings);
  emitProgress(onProgress, {
    stage: "eligible_universe",
    detail: `Eligible universe: ${eligibleUniverseSummary.eligibleInstrumentCount} of ${allInstruments.length}`,
  });
  const universeScreening = await runUniverseScreening(eligibleInstruments, settings, availability, onProgress);
  const screenedUniverseIndex = new Map(
    universeScreening.shortlistedSymbols
      .map((symbol) => [symbol, eligibleIndex.get(symbol)])
      .filter(([, instrument]) => Boolean(instrument))
  );
  const candidateMap = new Map();
  const normalizedSeedSymbols = uniqueSymbols(seedSymbols);

  if (settings.includeUniverseScreenSeeds) {
    for (const shortlistedCandidate of universeScreening.candidates) {
      const instrument = screenedUniverseIndex.get(shortlistedCandidate.symbol);
      if (!instrument) {
        continue;
      }

      recordCandidate(candidateMap, shortlistedCandidate.symbol, instrument, {
        sourceType: "universe_screen",
        catalyst: "stage1 universe screen",
        companyName: shortlistedCandidate.companyName || instrument.name || null,
      });
    }
  }

  if (settings.includeSeedSymbols) {
    for (const symbol of normalizedSeedSymbols) {
      const instrument = eligibleIndex.get(symbol);
      if (instrument) {
        recordCandidate(candidateMap, symbol, instrument, {
          sourceType: "seed_symbols",
          catalyst: "watchlist seed",
        });
      }
    }
  }

  if (availability.finnhub && settings.enableMarketNews) {
    emitProgress(onProgress, {
      stage: "discovery_market_news",
      detail: "Scanning Finnhub market news",
    });
    const client = new FinnhubClient();
    const marketNews = await safeCall(() => client.getMarketNews({ category: "general", limit: settings.newsLimit * settings.marketNewsLimitMultiplier }));
    for (const article of safeArray(marketNews)) {
      for (const symbol of extractFinnhubSymbols(article)) {
        const instrument = screenedUniverseIndex.get(symbol);
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

  if (availability.newsdata && settings.enableNewsData) {
    const client = new NewsDataClient();
    for (const [index, query] of settings.queryTerms.entries()) {
      emitProgress(onProgress, {
        stage: "discovery_newsdata",
        detail: `Running NewsData query ${index + 1}/${settings.queryTerms.length}: ${query}`,
        completed: index,
        total: settings.queryTerms.length,
      });
      const newsResponse = await safeCall(() => client.getLatestNews({ query, category: "business", language: "en" }));
      const articles = safeArray(newsResponse?.results);
      for (const article of articles) {
        for (const symbol of extractNewsDataSymbols(article)) {
          const instrument = screenedUniverseIndex.get(symbol);
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
    emitProgress(onProgress, {
      stage: "discovery_newsdata",
      detail: `Completed ${settings.queryTerms.length} NewsData queries`,
      completed: settings.queryTerms.length,
      total: settings.queryTerms.length,
    });
  }

  if (settings.enableOpenInsider) {
    emitProgress(onProgress, {
      stage: "discovery_openinsider",
      detail: `Scanning latest insider filings (${settings.insiderRows} rows)`,
    });
    const insiderClient = new OpenInsiderClient();
    const insiderResponse = await safeCall(() => insiderClient.getLatestInsiderTrades({ rows: settings.insiderRows }));
    for (const row of safeArray(insiderResponse?.rows)) {
      const symbol = normalizeSymbol(row?.ticker);
      const instrument = screenedUniverseIndex.get(symbol);
      if (!symbol || !instrument) {
        continue;
      }

      recordCandidate(candidateMap, symbol, instrument, {
        sourceType: "openinsider",
        title: row.companyName || null,
        catalyst: row.tradeType || "insider activity",
      });
    }
  }

  const rawCandidates = [...candidateMap.values()].sort((left, right) => {
    if (right.sourceTypes.size !== left.sourceTypes.size) {
      return right.sourceTypes.size - left.sourceTypes.size;
    }

    return right.mentionCount - left.mentionCount;
  });

  emitProgress(onProgress, {
    stage: "candidate_screening",
    detail: `Screening ${Math.min(rawCandidates.length, settings.screeningLimit)} discovery candidates`,
    completed: 0,
    total: Math.min(rawCandidates.length, settings.screeningLimit),
  });
  const screenedCandidates = await runLightweightScreening(rawCandidates, settings, availability, {
    onProgress,
    progressStage: "candidate_screening",
  });
  const preEnrichmentCandidates = screenedCandidates.slice(0, settings.rawCandidateLimit);

  const enrichedCandidates = [];
  emitProgress(onProgress, {
    stage: "candidate_enrichment",
    detail: `Building deep snapshots for ${preEnrichmentCandidates.length} shortlisted names`,
    completed: 0,
    total: preEnrichmentCandidates.length,
  });
  for (const [index, rawCandidate] of preEnrichmentCandidates.entries()) {
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
      settings,
    });

    enrichedCandidates.push({
      ...rawCandidate,
      companyName,
      cik,
      marketCap,
      selectionBucket: selectionBucket(
        marketCap,
        settings.minMarketCap,
        settings.maxMarketCap,
        settings.nearLimitMultiple
      ),
      newsSignal,
      insiderSignal,
      score,
    });

    emitProgress(onProgress, {
      stage: "candidate_enrichment",
      detail: `${rawCandidate.symbol} (${index + 1}/${preEnrichmentCandidates.length})`,
      completed: index + 1,
      total: preEnrichmentCandidates.length,
    });
  }

  enrichedCandidates.sort((left, right) => {
    const leftEligible = left.selectionBucket === "within_limit" ? 2 : left.selectionBucket === "unknown" ? 1 : left.selectionBucket === "near_limit" ? 0 : -1;
    const rightEligible = right.selectionBucket === "within_limit" ? 2 : right.selectionBucket === "unknown" ? 1 : right.selectionBucket === "near_limit" ? 0 : -1;
    if (rightEligible !== leftEligible) {
      return rightEligible - leftEligible;
    }
    return right.score - left.score;
  });

  const selectedCandidates = enrichedCandidates
    .filter((candidate) => {
      if (candidate.selectionBucket === "within_limit") {
        return true;
      }
      if (candidate.selectionBucket === "unknown") {
        return settings.allowUnknownMarketCap;
      }
      if (candidate.selectionBucket === "near_limit") {
        return settings.includeNearLimit;
      }
      return false;
    })
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
    instrumentUniverse: {
      provider: instrumentUniverse.provider,
      environment: instrumentUniverse.environment,
      source: instrumentUniverse.source,
      fetchedAt: instrumentUniverse.fetchedAt,
      fallbackReason: instrumentUniverse.fallbackReason || null,
      instrumentCount: allInstruments.length,
    },
    seedSymbols: normalizedSeedSymbols,
    newsProfile: settings.newsProfile,
    marketScopeProfile: settings.marketScopeProfile,
    queryTerms: settings.queryTerms,
    config: settings,
    eligibleUniverseSummary,
    universeScreeningSummary: {
      screeningEnabled: settings.enableUniverseScreening,
      includeUniverseScreenSeeds: settings.includeUniverseScreenSeeds,
      metadataRankedCount: universeScreening.metadataRankedCount,
      priceScreenedCount: universeScreening.priceScreenedCount,
      shortlistedCount: universeScreening.shortlistedCount,
    },
    screeningSummary: {
      screeningEnabled: settings.enableLightweightScreening,
      screeningPoolCount: Math.min(rawCandidates.length, settings.screeningLimit),
      shortlistedForEnrichmentCount: preEnrichmentCandidates.length,
    },
    eligibleUniverse: eligibleInstruments.map((item) => ({
      symbol: item.symbol,
      brokerTicker: item.brokerTicker,
      shortName: item.shortName,
      name: item.name,
      isin: item.isin,
      isinCountryPrefix: item.isinCountryPrefix,
      type: item.type,
      currencyCode: item.currencyCode,
      workingScheduleId: item.workingScheduleId,
      maxOpenQuantity: item.maxOpenQuantity,
      extendedHours: item.extendedHours,
      addedOn: item.addedOn,
      ageDays: item.ageDays,
    })),
    screenedUniverseCandidates: summarizeCandidates(universeScreening.candidates),
    rawCandidateCount: rawCandidates.length,
    screenedCandidates: summarizeCandidates(screenedCandidates.slice(0, settings.screeningLimit)),
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