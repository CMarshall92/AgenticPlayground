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
const { PipelineProgressReporter } = require("./src/pipeline_progress_reporter");
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
    rulesEngineMaxMarketCap: overrides.rulesEngineMaxMarketCap || parsePositiveNumberEnv("RULES_ENGINE_MAX_MARKET_CAP", 300_000_000),
    rulesEngineInsiderRows: overrides.rulesEngineInsiderRows || parsePositiveIntegerEnv("RULES_ENGINE_INSIDER_ROWS", 40),
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


function extractTaggedSummary(content, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, "i"));
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}


function extractBulletItems(content, heading, limit = 3) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`(?:^|\\n)(?:#+\\s*${escaped}|\\*\\*${escaped}\\*\\*)\\s*\\n([\\s\\S]*?)(?:\\n(?:#+\\s|\\*\\*[^\\n]+\\*\\*\\s*\\n)|$)`, "i"));
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim().replace(/\*\*/g, "").replace(/\s+/g, " ").trim())
    .slice(0, limit);
}


function buildRulesEngineNarrative(rulesEngineOutput) {
  if (!rulesEngineOutput) {
    return ["The run used a configured symbol set rather than the discovery engine."];
  }

  const eligibleUniverseSize = rulesEngineOutput.eligibleUniverseSummary?.eligibleInstrumentCount || 0;
  const universeShortlisted = rulesEngineOutput.universeScreeningSummary?.shortlistedCount || 0;
  const rawCandidateCount = rulesEngineOutput.rawCandidateCount || 0;
  const enrichmentShortlist = rulesEngineOutput.screeningSummary?.shortlistedForEnrichmentCount || 0;
  const selectedSymbols = rulesEngineOutput.selectedSymbols || [];
  const sourceBreakdown = Object.entries(rulesEngineOutput.sourceBreakdown || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([source, count]) => `${source} (${count})`);

  const lines = [
    `The broker universe filtered down to ${eligibleUniverseSize} eligible names, with ${universeShortlisted} surviving the stage-one universe screen before event-driven discovery began.`,
    `Discovery then produced ${rawCandidateCount} raw candidate${rawCandidateCount === 1 ? "" : "s"}, and ${enrichmentShortlist} advanced to deeper enrichment.`,
    selectedSymbols.length > 0
      ? `The final shortlist contained ${selectedSymbols.join(", ")}.`
      : "The final shortlist was empty after the rules-engine review.",
  ];

  if (sourceBreakdown.length > 0) {
    lines.push(`The strongest discovery inputs were ${sourceBreakdown.join(", ")}.`);
  }

  const topCandidate = rulesEngineOutput.candidates?.[0] || null;
  if (topCandidate) {
    lines.push(
      `${topCandidate.symbol} led the screened list with a final score of ${topCandidate.score.toFixed(1)} and a market-cap bucket of ${topCandidate.selectionBucket.replace(/_/g, " ")}.`
    );
  }

  return lines;
}


function buildPortfolioNarrative(portfolioContext, rebalancePreview, riskContent, portfolioContent) {
  const positionsCount = Array.isArray(portfolioContext?.positions) ? portfolioContext.positions.length : 0;
  const cashAvailable = portfolioContext?.cash?.availableToTrade ?? null;
  const riskSummary = extractTaggedSummary(riskContent, ["Review Summary"]);
  const constructionSummary = extractTaggedSummary(portfolioContent, ["Construction Summary"]);
  const riskCheck = extractBulletItems(portfolioContent, "Risk Check", 2);
  const approvedList = extractBulletItems(riskContent, "Approved List For Agent 4", 3);

  const lines = [];
  if (riskSummary) {
    lines.push(riskSummary);
  }
  if (constructionSummary) {
    lines.push(constructionSummary);
  }

  if (approvedList.length > 0 && approvedList[0].toLowerCase() !== "none") {
    lines.push(`Approved names for capital were ${approvedList.join("; ")}.`);
  } else {
    lines.push("No names cleared the investment standards gate for capital allocation in this run.");
  }

  if (positionsCount === 0 && cashAvailable != null) {
    lines.push(`The account stayed fully defensive with no positions open and ${cashAvailable} available to deploy.`);
  }

  if (Array.isArray(rebalancePreview?.actions) && rebalancePreview.actions.length > 0) {
    lines.push(`A rebalance plan was available with ${rebalancePreview.actions.length} proposed action${rebalancePreview.actions.length === 1 ? "" : "s"}.`);
  }

  if (riskCheck.length > 0) {
    lines.push(`Portfolio-level constraints remain ${riskCheck.join(" ")}`);
  }

  return lines;
}


