# paymodel

Crypto-native API proxy for open-source LLMs. Pay with stablecoins, get OpenAI-compatible inference. No API keys, no accounts, no invoices.

**Live:** `https://paymodel.bflynn4141.workers.dev`

## Zero to AI in 30 Seconds

```bash
# 1. Check available models and pricing
curl https://paymodel.bflynn4141.workers.dev/v1/models

# 2. Deposit PathUSD on Tempo testnet (after sending on-chain)
curl -X POST https://paymodel.bflynn4141.workers.dev/v1/deposit \
  -H "X-Payer: 0xYourAddress" \
  -H "Content-Type: application/json" \
  -d '{"txHash": "0xYourDepositTxHash"}'

# 3. Make an AI call — that's it
curl -X POST https://paymodel.bflynn4141.workers.dev/v1/chat/completions \
  -H "X-Payer: 0xYourAddress" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "What is the meaning of life?"}]
  }'
```

No signup. No API key. No credit card. Send stablecoins, get AI.

## How It Works

```
You (or your AI agent)
  │
  │  1. Deposit PathUSD to treasury address (one-time)
  │  2. POST /v1/chat/completions with X-Payer header
  │
  ▼
paymodel (Cloudflare Worker)
  │
  │  • Checks your balance in KV
  │  • Forwards to Together AI
  │  • Deducts actual cost (per-token)
  │  • Returns OpenAI-compatible response
  │
  ▼
Together AI → Llama 3.3 70B / DeepSeek R1 / Mixtral 8x7B
```

Payment IS authentication. Your Ethereum address is your identity.

## Models & Pricing

| Model | Category | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------|----------------------|----------------------|
| `llama-3.3-70b` | General | $1.056 | $1.056 |
| `deepseek-r1` | Reasoning | $3.600 | $8.400 |
| `mixtral-8x7b` | MoE | $0.720 | $0.216 |

All prices in PathUSD. 20% markup over Together AI's upstream cost.

## Use with OpenAI SDK

paymodel is a drop-in replacement for any OpenAI-compatible client. Just change the base URL:

### Python (openai package)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://paymodel.bflynn4141.workers.dev/v1",
    api_key="unused",  # paymodel uses X-Payer, not API keys
    default_headers={"X-Payer": "0xYourAddress"}
)

response = client.chat.completions.create(
    model="llama-3.3-70b",
    messages=[{"role": "user", "content": "Explain quantum computing in one sentence"}]
)
print(response.choices[0].message.content)
```

### Python (native SDK)

```python
from paymodel import Paymodel

pm = Paymodel(payer="0xYourAddress")

# Non-streaming
response = pm.chat.completions.create(
    model="llama-3.3-70b",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
print(f"Cost: ${response.cost} | Balance: {response.balance}")

# Streaming
for chunk in pm.chat.completions.create(
    model="deepseek-r1",
    messages=[{"role": "user", "content": "Write a haiku about crypto"}],
    stream=True
):
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### JavaScript/TypeScript

```javascript
const response = await fetch("https://paymodel.bflynn4141.workers.dev/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Payer": "0xYourAddress",
  },
  body: JSON.stringify({
    model: "llama-3.3-70b",
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="https://paymodel.bflynn4141.workers.dev/v1",
    api_key="unused",
    model="llama-3.3-70b",
    default_headers={"X-Payer": "0xYourAddress"}
)

response = llm.invoke("What is the capital of France?")
```

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Status and supported models |
| `/v1/models` | GET | — | Models with pricing |
| `/v1/deposit` | POST | X-Payer | Register a PathUSD deposit |
| `/v1/balance` | GET | X-Payer | Check your balance |
| `/v1/chat/completions` | POST | X-Payer | Chat completions (stream + non-stream) |
| `/v1/usage` | GET | X-Payer | Usage history |

### Authentication

No API keys. Include your Ethereum address in the `X-Payer` header:

```
X-Payer: 0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd
```

### Depositing Funds

1. Send PathUSD to the treasury address on Tempo testnet
2. Call `/v1/deposit` with the transaction hash:

```bash
curl -X POST https://paymodel.bflynn4141.workers.dev/v1/deposit \
  -H "X-Payer: 0xYourAddress" \
  -H "Content-Type: application/json" \
  -d '{"txHash": "0xYourTxHash"}'
```

The deposit is verified on-chain via Tempo RPC. Idempotent — calling twice with the same tx hash returns the existing credit.

### Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `MISSING_PAYER` | 400 | No X-Payer header |
| `INVALID_MODEL` | 400 | Model not found |
| `PAYMENT_REQUIRED` | 402 | Insufficient balance |
| `TX_NOT_FOUND` | 404 | Deposit tx not confirmed |
| `UPSTREAM_RATE_LIMITED` | 429 | Together AI rate limit |
| `UPSTREAM_ERROR` | 502 | Together AI error (no charge) |

## Why?

Open-source AI models are free to train but centralized to use. Meta releases Llama, and companies like Together/Groq/Fireworks monetize the inference — keeping all revenue, data, and control. Users get nothing.

paymodel decentralizes the payment layer first. AI agents pay with stablecoins — no accounts, no middlemen. The margin between what users pay and what providers charge flows transparently.

This is step one. Next: multi-provider routing, usage-based rewards, and community governance over model selection and pricing.

## Stack

- **Runtime:** Cloudflare Workers (23KB, zero npm dependencies)
- **Storage:** Cloudflare KV
- **Upstream:** Together AI (OpenAI-compatible)
- **Chain:** Tempo testnet (PathUSD stablecoin)
- **Payment:** Deposit + deduct (no per-request on-chain overhead)

## Development

```bash
# Install
npm install

# Local dev (uses .dev.vars for secrets)
npm run dev

# Deploy
npm run deploy

# Set secrets
npx wrangler secret put TOGETHER_API_KEY
npx wrangler secret put ADMIN_KEY
npx wrangler secret put TREASURY_ADDRESS

# Run tests
./test/manual-test.sh
./test/manual-test.sh http://localhost:8787  # test local
```

## License

MIT
