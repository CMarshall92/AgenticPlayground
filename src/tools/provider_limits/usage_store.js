const { withClient } = require("../db/postgres");

const PERIOD_TYPES = new Set(["hour", "day"]);


function normalizeWindowStart(now, periodType) {
  const date = new Date(now);

  if (periodType === "hour") {
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      0,
      0,
      0
    ));
  }

  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0
  ));
}


function normalizeWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("windows must be a non-empty array.");
  }

  return windows.map((window) => {
    const periodType = String(window.periodType || "").toLowerCase();
    const limitCount = Number(window.limitCount);
    const amount = Number(window.amount || 1);

    if (!PERIOD_TYPES.has(periodType)) {
      throw new Error(`Unsupported period type '${window.periodType}'.`);
    }
    if (!Number.isInteger(limitCount) || limitCount <= 0) {
      throw new Error("limitCount must be a positive integer.");
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("amount must be a positive integer.");
    }

    return { periodType, limitCount, amount };
  }).sort((left, right) => left.periodType.localeCompare(right.periodType));
}


async function reserveProviderUsage({ provider, windows, now = new Date() } = {}) {
  if (!provider || typeof provider !== "string") {
    throw new Error("provider is required.");
  }

  const normalizedWindows = normalizeWindows(windows);

  try {
    return await withClient(async (client) => {
      await client.query("BEGIN");

      try {
        const usage = [];

        for (const window of normalizedWindows) {
          const windowStart = normalizeWindowStart(now, window.periodType);
          const existing = await client.query(
            `
              SELECT request_count
              FROM provider_usage_windows
              WHERE provider = $1 AND period_type = $2 AND window_start = $3
              FOR UPDATE
            `,
            [provider, window.periodType, windowStart.toISOString()]
          );

          const currentCount = existing.rows[0] ? Number(existing.rows[0].request_count) : 0;
          const nextCount = currentCount + window.amount;

          if (nextCount > window.limitCount) {
            await client.query("ROLLBACK");
            return {
              allowed: false,
              exhausted: true,
              provider,
              periodType: window.periodType,
              limitCount: window.limitCount,
              used: currentCount,
              remaining: Math.max(window.limitCount - currentCount, 0),
              windowStart: windowStart.toISOString(),
            };
          }

          if (existing.rows[0]) {
            await client.query(
              `
                UPDATE provider_usage_windows
                SET request_count = $4,
                    limit_count = $5,
                    updated_at = NOW()
                WHERE provider = $1 AND period_type = $2 AND window_start = $3
              `,
              [provider, window.periodType, windowStart.toISOString(), nextCount, window.limitCount]
            );
          } else {
            await client.query(
              `
                INSERT INTO provider_usage_windows (
                  provider,
                  period_type,
                  window_start,
                  request_count,
                  limit_count
                )
                VALUES ($1, $2, $3, $4, $5)
              `,
              [provider, window.periodType, windowStart.toISOString(), nextCount, window.limitCount]
            );
          }

          usage.push({
            periodType: window.periodType,
            limitCount: window.limitCount,
            used: nextCount,
            remaining: Math.max(window.limitCount - nextCount, 0),
            windowStart: windowStart.toISOString(),
          });
        }

        await client.query("COMMIT");
        return {
          allowed: true,
          provider,
          usage,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    return {
      allowed: false,
      silent: true,
      provider,
      error: error.message,
    };
  }
}


module.exports = {
  normalizeWindowStart,
  reserveProviderUsage,
};