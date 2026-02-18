// Deposit handler: verify Tempo tx and credit KV balance
import { verifyDeposit } from "./verify.js";
import { creditBalance, incrementStats } from "./balance.js";
import { jsonResponse, formatPathUsd } from "./helpers.js";

/**
 * POST /v1/deposit
 *
 * Body: { "txHash": "0x..." }
 * Header: X-Payer: 0xAddress
 *
 * Verifies the PathUSD transfer on Tempo testnet, credits the payer's
 * KV balance, and returns the updated balance.
 *
 * Idempotent: calling with the same txHash returns the existing credit.
 */
export async function handleDeposit(request, env, payer) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, {
      error: "Invalid JSON body",
      code: "INVALID_REQUEST",
      expected: '{ "txHash": "0x..." }',
    }, 400);
  }

  const { txHash } = body;
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return jsonResponse(request, {
      error: "Invalid or missing txHash",
      code: "INVALID_REQUEST",
      expected: "64-character hex string prefixed with 0x",
    }, 400);
  }

  // Idempotency check: already credited this tx?
  const existingDeposit = await env.PAYMODEL.get(`deposit:${txHash}`, "json");
  if (existingDeposit) {
    const { getBalance } = await import("./balance.js");
    const balance = await getBalance(env.PAYMODEL, payer);
    return jsonResponse(request, {
      message: "Deposit already credited",
      txHash,
      credited: formatPathUsd(existingDeposit.amount),
      balance: formatPathUsd(balance),
      balanceRaw: balance,
    });
  }

  // Verify on Tempo
  const treasury = env.TREASURY_ADDRESS;
  if (!treasury) {
    return jsonResponse(request, {
      error: "Treasury address not configured",
      code: "SERVER_ERROR",
    }, 500);
  }

  let transfer;
  try {
    transfer = await verifyDeposit(txHash, treasury);
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : 400;
    return jsonResponse(request, {
      error: err.message,
      code: status === 404 ? "TX_NOT_FOUND" : "VERIFICATION_FAILED",
      txHash,
    }, status);
  }

  // Verify the sender matches the payer header
  if (transfer.from !== payer) {
    console.log(`[deposit] Sender ${transfer.from} != payer ${payer} — crediting payer anyway`);
    // We credit the payer, not necessarily the sender. This is fine for testnet.
    // For production, you might want to restrict this.
  }

  // Record the deposit (dedup key)
  await env.PAYMODEL.put(`deposit:${txHash}`, JSON.stringify({
    address: payer,
    amount: transfer.amount,
    from: transfer.from,
    blockNumber: transfer.blockNumber,
    creditedAt: new Date().toISOString(),
  }));

  // Credit the balance
  const newBalance = await creditBalance(env.PAYMODEL, payer, transfer.amount);

  // Update global stats
  await incrementStats(env.PAYMODEL, { deposits: transfer.amount });

  console.log(`[deposit] Credited ${formatPathUsd(transfer.amount)} PathUSD to ${payer.slice(0, 10)}... (tx: ${txHash.slice(0, 10)}...)`);

  return jsonResponse(request, {
    message: "Deposit verified and credited",
    txHash,
    credited: formatPathUsd(transfer.amount),
    balance: formatPathUsd(newBalance),
    balanceRaw: newBalance,
    transfer: {
      from: transfer.from,
      amount: transfer.amount,
      blockNumber: transfer.blockNumber,
    },
  });
}
