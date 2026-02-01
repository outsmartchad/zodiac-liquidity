"""
Check all Token-2022 NFT accounts to find Meteora positions.
For each NFT mint with balance=1, derive the Position PDA and check if it has liquidity.
"""
import subprocess, json, struct, base64, sys

OWNER = "5P9MWSyYFnJc9sxsBePXbgXUHuxjuE3T9wsUUYbmuP4R"
METEORA_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
RPC = "https://api.devnet.solana.com"

# NFT mints from the Token-2022 listing (balance=1 accounts)
nft_mints = [
    "13MRH4tZeDoCf6fRcU73mP9AtkTGyEo89khPcKMn3RvJ",
    "tCmV7zXMm4cncah6RDksFrkkWtycj4YBk5cX4qA7XLg",
    "37hLbmnape2fLxJeBz1mRTFGm21rbPEKMnJX1BXitmW2",
    "3rJjECpjW1FYWJAqZQ9hWpb8aRh6AQZDioYeUJq7XAtY",
    "5ExfH7wx9jJS9T67vNyNN1H4VKUgPFLBTzVrYeZCdYn4",
    "5Koa1w8dSedu35tnhXx37MijgKQoVLdr4dsRo4JoHKM3",
    "5RKDrh2x3BoGyS7qreJv2X45SNQVt8BsrvjyAD7naR7C",
    "5q7SUqxZzTpBJW8JTjNBHt4dg3X3pbLdPDv7X9RR74A2",
    "68Lt1pyN3GNwKrCppoZ7AtmDEFXdyNohiVZRht3CbmgF",
    "6iF4qQRj8aWtwXqQ7PF1Nb6yXZXf1aCbrGiaydcz9rcw",
    "7cHfgFTTZgRFfNaqru8Xq3xAYainUDAyUcR2cVkWd9TV",
    "7qbYUikwQSCctwtqnsUqWZbkwvSYr8T1N81D8ABB5u78",
    "8KstdcpCUZfe36H5cswqMFYcwTdtBsXKUdsvkTn91XSN",
    "8xHUe549QvfFnMcfapaU2ByENZeYk6xTaJp56BWpacDv",
    "8xeE8kCmqvYr9M14qK5HkmCtRqx5pVetQSgXaSxdzhzh",
    "8zpUYJE4vhwqQ4SHFWubKbwRpBsFd2Q1VX9yMadg14w1",
    "94T7ovGZpYJ1tWhBp1x5dA4YZNJby94Zfn2Pxep4yRG5",
    "9GR5AF7jGKEwcFeDM2dtfazTHYjmfqKEZH2zy9Z9hYEi",
    "Ap86SEkbNELaeae26xhJCiTqh5y8nmSqxW7vyEwN1kLk",
    "Aum2CSu4FVfsUoCtsmmNpdHpmmzvwX3dSe3eM5vQq7eo",
    "BCLqdpdS3HoWhi9VFMmDavGcbFXYbBfMvE6cD7YbNG4f",
    "BWEjH2QzooeUvwnGxFWiuyb6zc95ytGATzAdFcYC39Ww",
    "BcBhDkVjF2RrCwte2MVFq1zkUKiUbPdZ9WPVF4GhQbNs",
    "BrmTNoWCpzXKcHkYfsqEppwPmKM4oKzZidsZv7Cczc6c",
    "CszoHH4ZmaojyD388q23JLRubdMHrVoffcsJbHRLWMXt",
    "DPDaoacRLEuNBj4cYup5zWoVvmGEtLDr1qEPvAK8wG9b",
    "DRDN9EPWJgFyGo3BNsmkw2Qr4f5xZHDcUHABEdxDJKpF",
    "E4DUtVTS2ay22XWuFpVd8UaciyafJDTL6xL3ygiEWX4d",
    "EnbLKi1HMAkdr7iFFgaG76g5KbZ7D4PEd4mrXGpmzRzQ",
    "GMFAr2DiQwdsaH5zjNANJ9RSKx3pihBxHLQw8NyWsyzp",
    "J63Fyw25xirdgKi3drmHcfLpmHjwg5TBcEd3hin3GSpV",
]

print(f"Checking {len(nft_mints)} NFT mints for Meteora positions...\n")

has_liquidity = []
no_liquidity = []
no_position = []

for mint in nft_mints:
    # Derive position PDA: ["position", nft_mint_pubkey]
    result = subprocess.run(
        ["solana", "find-program-derived-address", METEORA_PROGRAM,
         "string:position", f"pubkey:{mint}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  {mint}: PDA derivation failed")
        no_position.append(mint)
        continue

    position_pda = result.stdout.strip().split()[0]

    # Fetch the position account
    result = subprocess.run(
        ["solana", "account", position_pda, "--url", RPC, "--output", "json"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  {mint}: No position account at {position_pda}")
        no_position.append(mint)
        continue

    acct_data = json.loads(result.stdout)
    data_b64 = acct_data['account']['data'][0]
    data = base64.b64decode(data_b64)

    # unlocked_liquidity is at offset 144 from struct start, +8 for discriminator = 152
    if len(data) >= 168:  # 152 + 16
        unlocked_liq = int.from_bytes(data[152:168], 'little')
        vested_liq = int.from_bytes(data[168:184], 'little')
        perm_locked = int.from_bytes(data[184:200], 'little')
        pool = base64.b64encode(data[8:40]).decode()  # pool pubkey

        if unlocked_liq > 0:
            print(f"  {mint}: LIQUIDITY={unlocked_liq} (position={position_pda})")
            has_liquidity.append((mint, position_pda, unlocked_liq))
        else:
            print(f"  {mint}: empty position (position={position_pda})")
            no_liquidity.append((mint, position_pda))
    else:
        print(f"  {mint}: account data too small ({len(data)} bytes)")
        no_position.append(mint)

print(f"\n=== SUMMARY ===")
print(f"Positions WITH liquidity: {len(has_liquidity)}")
for mint, pos, liq in has_liquidity:
    print(f"  mint={mint} pos={pos} liq={liq}")
print(f"Positions WITHOUT liquidity (closeable): {len(no_liquidity)}")
print(f"No position found (just NFT, burn+close): {len(no_position)}")
print(f"\nTotal Token-2022 accounts: {len(nft_mints)}")
print(f"Rent reclaimable from closing: ~{len(nft_mints) * 0.00204:.4f} SOL (token accounts)")
print(f"Plus position account rent if closed: ~{(len(has_liquidity)+len(no_liquidity)) * 0.00285:.4f} SOL")