function buildEvidenceGapsNarrative(rulesEngineOutput, universeContent, riskContent, yoloContent) {
  const lines = [];
  const likelyTraps = extractBulletItems(universeContent, "Likely Traps", 2);
  const rejectedNames = extractBulletItems(riskContent, "Rejected Names", 3);
  const hypeRejects = extractBulletItems(yoloContent, "Names Rejected As Hype", 3);
  const candidate = rulesEngineOutput?.candidates?.[0] || null;

  if (candidate && candidate.marketCap == null) {
    lines.push(`Market-cap resolution was incomplete for ${candidate.symbol}, so the name advanced under an evidence gap rather than a fully confirmed size profile.`);
  }

  if (likelyTraps.length > 0) {
    lines.push(`The universe scout flagged these trap conditions: ${likelyTraps.join("; ")}.`);
  }

  if (rejectedNames.length > 0) {
    lines.push(`The standards review rejected ${rejectedNames.join("; ")}.`);
  }

  if (hypeRejects.length > 0) {
    lines.push(`The speculative sleeve did not rescue the name set and instead rejected ${hypeRejects.join("; ")}.`);
  }

  return lines;
}


function buildFinalSummary({ config, portfolioContext, rebalancePreview, reportSnapshots, rulesEngineOutput }) {
  const reportContentByKey = Object.fromEntries(reportSnapshots.map((report) => [report.key, report.content || ""]));
  const macroSummary = extractTaggedSummary(reportContentByKey.macro || "", ["Executive Summary"]);
  const universeSummary = extractTaggedSummary(reportContentByKey.sector || "", ["Discovery Summary"]);
  const riskSummary = extractTaggedSummary(reportContentByKey.risk || "", ["Review Summary"]);
  const portfolioSummary = extractTaggedSummary(reportContentByKey.portfolio || "", ["Construction Summary", "Portfolio Objective"]);
  const speculativeSummary = extractTaggedSummary(reportContentByKey.yolo || "", ["Speculative Theme Summary"]);
  const macroTrends = extractBulletItems(reportContentByKey.macro || "", "Priority News Trends", 3);
  const candidateHighlights = extractBulletItems(reportContentByKey.sector || "", "Candidate Universe", 3);

  const overviewLines = [macroSummary, universeSummary, riskSummary, portfolioSummary]
    .filter(Boolean)
    .slice(0, 4);

  const stageNarrative = buildRulesEngineNarrative(rulesEngineOutput);
  const portfolioNarrative = buildPortfolioNarrative(
    portfolioContext,
    rebalancePreview,
    reportContentByKey.risk || "",
    reportContentByKey.portfolio || ""
  );
  const evidenceGaps = buildEvidenceGapsNarrative(
    rulesEngineOutput,
    reportContentByKey.sector || "",
    reportContentByKey.risk || "",
    reportContentByKey.yolo || ""
  );

  return `# Daily Research Synthesis\n\n`
    + `## Overall Takeaway\n\n`
    + `${overviewLines.map((line) => `- ${line}`).join("\n") || "- The run completed, but the agent chain did not produce a coherent analytical takeaway."}\n\n`
    + `## Step-By-Step Conclusions\n\n`
    + `### Stage 1: Macro And Theme Setup\n\n`
    + `${macroSummary ? `- ${macroSummary}\n` : ""}`
    + `${macroTrends.map((item) => `- ${item}`).join("\n") || "- No macro trend summary was captured."}\n\n`
    + `### Stage 2: Universe Formation And Discovery\n\n`
    + `${stageNarrative.map((line) => `- ${line}`).join("\n")}\n`
    + `${candidateHighlights.map((item) => `- ${item}`).join("\n") || ""}\n\n`
    + `### Stage 3: Investment Standards\n\n`
    + `${riskSummary ? `- ${riskSummary}\n` : "- No explicit investment-standards summary was captured.\n"}`
    + `${extractBulletItems(reportContentByKey.risk || "", "Portfolio-Level View", 3).map((item) => `- ${item}`).join("\n") || ""}\n\n`
    + `### Stage 4: Portfolio Construction\n\n`
    + `${portfolioNarrative.map((line) => `- ${line}`).join("\n")}\n\n`
    + `### Stage 5: Speculative Sleeve\n\n`
    + `${speculativeSummary ? `- ${speculativeSummary}\n` : "- No speculative-sleeve summary was captured.\n"}`
    + `${extractBulletItems(reportContentByKey.yolo || "", "Best Speculative Setup", 2).map((item) => `- ${item}`).join("\n") || "- No speculative setup survived with conviction."}\n\n`
    + `## Cross-Stage Readthrough\n\n`
    + `${portfolioNarrative.concat(evidenceGaps).map((line) => `- ${line}`).join("\n") || "- The run did not surface a durable cross-stage conclusion."}\n\n`
    + `## Bottom Line\n\n`
    + `${config.symbols.length > 0
      ? `- The final research path concentrated on ${config.symbols.join(", ")}, but the combined agent chain did not justify capital deployment.`
      : "- The pipeline completed without producing an investable final name set."}`;
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
      content,
      isTemplate: metadata.isTemplate,
    });
  }

  return snapshots;
}


