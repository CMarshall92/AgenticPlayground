require("dotenv").config();

const { closePool } = require("./db/postgres");
const { buildDefaultCycleName, runDailyPipeline } = require("./daily_pipeline_runner");


function parseScheduleValue(name, min, max, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}


function millisecondsUntilNextRun(hourUtc, minuteUtc, now = new Date()) {
  const nextRun = new Date(now);
  nextRun.setUTCHours(hourUtc, minuteUtc, 0, 0);

  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}


function getScheduleConfig() {
  return {
    hourUtc: parseScheduleValue("PIPELINE_RUN_HOUR_UTC", 0, 23, 6),
    minuteUtc: parseScheduleValue("PIPELINE_RUN_MINUTE_UTC", 0, 59, 0),
    runOnStart: String(process.env.PIPELINE_RUN_ON_START || "false").toLowerCase() === "true",
  };
}


async function executeScheduledRun(triggerSource = "scheduler") {
  const cycleName = buildDefaultCycleName();
  const result = await runDailyPipeline({
    cycleName,
    triggerSource,
  });
  console.log(JSON.stringify({ ok: true, scheduled: true, ...result }, null, 2));
}


function startDailyScheduler() {
  const schedule = getScheduleConfig();

  const scheduleNext = () => {
    const delayMs = millisecondsUntilNextRun(schedule.hourUtc, schedule.minuteUtc);
    console.log(JSON.stringify({
      ok: true,
      scheduled: true,
      nextRunInMs: delayMs,
      hourUtc: schedule.hourUtc,
      minuteUtc: schedule.minuteUtc,
    }, null, 2));

    setTimeout(async () => {
      try {
        await executeScheduledRun("scheduler");
      } catch (error) {
        console.error(JSON.stringify({ ok: false, error: error.message, scheduled: true }, null, 2));
      } finally {
        scheduleNext();
      }
    }, delayMs);
  };

  if (schedule.runOnStart) {
    executeScheduledRun("scheduler_startup")
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: error.message, scheduled: true }, null, 2));
      })
      .finally(() => {
        scheduleNext();
      });
    return;
  }

  scheduleNext();
}


if (require.main === module) {
  startDailyScheduler();

  const shutdown = async () => {
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}


module.exports = {
  executeScheduledRun,
  getScheduleConfig,
  millisecondsUntilNextRun,
  startDailyScheduler,
};