# Setup Checklist

## Completed

- [x] Project structure created
- [x] Dependencies configured (Anchor 0.32.1, Arcium 0.6.3)
- [x] Arcium documentation fetched to `/docs/arcium/`
- [x] Arcis circuits implemented in `encrypted-ixs/src/lib.rs`
- [x] CLAUDE.md project context
- [x] Anchor program with Arcium integration
- [x] Three-instruction pattern for each circuit (7 circuits)
- [x] Meteora DAMM v2 CPI integration
- [x] Token transfer in deposit instruction
- [x] TypeScript tests with encryption flow (basic coverage)
- [x] Docker build environment with proper ulimits
- [x] Build passes (`arcium build`)

## In Progress

- [ ] Localnet testing - Solana validator works, MPC nodes have Docker path issues

## TODO

- [ ] Test full deposit → deploy → withdraw cycle (use devnet)
- [ ] Add token distribution after withdrawal
- [ ] Multiple user test scenarios
- [ ] Devnet deployment and testing

## Known Issues

1. **Localnet MPC nodes**: Docker-in-Docker path issues. MPC containers can't properly mount config files. Workaround: Test on devnet instead (`arcium test --cluster devnet`)

2. **Stack overflow warning**: `arcium_client` dependency has stack overflow warning (external, not our code)

## Commands

```bash
# Start dev container (with proper ulimits for Solana)
docker run -d \
    --name zodiac-dev \
    --ulimit nofile=1048576:1048576 \
    --ulimit nproc=65535:65535 \
    -v "$(pwd)":/app \
    -v "$HOME/.config/solana":/root/.config/solana \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8899:8899 \
    -p 8900:8900 \
    zodiac-liquidity-dev \
    sleep infinity

# Build (inside container)
docker exec zodiac-dev arcium build

# Test on devnet (recommended)
docker exec zodiac-dev arcium test --cluster devnet

# Deploy
docker exec zodiac-dev arcium deploy --cluster-offset 456 --recovery-set-size 4
```

## Reference

- **Arcium Skill**: `/arcium-dev` or `/root/.claude/skills/arcium-dev/`
- **Meteora DAMM v2 CPI**: `/root/anchor-learning/meteora-damm-v2-cpi`
- **Arcium Voting Example**: `/root/examples/voting/`
