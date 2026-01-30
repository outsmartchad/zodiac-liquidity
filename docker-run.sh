#!/bin/bash
# Build and run Zodiac Liquidity development container

set -e

IMAGE_NAME="zodiac-liquidity-dev"
CONTAINER_NAME="zodiac-dev"

# Build the Docker image
echo "Building Docker image..."
docker build -t $IMAGE_NAME .

# Stop and remove existing container if it exists
if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Removing existing container..."
    docker rm -f $CONTAINER_NAME
fi

# Run the container with the project mounted
# Docker socket mounted for arcium test (runs MPC cluster in Docker)
echo "Starting container..."
docker run -it \
    --name $CONTAINER_NAME \
    -v "$(pwd)":/app \
    -v "$HOME/.config/solana":/root/.config/solana \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8899:8899 \
    -p 8900:8900 \
    $IMAGE_NAME \
    bash

echo "Container stopped."
