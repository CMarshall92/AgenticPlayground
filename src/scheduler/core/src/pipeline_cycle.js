const fs = require("fs/promises");
const path = require("path");

const {
  buildBrokerRebalancePreview,
  getPortfolioBrokerContext,
  getTickerBrokerContext,
} = require("../../tools/trading212/trading212_agent_tools");
const {
  getEquityDataSnapshot,
  getMacroDataSnapshot,
  providerStatus,
} = require("../../tools/market_data/market_data_agent_tools");


const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const OUTPUT_ROOT = path.join(WORKSPACE_ROOT, "output");

const REPORT_FILES = [
  {
    key: "macro",
    fileName: "01_macro_report.md",
    title: "Microcap Trend Scanner Output",
    source: "agents/micro_cap_agents/01_macro_strategist.md",
  },
  {
    key: "sector",
    fileName: "02_sector_report.md",
    title: "Microcap Universe Scout Output",
    source: "agents/micro_cap_agents/02_sector_analyst.md",
  },
  {
    key: "risk",
    fileName: "03_risk_report.md",
    title: "Investment Standards Review Output",
    source: "agents/micro_cap_agents/03_risk_manager.md",
  },
  {
    key: "portfolio",
    fileName: "04_portfolio_report.md",
    title: "Microcap Portfolio Manager Output",
    source: "agents/micro_cap_agents/04_portfolio_manager.md",
  },
  {
    key: "yolo",
    fileName: "05_yolo_microcap_report.md",
    title: "Microcap Catalyst Hunter Output",
    source: "agents/micro_cap_agents/05_yolo_microcap.md",
  },
];


function getCycleRoot(cycleName) {
  return path.join(OUTPUT_ROOT, cycleName);
}


function brokerDir(cycleName) {
  return path.join(getCycleRoot(cycleName), "broker");
}


function dataDir(cycleName) {
  return path.join(getCycleRoot(cycleName), "data");
}


function parseJsonArgument(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label}. Expected valid JSON.`);
  }
}


async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}


async function writeFileIfMissing(filePath, content) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf8");
  }
}


function reportTemplate(cycleName, report) {
  return `# ${report.title}\n\nCycle: ${cycleName}\nSource prompt: ${report.source}\n\n## Input\n\n[Paste upstream output or source material here]\n\n## Analysis\n\n[Run the corresponding agent prompt and place the generated report here]\n`;
}


async function initCycle(cycleName) {
  const cycleRoot = getCycleRoot(cycleName);
  const cycleBrokerDir = brokerDir(cycleName);

  await ensureDirectory(cycleRoot);
  await ensureDirectory(cycleBrokerDir);
  await ensureDirectory(dataDir(cycleName));

  for (const report of REPORT_FILES) {
    await writeFileIfMissing(
      path.join(cycleRoot, report.fileName),
      reportTemplate(cycleName, report)
    );
  }

  await writeFileIfMissing(
    path.join(cycleBrokerDir, "notes.md"),
    "# Broker Checks\n\nUse this folder for tradability checks, portfolio snapshots, and rebalance previews.\n"
  );

  await writeFileIfMissing(
    path.join(dataDir(cycleName), "notes.md"),
    "# Market Data\n\nUse this folder for external market-data snapshots from free APIs such as Alpha Vantage, Finnhub, FRED, SEC EDGAR, Tiingo, FMP, NewsData, and OpenInsider.\n"
  );

  return {
    ok: true,
    cycleName,
    cycleRoot,
    reports: REPORT_FILES.map((report) => report.fileName),
  };
}


async function captureTickerContexts(cycleName, tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    throw new Error("tickers must be a non-empty JSON array.");
  }

  const results = [];
  for (const ticker of tickers) {
    results.push(await getTickerBrokerContext(ticker));
  }

  const destination = path.join(brokerDir(cycleName), "ticker_contexts.json");
  await ensureDirectory(brokerDir(cycleName));
  await fs.writeFile(destination, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  return {
    ok: true,
    cycleName,
    destination,
    count: results.length,
  };
}


async function capturePortfolioContext(cycleName) {
  const result = await getPortfolioBrokerContext();
  const destination = path.join(brokerDir(cycleName), "portfolio_context.json");
  await ensureDirectory(brokerDir(cycleName));
  await fs.writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return {
    ok: true,
    cycleName,
    destination,
  };
}


