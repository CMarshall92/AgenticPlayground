require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");

const { closePool } = require("../../db/postgres");
const {
  createPipelineRun,
  updatePipelineRun,
  upsertAgentOutput,
  upsertFinalReport,
  upsertPipelineArtifact,
} = require("../../db/pipeline_store");
const {
  OUTPUT_ROOT,
  REPORT_FILES,
  captureMarketDataSnapshot,
  capturePortfolioContext,
  captureRebalancePreview,
  captureTickerContexts,
  getCycleRoot,
  initCycle,
} = require("./src/pipeline_cycle");
const { runRulesEngineSelection } = require("./src/rules_engine");
const { executeAgentPipeline, getAgentExecutionState } = require("../tools/llm/agent_execution");


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


function parsePositiveIntegerEnv(name, fallbackValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallbackValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}


function parsePositiveNumberEnv(name, fallbackValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallbackValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}


function usesDynamicUniverseAgentSet() {
  return REPORT_FILES.every((report) => report.source.includes("agents/micro_cap_agents/"));
}


function parseSymbolMode(rawValue, fallbackValue) {
  const normalized = (rawValue || fallbackValue || "configured").trim().toLowerCase();
  if (!["configured", "rules_engine", "auto"].includes(normalized)) {
    throw new Error("PIPELINE_SYMBOL_MODE must be one of: configured, rules_engine, auto.");
  }

  return normalized;
}


function buildDefaultCycleName(now = new Date()) {
  return now.toISOString().slice(0, 10);
}


