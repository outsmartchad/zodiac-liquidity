# Arcium Examples Overview

## Learning Path

Start with Coinflip and progress through the tiers in order.

## Getting Started

### Coinflip - Trustless Randomness
**Pattern:** Stateless MPC computation

Generate verifiably random outcomes using distributed entropy. No single party can predict or bias the result.

```rust
pub fn flip(input_ctxt: Enc<Shared, UserChoice>) -> bool {
    let input = input_ctxt.to_arcis();
    let toss = ArcisRNG::bool();  // MPC-generated randomness
    (input.choice == toss).reveal()
}
```

**Use cases:** Lotteries, random drops, fair matchmaking

### Rock Paper Scissors - Encrypted Asynchronous Gameplay
**Pattern:** Hidden moves with delayed revelation

Two modes:
- Player vs Player: Two encrypted submissions
- Player vs House: Provably fair randomized opponent

## Intermediate

### Voting - Private Ballots, Public Results
**Pattern:** Encrypted state accumulation

```rust
pub fn vote(
    input: Enc<Shared, UserVote>,
    votes: Enc<Mxe, VoteStats>,
) -> Enc<Mxe, VoteStats> {
    let input = input.to_arcis();
    let mut votes = votes.to_arcis();
    if input.vote {
        votes.yes_count += 1;
    } else {
        votes.no_count += 1;
    }
    votes.owner.from_arcis(votes)
}
```

**Key pattern:** Reading encrypted account data with byte offsets:
```rust
Argument::Account(
    ctx.accounts.poll_acc.key(),
    8 + 1,  // Skip discriminator + bump
    64,     // Read 2 ciphertexts
)
```

### Medical Records - Privacy-Preserving Data Sharing
**Pattern:** Re-encryption for selective disclosure

```rust
pub fn share_patient_data(
    receiver: Shared,
    input_ctxt: Enc<Shared, PatientData>,
) -> Enc<Shared, PatientData> {
    let input = input_ctxt.to_arcis();
    receiver.from_arcis(input)  // Re-encrypt for doctor
}
```

### Sealed-Bid Auction - Private Bids, Fair Outcomes
**Pattern:** Encrypted comparison and state tracking

Supports first-price and Vickrey (second-price) auction mechanisms.

```rust
pub fn place_bid(
    bid_ctxt: Enc<Shared, Bid>,
    state_ctxt: Enc<Mxe, AuctionState>,
) -> Enc<Mxe, AuctionState> {
    let bid = bid_ctxt.to_arcis();
    let mut state = state_ctxt.to_arcis();
    if bid.amount > state.highest_bid {
        state.second_highest_bid = state.highest_bid;
        state.highest_bid = bid.amount;
        // ... update bidder info
    }
    state_ctxt.owner.from_arcis(state)
}
```

## Advanced

### Blackjack - Hidden Game State with Compression
**Pattern:** Base-64 bit-packing for efficiency

52 cards compressed from 1,664 bytes to 96 bytes (94% reduction).

```rust
// Encoding: 21 cards per u128 using 6 bits each
let mut card_one: u128 = 0;
for i in 0..21 {
    card_one += POWS_OF_SIXTY_FOUR[i] * cards[i] as u128;
}
```

**Storage structure:**
```rust
pub struct BlackjackGame {
    pub deck: [[u8; 32]; 3],      // 3 encrypted u128s
    pub player_hand: [u8; 32],    // 1 encrypted u128
    pub dealer_hand: [u8; 32],    // 1 encrypted u128
    // ... nonces and metadata
}
```

### Ed25519 Signatures - Distributed Key Management
**Pattern:** MPC signing with `MXESigningKey`

```rust
pub fn sign_message(message: [u8; 5]) -> ArcisEd25519Signature {
    let signature = MXESigningKey::sign(&message);
    signature.reveal()
}
```

Private key never exists in a single location — split across MPC nodes.

## Pattern Summary

| Example | Core Pattern | Key Technique |
|---------|--------------|---------------|
| Coinflip | Stateless | `ArcisRNG::bool()` |
| Voting | State accumulation | `Enc<Mxe, T>` storage |
| Medical Records | Re-encryption | `receiver.from_arcis()` |
| Sealed Auction | Encrypted comparison | Conditional state update |
| Blackjack | Bit-packing | Base-64 compression |
| Ed25519 | Distributed signing | `MXESigningKey::sign()` |
