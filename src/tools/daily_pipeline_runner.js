require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");

const { closePool } = require("./db/postgres");
const {
  createPipelineRun,
  updatePipelineRun,
  upsertAgentOutput,
  upsertFinalReport,
  upsertPipelineArtifact,
} = require("./db/pipeline_store");
const {
  OUTPUT_ROOT,
  REPORT_FILES,
  captureMarketDataSnapshot,
  capturePortfolioContext,
  captureRebalancePreview,
  captureTickerContexts,
  getCycleRoot,
  initCycle,
} = require("./monthly_pipeline");
const { executeAgentPipeline, getAgentExecutionState } = require("./llm/agent_execution");


function parseJsonEnv(name, fallbackValue) {
  const raw = process.env[name];
  if (!raw) {
    return fallbackValue;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error.message}`);
  }
}


function parseCsvEnv(name, fallbackValue = []) {
  const raw = process.env[name];
  if (!raw) {
    return fallbackValue;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}


function buildDefaultCycleName(now = new Date()) {
  return now.toISOString().slice(0, 10);
}


function buildRunConfig(overrides = {}) {
  const targetWeights = parseJsonEnv("PIPELINE_TARGET_WEIGHTS", null);
  const symbolsFromWeights = targetWeights
    ? Object.keys(targetWeights).filter((ticker) => ticker.toUpperCase() !== "CASH")
    : [];

  const symbols = overrides.symbols
    || parseCsvEnv("PIPELINE_SYMBOLS", symbolsFromWeights);
  const fredSeries = overrides.fredSeries
    || parseCsvEnv("PIPELINE_FRED_SERIES", []);
  const companyNames = overrides.companyNames
    || parseJsonEnv("PIPELINE_COMPANY_NAMES", {});
  const cikMap = overrides.cikMap
    || parseJsonEnv("PIPELINE_CIK_MAP", {});

  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("At least one symbol is required. Set PIPELINE_SYMBOLS or PIPELINE_TARGET_WEIGHTS.");
  }

  return {
    cycleName: overrides.cycleName || process.env.PIPELINE_CYCLE_NAME || buildDefaultCycleName(),
    runType: overrides.runType || process.env.PIPELINE_RUN_TYPE || "daily",
    triggerSource: overrides.triggerSource || process.env.PIPELINE_TRIGGER_SOURCE || "manual",
    symbols,
    fredSeries,
    companyNames,
    cikMap,
    newsLimit: overrides.newsLimit || Number(process.env.PIPELINE_NEWS_LIMIT || 5),
    targetWeights: overrides.targetWeights || targetWeights,
  };
}


async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}


async function readTextFile(filePath) {
  return fs.readFile(filePath, "utf8");
}


function isTemplateReport(content) {
  return content.includes("[Run the corresponding agent prompt and place the generated report here]");
}


function buildFinalSummary({ runId, config, portfolioContext, marketDataSnapshot, rebalancePreview, reportSnapshots, cycleRoot, agentExecution }) {
  const completedReports = reportSnapshots.filter((report) => !report.isTemplate);
  const pendingReports = reportSnapshots.filter((report) => report.isTemplate);
  const providerAvailability = marketDataSnapshot?.providerAvailability || {};
  const positionsCount = Array.isArray(portfolioContext?.positions) ? portfolioContext.positions.length : 0;
  const pendingOrdersCount = Array.isArray(portfolioContext?.pendingOrders) ? portfolioContext.pendingOrders.length : 0;
  const llmState = agentExecution || getAgentExecutionState();

  const targetWeightLines = config.targetWeights
    ? Object.entries(config.targetWeights).map(([ticker, weight]) => `- ${ticker}: ${weight}%`)
    : ["- No target weights configured for this run."];

  return `# Daily Pipeline Summary\n\n`
    + `Run ID: ${runId}\n`
    + `Cycle: ${config.cycleName}\n`
    + `Output root: ${cycleRoot}\n\n`
    + `## Coverage\n\n`
    + `- Symbols: ${config.symbols.join(", ")}\n`
    + `- Macro series: ${config.fredSeries.length > 0 ? config.fredSeries.join(", ") : "None configured"}\n`
    + `- Providers available: ${Object.entries(providerAvailability).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "None"}\n\n`
    + `## Broker Snapshot\n\n`
    + `- Total positions captured: ${positionsCount}\n`
    + `- Pending orders captured: ${pendingOrdersCount}\n`
    + `- Account value available: ${portfolioContext?.summary?.totalValue ?? "Unavailable"}\n`
    + `- Cash available to trade: ${portfolioContext?.cash?.availableToTrade ?? "Unavailable"}\n\n`
    + `## Target Weights\n\n`
    + `${targetWeightLines.join("\n")}\n\n`
    + `## Report Status\n\n`
    + `- Completed agent reports: ${completedReports.length}\n`
    + `- Pending/template agent reports: ${pendingReports.length}\n`
    + `${reportSnapshots.map((report) => `- ${report.key}: ${report.isTemplate ? "template only" : "contains authored content"} (${report.reportPath})`).join("\n")}\n\n`
    + `## LLM Execution\n\n`
    + `- Enabled: ${llmState.enabled ? "yes" : "no"}\n`
    + `- Generated reports automatically: ${llmState.generated ? "yes" : "no"}\n`
    + `- Model: ${llmState.model || "Not configured"}\n`
    + `- Base URL: ${llmState.baseUrl || "Not configured"}\n`
    + `- Status note: ${llmState.reason || (llmState.generated ? "Agent reports were generated from the configured LLM." : "Agent reports remained file-based for this run.")}\n\n`
    + `## Rebalance Preview\n\n`
    + `${rebalancePreview
      ? `- Actions generated: ${Array.isArray(rebalancePreview.actions) ? rebalancePreview.actions.length : 0}\n- Estimated account value: ${rebalancePreview.totalValue ?? "Unavailable"}`
      : "- Rebalance preview skipped because PIPELINE_TARGET_WEIGHTS is not configured."}\n\n`
    + `## Current Limitation\n\n`
    + `- This runner persists collected data, report files, and a dashboard-ready summary to Postgres.\n`
    + `${llmState.generated
      ? "- Symbol discovery is still limited to the configured pipeline symbol universe and the captured data bundle for the current run.\n"
      : "- If no compatible LLM is configured, the data pipeline still runs but the report files stay in template/manual mode.\n"}`;
}


