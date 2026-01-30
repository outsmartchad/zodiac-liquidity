# Devnet Testing Results - 2026-01-28

## Summary
**Localnet: PASSING (11/11 tests)**
**Devnet: FAILING (Error 6000 - AbortedComputation)**

## Test Configuration
- Arcium CLI: 0.6.3
- Anchor: 0.32.1
- Program ID: FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL
- MXE Account (cluster 456): DQCLck1zXPxeuanTaJ9dxYUCW2daAzh5GJLpvmhY5FWv

## Circuit Verification
All circuits verified matching between local build and catbox.moe:
- SHA256: 222f0e6c534949c62e38095b76fe9cb9d5cca1b85e337e15cb9b042125b59675 (init_vault)
- Catbox URLs accessible: YES
- Hash stored in comp def matches local: YES

## Cluster 456 (v0.6.3) Results
| Test | Status | Error |
|------|--------|-------|
| 7 comp defs | ✅ Skipped (exist) | - |
| Vault creation | ❌ FAILED | Error 6000 (AbortedComputation) |
| User position | ❌ FAILED | Error 6000 (AbortedComputation) |
| Deposit | ❌ FAILED | Error 6000 (AbortedComputation) |
| Reveal | ❌ FAILED | Error 6000 (AbortedComputation) |

**Failed callback transactions:**
- tx1: 5jknesSopzFAd7zRKfuaj1WZhAqZ76vwTwAVtNWDve7BiXLvdaa9jDESKyukJkhsKyxT4TpFtZDDsK7sbA2BL7Wc
- tx2: 381UREuDHqiZa3ZUqWU1jS4Tz3dSUdZZU2eGq6683vwFiyMtViKXRVSZAz53369NeWeXpmA5bTXiac2nWQaLLNTd

## Cluster 123 (v0.5.4) Results
| Test | Status | Error |
|------|--------|-------|
| 7 comp defs | ✅ Skipped (exist) | - |
| Vault creation | ❌ FAILED | ConstraintAddress (2012) - mempool mismatch |

**Root cause:** Program deployed with cluster 456, PDAs don't match cluster 123.

## Possible Root Causes for Cluster 456 Failure
1. **Devnet ARX cluster issue** - Nodes might be down or misconfigured
2. **Circuit version incompatibility** - Format may have changed
3. **MXE key rotation** - x25519 key might have been rotated on cluster
4. **Stale comp defs** - May need fresh initialization

## Recommended Next Steps
1. Check Arcium Discord for devnet cluster 456 status
2. Try fresh deploy with new program keypair
3. Contact Arcium team if cluster is down
4. Wait and retry if temporary issue

## Circuit URLs (catbox.moe)
| Circuit | URL |
|---------|-----|
| init_vault | https://files.catbox.moe/aetojl.arcis |
| init_user_position | https://files.catbox.moe/efmtvn.arcis |
| deposit | https://files.catbox.moe/he0gzr.arcis |
| reveal_pending_deposits | https://files.catbox.moe/mwvb0h.arcis |
| record_lp_tokens | https://files.catbox.moe/fai7iv.arcis |
| compute_withdrawal | https://files.catbox.moe/c4xzqw.arcis |
| get_user_position | https://files.catbox.moe/igu1f1.arcis |
| clear_position | https://files.catbox.moe/9a5gu4.arcis |

## Localnet Working Configuration
For localnet testing, use local HTTP server:
```bash
docker exec -d zodiac-dev bash -c "cd /app/build && python3 -m http.server 8080 --bind 0.0.0.0"
```
Circuit URLs: http://172.20.0.2:8080/{circuit_name}.arcis
