const { query } = require("./postgres");


function normalizeJsonValue(value) {
  if (value == null) {
    return null;
  }

  return JSON.stringify(value);
}


async function createPipelineRun({
  cycleName,
  runType = "daily",
  triggerSource = "manual",
  status = "running",
  config = {},
  metadata = {},
} = {}) {
  if (!cycleName) {
    throw new Error("cycleName is required.");
  }

  const result = await query(
    `
      INSERT INTO pipeline_runs (
        cycle_name,
        run_type,
        trigger_source,
        status,
        config,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [cycleName, runType, triggerSource, status, normalizeJsonValue(config), normalizeJsonValue(metadata)]
  );

  return result.rows[0];
}


async function updatePipelineRun(runId, { status, completedAt, errorMessage, metadata } = {}) {
  const result = await query(
    `
      UPDATE pipeline_runs
      SET status = COALESCE($2, status),
          completed_at = COALESCE($3, completed_at),
          error_message = COALESCE($4, error_message),
          metadata = CASE
            WHEN $5::jsonb IS NULL THEN metadata
            ELSE metadata || $5::jsonb
          END
      WHERE id = $1
      RETURNING *
    `,
    [runId, status ?? null, completedAt ?? null, errorMessage ?? null, normalizeJsonValue(metadata)]
  );

  return result.rows[0] || null;
}


async function upsertPipelineArtifact({
  runId,
  artifactType,
  artifactKey,
  filePath = null,
  contentJson = null,
  contentMarkdown = null,
  contentText = null,
  metadata = {},
} = {}) {
  const result = await query(
    `
      INSERT INTO pipeline_artifacts (
        run_id,
        artifact_type,
        artifact_key,
        file_path,
        content_json,
        content_markdown,
        content_text,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (run_id, artifact_type, artifact_key)
      DO UPDATE SET
        file_path = EXCLUDED.file_path,
        content_json = EXCLUDED.content_json,
        content_markdown = EXCLUDED.content_markdown,
        content_text = EXCLUDED.content_text,
        metadata = pipeline_artifacts.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [
      runId,
      artifactType,
      artifactKey,
      filePath,
      normalizeJsonValue(contentJson),
      contentMarkdown,
      contentText,
      normalizeJsonValue(metadata),
    ]
  );

  return result.rows[0];
}


async function upsertAgentOutput({
  runId,
  agentKey,
  sourcePromptPath = null,
  reportPath = null,
  contentMarkdown,
  metadata = {},
} = {}) {
  if (!contentMarkdown) {
    throw new Error("contentMarkdown is required for agent outputs.");
  }

  const result = await query(
    `
      INSERT INTO pipeline_agent_outputs (
        run_id,
        agent_key,
        source_prompt_path,
        report_path,
        content_markdown,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (run_id, agent_key)
      DO UPDATE SET
        source_prompt_path = EXCLUDED.source_prompt_path,
        report_path = EXCLUDED.report_path,
        content_markdown = EXCLUDED.content_markdown,
        metadata = pipeline_agent_outputs.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [runId, agentKey, sourcePromptPath, reportPath, contentMarkdown, normalizeJsonValue(metadata)]
  );

  return result.rows[0];
}


async function upsertFinalReport({
  runId,
  reportKind = "daily_summary",
  title,
  contentMarkdown,
  metadata = {},
} = {}) {
  if (!title) {
    throw new Error("title is required for final reports.");
  }
  if (!contentMarkdown) {
    throw new Error("contentMarkdown is required for final reports.");
  }

  const result = await query(
    `
      INSERT INTO pipeline_final_reports (
        run_id,
        report_kind,
        title,
        content_markdown,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (run_id, report_kind)
      DO UPDATE SET
        title = EXCLUDED.title,
        content_markdown = EXCLUDED.content_markdown,
        metadata = pipeline_final_reports.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `,
    [runId, reportKind, title, contentMarkdown, normalizeJsonValue(metadata)]
  );

  return result.rows[0];
}


module.exports = {
  createPipelineRun,
  updatePipelineRun,
  upsertAgentOutput,
  upsertFinalReport,
  upsertPipelineArtifact,
};