async function captureRebalancePreview(cycleName, targetWeights) {
  const result = await buildBrokerRebalancePreview(targetWeights);
  const destination = path.join(brokerDir(cycleName), "rebalance_preview.json");
  await ensureDirectory(brokerDir(cycleName));
  await fs.writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return {
    ok: true,
    cycleName,
    destination,
  };
}


async function captureMarketDataSnapshot(cycleName, payload) {
  const { symbols = [], cikMap = {}, companyNames = {}, fredSeries = [], newsLimit = 5, fromDate, toDate } = payload || {};
  const snapshots = {};

  for (const symbol of symbols) {
    snapshots[symbol] = await getEquityDataSnapshot({
      symbol,
      companyName: companyNames[symbol],
      cik: cikMap[symbol],
      newsLimit,
      fromDate,
      toDate,
    });
  }

  const macro = fredSeries.length > 0
    ? await getMacroDataSnapshot({ seriesIds: fredSeries })
    : null;

  const result = {
    generatedAt: new Date().toISOString(),
    providerAvailability: providerStatus(),
    equity: snapshots,
    macro,
  };

  const destination = path.join(dataDir(cycleName), "market_data_snapshot.json");
  await ensureDirectory(dataDir(cycleName));
  await fs.writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return {
    ok: true,
    cycleName,
    destination,
    symbolsProcessed: symbols.length,
    macroSeriesProcessed: fredSeries.length,
  };
}


async function getCycleStatus(cycleName) {
  const cycleRoot = getCycleRoot(cycleName);
  const status = {
    cycleName,
    cycleRoot,
    reports: {},
    brokerFiles: {},
    dataFiles: {},
  };

  for (const report of REPORT_FILES) {
    const reportPath = path.join(cycleRoot, report.fileName);
    try {
      await fs.access(reportPath);
      status.reports[report.fileName] = true;
    } catch {
      status.reports[report.fileName] = false;
    }
  }

  for (const brokerFile of ["portfolio_context.json", "ticker_contexts.json", "rebalance_preview.json", "notes.md"]) {
    const brokerPath = path.join(brokerDir(cycleName), brokerFile);
    try {
      await fs.access(brokerPath);
      status.brokerFiles[brokerFile] = true;
    } catch {
      status.brokerFiles[brokerFile] = false;
    }
  }

  for (const dataFile of ["market_data_snapshot.json", "notes.md"]) {
    const dataPath = path.join(dataDir(cycleName), dataFile);
    try {
      await fs.access(dataPath);
      status.dataFiles[dataFile] = true;
    } catch {
      status.dataFiles[dataFile] = false;
    }
  }

  return status;
}


async function runCli() {
  const command = process.argv[2];
  const cycleName = process.argv[3];
  const arg = process.argv[4];

  if (!command) {
    throw new Error("Missing command. Use one of: init-cycle, portfolio-context, ticker-contexts, rebalance-preview, market-data, status.");
  }
  if (!cycleName) {
    throw new Error("Missing cycle name. Example: 2026-03.");
  }

  let result;
  if (command === "init-cycle") {
    result = await initCycle(cycleName);
  } else if (command === "portfolio-context") {
    result = await capturePortfolioContext(cycleName);
  } else if (command === "ticker-contexts") {
    result = await captureTickerContexts(cycleName, parseJsonArgument(arg, "ticker list"));
  } else if (command === "rebalance-preview") {
    result = await captureRebalancePreview(cycleName, parseJsonArgument(arg, "target weights"));
  } else if (command === "market-data") {
    result = await captureMarketDataSnapshot(cycleName, parseJsonArgument(arg, "market data payload"));
  } else if (command === "status") {
    result = await getCycleStatus(cycleName);
  } else {
    throw new Error(`Unsupported command '${command}'.`);
  }

  console.log(JSON.stringify(result, null, 2));
}


if (require.main === module) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}


module.exports = {
  OUTPUT_ROOT,
  REPORT_FILES,
  capturePortfolioContext,
  captureMarketDataSnapshot,
  captureRebalancePreview,
  captureTickerContexts,
  getCycleRoot,
  getCycleStatus,
  initCycle,
};