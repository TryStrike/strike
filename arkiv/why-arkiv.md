# why Arkiv

## swap Arkiv for Postgres and here's what you lose

with Postgres, the history page would be a page we control. we could change a bet or a result after the fact, quietly, and nobody could ever prove it. that's the exact thing people fear about fast betting apps.. a 5 second round settles faster than anyone can check it

with Arkiv:

- **we can't edit the past.** every round and every bet is written read only. the history tab compares our ledger against Arkiv and shows **Mismatch** if they ever disagree, in our own UI
- **we can't change what you bet.** your bet is written by your own browser key before the round ends. we never hold that key, so we can't rewrite your direction or your stake
- **you don't need us to look.** anyone can query Strike's results on the public RPC, filter them, and build on them. the queries are in the [README](../README.md), and none of them touch a Strike server
- **other apps can read it.** a leaderboard, a tax tool or a rival front end can read every Strike round without asking us for an API key
- **it ties the money chain together.** each 10 minute batch on Arkiv carries the same fingerprint Arc stores and points to the full proof file on Swarm, so one query leads to proof you can check against Arc

## what we kept off Arkiv, and why

| kept off | why |
|---|---|
| balances and the money ledger | every bet moves money in the same write that records it, and that needs one atomic writer. it lives in SQLite on our server, and Arkiv is where we prove it to you |
| withdrawals | they pay out on Arc itself, through the Strike vault, so Arc already has the public record |
| World ID humans and nullifiers | that's about who you are. putting it in a public database would link your wallets together for anyone to see |
| live price ticks | thousands a minute and only useful for seconds. the start and end price of every round are on Arkiv, which is the part that matters |
| the AI agent's reasoning | your strategy is yours. the bets it places still land on Arkiv like any other |
| the full proof file | too large for one entity, and it should outlive Arkiv's expiry. it lives on Swarm, and Arkiv keeps the reference, see [swarm.md](swarm.md) |
