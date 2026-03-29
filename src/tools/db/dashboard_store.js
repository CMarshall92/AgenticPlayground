const { query } = require("./postgres");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;


function normalizeLimit(limit) {
  if (limit == null) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }

  return parsed;
}


async function getDashboardOverview() {
  const [totalsResult, statusesResult, latestRunResult] = await Promise.all([
    query(
      `
        SELECT
          COUNT(*)::int AS total_runs,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_runs,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
          COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days')::int AS runs_last_7_days
        FROM pipeline_runs
      `
    ),
    query(
      `
        SELECT status, COUNT(*)::int AS count
        FROM pipeline_runs
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    query(
      `
        SELECT id, cycle_name, run_type, trigger_source, status, started_at, completed_at
        FROM pipeline_runs
        ORDER BY started_at DESC
        LIMIT 1
      `
    ),
  ]);

  return {
    totals: totalsResult.rows[0] || {
      total_runs: 0,
      completed_runs: 0,
      failed_runs: 0,
      runs_last_7_days: 0,
    },
    statuses: statusesResult.rows,
    latestRun: latestRunResult.rows[0] || null,
  };
}


async function listPipelineRuns({ limit, status } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  const values = [normalizedLimit];
  let whereClause = "";

  if (status) {
    values.push(status);
    whereClause = "WHERE pr.status = $2";
  }

  const result = await query(
    `
      SELECT
        pr.id,
        pr.cycle_name,
        pr.run_type,
        pr.trigger_source,
        pr.status,
        pr.error_message,
        pr.started_at,
        pr.completed_at,
        COUNT(DISTINCT pa.id)::int AS artifact_count,
        COUNT(DISTINCT ao.id)::int AS agent_output_count,
        COUNT(DISTINCT fr.id)::int AS final_report_count
      FROM pipeline_runs pr
      LEFT JOIN pipeline_artifacts pa ON pa.run_id = pr.id
      LEFT JOIN pipeline_agent_outputs ao ON ao.run_id = pr.id
      LEFT JOIN pipeline_final_reports fr ON fr.run_id = pr.id
      ${whereClause}
      GROUP BY pr.id
      ORDER BY pr.started_at DESC
      LIMIT $1
    `,
    values
  );

  return result.rows;
}


async function getPipelineRun(runId) {
  const result = await query(
    `
      SELECT *
      FROM pipeline_runs
      WHERE id = $1
      LIMIT 1
    `,
    [runId]
  );

  return result.rows[0] || null;
}


async function getPipelineArtifacts(runId) {
  const result = await query(
    `
      SELECT id, run_id, artifact_type, artifact_key, file_path, content_json, content_markdown, content_text, metadata, created_at, updated_at
      FROM pipeline_artifacts
      WHERE run_id = $1
      ORDER BY artifact_type ASC, artifact_key ASC
    `,
    [runId]
  );

  return result.rows;
}


async function getPipelineAgentOutputs(runId) {
  const result = await query(
    `
      SELECT id, run_id, agent_key, source_prompt_path, report_path, content_markdown, metadata, created_at, updated_at
      FROM pipeline_agent_outputs
      WHERE run_id = $1
      ORDER BY agent_key ASC
    `,
    [runId]
  );

  return result.rows;
}


async function getPipelineFinalReports(runId) {
  const result = await query(
    `
      SELECT id, run_id, report_kind, title, content_markdown, metadata, created_at, updated_at
      FROM pipeline_final_reports
      WHERE run_id = $1
      ORDER BY report_kind ASC
    `,
    [runId]
  );

  return result.rows;
}


async function getLatestPipelineRun() {
  const runs = await listPipelineRuns({ limit: 1 });
  return runs[0] || null;
}


module.exports = {
  getDashboardOverview,
  getLatestPipelineRun,
  getPipelineAgentOutputs,
  getPipelineArtifacts,
  getPipelineFinalReports,
  getPipelineRun,
  listPipelineRuns,
};