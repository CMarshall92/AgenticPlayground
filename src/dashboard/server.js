require("dotenv").config();

const fs = require("fs/promises");
const http = require("http");
const path = require("path");

const { closePool } = require("../tools/db/postgres");
const {
  getDashboardOverview,
  getLatestPipelineRun,
  getPipelineAgentOutputs,
  getPipelineArtifacts,
  getPipelineFinalReports,
  getPipelineRun,
  listPipelineRuns,
} = require("../tools/db/dashboard_store");

const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};


function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": CONTENT_TYPES[".json"] });
  response.end(JSON.stringify(payload, null, 2));
}


function sendNotFound(response) {
  sendJson(response, 404, { ok: false, error: "Not found." });
}


async function sendStaticFile(response, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  const content = await fs.readFile(filePath);
  const extension = path.extname(filePath);
  response.writeHead(200, { "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream" });
  response.end(content);
}


async function routeApi(request, response, pathname, searchParams) {
  if (pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/overview") {
    sendJson(response, 200, await getDashboardOverview());
    return;
  }

  if (pathname === "/api/runs") {
    sendJson(response, 200, await listPipelineRuns({
      limit: searchParams.get("limit"),
      status: searchParams.get("status") || undefined,
    }));
    return;
  }

  if (pathname === "/api/runs/latest") {
    const latestRun = await getLatestPipelineRun();
    if (!latestRun) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, latestRun);
    return;
  }

  const runDetailMatch = pathname.match(/^\/api\/runs\/(\d+)$/);
  if (runDetailMatch) {
    const run = await getPipelineRun(Number(runDetailMatch[1]));
    if (!run) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, run);
    return;
  }

  const artifactMatch = pathname.match(/^\/api\/runs\/(\d+)\/artifacts$/);
  if (artifactMatch) {
    sendJson(response, 200, await getPipelineArtifacts(Number(artifactMatch[1])));
    return;
  }

  const outputsMatch = pathname.match(/^\/api\/runs\/(\d+)\/agent-outputs$/);
  if (outputsMatch) {
    sendJson(response, 200, await getPipelineAgentOutputs(Number(outputsMatch[1])));
    return;
  }

  const reportsMatch = pathname.match(/^\/api\/runs\/(\d+)\/final-reports$/);
  if (reportsMatch) {
    sendJson(response, 200, await getPipelineFinalReports(Number(reportsMatch[1])));
    return;
  }

  sendNotFound(response);
}


async function requestListener(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    const { pathname, searchParams } = url;

    if (pathname.startsWith("/api/")) {
      await routeApi(request, response, pathname, searchParams);
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      await sendStaticFile(response, "index.html");
      return;
    }

    if (pathname === "/app.css") {
      await sendStaticFile(response, "app.css");
      return;
    }

    if (pathname === "/app.js") {
      await sendStaticFile(response, "app.js");
      return;
    }

    sendNotFound(response);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
}


const server = http.createServer(requestListener);

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, host: HOST, port: PORT }, null, 2));
});


async function shutdown() {
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}


process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);