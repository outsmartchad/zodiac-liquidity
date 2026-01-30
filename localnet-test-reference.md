# Zodiac Liquidity - Localnet Test Reference

## Test Run Date
$(date)

## Test Results Summary
**11 passing tests (9s)**

## Test Output
Syncing program keys... (use --skip-keys-sync to skip)
Clean completed successfully!
Syncing program ids for the configured cluster (localnet)

All program id declarations are synced.
Checking if encrypted instructions are up to date.
Encrypted instructions are up to date. Skipping build.
Error: Function _ZN109_$LT$arcium_client..idl..arcium..utils..Account$u20$as$u20$core..convert..TryFrom$LT$$RF$$u5b$u8$u5d$$GT$$GT$8try_from17ha037aaf1519dcf38E Stack offset of 721512 exceeded max offset of 4096 by 717416 bytes, please minimize large stack variables. Estimated function frame size: 721536 bytes. Exceeding the maximum stack offset may cause undefined behavior during execution.

   Compiling zodiac_liquidity v0.1.0 (/app/programs/zodiac_liquidity)
warning: constant `COMP_DEF_OFFSET_CLEAR_POSITION` is never used
  --> programs/zodiac_liquidity/src/lib.rs:39:7
   |
39 | const COMP_DEF_OFFSET_CLEAR_POSITION: u32 = comp_def_offset("clear_position");
   |       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   |
   = note: `#[warn(dead_code)]` on by default

warning: `zodiac_liquidity` (lib) generated 1 warning
    Finished `release` profile [optimized] target(s) in 21.60s
   Compiling zodiac_liquidity v0.1.0 (/app/programs/zodiac_liquidity)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 9.32s
     Running unittests src/lib.rs (/app/target/debug/deps/zodiac_liquidity-dfd1186b3ff6587a)
Clean completed successfully!
Generating accounts with owner pubkey: 5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R
Lighthouse program already exists at artifacts/lighthouse.so
Creating genesis accounts...
Added lighthouse program to genesis accounts
Starting anchor localnet...
Waiting for solana localnet to come online at http://127.0.0.1:8899...
Solana localnet is online ✔️
Starting Arcium node(s)...
Waiting for the arcium nodes to come online...
Primary cluster nodes are online ✔️
Solana localnet & Arx nodes are online! 🎉
Starting anchor test...

Found a 'test' script in the Anchor.toml. Running it as a test suite!

Running test suite: "/app/Anchor.toml"

yarn run v1.22.22
$ /app/node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'


  zodiac-liquidity
============================================================
Zodiac Liquidity Tests - Setup
============================================================
Program ID: FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL
Owner: 5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R
MXE x25519 pubkey: 8b4d25371b49626dadaa85fa95c257588b35ba639bfcfdab5d49bc704fb5610d
Encryption cipher initialized
Creating test token mint...
Token mint: JABGXYtEbpPATnSrxTgHwvd8yymc8Y34tPkSdB4anwNh
Vault PDA: 47bCJVQqPybGdAksgcVr3oEUHj9QWgCf5XxFSPUDA6zZ
User Position PDA: 2VMqB5HSyuBVdQJcykidxo287nSLnojK8MkAdJ1fih3E
    Computation Definition Initialization
init_vault comp def PDA: EJX8W6xXyJVW3Cgs2C3mZabYaLqKkfW1FVMZeJvjyezp
Initializing init_vault comp def (offchain circuit)...
init_vault init tx: 3WZSnxdy5fSSj5f5m9WBvB98rpLW6TzFrDaKCjyUrgN19pgx1fKwceCYTjDd2XhHtKbzLtYrfWvhz9m8zA6XyvTq
Init vault comp def tx: 3WZSnxdy5fSSj5f5m9WBvB98rpLW6TzFrDaKCjyUrgN19pgx1fKwceCYTjDd2XhHtKbzLtYrfWvhz9m8zA6XyvTq
      ✔ initializes init_vault computation definition (403ms)
