import json, sys

data = json.load(sys.stdin)
accounts = data['accounts']
print(f'Total token accounts: {len(accounts)}')

wsol_mint = 'So11111111111111111111111111111111111111112'
wsol = [a for a in accounts if a['mint'] == wsol_mint]
non_wsol = [a for a in accounts if a['mint'] != wsol_mint]

wsol_zero = [a for a in wsol if float(a['tokenAmount']['uiAmountString']) == 0]
wsol_with_bal = [a for a in wsol if float(a['tokenAmount']['uiAmountString']) > 0]
non_wsol_zero = [a for a in non_wsol if float(a['tokenAmount']['uiAmountString']) == 0]
non_wsol_with_bal = [a for a in non_wsol if float(a['tokenAmount']['uiAmountString']) > 0]

wsol_total = sum(float(a['tokenAmount']['uiAmountString']) for a in wsol_with_bal)

print(f'\nWSOL accounts: {len(wsol)} ({len(wsol_zero)} zero, {len(wsol_with_bal)} with balance)')
print(f'WSOL total balance: {wsol_total:.6f} SOL')
print(f'\nNon-WSOL accounts: {len(non_wsol)} ({len(non_wsol_zero)} zero, {len(non_wsol_with_bal)} with balance)')

total = len(accounts)
rent = total * 0.00203928
print(f'\nRent reclaimable: {total} accounts x ~0.00204 = ~{rent:.4f} SOL')
print(f'Plus WSOL unwrap: ~{wsol_total:.4f} SOL')
print(f'GRAND TOTAL: ~{rent + wsol_total:.4f} SOL')

# Output addresses for closing
print('\n--- WSOL zero balance (close directly) ---')
for a in wsol_zero:
    print(a['address'])

print('\n--- WSOL with balance (close+unwrap) ---')
for a in wsol_with_bal:
    print(f"{a['address']} {a['tokenAmount']['uiAmountString']}")

print('\n--- Non-WSOL zero balance (close directly) ---')
for a in non_wsol_zero:
    print(a['address'])

print('\n--- Non-WSOL with balance (burn+close) ---')
for a in non_wsol_with_bal:
    print(f"{a['address']} {a['mint']} {a['tokenAmount']['uiAmountString']}")
