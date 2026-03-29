const REFRESH_INTERVAL_MS = 250;


function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "--:--";
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}


function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}


function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


class PipelineProgressReporter {
  constructor({ cycleName, enabled } = {}) {
    this.cycleName = cycleName || "unspecified";
    this.enabled = enabled ?? (Boolean(process.stdout.isTTY) && process.env.CI !== "true");
    this.startedAt = Date.now();
    this.steps = [];
    this.stepIndex = new Map();
    this.recentEvents = [];
    this.refreshTimer = null;
    this.lastRender = "";
  }

  setSteps(steps) {
    this.steps = steps.map((step, index) => ({
      ...step,
      index,
      status: "pending",
      detail: step.detail || "Waiting",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      completedUnits: 0,
      totalUnits: null,
    }));
    this.stepIndex = new Map(this.steps.map((step) => [step.id, step]));
  }

  start() {
    this.event(`Cycle ${this.cycleName} started.`);
    if (this.enabled) {
      this.refreshTimer = setInterval(() => this.render(), REFRESH_INTERVAL_MS);
      this.render();
      return;
    }

    console.log(`[pipeline] cycle ${this.cycleName} started`);
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.enabled) {
      this.render();
      process.stdout.write("\n");
    }
  }

  event(message) {
    this.recentEvents.unshift({ at: new Date(), message });
    this.recentEvents = this.recentEvents.slice(0, 6);
    if (!this.enabled) {
      console.log(`[pipeline] ${message}`);
    }
  }

  startStep(id, detail, options = {}) {
    const step = this.requireStep(id);
    if (!step.startedAt) {
      step.startedAt = Date.now();
    }
    step.status = "running";
    step.detail = detail || step.detail;
    if (Number.isFinite(options.totalUnits)) {
      step.totalUnits = options.totalUnits;
    }
    if (Number.isFinite(options.completedUnits)) {
      step.completedUnits = options.completedUnits;
    }
    this.event(`Started ${step.title}${detail ? `: ${detail}` : ""}`);
    if (this.enabled) {
      this.render();
    }
  }

  updateStep(id, { detail, completedUnits, totalUnits } = {}) {
    const step = this.requireStep(id);
    if (step.status === "pending") {
      step.status = "running";
      step.startedAt = Date.now();
    }
    if (detail) {
      step.detail = detail;
    }
    if (Number.isFinite(totalUnits)) {
      step.totalUnits = totalUnits;
    }
    if (Number.isFinite(completedUnits)) {
      step.completedUnits = completedUnits;
    }
    if (this.enabled) {
      this.render();
    }
  }

  completeStep(id, detail) {
    const step = this.requireStep(id);
    if (!step.startedAt) {
      step.startedAt = Date.now();
    }
    step.status = "completed";
    step.completedAt = Date.now();
    step.durationMs = step.completedAt - step.startedAt;
    step.detail = detail || step.detail;
    if (Number.isFinite(step.totalUnits) && !Number.isFinite(step.completedUnits)) {
      step.completedUnits = step.totalUnits;
    }
    if (Number.isFinite(step.totalUnits)) {
      step.completedUnits = step.totalUnits;
    }
    this.event(`Completed ${step.title} in ${formatDuration(step.durationMs)}${step.detail ? `: ${step.detail}` : ""}`);
    if (this.enabled) {
      this.render();
    }
  }

  skipStep(id, detail) {
    const step = this.requireStep(id);
    step.status = "skipped";
    step.detail = detail || "Skipped";
    step.startedAt = step.startedAt || Date.now();
    step.completedAt = Date.now();
    step.durationMs = 0;
    this.event(`Skipped ${step.title}${detail ? `: ${detail}` : ""}`);
    if (this.enabled) {
      this.render();
    }
  }

  failStep(id, detail) {
    const step = this.requireStep(id);
    step.status = "failed";
    step.detail = detail || step.detail || "Failed";
    step.completedAt = Date.now();
    step.durationMs = step.startedAt ? step.completedAt - step.startedAt : 0;
    this.event(`Failed ${step.title}${detail ? `: ${detail}` : ""}`);
    if (this.enabled) {
      this.render();
    }
  }

  requireStep(id) {
    const step = this.stepIndex.get(id);
    if (!step) {
      throw new Error(`Unknown pipeline step '${id}'.`);
    }
    return step;
  }

  stepProgress(step) {
    if (step.status === "completed" || step.status === "skipped") {
      return 1;
    }
    if (step.status === "failed") {
      return 1;
    }
    if (step.status === "running") {
      if (Number.isFinite(step.totalUnits) && step.totalUnits > 0) {
        return clamp(step.completedUnits / step.totalUnits, 0.02, 0.95);
      }
      return 0.5;
    }
    return 0;
  }

  overallProgress() {
    if (this.steps.length === 0) {
      return 0;
    }

    const total = this.steps.reduce((sum, step) => sum + this.stepProgress(step), 0);
    return total / this.steps.length;
  }

  estimatedRemainingMs() {
    const progress = this.overallProgress();
    if (progress <= 0.02) {
      return null;
    }

    const elapsed = Date.now() - this.startedAt;
    return Math.max(Math.round((elapsed / progress) - elapsed), 0);
  }

  stepStatusLabel(step) {
    if (step.status === "completed") {
      return "[x]";
    }
    if (step.status === "running") {
      return "[>]";
    }
    if (step.status === "skipped") {
      return "[-]";
    }
    if (step.status === "failed") {
      return "[!]";
    }
    return "[ ]";
  }

  stepDuration(step) {
    if (step.status === "completed" || step.status === "failed") {
      return formatDuration(step.durationMs);
    }
    if (step.status === "running" && step.startedAt) {
      return formatDuration(Date.now() - step.startedAt);
    }
    return "--:--";
  }

  render() {
    const elapsed = Date.now() - this.startedAt;
    const eta = this.estimatedRemainingMs();
    const progressPct = Math.round(this.overallProgress() * 100);
    const lines = [
      `Pipeline Progress | Cycle ${this.cycleName}`,
      `Elapsed ${formatDuration(elapsed)} | ETA ${eta == null ? "estimating" : formatDuration(eta)} | Overall ${progressPct}%`,
      "",
      ...this.steps.map((step, index) => {
        const progressText = Number.isFinite(step.totalUnits) && step.totalUnits > 0
          ? ` (${Math.min(step.completedUnits, step.totalUnits)}/${step.totalUnits})`
          : "";
        return `${String(index + 1).padStart(2, "0")}. ${this.stepStatusLabel(step)} ${step.title} | ${this.stepDuration(step)}${progressText}${step.detail ? ` | ${step.detail}` : ""}`;
      }),
      "",
      "Recent Events",
      ...(this.recentEvents.length > 0
        ? this.recentEvents.map((event) => `- ${formatTimestamp(event.at)} ${event.message}`)
        : ["- No events recorded yet."]),
    ];

    const output = lines.join("\n");
    if (!this.enabled) {
      return;
    }
    if (output === this.lastRender) {
      return;
    }

    this.lastRender = output;
    process.stdout.write(`\x1b[2J\x1b[0f${output}`);
  }
}


module.exports = {
  PipelineProgressReporter,
};