init_user_position comp def PDA: AtDdpxywFm79JA9eQ91ZqKamqVuz1n6xDJFJyNEEfKme
Initializing init_user_position comp def (offchain circuit)...
init_user_position init tx: 5VxfLzBvoFiA4c6xhz9wxHECVYiY1UCzMncXRy2tzqR6aThq7w5K9wxa2cKNDZkk7Z6VvASD5ZnQVNzwLxzMniU6
Init user position comp def tx: 5VxfLzBvoFiA4c6xhz9wxHECVYiY1UCzMncXRy2tzqR6aThq7w5K9wxa2cKNDZkk7Z6VvASD5ZnQVNzwLxzMniU6
      ✔ initializes init_user_position computation definition (405ms)
deposit comp def PDA: 8SHqgCFcFEP8nuHtFsvMieS98sNRNr3qPUDpJLXjL4Xu
Initializing deposit comp def (offchain circuit)...
deposit init tx: 5xNdLdeq4DCBz2TnHb4S6Tq86y61UgxuG2svVWnEPvCgcoUYNWvFzH3UPuG65e7wUVahCMtm22qkhJUBtpyamgFr
Init deposit comp def tx: 5xNdLdeq4DCBz2TnHb4S6Tq86y61UgxuG2svVWnEPvCgcoUYNWvFzH3UPuG65e7wUVahCMtm22qkhJUBtpyamgFr
      ✔ initializes deposit computation definition (405ms)
reveal_pending_deposits comp def PDA: FBv7CfhRZNc88Apht6Wbk13wkCd6oHy6pptjq89bsGuM
Initializing reveal_pending_deposits comp def (offchain circuit)...
reveal_pending_deposits init tx: 2VKRpuNYtJRyUVorQ1HdUJtdvcbsBQYKrcqpLXuVPetuszzyyjja8vQq83bqTuodFfoZMykAMoSjkvjun7BapnYD
Init reveal pending comp def tx: 2VKRpuNYtJRyUVorQ1HdUJtdvcbsBQYKrcqpLXuVPetuszzyyjja8vQq83bqTuodFfoZMykAMoSjkvjun7BapnYD
      ✔ initializes reveal_pending_deposits computation definition (406ms)
record_lp_tokens comp def PDA: ENBEG9vzNebBoFsP5gcDP8r8v34dAkPwgL5eRHjFZseJ
Initializing record_lp_tokens comp def (offchain circuit)...
record_lp_tokens init tx: 3wdPkPKk986hF3CutiAdLHHSsU5S1HhwTX8kBRmBkvHKvmXVSUGh1iNg13R9GNMGXkVbZCADVCdiw4bD77iLbdQT
Init record LP comp def tx: 3wdPkPKk986hF3CutiAdLHHSsU5S1HhwTX8kBRmBkvHKvmXVSUGh1iNg13R9GNMGXkVbZCADVCdiw4bD77iLbdQT
      ✔ initializes record_lp_tokens computation definition (406ms)
compute_withdrawal comp def PDA: 7BPHyvom64mXLLGFb8vC3Cn6YvjkwYB2n6oUpP21HdZk
Initializing compute_withdrawal comp def (offchain circuit)...
compute_withdrawal init tx: 3LeECVP87WsL2C8NqVtd42N5oqgMznxY79TcFdFoYbi6YKc8zmXFcMr8UNpdPQgEAHC96ygWVK1e6xvN752nq3kC
Init withdraw comp def tx: 3LeECVP87WsL2C8NqVtd42N5oqgMznxY79TcFdFoYbi6YKc8zmXFcMr8UNpdPQgEAHC96ygWVK1e6xvN752nq3kC
      ✔ initializes compute_withdrawal computation definition (406ms)
get_user_position comp def PDA: 2ZPcL5aKHW7eRjmNjvbNLRNtMpCkGcgLfg5Gpz4YfTBk
Initializing get_user_position comp def (offchain circuit)...
get_user_position init tx: 4tKeDKYNPpgaEYGVWcKMJAXcKSTKhMGAZ3qwS3Lb13UgSpXc8jjrqxKA6tWtZBoPYGVNx3KjTr6pgcycXxcNR1BK
Init get position comp def tx: 4tKeDKYNPpgaEYGVWcKMJAXcKSTKhMGAZ3qwS3Lb13UgSpXc8jjrqxKA6tWtZBoPYGVNx3KjTr6pgcycXxcNR1BK
      ✔ initializes get_user_position computation definition (406ms)
    Vault Creation
