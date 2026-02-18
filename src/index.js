import { MODELS, buildModelsResponse } from "./models.js";
import { corsHeaders, jsonResponse, missingPayerResponse, formatPathUsd } from "./helpers.js";

const VERSION = "0.1.0";
const TEMPO_CHAIN_ID = 42429;
const PATHUSD_ADDRESS = "0x20c0000000000000000000000000000000000000";

// ============================================
// Auth Helpers
// ============================================

function getPayer(request) {
  const payer = request.headers.get("X-Payer");
  if (!payer || !/^0x[a-fA-F0-9]{40}$/.test(payer)) return null;
  return payer.toLowerCase();
}

function isAdminAuthenticated(request, env) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (!env.ADMIN_KEY) return false;
  return adminKey === env.ADMIN_KEY;
}

// ============================================
// Route Handlers
// ============================================

function handleHealth(request) {
  return jsonResponse(request, {
    status: "ok",
    version: VERSION,
    chain: {
      name: "Tempo Testnet",
      chainId: TEMPO_CHAIN_ID,
      token: "PathUSD",
      tokenAddress: PATHUSD_ADDRESS,
    },
    models: Object.keys(MODELS),
  });
}

function handleModels(request) {
  return jsonResponse(request, buildModelsResponse());
}

// ============================================
// Main Worker
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // --- Public endpoints (no auth) ---

    if (path === "/health" && method === "GET") {
      return handleHealth(request);
    }

    if (path === "/v1/models" && method === "GET") {
      return handleModels(request);
    }

    // --- Payer-authenticated endpoints ---

    if (path === "/v1/deposit" && method === "POST") {
      const payer = getPayer(request);
      if (!payer) return missingPayerResponse(request);

      const { handleDeposit } = await import("./deposit.js");
      return await handleDeposit(request, env, payer);
    }

    if (path === "/v1/balance" && method === "GET") {
      const payer = getPayer(request);
      if (!payer) return missingPayerResponse(request);

      const { getBalance } = await import("./balance.js");
      const balance = await getBalance(env.PAYMODEL, payer);
      return jsonResponse(request, {
        address: payer,
        balance: formatPathUsd(balance),
        balanceRaw: balance,
        currency: "PathUSD",
      });
    }

    if (path === "/v1/chat/completions" && method === "POST") {
      const payer = getPayer(request);
      if (!payer) return missingPayerResponse(request);

      const { handleChatCompletions } = await import("./gateway.js");
      return await handleChatCompletions(request, env, ctx, payer);
    }

    if (path === "/v1/usage" && method === "GET") {
      const payer = getPayer(request);
      if (!payer) return missingPayerResponse(request);

      const { getUsage } = await import("./balance.js");
      const usage = await getUsage(env.PAYMODEL, payer);
      return jsonResponse(request, { address: payer, usage });
    }

    // --- Admin endpoints ---

    if (path === "/admin/stats" && method === "GET") {
      if (!isAdminAuthenticated(request, env)) {
        return jsonResponse(request, { error: "Unauthorized" }, 401);
      }

      const stats = await env.PAYMODEL.get("stats:global", "json");
      return jsonResponse(request, stats || {
        totalDeposits: "0",
        totalRequests: 0,
        totalRevenue: "0",
      });
    }

    // --- 404 ---

    return jsonResponse(request, {
      error: "Not found",
      code: "NOT_FOUND",
      endpoints: [
        "GET  /health",
        "GET  /v1/models",
        "POST /v1/deposit",
        "GET  /v1/balance",
        "POST /v1/chat/completions",
        "GET  /v1/usage",
        "GET  /admin/stats",
      ],
    }, 404);
  },
};
