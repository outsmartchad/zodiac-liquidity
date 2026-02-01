#!/bin/bash
# Close all token accounts to reclaim SOL
# Step 1: Close zero-balance accounts (WSOL + non-WSOL)
# Step 2: Close WSOL with balance (unwraps SOL back)
# Step 3: Burn non-WSOL tokens, then close

OWNER="5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R"
RPC="https://api.devnet.solana.com"
CLOSED=0
FAILED=0

echo "=== Starting token account cleanup ==="
echo ""

# Get all accounts as JSON
ACCOUNTS_JSON=$(spl-token accounts --url devnet --owner $OWNER --output json 2>/dev/null)

# Process zero-balance accounts first (simplest)
echo "--- Phase 1: Closing zero-balance accounts ---"
ZERO_ADDRS=$(echo "$ACCOUNTS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data['accounts']:
    if float(a['tokenAmount']['uiAmountString']) == 0:
        print(a['address'])
")

ZERO_COUNT=$(echo "$ZERO_ADDRS" | grep -c .)
echo "Found $ZERO_COUNT zero-balance accounts"

echo "$ZERO_ADDRS" | while read addr; do
    [ -z "$addr" ] && continue
    spl-token close --url devnet "$addr" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  Closed: $addr"
    else
        echo "  FAILED: $addr"
    fi
    sleep 0.3
done

echo ""
echo "--- Phase 2: Closing WSOL accounts with balance (unwrap SOL) ---"
WSOL_ADDRS=$(echo "$ACCOUNTS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data['accounts']:
    if a['mint'] == 'So11111111111111111111111111111111111111112' and float(a['tokenAmount']['uiAmountString']) > 0:
        print(a['address'])
")

WSOL_COUNT=$(echo "$WSOL_ADDRS" | grep -c .)
echo "Found $WSOL_COUNT WSOL accounts with balance"

echo "$WSOL_ADDRS" | while read addr; do
    [ -z "$addr" ] && continue
    spl-token close --url devnet "$addr" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  Closed+unwrapped: $addr"
    else
        echo "  FAILED: $addr"
    fi
    sleep 0.3
done

echo ""
echo "--- Phase 3: Burn and close non-WSOL accounts with balance ---"
NONWSOL_DATA=$(echo "$ACCOUNTS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data['accounts']:
    if a['mint'] != 'So11111111111111111111111111111111111111112' and float(a['tokenAmount']['uiAmountString']) > 0:
        print(f\"{a['address']} {a['mint']} {a['tokenAmount']['amount']}\")
")

NONWSOL_COUNT=$(echo "$NONWSOL_DATA" | grep -c .)
echo "Found $NONWSOL_COUNT non-WSOL accounts to burn+close"

echo "$NONWSOL_DATA" | while read line; do
    [ -z "$line" ] && continue
    ADDR=$(echo "$line" | awk '{print $1}')
    MINT=$(echo "$line" | awk '{print $2}')
    AMT=$(echo "$line" | awk '{print $3}')

    # Burn tokens first
    spl-token burn --url devnet "$ADDR" "$AMT" 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "  BURN FAILED: $ADDR (trying close anyway)"
    fi
    sleep 0.2

    # Then close
    spl-token close --url devnet "$ADDR" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  Burned+closed: $ADDR ($MINT)"
    else
        echo "  CLOSE FAILED: $ADDR"
    fi
    sleep 0.3
done

echo ""
echo "=== Cleanup complete ==="
solana balance --url devnet
