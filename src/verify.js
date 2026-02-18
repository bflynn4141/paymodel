// Tempo RPC helpers: verify PathUSD transfers via JSON-RPC
// No SDK needed — pure fetch() to EVM-compatible RPC.

const TEMPO_RPC = "https://rpc.testnet.tempo.xyz";
const PATHUSD_ADDRESS = "0x20c0000000000000000000000000000000000000";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Call Tempo JSON-RPC.
 */
async function tempoRpc(method, params) {
  const res = await fetch(TEMPO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`Tempo RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Verify a PathUSD deposit transaction on Tempo testnet.
 *
 * Checks:
 * 1. Transaction exists and succeeded (status 0x1)
 * 2. Contains a Transfer event from PathUSD contract
 * 3. Transfer recipient matches our treasury address
 *
 * Returns { from, to, amount, blockNumber } on success.
 * Throws on failure with descriptive error.
 */
export async function verifyDeposit(txHash, treasuryAddress) {
  // Get transaction receipt
  const receipt = await tempoRpc("eth_getTransactionReceipt", [txHash]);

  if (!receipt) {
    throw new Error("Transaction not found or not yet confirmed. Wait for finality and retry.");
  }

  if (receipt.status !== "0x1") {
    throw new Error("Transaction reverted on-chain");
  }

  // Find the PathUSD Transfer event
  const transferLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === PATHUSD_ADDRESS.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC
  );

  if (!transferLog) {
    throw new Error("No PathUSD Transfer event found in this transaction");
  }

  // Decode Transfer(address indexed from, address indexed to, uint256 value)
  // topics[1] = from (address padded to 32 bytes)
  // topics[2] = to (address padded to 32 bytes)
  // data = value (uint256)
  const from = "0x" + transferLog.topics[1].slice(26).toLowerCase();
  const to = "0x" + transferLog.topics[2].slice(26).toLowerCase();
  const amount = BigInt(transferLog.data).toString();

  // Verify recipient is our treasury
  if (to !== treasuryAddress.toLowerCase()) {
    throw new Error(
      `Transfer recipient ${to} does not match treasury ${treasuryAddress.toLowerCase()}`
    );
  }

  return {
    from,
    to,
    amount,
    blockNumber: parseInt(receipt.blockNumber, 16),
  };
}
