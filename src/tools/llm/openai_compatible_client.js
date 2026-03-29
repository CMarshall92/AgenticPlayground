require("dotenv").config();

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2_400;


function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}


function resolveLlmConfig(overrides = {}) {
  const baseUrl = String(overrides.baseUrl || process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = overrides.apiKey || process.env.LLM_API_KEY || "";
  const model = overrides.model || process.env.LLM_MODEL || "";
  const enabled = overrides.enabled !== undefined
    ? Boolean(overrides.enabled)
    : parseBoolean(process.env.LLM_ENABLED, Boolean(apiKey && model));
  const temperature = overrides.temperature ?? Number(process.env.LLM_TEMPERATURE || DEFAULT_TEMPERATURE);
  const maxTokens = overrides.maxTokens ?? Number(process.env.LLM_MAX_OUTPUT_TOKENS || DEFAULT_MAX_TOKENS);

  return {
    enabled,
    apiKey,
    model,
    baseUrl,
    temperature,
    maxTokens,
  };
}


function getTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text || "";
        }
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}


class OpenAICompatibleLlmClient {
  constructor(options = {}) {
    this.config = resolveLlmConfig(options);

    if (this.config.enabled && (!this.config.apiKey || !this.config.model)) {
      throw new Error("LLM_ENABLED is true, but LLM_API_KEY or LLM_MODEL is missing.");
    }

    if (typeof fetch !== "function") {
      throw new Error("Fetch API is not available. Use Node.js 18+.");
    }
  }

  isConfigured() {
    return Boolean(this.config.enabled && this.config.apiKey && this.config.model);
  }

  async generateMarkdownReport({ systemPrompt, userPrompt, temperature, maxTokens } = {}) {
    if (!this.isConfigured()) {
      throw new Error("LLM client is not configured.");
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: temperature ?? this.config.temperature,
        max_tokens: maxTokens ?? this.config.maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `LLM request failed with status ${response.status}.`;
      throw new Error(message);
    }

    const content = getTextFromContent(payload?.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error("LLM response did not contain a message body.");
    }

    return content.trim();
  }
}


module.exports = {
  OpenAICompatibleLlmClient,
  resolveLlmConfig,
};