async function runDailyPipeline(overrides = {}) {
  let config = buildRunConfig(overrides);
  let rulesEngineOutput = null;
  const progressReporter = new PipelineProgressReporter({ cycleName: config.cycleName });
  progressReporter.setSteps([
    { id: "rules_engine", title: "Rules engine discovery", detail: "Waiting" },
    { id: "cycle", title: "Initialize cycle folders", detail: "Waiting" },
    { id: "rules_artifacts", title: "Persist rules artifacts", detail: "Waiting" },
    { id: "portfolio", title: "Capture portfolio context", detail: "Waiting" },
    { id: "tickers", title: "Capture ticker broker context", detail: "Waiting" },
    { id: "market", title: "Capture market data bundle", detail: "Waiting" },
    { id: "rebalance", title: "Build rebalance preview", detail: "Waiting" },
    { id: "agents", title: "Generate agent reports", detail: "Waiting" },
    { id: "reports", title: "Persist report files", detail: "Waiting" },
    { id: "summary", title: "Write final summary", detail: "Waiting" },
  ]);
  progressReporter.start();

  const handleRulesEngineProgress = ({ stage, detail, completed, total } = {}) => {
    const stagePrefix = {
      load_universe: "Loading broker universe",
      eligible_universe: "Eligible universe built",
      universe_screen_metadata: "Stage 1 metadata screen",
      universe_screen_prices: "Stage 1 price overlay",
      discovery_market_news: "Finnhub market news",
      discovery_newsdata: "NewsData discovery",
      discovery_openinsider: "OpenInsider discovery",
      candidate_screening: "Stage 2 candidate screening",
      candidate_enrichment: "Deep enrichment",
    }[stage] || "Rules engine";

    progressReporter.updateStep("rules_engine", {
      detail: detail ? `${stagePrefix}: ${detail}` : stagePrefix,
      completedUnits: completed,
      totalUnits: total,
    });
  };

  try {
    if (config.symbolMode === "rules_engine") {
      progressReporter.startStep("rules_engine", "Starting rules engine discovery");
      rulesEngineOutput = await runRulesEngineSelection({
        seedSymbols: config.seedSymbols,
        maxCandidates: config.rulesEngineCandidateLimit,
        rawCandidateLimit: config.rulesEngineRawLimit,
        maxMarketCap: config.rulesEngineMaxMarketCap,
        newsLimit: config.newsLimit,
        insiderRows: config.rulesEngineInsiderRows,
        queryTerms: config.rulesEngineQueryTerms,
        onProgress: handleRulesEngineProgress,
      });

      progressReporter.completeStep(
        "rules_engine",
        `Selected ${rulesEngineOutput.selectedSymbols.length} final symbols from ${rulesEngineOutput.eligibleUniverseSummary?.eligibleInstrumentCount || 0} eligible names`
      );

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
          instrumentUniverseSource: rulesEngineOutput.instrumentUniverse?.source || "unknown",
          instrumentUniverseFallbackReason: rulesEngineOutput.instrumentUniverse?.fallbackReason || null,
          eligibleInstrumentCount: rulesEngineOutput.eligibleUniverseSummary?.eligibleInstrumentCount || 0,
          universeShortlistedCount: rulesEngineOutput.universeScreeningSummary?.shortlistedCount || 0,
          rawCandidateCount: rulesEngineOutput.rawCandidateCount,
          screeningPoolCount: rulesEngineOutput.screeningSummary?.screeningPoolCount || 0,
          shortlistedForEnrichmentCount: rulesEngineOutput.screeningSummary?.shortlistedForEnrichmentCount || 0,
          selectedSymbols: rulesEngineOutput.selectedSymbols,
        },
      };
    } else {
      progressReporter.skipStep("rules_engine", "Configured symbol mode");
    }

    progressReporter.startStep("cycle", `Preparing cycle ${config.cycleName}`);
    await initCycle(config.cycleName);
    progressReporter.completeStep("cycle", "Cycle folder ready");
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
        progressReporter.startStep("rules_artifacts", "Writing rules engine artifacts");
        const eligibleUniversePath = path.join(cycleRoot, "data", "eligible_microcap_universe.json");
        await fs.writeFile(eligibleUniversePath, `${JSON.stringify({
          generatedAt: rulesEngineOutput.generatedAt,
          config: rulesEngineOutput.config,
          eligibleUniverseSummary: rulesEngineOutput.eligibleUniverseSummary,
          eligibleUniverse: rulesEngineOutput.eligibleUniverse,
        }, null, 2)}\n`, "utf8");
        await upsertPipelineArtifact({
          runId: run.id,
          artifactType: "rules_engine",
          artifactKey: "eligible_microcap_universe",
          filePath: eligibleUniversePath,
          contentJson: {
            eligibleUniverseSummary: rulesEngineOutput.eligibleUniverseSummary,
          },
        });

        const universeScreenPath = path.join(cycleRoot, "data", "screened_universe_candidates.json");
        await fs.writeFile(universeScreenPath, `${JSON.stringify({
          generatedAt: rulesEngineOutput.generatedAt,
          config: rulesEngineOutput.config,
          universeScreeningSummary: rulesEngineOutput.universeScreeningSummary,
          screenedUniverseCandidates: rulesEngineOutput.screenedUniverseCandidates,
        }, null, 2)}\n`, "utf8");
        await upsertPipelineArtifact({
          runId: run.id,
          artifactType: "rules_engine",
          artifactKey: "universe_screening_stage",
          filePath: universeScreenPath,
          contentJson: {
            universeScreeningSummary: rulesEngineOutput.universeScreeningSummary,
            screenedUniverseCandidates: rulesEngineOutput.screenedUniverseCandidates,
          },
          metadata: {
            shortlistedCount: rulesEngineOutput.universeScreeningSummary?.shortlistedCount || 0,
            priceScreenedCount: rulesEngineOutput.universeScreeningSummary?.priceScreenedCount || 0,
          },
        });

        const screeningPath = path.join(cycleRoot, "data", "screened_candidates.json");
        await fs.writeFile(screeningPath, `${JSON.stringify({
          generatedAt: rulesEngineOutput.generatedAt,
          config: rulesEngineOutput.config,
          screeningSummary: rulesEngineOutput.screeningSummary,
          screenedCandidates: rulesEngineOutput.screenedCandidates,
        }, null, 2)}\n`, "utf8");
        await upsertPipelineArtifact({
          runId: run.id,
          artifactType: "rules_engine",
          artifactKey: "screening_stage",
          filePath: screeningPath,
          contentJson: {
            screeningSummary: rulesEngineOutput.screeningSummary,
            screenedCandidates: rulesEngineOutput.screenedCandidates,
          },
          metadata: {
            screeningPoolCount: rulesEngineOutput.screeningSummary?.screeningPoolCount || 0,
            shortlistedForEnrichmentCount: rulesEngineOutput.screeningSummary?.shortlistedForEnrichmentCount || 0,
          },
        });

        const rulesEnginePath = path.join(cycleRoot, "data", "rules_engine_output.json");
        const { eligibleUniverse, screenedUniverseCandidates, screenedCandidates, ...rulesEngineArtifact } = rulesEngineOutput;
        await fs.writeFile(rulesEnginePath, `${JSON.stringify(rulesEngineArtifact, null, 2)}\n`, "utf8");
        await upsertPipelineArtifact({
          runId: run.id,
          artifactType: "rules_engine",
          artifactKey: "candidate_selection",
          filePath: rulesEnginePath,
          contentJson: rulesEngineArtifact,
          metadata: {
            eligibleInstrumentCount: rulesEngineOutput.eligibleUniverseSummary?.eligibleInstrumentCount || 0,
            selectedCount: rulesEngineOutput.selectedSymbols.length,
            rawCandidateCount: rulesEngineOutput.rawCandidateCount,
          },
        });
        progressReporter.completeStep("rules_artifacts", "Rules engine artifacts written");
      } else {
        progressReporter.skipStep("rules_artifacts", "No rules engine artifacts in configured mode");
      }

      progressReporter.startStep("portfolio", "Capturing portfolio context");
      const portfolioCapture = await capturePortfolioContext(config.cycleName);
      const portfolioContext = await readJsonFile(portfolioCapture.destination);
      await upsertPipelineArtifact({
        runId: run.id,
        artifactType: "broker",
        artifactKey: "portfolio_context",
        filePath: portfolioCapture.destination,
        contentJson: portfolioContext,
      });
      progressReporter.completeStep("portfolio", "Portfolio context captured");

      progressReporter.startStep("tickers", `Capturing broker context for ${config.symbols.length} symbols`, { totalUnits: config.symbols.length });
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
      progressReporter.completeStep("tickers", `${config.symbols.length} ticker contexts captured`);

      progressReporter.startStep("market", `Capturing market data for ${config.symbols.length} symbols and ${config.fredSeries.length} macro series`);
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
      progressReporter.completeStep("market", `${marketCapture.symbolsProcessed} symbols and ${marketCapture.macroSeriesProcessed} macro series processed`);

      let rebalancePreview = null;
      if (config.targetWeights) {
        progressReporter.startStep("rebalance", "Building rebalance preview");
        const rebalanceCapture = await captureRebalancePreview(config.cycleName, config.targetWeights);
        rebalancePreview = await readJsonFile(rebalanceCapture.destination);
        await upsertPipelineArtifact({
          runId: run.id,
          artifactType: "broker",
          artifactKey: "rebalance_preview",
          filePath: rebalanceCapture.destination,
          contentJson: rebalancePreview,
        });
        progressReporter.completeStep("rebalance", `${Array.isArray(rebalancePreview.actions) ? rebalancePreview.actions.length : 0} rebalance actions prepared`);
      } else {
        progressReporter.skipStep("rebalance", "No target weights configured");
      }

      progressReporter.startStep("agents", "Preparing agent reports", { totalUnits: REPORT_FILES.length });
      const agentExecution = await executeAgentPipeline({
        config,
        cycleRoot,
        portfolioContext,
        tickerContexts,
        marketDataSnapshot,
        rebalancePreview,
        rulesEngineOutput,
        llmOptions: overrides.llm,
        onProgress: ({ stage, detail, completed, total }) => {
          progressReporter.updateStep("agents", {
            detail: stage === "agent_report" ? detail : `Agent pipeline: ${detail}`,
            completedUnits: completed,
            totalUnits: total,
          });
        },
      });
      progressReporter.completeStep("agents", agentExecution.generated ? "All agent reports generated" : agentExecution.reason);

      progressReporter.startStep("reports", "Persisting generated reports", { totalUnits: REPORT_FILES.length });
      const reportSnapshots = await persistReportFiles(run.id, cycleRoot);
      progressReporter.completeStep("reports", `${reportSnapshots.length} report files persisted`);

      progressReporter.startStep("summary", "Writing final research synthesis");
      const finalSummary = buildFinalSummary({
        config,
        portfolioContext,
        rebalancePreview,
        reportSnapshots,
        rulesEngineOutput,
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
      progressReporter.completeStep("summary", "Final research synthesis written");

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

      progressReporter.event(`Cycle completed successfully with ${config.symbols.length} symbol${config.symbols.length === 1 ? "" : "s"}.`);
      return {
        ok: true,
        runId: run.id,
        cycleName: config.cycleName,
        status: completedRun.status,
        finalReportPath,
        llmExecution: agentExecution,
      };
    } catch (error) {
      progressReporter.failStep("summary", error.message);
      await updatePipelineRun(run.id, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: error.message,
      });
      throw error;
    }
  } catch (error) {
    if (config.symbolMode === "rules_engine") {
      progressReporter.failStep("rules_engine", error.message);
    }
    throw error;
  } finally {
    progressReporter.stop();
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