Create vault tx: 2MmJexvVsQbotoL996nsQUZqaZS76yokUFTy1gKTSsDgi3LpsYWikeeYworYH5KfUruxSV9kmsfEq8L5dnXjXJwY
Vault finalize tx: 5JY3mXf6b7R4rrwCnHkLuhsaCUuULreTgpdGj11C7sEcTpiM6jXFYqbjzJWpNNUQNK7Np9c2Ssgxg3XPBzEciXNW
Vault created: 47bCJVQqPybGdAksgcVr3oEUHj9QWgCf5XxFSPUDA6zZ
      ✔ creates a new vault (901ms)
    User Position Creation
Create user position tx: 412piX8fDzTrrwFB3viuPswcvoe8TbW5nN8H7DYTHYgcgeEQjBmmdtdkH6rVgnxBzYZu9q63s4A6Tct7e1MTRxgJ
User position finalize tx: 2s3ZtDEfrkKUNQrwqv5nD2sx2Y5oK5mWA4ZcvnSSUakq47f1ikgVGpTbpuQmaUvVGwgE8GXxzHR2oXcsqVpyfK8Q
      ✔ creates a user position (835ms)
    Deposit Flow
Deposit tx: 2F5dfk1Lb8DQMYkeQhVf4knSEhp5uFie8UV45i6cMD9KWd99yHLY4aMMnucV6vzioYmCfsgeCjEdYtEj5Y7qFceB
Deposit finalize tx: zL5sFqwRLS6MZUutKxkzVc4LgmXSkjHH2EsrJzutrMbCiEv7YLpnntaT4WQZXEKDW2CiWduJqF76yMJeLCzun4u
Deposit event - vault: 47bCJVQqPybGdAksgcVr3oEUHj9QWgCf5XxFSPUDA6zZ user: 5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R
      ✔ deposits tokens with encrypted amount (2945ms)
    Reveal Pending Deposits
Reveal pending deposits tx: yKX9bytMnKebPXZx5vbX5nBEmgwfqCunwuN4YcuuxeA945tbuMP5cZBUXfKTnYWtthvzU7kCv2VuYgaJvBAwFJr
Reveal finalize tx: 63YWUZnW4AZAB9fSiMd6SqBRbJ4HLqpXwVLn7dJnXCmk6TnCCZ81ipKiieeKXs1ZiHMATpPAgohkcniXXKCSRePd
Revealed pending deposits: 1000000000
      ✔ reveals aggregate pending deposits (818ms)


  11 passing (9s)

Done in 11.59s.
 Container artifacts-arx-node-1-1  Stopping
 Container artifacts-arx-node-0-1  Stopping
 Container artifacts-arcium-trusted-dealer-1  Stopping
 Container artifacts-arx-node-1-1  Stopped
 Container artifacts-arcium-trusted-dealer-1  Stopped
 Container artifacts-arx-node-0-1  Stopped
Cleanup completed.


## Key Information

### Program ID
FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL

### Owner
5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R

### MXE x25519 Public Key
8b4d25371b49626dadaa85fa95c257588b35ba639bfcfdab5d49bc704fb5610d

### Computation Definition PDAs
| Circuit | PDA |
|---------|-----|
| init_vault | EJX8W6xXyJVW3Cgs2C3mZabYaLqKkfW1FVMZeJvjyezp |
| init_user_position | AtDdpxywFm79JA9eQ91ZqKamqVuz1n6xDJFJyNEEfKme |
| deposit | 8SHqgCFcFEP8nuHtFsvMieS98sNRNr3qPUDpJLXjL4Xu |
| reveal_pending_deposits | FBv7CfhRZNc88Apht6Wbk13wkCd6oHy6pptjq89bsGuM |
| record_lp_tokens | ENBEG9vzNebBoFsP5gcDP8r8v34dAkPwgL5eRHjFZseJ |
| compute_withdrawal | 7BPHyvom64mXLLGFb8vC3Cn6YvjkwYB2n6oUpP21HdZk |
| get_user_position | 2ZPcL5aKHW7eRjmNjvbNLRNtMpCkGcgLfg5Gpz4YfTBk |

