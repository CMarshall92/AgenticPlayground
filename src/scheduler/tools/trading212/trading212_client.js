require("dotenv").config();

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_ENVIRONMENT = "live";
const MAX_PAGE_SIZE = 50;
const DEFAULT_REPORT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REPORT_TIMEOUT_MS = 5 * 60_000;

const API_ROOTS = {
  demo: "https://demo.trading212.com",
  paper: "https://demo.trading212.com",
  live: "https://live.trading212.com",
};

const TIME_VALIDITIES = new Set(["DAY", "GOOD_TILL_CANCEL"]);
const DIVIDEND_CASH_ACTIONS = new Set(["REINVEST", "TO_ACCOUNT_CASH"]);
const REPORT_STATUSES = new Set(["Queued", "Processing", "Running", "Canceled", "Failed", "Finished"]);
const ORDER_TYPES = new Set(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]);


class Trading212Error extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}


class Trading212ConfigurationError extends Trading212Error {}


class Trading212ValidationError extends Trading212Error {
  constructor(message, details = null) {
    super(message);
    this.details = details;
  }
}


class Trading212RequestError extends Trading212Error {
  constructor(statusCode, message, payload = null) {
    super(message);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}


function normalizeEnvironment(environment) {
  const selected = String(environment || process.env.T212_ENV || DEFAULT_ENVIRONMENT).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(API_ROOTS, selected)) {
    throw new Trading212ConfigurationError(
      `Unsupported Trading 212 environment '${selected}'. Expected one of: ${Object.keys(API_ROOTS).join(", ")}.`
    );
  }
  return selected;
}


function buildBasicAuthHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;
}


function resolveCredentials(environment, { apiKey, apiSecret } = {}) {
  if (apiKey && apiSecret) {
    return { apiKey, apiSecret };
  }

  const normalizedEnvironment = normalizeEnvironment(environment);
  const environmentPrefix = normalizedEnvironment === "live" ? "LIVE" : "DEMO";
  const resolvedKey = apiKey || process.env[`${environmentPrefix}_T212_API_KEY`] || process.env.T212_API_KEY;
  const resolvedSecret = apiSecret || process.env[`${environmentPrefix}_T212_API_SECRET`] || process.env.T212_API_SECRET;

  if (!resolvedKey || !resolvedSecret) {
    throw new Trading212ConfigurationError(
      `Missing Trading 212 credentials for '${normalizedEnvironment}'. Set ${environmentPrefix}_T212_API_KEY and ${environmentPrefix}_T212_API_SECRET, or provide T212_API_KEY and T212_API_SECRET.`
    );
  }

  return {
    apiKey: resolvedKey,
    apiSecret: resolvedSecret,
  };
}


function getT212Headers({ apiKey, apiSecret, environment } = {}) {
  const resolvedCredentials = resolveCredentials(environment, { apiKey, apiSecret });

  return {
    Authorization: buildBasicAuthHeader(resolvedCredentials.apiKey, resolvedCredentials.apiSecret),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}


function validateLimit(limit) {
  if (limit == null) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Trading212ValidationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}


function assertPlainObject(value, name) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Trading212ValidationError(`${name} must be a plain object.`);
  }
}


function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Trading212ValidationError(`${name} must be a non-empty string.`);
  }
}


function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Trading212ValidationError(`${name} must be a finite number.`);
  }
}


function assertBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Trading212ValidationError(`${name} must be a boolean.`);
  }
}


function assertEnum(value, allowedValues, name) {
  if (value == null) {
    return;
  }
  if (!allowedValues.has(value)) {
    throw new Trading212ValidationError(
      `${name} must be one of: ${Array.from(allowedValues).join(", ")}.`
    );
  }
}


function assertAllowedKeys(payload, allowedKeys, requiredKeys, name) {
  assertPlainObject(payload, name);
  const payloadKeys = Object.keys(payload);
  const unknownKeys = payloadKeys.filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Trading212ValidationError(
      `${name} contains unsupported keys: ${unknownKeys.join(", ")}.`
    );
  }

  const missingKeys = Array.from(requiredKeys).filter((key) => payload[key] == null);
  if (missingKeys.length > 0) {
    throw new Trading212ValidationError(
      `${name} is missing required keys: ${missingKeys.join(", ")}.`
    );
  }
}


