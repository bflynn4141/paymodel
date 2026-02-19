// Shared helpers: CORS, JSON responses, formatters
// Extracted to avoid circular imports between index.js and route handlers.

import { MODELS } from "./models.js";

const TEMPO_CHAIN_ID = 42431;
const PATHUSD_ADDRESS = "0x20c0000000000000000000000000000000000000";

// ============================================
// CORS (adapted from clara-proxy)
// ============================================

export function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      request.headers.get("Access-Control-Request-Headers") ??
      "Content-Type,Authorization,X-Payer,X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withCors(request, response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(request, data, status = 200) {
  return withCors(
    request,
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ============================================
// Format Helpers
// ============================================

export function formatPathUsd(units) {
  const n = BigInt(units || "0");
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

// ============================================
// Error Responses
// ============================================

export function missingPayerResponse(request) {
  return jsonResponse(request, {
    error: "Missing or invalid X-Payer header",
    code: "MISSING_PAYER",
    message: "Include X-Payer header with your Ethereum address (0x...)",
    example: 'curl -H "X-Payer: 0xYourAddress..." ...',
  }, 400);
}

export function paymentRequiredResponse(request, balance, env) {
  return jsonResponse(request, {
    error: "Insufficient balance",
    code: "PAYMENT_REQUIRED",
    balance: formatPathUsd(balance),
    deposit: {
      treasury: env.TREASURY_ADDRESS || "NOT_CONFIGURED",
      token: PATHUSD_ADDRESS,
      tokenName: "PathUSD",
      decimals: 6,
      chain: "Tempo Testnet",
      chainId: TEMPO_CHAIN_ID,
      rpc: "https://rpc.moderato.tempo.xyz",
    },
    howTo: [
      "1. Get testnet PathUSD from Tempo faucet",
      "2. Transfer PathUSD to the treasury address above",
      '3. POST /v1/deposit with {"txHash": "0x..."} and X-Payer header',
    ],
  }, 402);
}

export function invalidModelResponse(request, modelInput) {
  return jsonResponse(request, {
    error: `Unknown model: ${modelInput}`,
    code: "INVALID_MODEL",
    available: Object.entries(MODELS).map(([key, m]) => ({
      id: key,
      name: m.displayName,
      togetherId: m.togetherId,
    })),
  }, 400);
}
