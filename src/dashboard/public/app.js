async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${path}`);
  }
  return response.json();
}


function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}


function createMetricCard(label, value) {
  const card = document.createElement("article");
  card.className = "metric-card";
  card.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  return card;
}


function renderMetrics(overview) {
  const metricsGrid = document.getElementById("metricsGrid");
  metricsGrid.innerHTML = "";

  const totals = overview.totals || {};
  metricsGrid.append(
    createMetricCard("Total Runs", totals.total_runs ?? 0),
    createMetricCard("Completed", totals.completed_runs ?? 0),
    createMetricCard("Failed", totals.failed_runs ?? 0),
    createMetricCard("Last 7 Days", totals.runs_last_7_days ?? 0),
  );
}


function renderRuns(runs, selectedRunId) {
  const runsList = document.getElementById("runsList");
  const runsMeta = document.getElementById("runsMeta");
  runsMeta.textContent = `${runs.length} shown`;
  runsList.innerHTML = "";

  for (const run of runs) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `run-card${Number(run.id) === Number(selectedRunId) ? " active" : ""}`;
    card.innerHTML = `
      <div class="status-pill">${run.status}</div>
      <h3>Run #${run.id} · ${run.cycle_name}</h3>
      <p class="run-meta">Started ${formatDate(run.started_at)}</p>
      <p class="run-meta">Artifacts ${run.artifact_count} · Agent Outputs ${run.agent_output_count} · Final Reports ${run.final_report_count}</p>
    `;
    card.addEventListener("click", () => loadRun(run.id));
    runsList.appendChild(card);
  }
}


function createTextCard(title, body, className = "markdown-block") {
  const card = document.createElement("article");
  card.className = "report-card";
  card.innerHTML = `<h4>${title}</h4><div class="${className}">${body}</div>`;
  return card;
}


function renderRunSummary(run, finalReports) {
  const selectedRunMeta = document.getElementById("selectedRunMeta");
  const runSummary = document.getElementById("runSummary");
  selectedRunMeta.textContent = `Run #${run.id} · ${run.status} · ${formatDate(run.started_at)}`;

  const summaryReport = finalReports.find((report) => report.report_kind === "daily_summary");
  runSummary.innerHTML = `
    <div class="status-pill">${run.status}</div>
    <p class="artifact-meta">Cycle ${run.cycle_name} · Trigger ${run.trigger_source} · Type ${run.run_type}</p>
    <p class="artifact-meta">Started ${formatDate(run.started_at)} · Completed ${formatDate(run.completed_at)}</p>
    ${run.error_message ? `<p class="artifact-meta">Error: ${run.error_message}</p>` : ""}
    ${summaryReport ? `<div class="markdown-block">${summaryReport.content_markdown}</div>` : ""}
  `;
}


function renderTextCollection(elementId, items, titleResolver) {
  const container = document.getElementById(elementId);
  container.innerHTML = "";

  if (!items.length) {
    container.innerHTML = '<p class="muted-text">No entries for this run.</p>';
    return;
  }

  for (const item of items) {
    container.appendChild(createTextCard(titleResolver(item), item.content_markdown || item.content_text || "No text content available."));
  }
}


function renderArtifacts(artifacts) {
  const container = document.getElementById("artifacts");
  container.innerHTML = "";

  if (!artifacts.length) {
    container.innerHTML = '<p class="muted-text">No artifacts for this run.</p>';
    return;
  }

  for (const artifact of artifacts) {
    const card = document.createElement("article");
    card.className = "artifact-card";
    const content = artifact.content_markdown || artifact.content_text || (artifact.content_json ? JSON.stringify(artifact.content_json, null, 2) : "No inline content stored.");
    const contentClass = artifact.content_json ? "json-block" : "markdown-block";
    card.innerHTML = `
      <h4>${artifact.artifact_type} · ${artifact.artifact_key}</h4>
      <p class="artifact-meta">${artifact.file_path || "Stored in database only"}</p>
      <div class="${contentClass}">${content}</div>
    `;
    container.appendChild(card);
  }
}


async function loadRun(runId) {
  const [run, artifacts, outputs, finalReports, runs] = await Promise.all([
    getJson(`/api/runs/${runId}`),
    getJson(`/api/runs/${runId}/artifacts`),
    getJson(`/api/runs/${runId}/agent-outputs`),
    getJson(`/api/runs/${runId}/final-reports`),
    getJson("/api/runs?limit=20"),
  ]);

  renderRuns(runs, runId);
  renderRunSummary(run, finalReports);
  renderTextCollection("finalReports", finalReports, (report) => `${report.report_kind} · ${report.title}`);
  renderTextCollection("agentOutputs", outputs, (output) => `${output.agent_key} · ${output.report_path || output.source_prompt_path || "agent report"}`);
  renderArtifacts(artifacts);
}


async function boot() {
  const [overview, latestRun, runs] = await Promise.all([
    getJson("/api/overview"),
    getJson("/api/runs/latest").catch(() => null),
    getJson("/api/runs?limit=20"),
  ]);

  renderMetrics(overview);
  renderRuns(runs, latestRun?.id);
  if (latestRun?.id) {
    await loadRun(latestRun.id);
  }
}


document.getElementById("refreshButton").addEventListener("click", () => {
  boot().catch((error) => {
    console.error(error);
  });
});


boot().catch((error) => {
  console.error(error);
});