require("dotenv").config();

const fs = require("fs/promises");
const { Pool } = require("pg");

let pool;


function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
  return databaseUrl;
}


function buildPoolConfig() {
  const connectionString = getDatabaseUrl();
  let ssl;
  let enableChannelBinding = false;

  try {
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") === "require") {
      ssl = { rejectUnauthorized: false };
    }
    if (url.searchParams.get("channel_binding") === "require") {
      enableChannelBinding = true;
    }
  } catch {
    ssl = undefined;
  }

  return {
    connectionString,
    ssl,
    enableChannelBinding,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
  };
}


function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
  }
  return pool;
}


async function query(text, params) {
  return getPool().query(text, params);
}


async function withClient(callback) {
  const client = await getPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}


async function executeSqlFile(filePath) {
  const sql = await fs.readFile(filePath, "utf8");
  return query(sql);
}


async function closePool() {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}


module.exports = {
  closePool,
  executeSqlFile,
  getPool,
  query,
  withClient,
};