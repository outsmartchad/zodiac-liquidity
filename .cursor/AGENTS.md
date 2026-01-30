# Cursor Agent Instructions

This project uses specialized agents for different domains.

## Available Agents

### @.cursor/rules/zodiac-liquidity-agent.mdc
**Privacy DeFi Architect** - Specialized agent for building Zodiac Liquidity with:
- Arcium Cerberus MPC integration
- Meteora DAMM v2 CPI
- Protocol-managed deployment (PDA → Meteora)
- Privacy-first architecture

**Activation**:
- **Automatic**: Agent auto-applies when editing `.rs`, `.ts`, `.tsx` files
- **Manual**: Reference in chat

## Quick Start

1. **For building**: The agent auto-applies in this project
2. **For Arcium context**: Use `/arcium-dev` skill
3. **For setup**: See `SETUP.md`

## Project Focus

- **Pool Type**: Meteora DAMM v2 only
- **Privacy Layer**: Arcium Cerberus MPC
- **Deployment**: Protocol PDA signs Meteora CPI (breaks user → LP linkability)