function ensureArrayResponse(value, endpointName) {
  if (!Array.isArray(value)) {
    throw new Trading212RequestError(0, `Expected ${endpointName} to return an array.`, value);
  }
  return value;
}


function ensureObjectResponse(value, endpointName) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Trading212RequestError(0, `Expected ${endpointName} to return an object.`, value);
  }
  return value;
}


function ensurePaginatedResponse(value, endpointName) {
  const response = ensureObjectResponse(value, endpointName);
  if (!Array.isArray(response.items) || !Object.prototype.hasOwnProperty.call(response, "nextPagePath")) {
    throw new Trading212RequestError(0, `Expected ${endpointName} to return a paginated response.`, value);
  }
  return response;
}


function normalizeAccountCashResponse(value) {
  const response = ensureObjectResponse(value, "account cash");

  const availableToTrade = response.availableToTrade ?? response.free ?? null;
  const inPies = response.inPies ?? response.pieCash ?? null;
  const reservedForOrders = response.reservedForOrders ?? response.blocked ?? null;

  return {
    availableToTrade,
    inPies,
    reservedForOrders,
    total: response.total ?? null,
    invested: response.invested ?? null,
    result: response.result ?? null,
    profitLoss: response.ppl ?? null,
    raw: response,
  };
}


function pickDefined(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}


function mergeStrictPayload(payload, namedFields) {
  const merged = { ...(payload || {}) };
  for (const [key, value] of Object.entries(namedFields)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}


function validateTicker(ticker, name = "ticker") {
  assertString(ticker, name);
}


function validateOrderPayload(payload, orderType) {
  const allowedFieldsByType = {
    MARKET: new Set(["ticker", "quantity", "extendedHours"]),
    LIMIT: new Set(["ticker", "quantity", "limitPrice", "timeValidity"]),
    STOP: new Set(["ticker", "quantity", "stopPrice", "timeValidity"]),
    STOP_LIMIT: new Set(["ticker", "quantity", "stopPrice", "limitPrice", "timeValidity"]),
  };

  const requiredFieldsByType = {
    MARKET: new Set(["ticker", "quantity"]),
    LIMIT: new Set(["ticker", "quantity", "limitPrice"]),
    STOP: new Set(["ticker", "quantity", "stopPrice"]),
    STOP_LIMIT: new Set(["ticker", "quantity", "stopPrice", "limitPrice"]),
  };

  assertEnum(orderType, ORDER_TYPES, "orderType");
  assertAllowedKeys(payload, allowedFieldsByType[orderType], requiredFieldsByType[orderType], `${orderType} order payload`);
  validateTicker(payload.ticker);
  assertFiniteNumber(payload.quantity, "quantity");

  if (Object.prototype.hasOwnProperty.call(payload, "limitPrice")) {
    assertFiniteNumber(payload.limitPrice, "limitPrice");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "stopPrice")) {
    assertFiniteNumber(payload.stopPrice, "stopPrice");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "extendedHours")) {
    assertBoolean(payload.extendedHours, "extendedHours");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "timeValidity")) {
    assertEnum(payload.timeValidity, TIME_VALIDITIES, "timeValidity");
  }

  return payload;
}


function validateReportRequest(payload) {
  const allowed = new Set(["timeFrom", "timeTo", "dataIncluded"]);
  const required = new Set(["timeFrom", "timeTo", "dataIncluded"]);
  assertAllowedKeys(payload, allowed, required, "report payload");
  assertString(payload.timeFrom, "timeFrom");
  assertString(payload.timeTo, "timeTo");
  assertPlainObject(payload.dataIncluded, "dataIncluded");

  const allowedDataIncluded = new Set([
    "includeDividends",
    "includeInterest",
    "includeOrders",
    "includeTransactions",
  ]);
  assertAllowedKeys(payload.dataIncluded, allowedDataIncluded, new Set(), "dataIncluded");
  for (const [key, value] of Object.entries(payload.dataIncluded)) {
    assertBoolean(value, key);
  }

  return payload;
}


function validateInstrumentShares(instrumentShares) {
  assertPlainObject(instrumentShares, "instrumentShares");
  const entries = Object.entries(instrumentShares);
  if (entries.length === 0) {
    throw new Trading212ValidationError("instrumentShares must contain at least one ticker.");
  }
  for (const [ticker, value] of entries) {
    validateTicker(ticker, `instrumentShares.${ticker}`);
    assertFiniteNumber(value, `instrumentShares.${ticker}`);
  }
}


