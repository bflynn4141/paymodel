// LLM Gateway: proxy requests to Together AI with balance check + deduction
import { resolveModel, calculateCost } from "./models.js";
import { getBalance, deductBalance, recordUsage, incrementStats } from "./balance.js";
import {
  jsonResponse,
  formatPathUsd,
  paymentRequiredResponse,
  invalidModelResponse,
  withCors,
} from "./helpers.js";

const TOGETHER_API = "https://api.together.xyz/v1/chat/completions";

// Minimum balance to allow streaming (covers ~100K tokens at cheapest model)
const MIN_STREAM_BALANCE = "100000"; // $0.10 in PathUSD units

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint.
 * Checks balance, proxies to Together AI, deducts actual cost.
 */
export async function handleChatCompletions(request, env, ctx, payer) {
  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, {
      error: "Invalid JSON body",
      code: "INVALID_REQUEST",
    }, 400);
  }

  // Resolve model
  const modelInput = body.model;
  if (!modelInput) {
    return jsonResponse(request, {
      error: "Missing 'model' field",
      code: "INVALID_REQUEST",
    }, 400);
  }

  const resolved = resolveModel(modelInput);
  if (!resolved) {
    return invalidModelResponse(request, modelInput);
  }

  const { key: modelKey, model } = resolved;

  // Check balance
  const balance = await getBalance(env.PAYMODEL, payer);
  const isStreaming = body.stream === true;

  // For streaming, require a minimum balance to cover the response
  // For non-streaming, we allow any positive balance (we'll check after)
  if (BigInt(balance) <= 0n) {
    return paymentRequiredResponse(request, balance, env);
  }

  if (isStreaming && BigInt(balance) < BigInt(MIN_STREAM_BALANCE)) {
    return paymentRequiredResponse(request, balance, env);
  }

  // Build Together AI request
  const togetherBody = {
    ...body,
    model: model.togetherId, // Replace our alias with Together's model ID
  };

  // For streaming, inject stream_options to get usage in the final chunk
  if (isStreaming) {
    togetherBody.stream_options = { include_usage: true };
  }

  // Forward to Together AI
  const togetherResponse = await fetch(TOGETHER_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TOGETHER_API_KEY}`,
    },
    body: JSON.stringify(togetherBody),
  });

  // Handle upstream errors (no balance deduction)
  if (!togetherResponse.ok) {
    const status = togetherResponse.status;
    const upstreamBody = await togetherResponse.text();

    if (status === 429) {
      return jsonResponse(request, {
        error: "Model is rate limited. Retry shortly.",
        code: "UPSTREAM_RATE_LIMITED",
        retryAfter: togetherResponse.headers.get("Retry-After") || "5",
      }, 429);
    }

    console.error(`[gateway] Together AI error ${status}: ${upstreamBody.slice(0, 200)}`);
    return jsonResponse(request, {
      error: "Model provider error. No balance deducted.",
      code: "UPSTREAM_ERROR",
      upstreamStatus: status,
    }, 502);
  }

  // --- Streaming response ---
  if (isStreaming) {
    return handleStreamingResponse(togetherResponse, request, env, ctx, payer, modelKey);
  }

  // --- Non-streaming response ---
  return handleNonStreamingResponse(togetherResponse, request, env, ctx, payer, modelKey);
}

/**
 * Handle a non-streaming Together AI response.
 * Parse usage, deduct balance, return response.
 */
async function handleNonStreamingResponse(togetherResponse, request, env, ctx, payer, modelKey) {
  const data = await togetherResponse.json();

  // Extract token usage
  const usage = data.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;

  // Calculate cost with 20% markup
  const cost = calculateCost(modelKey, promptTokens, completionTokens);

  // Deduct balance (background is fine for non-critical path)
  const deductResult = await deductBalance(env.PAYMODEL, payer, cost.pathUsdUnits.toString());

  if (!deductResult.success) {
    // Edge case: balance went to zero between check and deduction
    // Return the response anyway (we already called Together), but log it
    console.warn(`[gateway] Deduction failed for ${payer.slice(0, 10)}... — cost: ${cost.pathUsdUnits}, balance: ${deductResult.balance}`);
  }

  // Record usage in background
  ctx.waitUntil(
    Promise.all([
      recordUsage(env.PAYMODEL, payer, modelKey, promptTokens, completionTokens, cost.pathUsdUnits),
      incrementStats(env.PAYMODEL, { requests: 1, revenue: cost.pathUsdUnits.toString() }),
    ])
  );

  // Return OpenAI-compatible response with extra headers
  const response = jsonResponse(request, data);
  response.headers.set("X-Cost", cost.totalUsd.toFixed(8));
  response.headers.set("X-Cost-PathUSD", cost.pathUsdUnits.toString());
  response.headers.set("X-Balance", formatPathUsd(deductResult.balance || "0"));
  response.headers.set("X-Model", modelKey);

  return response;
}

/**
 * Handle a streaming Together AI response.
 * Pipe SSE chunks through, capture usage from final chunk, deduct in background.
 */
function handleStreamingResponse(togetherResponse, request, env, ctx, payer, modelKey) {
  let capturedUsage = null;
  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      // Try to capture usage from SSE data lines
      const text = decoder.decode(chunk, { stream: true });
      if (text.includes('"usage"')) {
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.usage) {
              capturedUsage = parsed.usage;
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    },

    flush() {
      // Stream complete — deduct actual cost in background
      if (capturedUsage) {
        const promptTokens = capturedUsage.prompt_tokens || 0;
        const completionTokens = capturedUsage.completion_tokens || 0;
        const cost = calculateCost(modelKey, promptTokens, completionTokens);

        ctx.waitUntil(
          Promise.all([
            deductBalance(env.PAYMODEL, payer, cost.pathUsdUnits.toString()),
            recordUsage(env.PAYMODEL, payer, modelKey, promptTokens, completionTokens, cost.pathUsdUnits),
            incrementStats(env.PAYMODEL, { requests: 1, revenue: cost.pathUsdUnits.toString() }),
          ]).catch((err) => {
            console.error(`[gateway] Stream deduction error for ${payer.slice(0, 10)}...:`, err);
          })
        );
      } else {
        console.warn(`[gateway] No usage captured from stream for ${payer.slice(0, 10)}...`);
        // Still count the request
        ctx.waitUntil(incrementStats(env.PAYMODEL, { requests: 1 }));
      }
    },
  });

  // Pipe Together's response body through our transform
  togetherResponse.body.pipeTo(writable);

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Payer": payer,
      "X-Model": modelKey,
      ...Object.fromEntries(
        Object.entries(corsHeaders(request) || {})
      ),
    },
  });
}

// Re-export corsHeaders for the streaming response
function corsHeaders(request) {
  const origin = request?.headers?.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    Vary: "Origin",
  };
}