function buildRunConfig(overrides = {}) {
  const dynamicUniverseAgentSet = usesDynamicUniverseAgentSet();
  const configuredTargetWeights = parseJsonEnv("PIPELINE_TARGET_WEIGHTS", null);
  const symbolsFromWeights = configuredTargetWeights
    ? Object.keys(configuredTargetWeights).filter((ticker) => ticker.toUpperCase() !== "CASH")
    : [];
  const configuredSymbols = parseCsvEnv("PIPELINE_SYMBOLS", symbolsFromWeights);
  const symbolMode = parseSymbolMode(
    overrides.symbolMode || process.env.PIPELINE_SYMBOL_MODE,
    dynamicUniverseAgentSet ? "rules_engine" : "configured"
  );
  const effectiveSymbolMode = symbolMode === "auto"
    ? (configuredSymbols.length > 0 ? "configured" : "rules_engine")
    : symbolMode;
  const explicitTargetWeightsProvided = Object.prototype.hasOwnProperty.call(overrides, "targetWeights");

  const symbols = overrides.symbols
    || (effectiveSymbolMode === "configured" ? configuredSymbols : []);
  const fredSeries = overrides.fredSeries
    || parseCsvEnv("PIPELINE_FRED_SERIES", []);
  const companyNames = overrides.companyNames
    || parseJsonEnv("PIPELINE_COMPANY_NAMES", {});
  const cikMap = overrides.cikMap
    || parseJsonEnv("PIPELINE_CIK_MAP", {});
  const targetWeights = explicitTargetWeightsProvided
    ? overrides.targetWeights
    : (effectiveSymbolMode === "configured" ? configuredTargetWeights : null);

  if (effectiveSymbolMode === "configured" && (!Array.isArray(symbols) || symbols.length === 0)) {
    throw new Error("At least one symbol is required. Set PIPELINE_SYMBOLS or PIPELINE_TARGET_WEIGHTS.");
  }

  return {
    cycleName: overrides.cycleName || process.env.PIPELINE_CYCLE_NAME || buildDefaultCycleName(),
    runType: overrides.runType || process.env.PIPELINE_RUN_TYPE || "daily",
    triggerSource: overrides.triggerSource || process.env.PIPELINE_TRIGGER_SOURCE || "manual",
    symbolMode: effectiveSymbolMode,
    seedSymbols: overrides.seedSymbols || configuredSymbols,
    symbols,
    fredSeries,
    companyNames,
    cikMap,
    newsLimit: overrides.newsLimit || Number(process.env.PIPELINE_NEWS_LIMIT || 5),
    targetWeights: explicitTargetWeightsProvided ? overrides.targetWeights : targetWeights,
    rulesEngineCandidateLimit: overrides.rulesEngineCandidateLimit || parsePositiveIntegerEnv("RULES_ENGINE_CANDIDATE_LIMIT", 10),
    rulesEngineRawLimit: overrides.rulesEngineRawLimit || parsePositiveIntegerEnv("RULES_ENGINE_RAW_LIMIT", 18),
    rulesEngineMaxMarketCap: overrides.rulesEngineMaxMarketCap || parsePositiveNumberEnv("RULES_ENGINE_MAX_MARKET_CAP", 500_000_000),
    rulesEngineQueryTerms: overrides.rulesEngineQueryTerms,
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
  const rulesEngineSummary = config.rulesEngineSummary || null;
  const rulesEngineLines = rulesEngineSummary
    ? [
        `- Symbol mode: ${config.symbolMode}`,
        `- Seed symbols: ${config.seedSymbols.length > 0 ? config.seedSymbols.join(", ") : "None"}`,
        `- Rules engine raw candidates: ${rulesEngineSummary.rawCandidateCount}`,
        `- Rules engine selected symbols: ${rulesEngineSummary.selectedSymbols.join(", ") || "None"}`,
      ]
    : [`- Symbol mode: ${config.symbolMode}`, `- Symbol universe came from configured pipeline symbols.`];

  return `# Daily Pipeline Summary\n\n`
    + `Run ID: ${runId}\n`
    + `Cycle: ${config.cycleName}\n`
    + `Output root: ${cycleRoot}\n\n`
    + `## Coverage\n\n`
    + `- Symbols: ${config.symbols.join(", ")}\n`
    + `- Macro series: ${config.fredSeries.length > 0 ? config.fredSeries.join(", ") : "None configured"}\n`
    + `- Providers available: ${Object.entries(providerAvailability).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "None"}\n\n`
    + `## Rules Engine\n\n`
    + `${rulesEngineLines.join("\n")}\n\n`
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
    + `- This runner persists collected data, report files, and a final pipeline summary to Postgres.\n`
    + `${llmState.generated
      ? (config.symbolMode === "rules_engine"
        ? "- The rules engine uses broker-tradable instruments seeded by market news and insider activity, then builds per-ticker snapshots only for the selected candidates.\n"
        : "- Report generation uses the configured pipeline symbol universe and the captured data bundle for the current run.\n")
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
  let config = buildRunConfig(overrides);
  let rulesEngineOutput = null;

  if (config.symbolMode === "rules_engine") {
    rulesEngineOutput = await runRulesEngineSelection({
      seedSymbols: config.seedSymbols,
      maxCandidates: config.rulesEngineCandidateLimit,
      rawCandidateLimit: config.rulesEngineRawLimit,
      maxMarketCap: config.rulesEngineMaxMarketCap,
      newsLimit: config.newsLimit,
      queryTerms: config.rulesEngineQueryTerms,
    });

    if (!Array.isArray(rulesEngineOutput.selectedSymbols) || rulesEngineOutput.selectedSymbols.length === 0) {
      throw new Error("The rules engine did not produce any tradable candidates. Adjust the rules settings or provider coverage.");
    }

    config = {
      ...config,
      symbols: rulesEngineOutput.selectedSymbols,
      companyNames: {
        ...rulesEngineOutput.companyNames,
        ...config.companyNames,
      },
      cikMap: {
        ...rulesEngineOutput.cikMap,
        ...config.cikMap,
      },
      rulesEngineSummary: {
        rawCandidateCount: rulesEngineOutput.rawCandidateCount,
        selectedSymbols: rulesEngineOutput.selectedSymbols,
      },
    };
  }

  await initCycle(config.cycleName);
  const agentExecutionState = getAgentExecutionState(overrides.llm);

  const run = await createPipelineRun({
    cycleName: config.cycleName,
    runType: config.runType,
    triggerSource: config.triggerSource,
    config,
    metadata: {
      outputRoot: OUTPUT_ROOT,
      symbolMode: config.symbolMode,
    },
  });

  const cycleRoot = getCycleRoot(config.cycleName);

  try {
    if (rulesEngineOutput) {
      const rulesEnginePath = path.join(cycleRoot, "data", "rules_engine_output.json");
      await fs.writeFile(rulesEnginePath, `${JSON.stringify(rulesEngineOutput, null, 2)}\n`, "utf8");
      await upsertPipelineArtifact({
        runId: run.id,
        artifactType: "rules_engine",
        artifactKey: "candidate_selection",
        filePath: rulesEnginePath,
        contentJson: rulesEngineOutput,
        metadata: {
          selectedCount: rulesEngineOutput.selectedSymbols.length,
          rawCandidateCount: rulesEngineOutput.rawCandidateCount,
        },
      });
    }

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
      rulesEngineOutput,
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
        symbolMode: config.symbolMode,
        rulesEngineSelectedCount: rulesEngineOutput?.selectedSymbols?.length || 0,
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