function validatePiePayload(payload, name = "pie payload") {
  const allowed = new Set(["name", "instrumentShares", "dividendCashAction", "endDate", "goal", "icon"]);
  assertAllowedKeys(payload, allowed, new Set(), name);

  if (Object.prototype.hasOwnProperty.call(payload, "name")) {
    assertString(payload.name, "name");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "instrumentShares")) {
    validateInstrumentShares(payload.instrumentShares);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "dividendCashAction")) {
    assertEnum(payload.dividendCashAction, DIVIDEND_CASH_ACTIONS, "dividendCashAction");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "endDate")) {
    assertString(payload.endDate, "endDate");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "goal")) {
    assertFiniteNumber(payload.goal, "goal");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "icon")) {
    assertString(payload.icon, "icon");
  }

  return payload;
}


function validateDuplicatePiePayload(payload) {
  const allowed = new Set(["name", "icon"]);
  assertAllowedKeys(payload, allowed, new Set(["name", "icon"]), "duplicate pie payload");
  assertString(payload.name, "name");
  assertString(payload.icon, "icon");
  return payload;
}


function validateTargetWeights(targetWeights) {
  assertPlainObject(targetWeights, "targetWeights");
  const entries = Object.entries(targetWeights);
  if (entries.length === 0) {
    throw new Trading212ValidationError("targetWeights must contain at least one allocation.");
  }

  let total = 0;
  for (const [symbol, weight] of entries) {
    assertString(symbol, `targetWeights.${symbol}`);
    assertFiniteNumber(weight, `targetWeights.${symbol}`);
    if (weight < 0 || weight > 100) {
      throw new Trading212ValidationError(`targetWeights.${symbol} must be between 0 and 100.`);
    }
    total += weight;
  }

  if (Math.abs(total - 100) > 0.0001) {
    throw new Trading212ValidationError(`targetWeights must sum to 100. Received ${total}.`);
  }
}


class Trading212Client {
  constructor({
    apiKey,
    apiSecret,
    environment,
    baseUrl,
    timeout = DEFAULT_TIMEOUT,
    fetchImpl,
  } = {}) {
    this.environment = normalizeEnvironment(environment);
    this.baseUrl = (baseUrl || API_ROOTS[this.environment]).replace(/\/$/, "");
    this.timeout = timeout;
    this.headers = getT212Headers({ apiKey, apiSecret, environment: this.environment });
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.lastRateLimit = {};
    this.cache = new Map();

    if (typeof this.fetchImpl !== "function") {
      throw new Trading212ConfigurationError(
        "Fetch API is not available. Use Node.js 18+ or provide fetchImpl explicitly."
      );
    }
  }

  static fromEnv({ environment, fetchImpl } = {}) {
    return new Trading212Client({ environment, fetchImpl });
  }

