#!/bin/bash
# Paymodel v1 — Manual E2E Test Script
# Tests all endpoints against a deployed or local worker.
#
# Usage:
#   ./test/manual-test.sh                          # Uses production URL
#   ./test/manual-test.sh http://localhost:8787     # Uses local dev
#
# For full E2E (deposit + chat), you need:
#   - A funded Tempo testnet wallet (cast + private key)
#   - TOGETHER_API_KEY set as a wrangler secret
#   - TREASURY_ADDRESS set as a wrangler secret

set -uo pipefail

BASE_URL="${1:-https://paymodel.bflynn4141.workers.dev}"
PAYER="${TEST_PAYER:-0x8744baf00f5ad7ffccc56c25fa5aa9270e2caffd}"
ADMIN_KEY="${ADMIN_KEY:-paymodel-admin-76b84ba8002039a5}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass=0
fail=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"

  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}✓${NC} $name"
    pass=$((pass + 1))
  else
    echo -e "  ${RED}✗${NC} $name (expected '$expected')"
    echo "    Got: $(echo "$actual" | head -3)"
    fail=$((fail + 1))
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Paymodel v1 — E2E Tests"
echo " Target: $BASE_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 1. Health ───────────────────────────────
echo ""
echo "1. Health"
HEALTH=$(curl -s "$BASE_URL/health")
check "Returns status ok" '"status":"ok"' "$HEALTH"
check "Shows version" '"version":"0.1.0"' "$HEALTH"
check "Lists models" '"llama-3.3-70b"' "$HEALTH"
check "Shows chain info" '"Tempo Testnet"' "$HEALTH"

# ─── 2. Models ───────────────────────────────
echo ""
echo "2. Models"
MODELS=$(curl -s "$BASE_URL/v1/models")
check "Returns model list" '"object":"list"' "$MODELS"
check "Llama with pricing" '"input_per_million":"1.0560"' "$MODELS"
check "DeepSeek R1 present" '"deepseek-r1"' "$MODELS"
check "Mixtral present" '"mixtral-8x7b"' "$MODELS"
check "Shows 20% markup" '"markup":"20%"' "$MODELS"

# ─── 3. Missing Payer ────────────────────────
echo ""
echo "3. Error: Missing Payer"
NO_PAYER=$(curl -s "$BASE_URL/v1/balance")
check "Returns MISSING_PAYER" '"MISSING_PAYER"' "$NO_PAYER"

# ─── 4. Balance (zero) ──────────────────────
echo ""
echo "4. Balance (zero balance)"
BALANCE=$(curl -s -H "X-Payer: $PAYER" "$BASE_URL/v1/balance")
check "Returns balance object" '"currency":"PathUSD"' "$BALANCE"
check "Balance is zero" '"balance":"0.000000"' "$BALANCE"

# ─── 5. Chat without balance (402) ──────────
echo ""
echo "5. Chat without balance"
CHAT_402=$(curl -s -X POST \
  -H "X-Payer: $PAYER" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"hi"}]}' \
  "$BASE_URL/v1/chat/completions")
check "Returns PAYMENT_REQUIRED" '"PAYMENT_REQUIRED"' "$CHAT_402"
check "Includes deposit instructions" '"howTo"' "$CHAT_402"
check "Shows treasury address" '"treasury"' "$CHAT_402"

# ─── 6. Invalid model ───────────────────────
echo ""
echo "6. Invalid model"
BAD_MODEL=$(curl -s -X POST \
  -H "X-Payer: $PAYER" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}' \
  "$BASE_URL/v1/chat/completions")
check "Returns INVALID_MODEL" '"INVALID_MODEL"' "$BAD_MODEL"
check "Lists available models" '"available"' "$BAD_MODEL"

# ─── 7. Admin (unauthorized) ────────────────
echo ""
echo "7. Admin (no key)"
ADMIN_NOKEY=$(curl -s "$BASE_URL/admin/stats")
check "Returns 401" '"Unauthorized"' "$ADMIN_NOKEY"

# ─── 8. Admin (authorized) ──────────────────
echo ""
echo "8. Admin (with key)"
ADMIN_OK=$(curl -s -H "X-Admin-Key: $ADMIN_KEY" "$BASE_URL/admin/stats")
check "Returns stats" '"totalRequests"' "$ADMIN_OK"

# ─── 9. 404 ─────────────────────────────────
echo ""
echo "9. Unknown route"
NOT_FOUND=$(curl -s "$BASE_URL/v1/nonexistent")
check "Returns NOT_FOUND" '"NOT_FOUND"' "$NOT_FOUND"
check "Lists valid endpoints" '"endpoints"' "$NOT_FOUND"

# ─── 10. CORS ────────────────────────────────
echo ""
echo "10. CORS"
CORS=$(curl -s -I -X OPTIONS "$BASE_URL/v1/models" 2>&1)
check "Returns 204" "204" "$CORS"
CORS_LOWER=$(echo "$CORS" | tr '[:upper:]' '[:lower:]')
check "Has Access-Control headers" "access-control-allow" "$CORS_LOWER"

# ─── Summary ─────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$fail" -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}Note: Deposit + Chat E2E tests require:${NC}"
  echo "  - TOGETHER_API_KEY secret set"
  echo "  - TREASURY_ADDRESS secret set"
  echo "  - Funded Tempo testnet wallet"
  echo ""
  echo "Set secrets with:"
  echo "  npx wrangler secret put TOGETHER_API_KEY"
  echo "  npx wrangler secret put TREASURY_ADDRESS"
fi

exit $fail
