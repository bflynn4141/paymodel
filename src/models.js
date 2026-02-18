// Model registry: paymodel aliases → Together AI config + pricing
// All upstream prices from https://www.together.ai/pricing

export const MARKUP = 1.2; // 20% margin over Together AI cost

export const MODELS = {
  "llama-3.3-70b": {
    togetherId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    displayName: "Llama 3.3 70B",
    category: "general",
    inputPricePerMillion: 0.88,
    outputPricePerMillion: 0.88,
    maxTokens: 4096,
    contextWindow: 131072,
  },
  "deepseek-r1": {
    togetherId: "deepseek-ai/DeepSeek-R1",
    displayName: "DeepSeek R1",
    category: "reasoning",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 7.00,
    maxTokens: 4096,
    contextWindow: 131072,
  },
  "mixtral-8x7b": {
    togetherId: "mistralai/Mixtral-8x7B-Instruct-v0.1",
    displayName: "Mixtral 8x7B",
    category: "moe",
    inputPricePerMillion: 0.60,
    outputPricePerMillion: 0.18,
    maxTokens: 4096,
    contextWindow: 32768,
  },
};

/**
 * Look up a model by paymodel alias or Together ID.
 * Returns { key, model } or null if not found.
 */
export function resolveModel(modelInput) {
  if (MODELS[modelInput]) {
    return { key: modelInput, model: MODELS[modelInput] };
  }
  for (const [key, model] of Object.entries(MODELS)) {
    if (model.togetherId === modelInput) {
      return { key, model };
    }
  }
  return null;
}

/**
 * Calculate the cost of a request in PathUSD units (6 decimals).
 * $1.00 = 1_000_000 PathUSD units.
 */
export function calculateCost(modelKey, promptTokens, completionTokens) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unknown model: ${modelKey}`);

  const inputCost = (promptTokens / 1_000_000) * model.inputPricePerMillion * MARKUP;
  const outputCost = (completionTokens / 1_000_000) * model.outputPricePerMillion * MARKUP;
  const totalUsd = inputCost + outputCost;
  const pathUsdUnits = Math.ceil(totalUsd * 1_000_000);

  return { inputCost, outputCost, totalUsd, pathUsdUnits };
}

/**
 * Build OpenAI-compatible /v1/models response with pricing metadata.
 */
export function buildModelsResponse() {
  const data = Object.entries(MODELS).map(([key, model]) => ({
    id: key,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "paymodel",
    permission: [],
    root: model.togetherId,
    parent: null,
    pricing: {
      input_per_million: (model.inputPricePerMillion * MARKUP).toFixed(4),
      output_per_million: (model.outputPricePerMillion * MARKUP).toFixed(4),
      currency: "PathUSD",
      markup: `${((MARKUP - 1) * 100).toFixed(0)}%`,
    },
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    category: model.category,
  }));

  return { object: "list", data };
}