  buildUrl(path, params) {
    const url = path.startsWith("http://") || path.startsWith("https://")
      ? new URL(path)
      : new URL(path.startsWith("/") ? path : `/api/v0/${path.replace(/^\/+/, "")}`, this.baseUrl);

    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  captureRateLimitHeaders(headers) {
    this.lastRateLimit = {
      limit: headers.get("x-ratelimit-limit"),
      period: headers.get("x-ratelimit-period"),
      remaining: headers.get("x-ratelimit-remaining"),
      reset: headers.get("x-ratelimit-reset"),
      used: headers.get("x-ratelimit-used"),
    };
  }

  async parseResponseBody(response) {
    const text = await response.text();
    if (!text) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return JSON.parse(text);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async request(method, path, { params, payload } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const url = this.buildUrl(path, params);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });

      this.captureRateLimitHeaders(response.headers);
      const parsed = await this.parseResponseBody(response);

      if (!response.ok) {
        const message = parsed && typeof parsed === "object"
          ? parsed.message || parsed.error || JSON.stringify(parsed)
          : String(parsed || response.statusText);
        throw new Trading212RequestError(response.status, message, parsed);
      }

      return parsed;
    } catch (error) {
      if (error instanceof Trading212Error) {
        throw error;
      }
      if (error.name === "AbortError") {
        throw new Trading212RequestError(408, `Trading 212 request timed out after ${this.timeout}ms.`);
      }
      throw new Trading212RequestError(0, `Unable to reach Trading 212 API: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async get(path, params) {
    return this.request("GET", path, { params });
  }

  async post(path, payload) {
    return this.request("POST", path, { payload });
  }

  async delete(path) {
    return this.request("DELETE", path);
  }

  async getCached(cacheKey, path, ttlMs) {
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < ttlMs) {
      return cached.value;
    }

    const value = await this.get(path);
    this.cache.set(cacheKey, { timestamp: now, value });
    return value;
  }

  async *paginate(path, { params } = {}) {
    let nextPath = path;
    let nextParams = { ...(params || {}) };

    while (nextPath) {
      const page = ensurePaginatedResponse(await this.get(nextPath, nextParams), nextPath);
      for (const item of page.items) {
        yield item;
      }
      nextPath = page.nextPagePath;
      nextParams = undefined;
    }
  }

  async listEndpoint(path, { limit, cursor, extraParams, allPages = false } = {}) {
    const params = {
      limit: validateLimit(limit),
      cursor,
      ...(extraParams || {}),
    };

    if (allPages) {
      const items = [];
      for await (const item of this.paginate(path, { params })) {
        items.push(item);
      }
      return items;
    }

    return this.get(path, params);
  }

  async getAccountSummary() {
    return ensureObjectResponse(await this.get("/api/v0/equity/account/summary"), "account summary");
  }

  async getAccountCash() {
    return normalizeAccountCashResponse(await this.get("/api/v0/equity/account/cash"));
  }

  async getExchangesMetadata({ forceRefresh = false } = {}) {
    if (forceRefresh) {
      this.cache.delete("exchanges");
    }
    return ensureArrayResponse(
      await this.getCached("exchanges", "/api/v0/equity/metadata/exchanges", 10 * 60_000),
      "exchanges metadata"
    );
  }

  async getAllInstruments({ forceRefresh = false } = {}) {
    if (forceRefresh) {
      this.cache.delete("instruments");
    }
    return ensureArrayResponse(
      await this.getCached("instruments", "/api/v0/equity/metadata/instruments", 10 * 60_000),
      "instruments metadata"
    );
  }

  async searchInstrument(ticker, { exact = false, limit = 10 } = {}) {
    validateTicker(ticker);
    validateLimit(Math.min(limit, MAX_PAGE_SIZE));

    const normalizedQuery = ticker.trim().toLowerCase();
    const instruments = await this.getAllInstruments();
    const exactMatches = [];
    const partialMatches = [];

    for (const instrument of instruments) {
      const candidateValues = [
        instrument.ticker,
        instrument.name,
        instrument.shortName,
        instrument.isin,
        instrument.currencyCode,
        instrument.type,
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim().toLowerCase());

      if (candidateValues.includes(normalizedQuery)) {
        exactMatches.push(instrument);
        continue;
      }

      if (!exact && candidateValues.some((value) => value.includes(normalizedQuery))) {
        partialMatches.push(instrument);
      }
    }

    const matches = exact ? exactMatches : [...exactMatches, ...partialMatches];

    return {
      query: ticker,
      environment: this.environment,
      exactMatch: exactMatches.length > 0,
      matchCount: matches.length,
      matches: matches.slice(0, limit),
      rateLimit: this.lastRateLimit,
    };
  }

  async getInstrumentByTicker(ticker, { exact = true } = {}) {
    const result = await this.searchInstrument(ticker, { exact, limit: 1 });
    return result.matches[0] || null;
  }

  async verifyTradableInstrument(ticker, { exact = true } = {}) {
    const result = await this.searchInstrument(ticker, { exact, limit: 5 });
    const primaryMatch = result.matches[0] || null;

    return {
      query: ticker,
      environment: this.environment,
      found: Boolean(primaryMatch),
      exactMatch: result.exactMatch,
      tradable: Boolean(primaryMatch),
      instrument: primaryMatch,
      alternatives: result.matches.slice(1),
      rateLimit: result.rateLimit,
    };
  }

  async getPendingOrders() {
    return ensureArrayResponse(await this.get("/api/v0/equity/orders"), "pending orders");
  }

  async getPendingOrderById(orderId) {
    if (!Number.isInteger(orderId) || orderId < 0) {
      throw new Trading212ValidationError("orderId must be a positive integer.");
    }
    return ensureObjectResponse(await this.get(`/api/v0/equity/orders/${orderId}`), "pending order by id");
  }

  async cancelPendingOrder(orderId) {
    if (!Number.isInteger(orderId) || orderId < 0) {
      throw new Trading212ValidationError("orderId must be a positive integer.");
    }
    return this.delete(`/api/v0/equity/orders/${orderId}`);
  }

  async placeMarketOrder(payload) {
    const validated = validateOrderPayload(payload, "MARKET");
    return ensureObjectResponse(await this.post("/api/v0/equity/orders/market", validated), "market order");
  }

  async placeLimitOrder(payload) {
    const validated = validateOrderPayload(payload, "LIMIT");
    return ensureObjectResponse(await this.post("/api/v0/equity/orders/limit", validated), "limit order");
  }

  async placeStopOrder(payload) {
    const validated = validateOrderPayload(payload, "STOP");
    return ensureObjectResponse(await this.post("/api/v0/equity/orders/stop", validated), "stop order");
  }

  async placeStopLimitOrder(payload) {
    const validated = validateOrderPayload(payload, "STOP_LIMIT");
    return ensureObjectResponse(await this.post("/api/v0/equity/orders/stop_limit", validated), "stop-limit order");
  }

  async getPositions({ ticker } = {}) {
    if (ticker !== undefined) {
      validateTicker(ticker);
    }
    return ensureArrayResponse(await this.get("/api/v0/equity/positions", pickDefined([["ticker", ticker]])), "positions");
  }

  async getPaidOutDividends({ limit, cursor, ticker, allPages = false } = {}) {
    if (ticker !== undefined) {
      validateTicker(ticker);
    }
    const response = await this.listEndpoint("/api/v0/equity/history/dividends", {
      limit,
      cursor,
      extraParams: pickDefined([["ticker", ticker]]),
      allPages,
    });
    return allPages ? response : ensurePaginatedResponse(response, "dividends");
  }

  async listGeneratedReports() {
    return ensureArrayResponse(await this.get("/api/v0/equity/history/exports"), "generated reports");
  }

  async requestCsvReport(payload) {
    const validated = validateReportRequest(payload);
    return ensureObjectResponse(await this.post("/api/v0/equity/history/exports", validated), "csv report request");
  }

  async waitForReport(reportId, {
    pollIntervalMs = DEFAULT_REPORT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_REPORT_TIMEOUT_MS,
  } = {}) {
    if (!Number.isInteger(reportId) || reportId < 0) {
      throw new Trading212ValidationError("reportId must be a positive integer.");
    }
    assertFiniteNumber(pollIntervalMs, "pollIntervalMs");
    assertFiniteNumber(timeoutMs, "timeoutMs");

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const reports = await this.listGeneratedReports();
      const report = reports.find((candidate) => candidate.reportId === reportId);
      if (report) {
        assertEnum(report.status, REPORT_STATUSES, "report status");
        if (report.status === "Finished" || report.status === "Canceled" || report.status === "Failed") {
          return report;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Trading212RequestError(408, `Timed out waiting for report ${reportId}.`);
  }

  async getHistoricalOrders({ limit, cursor, ticker, allPages = false } = {}) {
    if (ticker !== undefined) {
      validateTicker(ticker);
    }
    const response = await this.listEndpoint("/api/v0/equity/history/orders", {
      limit,
      cursor,
      extraParams: pickDefined([["ticker", ticker]]),
      allPages,
    });
    return allPages ? response : ensurePaginatedResponse(response, "historical orders");
  }

  async getTransactions({ limit, cursor, timeFrom, allPages = false } = {}) {
    if (timeFrom !== undefined) {
      assertString(timeFrom, "timeFrom");
    }
    const response = await this.listEndpoint("/api/v0/equity/history/transactions", {
      limit,
      cursor,
      extraParams: pickDefined([["time", timeFrom]]),
      allPages,
    });
    return allPages ? response : ensurePaginatedResponse(response, "transactions");
  }

  async getPies() {
    return ensureArrayResponse(await this.get("/api/v0/equity/pies"), "pies");
  }

  async createPie(payload) {
    const validated = validatePiePayload(payload, "create pie payload");
    return ensureObjectResponse(await this.post("/api/v0/equity/pies", validated), "create pie");
  }

  async deletePie(pieId) {
    if (!Number.isInteger(pieId) || pieId < 0) {
      throw new Trading212ValidationError("pieId must be a positive integer.");
    }
    return this.delete(`/api/v0/equity/pies/${pieId}`);
  }

  async getPie(pieId) {
    if (!Number.isInteger(pieId) || pieId < 0) {
      throw new Trading212ValidationError("pieId must be a positive integer.");
    }
    return ensureObjectResponse(await this.get(`/api/v0/equity/pies/${pieId}`), "pie");
  }

  async updatePie(pieId, payload) {
    if (!Number.isInteger(pieId) || pieId < 0) {
      throw new Trading212ValidationError("pieId must be a positive integer.");
    }
    const validated = validatePiePayload(payload, "update pie payload");
    return ensureObjectResponse(await this.post(`/api/v0/equity/pies/${pieId}`, validated), "update pie");
  }

  async duplicatePie(pieId, payload) {
    if (!Number.isInteger(pieId) || pieId < 0) {
      throw new Trading212ValidationError("pieId must be a positive integer.");
    }
    const validated = validateDuplicatePiePayload(payload);
    return ensureObjectResponse(await this.post(`/api/v0/equity/pies/${pieId}/duplicate`, validated), "duplicate pie");
  }

  async getPortfolioSnapshot({ includePendingOrders = true } = {}) {
    const [summary, cash, positions, pendingOrders] = await Promise.all([
      this.getAccountSummary(),
      this.getAccountCash(),
      this.getPositions(),
      includePendingOrders ? this.getPendingOrders() : Promise.resolve([]),
    ]);

    return {
      environment: this.environment,
      summary,
      cash,
      positions,
      pendingOrders,
      rateLimit: this.lastRateLimit,
    };
  }

  async buildRebalancePreview(targetWeights, { includePendingOrders = true } = {}) {
    validateTargetWeights(targetWeights);

    const snapshot = await this.getPortfolioSnapshot({ includePendingOrders });
    const totalValue = Number(snapshot.summary.totalValue || 0);
    const currentPositions = new Map(
      snapshot.positions.map((position) => [
        position.instrument?.ticker || position.ticker,
        Number(position.walletImpact?.currentValue || 0),
      ])
    );

    const currentWeights = {};
    for (const [ticker, currentValue] of currentPositions.entries()) {
      currentWeights[ticker] = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
    }

    const actions = Object.entries(targetWeights).map(([ticker, targetWeight]) => {
      const currentWeight = ticker === "CASH"
        ? Math.max(0, 100 - Object.values(currentWeights).reduce((sum, weight) => sum + weight, 0))
        : currentWeights[ticker] || 0;
      const deltaWeight = targetWeight - currentWeight;
      const deltaValue = totalValue * (deltaWeight / 100);
      let action = "hold";
      if (deltaWeight > 0.0001) {
        action = ticker === "CASH" ? "raise-cash-buffer" : "buy";
      } else if (deltaWeight < -0.0001) {
        action = ticker === "CASH" ? "deploy-cash" : "sell";
      }

      return {
        ticker,
        currentWeight,
        targetWeight,
        deltaWeight,
        deltaValue,
        action,
      };
    });

    return {
      environment: this.environment,
      totalValue,
      currentWeights,
      targetWeights,
      actions,
      pendingOrders: snapshot.pendingOrders,
      rateLimit: this.lastRateLimit,
    };
  }
}


function createClient(options = {}) {
  return new Trading212Client(options);
}


async function searchInstrument(ticker, options = {}) {
  const client = Trading212Client.fromEnv({ environment: options.environment, fetchImpl: options.fetchImpl });
  return client.searchInstrument(ticker, options);
}


module.exports = {
  API_ROOTS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_TIMEOUT,
  MAX_PAGE_SIZE,
  Trading212Client,
  Trading212ConfigurationError,
  Trading212Error,
  Trading212RequestError,
  Trading212ValidationError,
  buildBasicAuthHeader,
  createClient,
  getT212Headers,
  normalizeAccountCashResponse,
  resolveCredentials,
  searchInstrument,
  validateReportRequest,
  validateTargetWeights,
};