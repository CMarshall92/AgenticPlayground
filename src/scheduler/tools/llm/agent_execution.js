require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");

const { REPORT_FILES } = require("../../core/pipeline_cycle");
const { OpenAICompatibleLlmClient, resolveLlmConfig } = require("./openai_compatible_client");

const REPORT_ORDER = ["macro", "sector", "risk", "portfolio", "yolo"];
const DEFAULT_CONTEXT_LIMIT = Number(process.env.LLM_CONTEXT_MAX_CHARS || 18_000);


function truncateText(value, maxLength = DEFAULT_CONTEXT_LIMIT) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[Truncated ${text.length - maxLength} additional characters from this context block.]`;
}


function compactJson(value, maxLength = DEFAULT_CONTEXT_LIMIT) {
  return truncateText(JSON.stringify(value, null, 2), maxLength);
}


function getReportDefinition(key) {
  return REPORT_FILES.find((report) => report.key === key);
}


function getPromptPath(report) {
  return path.resolve(__dirname, "..", "..", report.source);
}


async function readPrompt(report) {
  return fs.readFile(getPromptPath(report), "utf8");
}


function simplifyMacroData(marketDataSnapshot) {
  const macroSeries = marketDataSnapshot?.macro?.series || {};
  return Object.fromEntries(
    Object.entries(macroSeries).map(([seriesId, seriesData]) => {
      const meta = seriesData?.value?.meta?.seriess?.[0] || null;
      const observations = seriesData?.value?.observations?.observations?.slice(0, 5) || [];
      return [seriesId, { meta, observations }];
    })
  );
}


function simplifyTickerContexts(tickerContexts) {
  return (tickerContexts || []).map((context) => ({
    ticker: context.ticker,
    tradable: context.tradability?.value?.tradable ?? context.tradability?.tradable ?? false,
    exactMatch: context.tradability?.value?.exactMatch ?? context.tradability?.exactMatch ?? false,
    instrument: context.tradability?.value?.instrument || context.tradability?.instrument || null,
    heldQuantity: context.positions?.totalQuantity ?? null,
    pendingOrderCount: context.pendingOrders?.count ?? null,
  }));
}


function simplifyPortfolioContext(portfolioContext) {
  return {
    summary: portfolioContext?.summary || null,
    cash: portfolioContext?.cash || null,
    positions: (portfolioContext?.positions || []).map((position) => ({
      ticker: position.instrument?.ticker || position.ticker || null,
      quantity: position.quantity ?? null,
      currentValue: position.walletImpact?.currentValue ?? null,
      result: position.walletImpact?.result ?? null,
    })),
    pendingOrders: (portfolioContext?.pendingOrders || []).map((order) => ({
      id: order.id ?? null,
      ticker: order.instrument?.ticker || order.ticker || null,
      type: order.type ?? null,
      quantity: order.quantity ?? null,
      status: order.status ?? null,
    })),
  };
}


function simplifyEquitySnapshot(marketDataSnapshot) {
  const equity = marketDataSnapshot?.equity || {};
  return Object.fromEntries(
    Object.entries(equity).map(([symbol, snapshot]) => [
      symbol,
      {
        companyName: snapshot.companyName,
        cik: snapshot.cik,
        providers: snapshot.providers,
      },
    ])
  );
}


function buildSharedContext({ config, portfolioContext, tickerContexts, marketDataSnapshot, rebalancePreview }) {
  return {
    asOfDate: new Date().toISOString().slice(0, 10),
    cycleName: config.cycleName,
    symbolUniverse: config.symbols,
    configuredTargetWeights: config.targetWeights || null,
    companyNames: config.companyNames,
    cikMap: config.cikMap,
    broker: simplifyPortfolioContext(portfolioContext),
    tickerContexts: simplifyTickerContexts(tickerContexts),
    macroData: simplifyMacroData(marketDataSnapshot),
    equityData: simplifyEquitySnapshot(marketDataSnapshot),
    rebalancePreview,
  };
}


function buildUserPrompt({ key, sharedContext, priorReports }) {
  const baseInstruction = [
    `Date: ${sharedContext.asOfDate}`,
    `Cycle: ${sharedContext.cycleName}`,
    "Use only the provided data bundle and the captured symbol universe unless you explicitly say evidence is missing.",
    "Return Markdown only.",
    "Do not wrap the answer in code fences.",
  ];

  if (key === "macro") {
    return `${baseInstruction.join("\n")}\n\n## Available Symbol Universe\n${sharedContext.symbolUniverse.join(", ")}\n\n## Macro Data\n${compactJson(sharedContext.macroData)}\n\n## Equity Data Bundle\n${compactJson(sharedContext.equityData)}\n\n## Broker Snapshot\n${compactJson(sharedContext.broker, 10_000)}`;
  }

  if (key === "sector") {
    return `${baseInstruction.join("\n")}\n\n## Prior Macro Report\n${truncateText(priorReports.macro || "No macro report available.", 12_000)}\n\n## Tradability And Broker Context\n${compactJson(sharedContext.tickerContexts, 10_000)}\n\n## Equity Data Bundle\n${compactJson(sharedContext.equityData)}`;
  }

  if (key === "risk") {
    return `${baseInstruction.join("\n")}\n\n## Prior Macro Report\n${truncateText(priorReports.macro || "", 9_000)}\n\n## Prior Sector Report\n${truncateText(priorReports.sector || "", 12_000)}\n\n## Portfolio Context\n${compactJson(sharedContext.broker, 8_000)}\n\n## Ticker Contexts\n${compactJson(sharedContext.tickerContexts, 8_000)}\n\n## Equity Data Bundle\n${compactJson(sharedContext.equityData, 14_000)}`;
  }

  if (key === "portfolio") {
    return `${baseInstruction.join("\n")}\n\n## Prior Macro Report\n${truncateText(priorReports.macro || "", 7_000)}\n\n## Prior Sector Report\n${truncateText(priorReports.sector || "", 10_000)}\n\n## Prior Risk Report\n${truncateText(priorReports.risk || "", 12_000)}\n\n## Current Portfolio Context\n${compactJson(sharedContext.broker, 8_000)}\n\n## Configured Target Weights\n${compactJson(sharedContext.configuredTargetWeights, 4_000)}\n\n## Existing Rebalance Preview\n${compactJson(sharedContext.rebalancePreview, 8_000)}`;
  }

  return `${baseInstruction.join("\n")}\n\n## Prior Macro Report\n${truncateText(priorReports.macro || "", 10_000)}\n\n## Equity Data Bundle\n${compactJson(sharedContext.equityData, 16_000)}\n\n## Ticker Contexts\n${compactJson(sharedContext.tickerContexts, 8_000)}\n\n## Additional Constraint\nTreat this as a separate speculative sleeve. If the captured symbol universe does not contain legitimate micro-cap or high-risk asymmetry, say so explicitly and return fewer ideas.`;
}