async function persistReportFiles(runId, cycleRoot) {
  const snapshots = [];

  for (const report of REPORT_FILES) {
    const reportPath = path.join(cycleRoot, report.fileName);
    const content = await readTextFile(reportPath);
    const metadata = {
      sourcePrompt: report.source,
      title: report.title,
      isTemplate: isTemplateReport(content),
    };

    await upsertAgentOutput({
      runId,
      agentKey: report.key,
      sourcePromptPath: report.source,
      reportPath,
      contentMarkdown: content,
      metadata,
    });

    await upsertPipelineArtifact({
      runId,
      artifactType: "report_file",
      artifactKey: report.key,
      filePath: reportPath,
      contentMarkdown: content,
      metadata,
    });

    snapshots.push({
      key: report.key,
      reportPath,
      isTemplate: metadata.isTemplate,
    });
  }

  return snapshots;
}


async function runDailyPipeline(overrides = {}) {
  const config = buildRunConfig(overrides);
  await initCycle(config.cycleName);
  const agentExecutionState = getAgentExecutionState(overrides.llm);

  const run = await createPipelineRun({
    cycleName: config.cycleName,
    runType: config.runType,
    triggerSource: config.triggerSource,
    config,
    metadata: {
      outputRoot: OUTPUT_ROOT,
    },
  });

  const cycleRoot = getCycleRoot(config.cycleName);

  try {
    const portfolioCapture = await capturePortfolioContext(config.cycleName);
    const portfolioContext = await readJsonFile(portfolioCapture.destination);
    await upsertPipelineArtifact({
      runId: run.id,
      artifactType: "broker",
      artifactKey: "portfolio_context",
      filePath: portfolioCapture.destination,
      contentJson: portfolioContext,
    });

    const tickerCapture = await captureTickerContexts(config.cycleName, config.symbols);
    const tickerContexts = await readJsonFile(tickerCapture.destination);
    await upsertPipelineArtifact({
      runId: run.id,
      artifactType: "broker",
      artifactKey: "ticker_contexts",
      filePath: tickerCapture.destination,
      contentJson: tickerContexts,
      metadata: { symbolCount: config.symbols.length },
    });

    const marketCapture = await captureMarketDataSnapshot(config.cycleName, {
      symbols: config.symbols,
      cikMap: config.cikMap,
      companyNames: config.companyNames,
      fredSeries: config.fredSeries,
      newsLimit: config.newsLimit,
    });
    const marketDataSnapshot = await readJsonFile(marketCapture.destination);
    await upsertPipelineArtifact({
      runId: run.id,
      artifactType: "market_data",
      artifactKey: "snapshot",
      filePath: marketCapture.destination,
      contentJson: marketDataSnapshot,
      metadata: {
        symbolsProcessed: marketCapture.symbolsProcessed,
        macroSeriesProcessed: marketCapture.macroSeriesProcessed,
      },
    });

    let rebalancePreview = null;
    if (config.targetWeights) {
      const rebalanceCapture = await captureRebalancePreview(config.cycleName, config.targetWeights);
      rebalancePreview = await readJsonFile(rebalanceCapture.destination);
      await upsertPipelineArtifact({
        runId: run.id,
        artifactType: "broker",
        artifactKey: "rebalance_preview",
        filePath: rebalanceCapture.destination,
        contentJson: rebalancePreview,
      });
    }

    const agentExecution = await executeAgentPipeline({
      config,
      cycleRoot,
      portfolioContext,
      tickerContexts,
      marketDataSnapshot,
      rebalancePreview,
      llmOptions: overrides.llm,
    });

    const reportSnapshots = await persistReportFiles(run.id, cycleRoot);
    const finalSummary = buildFinalSummary({
      runId: run.id,
      config,
      portfolioContext,
      marketDataSnapshot,
      rebalancePreview,
      reportSnapshots,
      cycleRoot,
      agentExecution,
    });

    const finalReportPath = path.join(cycleRoot, "06_daily_summary_report.md");
    await fs.writeFile(finalReportPath, `${finalSummary}\n`, "utf8");

    await upsertFinalReport({
      runId: run.id,
      title: `Daily pipeline summary for ${config.cycleName}`,
      contentMarkdown: finalSummary,
      metadata: {
        reportPath: finalReportPath,
        manualAgentExecutionRequired: !agentExecution.generated,
        llmExecution: agentExecution,
      },
    });

    await upsertPipelineArtifact({
      runId: run.id,
      artifactType: "final_report",
      artifactKey: "daily_summary",
      filePath: finalReportPath,
      contentMarkdown: finalSummary,
      metadata: {
        manualAgentExecutionRequired: !agentExecution.generated,
        llmExecution: agentExecution,
      },
    });

    const completedRun = await updatePipelineRun(run.id, {
      status: "completed",
      completedAt: new Date(),
      metadata: {
        symbolsProcessed: config.symbols.length,
        reportFilesPersisted: reportSnapshots.length,
        finalReportPath,
        llmExecution: agentExecution,
      },
    });

    return {
      ok: true,
      runId: run.id,
      cycleName: config.cycleName,
      status: completedRun.status,
      finalReportPath,
      llmExecution: agentExecution,
    };
  } catch (error) {
    await updatePipelineRun(run.id, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: error.message,
    });
    throw error;
  }
}


async function runCli() {
  const cycleName = process.argv[2];
  const result = await runDailyPipeline(cycleName ? { cycleName } : {});
  console.log(JSON.stringify(result, null, 2));
}


if (require.main === module) {
  runCli()
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}


module.exports = {
  buildDefaultCycleName,
  buildRunConfig,
  getAgentExecutionState,
  runDailyPipeline,
};