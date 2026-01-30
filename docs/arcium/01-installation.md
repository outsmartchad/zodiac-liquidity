# Arcium Installation Guide

## Quick Start (Recommended)

The fastest way to set up Arcium on Mac or Linux is with a single command:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash
```

This script handles dependency checking, installs build tools, and deploys `arcup`, the Arcium CLI, and Arx Node.

## Required Dependencies

Before installation, ensure you have:

- **Rust** (via https://www.rust-lang.org/tools/install)
- **Solana CLI 2.3.0** (https://docs.solana.com/cli/install-solana-cli-tools, then run `solana-keygen new`)
- **Yarn** (https://yarnpkg.com/getting-started/install)
- **Anchor 0.32.1** (https://www.anchor-lang.com/docs/installation)
- **Docker & Docker Compose** (https://docs.docker.com/engine/install/ and https://docs.docker.com/compose/install/)

## Manual Installation

For supported platforms (aarch64_linux, x86_64_linux, aarch64_macos, x86_64_macos), manually install `arcup`:

**Choose your target:**
- Arch Linux: `TARGET=aarch64_linux && curl "https://bin.arcium.com/download/arcup_${TARGET}_0.6.3" -o ~/.cargo/bin/arcup && chmod +x ~/.cargo/bin/arcup`
- x86 Linux: `TARGET=x86_64_linux && curl "https://bin.arcium.com/download/arcup_${TARGET}_0.6.3" -o ~/.cargo/bin/arcup && chmod +x ~/.cargo/bin/arcup`
- Apple Silicon: `TARGET=aarch64_macos && curl "https://bin.arcium.com/download/arcup_${TARGET}_0.6.3" -o ~/.cargo/bin/arcup && chmod +x ~/.cargo/bin/arcup`
- Intel Mac: `TARGET=x86_64_macos && curl "https://bin.arcium.com/download/arcup_${TARGET}_0.6.3" -o ~/.cargo/bin/arcup && chmod +x ~/.cargo/bin/arcup`

Then install and verify:
```bash
arcup install
arcium --version
```

## Troubleshooting

**Windows:** Not currently supported; use WSL2 with Ubuntu instead.

**Linux Dependencies:** On Ubuntu/Debian, run:
```bash
sudo apt-get update && sudo apt-get upgrade && sudo apt-get install -y pkg-config build-essential libudev-dev libssl-dev
```

**PATH Issues:** Verify with `which arcium`. If missing, add to your shell config:
- Bash/Zsh: `export PATH="$HOME/.cargo/bin:$PATH"` in `~/.bashrc` or `~/.zshrc`
- Fish: `set -gx PATH $HOME/.cargo/bin $PATH` in `~/.config/fish/config.fish`

Restart your terminal afterward.

## Default Versions (v0.6.3)

- Arcium: 0.6.3
- Anchor: 0.32.1
- Node.js: 20.18.0
- Solana CLI: 2.3.0