async function writeReport(cycleRoot, report, content) {
  const reportPath = path.join(cycleRoot, report.fileName);
  await fs.writeFile(reportPath, `${content.trim()}\n`, "utf8");
  return reportPath;
}


function getAgentExecutionState(overrides = {}) {
  const config = resolveLlmConfig(overrides);
  return {
    enabled: config.enabled,
    generated: false,
    model: config.model || null,
    baseUrl: config.baseUrl || null,
    reason: config.enabled
      ? "LLM is configured and will be used to generate authored agent reports."
      : "LLM is disabled or not configured for this run.",
  };
}


async function executeAgentPipeline({ config, cycleRoot, portfolioContext, tickerContexts, marketDataSnapshot, rebalancePreview, llmOptions } = {}) {
  const llmClient = new OpenAICompatibleLlmClient(llmOptions);
  if (!llmClient.isConfigured()) {
    return getAgentExecutionState(llmOptions);
  }

  const sharedContext = buildSharedContext({
    config,
    portfolioContext,
    tickerContexts,
    marketDataSnapshot,
    rebalancePreview,
  });
  const priorReports = {};

  for (const key of REPORT_ORDER) {
    const report = getReportDefinition(key);
    const systemPrompt = await readPrompt(report);
    const userPrompt = buildUserPrompt({ key, sharedContext, priorReports });
    const content = await llmClient.generateMarkdownReport({
      systemPrompt,
      userPrompt,
    });

    await writeReport(cycleRoot, report, content);
    priorReports[key] = content;
  }

  return {
    enabled: true,
    generated: true,
    model: llmClient.config.model,
    baseUrl: llmClient.config.baseUrl,
    reason: `Generated ${REPORT_ORDER.length} agent reports automatically via the configured LLM.`,
  };
}


module.exports = {
  executeAgentPipeline,
  getAgentExecutionState,
};