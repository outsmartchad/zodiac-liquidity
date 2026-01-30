FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies + Docker CLI + Compose (for arcium test MPC cluster)
RUN rm -rf /var/lib/apt/lists/* \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        build-essential \
        libssl-dev \
        pkg-config \
        libudev-dev \
        git \
        ca-certificates \
        unzip \
        gnupg \
        docker.io \
        docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (required for Arcium)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g yarn \
    && rm -rf /var/lib/apt/lists/*

# Install Rust 1.89.0 (matches rust-toolchain.toml)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . "$HOME/.cargo/env" \
    && rustup default 1.89.0 \
    && rustup component add rustfmt clippy

# Install Solana CLI 2.3.0 (required by Arcium 0.6.3)
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)" \
    && . "$HOME/.bashrc"

# Set PATH - cargo/bin before solana/bin to use rustup's cargo
ENV PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:${PATH}"

# Generate Solana keypair if it doesn't exist
RUN solana-keygen new --no-bip39-passphrase --silent || true

# Install Anchor 0.32.1 via AVM
RUN cargo install --git https://github.com/coral-xyz/anchor avm --force \
    && avm install 0.32.1 \
    && avm use 0.32.1

# Install Arcium CLI binaries directly (x86_64_linux)
# arcup requires Docker during install, so we download binaries directly
RUN curl "https://bin.arcium.com/download/arcium_x86_64_linux_0.6.3" -o /root/.cargo/bin/arcium \
    && chmod +x /root/.cargo/bin/arcium \
    && curl "https://bin.arcium.com/download/arcup_x86_64_linux_0.6.3" -o /root/.cargo/bin/arcup \
    && chmod +x /root/.cargo/bin/arcup

# Clear Cargo registry cache to avoid version conflicts
RUN rm -rf /root/.cargo/registry/cache \
    && rm -rf /root/.cargo/registry/src \
    && rm -rf /root/.cargo/registry/index

# Verify all installations
RUN echo "=== Verifying installations ===" \
    && rustc --version \
    && cargo --version \
    && solana --version \
    && anchor --version \
    && arcium --version \
    && node --version \
    && yarn --version

# Set working directory
WORKDIR /app

SHELL ["/bin/bash", "-c"]
