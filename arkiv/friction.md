# friction

what got in our way building Strike on Arkiv, and what would have helped. everything here was hit for real during the event, on the Rabdi testnet

## what we'd improve first

1. **a Rust SDK, or a documented `execute` encoding.** our backend is Rust, and there's only a TypeScript SDK. we read the SDK's source to rebuild the calldata by hand: the op tuple, the attribute type codes, the indexed bit, the read only flag. one page with the exact ABI would have saved us most of a day. so we built it: [arkiv-rs-sdk](https://github.com/TryStrike/arkiv-rs-sdk), MIT, tested byte for byte against the official TypeScript SDK
2. **paging that works on the public node.** see the repro below. today a query that returns more than one page can't be read to the end
3. **the write limits, written down.** how big a batch can be, how many queries a second, and the largest `limit` a query takes. we found all three by hitting them

we filed the main ones upstream: [arkiv#289](https://github.com/Arkiv-Network/arkiv/issues/289) (paging), [arkiv#290](https://github.com/Arkiv-Network/arkiv/issues/290) (batch size) and [arkiv-starlight-docs#96](https://github.com/Arkiv-Network/arkiv-starlight-docs/issues/96) (public node limits). the rate limits are already tracked in [arkiv-sdk-js#126](https://github.com/Arkiv-Network/arkiv-sdk-js/issues/126)

## when something broke

### big batches are refused with no hint why

- **expected:** a batch over the limit fails with a message saying what the limit is
- **happened:** the RPC answered a plain `413`, so nothing went out. our sealing stalled, and the history tab said "sealing" for minutes while the queue grew
- **repro:** send one `execute` with 50 `create` ops of about 15 attributes each, the way we first sealed rounds. the request is refused before it reaches the chain
- **what we did:** cap every batch by its encoded size, not by a count ([`backend/crates/core/src/arkiv.rs`](../backend/crates/core/src/arkiv.rs), `fit`)

### the second page of a query can't be read

- **expected:** pass back `cursor` and get the next page
- **happened:** without `atBlock`, the next call fails with `cursor belongs to a different query, block or select`. with `atBlock` set to the first page's block, it fails with `block 307620 is unavailable: state for this block is not retained`, because the public node only keeps the latest block
- **repro:**
  ```bash
  # page 1: note result.cursor and result.blockNumber
  curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'strike.rounds'"'"')",{"select":{"key":true},"limit":"0x64"}]}'
  # page 2: pass the cursor, with or without "atBlock": <blockNumber>, a block or two later
  ```
- **what we did:** our reads never page. they filter tightly enough (one wallet, one market, one day) to fit in one page

### a query limit above 100 is refused

- **expected:** a larger limit, or the cap in the docs
- **happened:** the public node refuses `limit` above 100
- **what we did:** every read asks for 100 at most ([`frontend/lib/arkiv.ts`](../frontend/lib/arkiv.ts))

### bursts of reads get rate limited

- **expected:** a documented rate, or a header saying when to retry
- **happened:** several components reading at once (history, trade tape, bets in play) got `429` from the public RPC
- **what we did:** back off and retry twice, and poll every 10 seconds instead of on every render

## smaller things

- **expiry is in blocks, not time.** we want "keep this for an hour after the round", and had to work out the block time (2 seconds) to convert it. an `expiresIn` in seconds would read better and survive a block time change
- **a key needs gas before it can write.** each player's browser key needs a little testnet ETH first, so our backend funds it. a sponsored or relayed write for small entities would remove that step
- **Swarm,** for the bonus, has its own list in [swarm.md](swarm.md#what-got-in-our-way)
