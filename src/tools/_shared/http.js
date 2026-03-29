require("dotenv").config();

const DEFAULT_TIMEOUT = 30_000;


function assertFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Fetch API is not available. Use Node.js 18+.");
  }
}


function ensureEnv(name, { fallbackNames = [], optional = false } = {}) {
  const keys = [name, ...fallbackNames];
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  if (optional) {
    return undefined;
  }

  throw new Error(`Missing required environment variable: ${name}`);
}


function pickDefined(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}


function normalizeArrayParam(value, separator = ",") {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(separator);
  }
  return value;
}


function toIsoDate(value) {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}


function buildUrl(baseUrl, path = "", params = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(pickDefined(params))) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}


async function request(url, { method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT, parseAs = "json" } = {}) {
  assertFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = parseAs === "text"
      ? text
      : text
        ? JSON.parse(text)
        : null;

    if (!response.ok) {
      throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload || { status: response.status }));
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}


async function requestJson(url, options = {}) {
  return request(url, { ...options, parseAs: "json" });
}


async function requestText(url, options = {}) {
  return request(url, { ...options, parseAs: "text" });
}


function withQueryToken(params, tokenKey, tokenValue) {
  return {
    ...pickDefined(params),
    [tokenKey]: tokenValue,
  };
}


module.exports = {
  DEFAULT_TIMEOUT,
  buildUrl,
  ensureEnv,
  normalizeArrayParam,
  pickDefined,
  requestJson,
  requestText,
  toIsoDate,
  withQueryToken,
};