// Balance helpers: KV operations for PathUSD balances
// All amounts stored as string integers (6 decimals). "1000000" = 1.00 PathUSD.

/**
 * Get a payer's PathUSD balance in raw units.
 * Returns "0" if no balance exists.
 */
export async function getBalance(kv, address) {
  const data = await kv.get(`balance:${address}`, "json");
  return data?.amount || "0";
}

/**
 * Credit a payer's balance (add funds after verified deposit).
 * Returns the new balance.
 */
export async function creditBalance(kv, address, amountUnits) {
  const current = BigInt(await getBalance(kv, address));
  const credit = BigInt(amountUnits);
  const newBalance = (current + credit).toString();

  await kv.put(`balance:${address}`, JSON.stringify({
    amount: newBalance,
    lastUpdated: new Date().toISOString(),
  }));

  return newBalance;
}

/**
 * Deduct from a payer's balance (after LLM request).
 * Returns { success, newBalance } or { success: false } if insufficient.
 */
export async function deductBalance(kv, address, amountUnits) {
  const current = BigInt(await getBalance(kv, address));
  const deduction = BigInt(amountUnits);

  if (current < deduction) {
    return { success: false, balance: current.toString() };
  }

  const newBalance = (current - deduction).toString();
  await kv.put(`balance:${address}`, JSON.stringify({
    amount: newBalance,
    lastUpdated: new Date().toISOString(),
  }));

  return { success: true, balance: newBalance };
}

/**
 * Record usage for a payer (daily aggregate).
 */
export async function recordUsage(kv, address, modelKey, inputTokens, outputTokens, costUnits) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `usage:${address}:${today}`;

  const existing = await kv.get(key, "json") || {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    models: {},
  };

  existing.requests += 1;
  existing.inputTokens += inputTokens;
  existing.outputTokens += outputTokens;
  existing.cost += costUnits;
  existing.models[modelKey] = (existing.models[modelKey] || 0) + 1;

  await kv.put(key, JSON.stringify(existing), { expirationTtl: 90 * 24 * 60 * 60 });
}

/**
 * Get usage history for a payer (last N days).
 */
export async function getUsage(kv, address, days = 7) {
  const usage = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const data = await kv.get(`usage:${address}:${dateStr}`, "json");
    if (data) {
      usage.push({ date: dateStr, ...data });
    }
  }

  return usage;
}

/**
 * Increment global stats counters.
 */
export async function incrementStats(kv, { deposits = "0", requests = 0, revenue = "0" }) {
  const stats = await kv.get("stats:global", "json") || {
    totalDeposits: "0",
    totalRequests: 0,
    totalRevenue: "0",
  };

  stats.totalDeposits = (BigInt(stats.totalDeposits) + BigInt(deposits)).toString();
  stats.totalRequests += requests;
  stats.totalRevenue = (BigInt(stats.totalRevenue) + BigInt(revenue)).toString();

  await kv.put("stats:global", JSON.stringify(stats));
}