### Circuit URLs (Localnet - Local HTTP Server)
| Circuit | URL |
|---------|-----|
| init_vault | http://172.20.0.2:8080/init_vault.arcis |
| init_user_position | http://172.20.0.2:8080/init_user_position.arcis |
| deposit | http://172.20.0.2:8080/deposit.arcis |
| reveal_pending_deposits | http://172.20.0.2:8080/reveal_pending_deposits.arcis |
| record_lp_tokens | http://172.20.0.2:8080/record_lp_tokens.arcis |
| compute_withdrawal | http://172.20.0.2:8080/compute_withdrawal.arcis |
| get_user_position | http://172.20.0.2:8080/get_user_position.arcis |

### Circuit URLs (Devnet - Catbox)
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

## Test Flow

### 1. Computation Definition Initialization
All 7 comp defs initialized successfully with offchain circuit URLs.

### 2. Vault Creation
- Create vault tx: 2MmJexvVsQbotoL996nsQUZqaZS76yokUFTy1gKTSsDgi3LpsYWikeeYworYH5KfUruxSV9kmsfEq8L5dnXjXJwY
- MPC callback finalize tx: 5JY3mXf6b7R4rrwCnHkLuhsaCUuULreTgpdGj11C7sEcTpiM6jXFYqbjzJWpNNUQNK7Np9c2Ssgxg3XPBzEciXNW
- Vault PDA: 47bCJVQqPybGdAksgcVr3oEUHj9QWgCf5XxFSPUDA6zZ

### 3. User Position Creation
- Create tx: 412piX8fDzTrrwFB3viuPswcvoe8TbW5nN8H7DYTHYgcgeEQjBmmdtdkH6rVgnxBzYZu9q63s4A6Tct7e1MTRxgJ
- MPC callback tx: 2s3ZtDEfrkKUNQrwqv5nD2sx2Y5oK5mWA4ZcvnSSUakq47f1ikgVGpTbpuQmaUvVGwgE8GXxzHR2oXcsqVpyfK8Q
- User Position PDA: 2VMqB5HSyuBVdQJcykidxo287nSLnojK8MkAdJ1fih3E

### 4. Deposit (Encrypted Amount)
- Deposit tx: 2F5dfk1Lb8DQMYkeQhVf4knSEhp5uFie8UV45i6cMD9KWd99yHLY4aMMnucV6vzioYmCfsgeCjEdYtEj5Y7qFceB
- MPC callback tx: zL5sFqwRLS6MZUutKxkzVc4LgmXSkjHH2EsrJzutrMbCiEv7YLpnntaT4WQZXEKDW2CiWduJqF76yMJeLCzun4u
- Deposit event emitted with vault and user info

### 5. Reveal Pending Deposits
- Reveal tx: yKX9bytMnKebPXZx5vbX5nBEmgwfqCunwuN4YcuuxeA945tbuMP5cZBUXfKTnYWtthvzU7kCv2VuYgaJvBAwFJr
- MPC callback tx: 63YWUZnW4AZAB9fSiMd6SqBRbJ4HLqpXwVLn7dJnXCmk6TnCCZ81ipKiieeKXs1ZiHMATpPAgohkcniXXKCSRePd
- **Revealed amount: 1,000,000,000 (1 SOL equivalent)**

## Architecture Notes

### Three-Instruction Pattern
1. `init_*_comp_def` - One-time setup, stores circuit URL + hash
2. `queue_computation` - Queue MPC computation with encrypted args
3. `*_callback` - ARX nodes call this with verified MPC results

### MPC Callback Flow
1. User calls instruction (e.g., create_vault)
2. Program queues computation via Arcium
3. ARX nodes fetch circuit from URL
4. ARX nodes execute MPC computation
5. ARX nodes call callback with signed results
6. Program verifies signature and updates state

### Offchain Circuit Storage
- Circuits stored at URLs (catbox.moe or local HTTP server)
- ARX nodes fetch and verify hash matches
- Eliminates on-chain circuit upload (saves tx space, avoids rate limits)

## Localnet Setup

### Docker Containers
- zodiac-dev: Main dev container with Arcium CLI
- artifacts-arx-node-0-1: ARX node 0
- artifacts-arx-node-1-1: ARX node 1
- artifacts-arcium-trusted-dealer-1: Trusted dealer for key generation

### HTTP Server for Circuits
```bash
docker exec -d zodiac-dev bash -c "cd /app/build && python3 -m http.server 8080 --bind 0.0.0.0"
```

### Run Test
```bash
docker exec zodiac-dev bash -c "cd /app && arcium test"
```

