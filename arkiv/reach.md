# reach

## who it's for

people who already play fast price games: up or down apps, binary options, short term prediction markets. they love the speed and hate one thing about it.. the house runs the game, keeps the records, and nobody can check them

Strike keeps the speed (a 5 second round, no wallet popup per bet) and takes away the trust. every bet and every result is public on Arkiv, so a player can check any round, and so can anyone else

it's also for builders. Strike's whole history is a public dataset: a leaderboard, a stats page or a rival front end can read every round without asking us

## would they use it

the speed is what brings people in, and that part already works: rounds from 5 seconds to 1 minute on crypto, forex, stocks and metals, settled in USDC or EURC. Arkiv is what makes it worth trusting, and it's built into the screens people already look at:

- the history tab marks each of your rounds **Verified** against Arkiv
- the trade page shows every player's recent results and the bets still in play, read from Arkiv
- any round's proof links to its entity, its 10 minute batch, and the full proof file on Swarm

## can they try it today

yes. it's live on Arc testnet at [strike.fastship.studio](https://strike.fastship.studio)

1. get free test USDC at [faucet.circle.com](https://faucet.circle.com)
2. connect a wallet and verify as a human with World ID (the simulator works on testnet)
3. deposit, play a round, then open the history tab and see it Verified

during the event, Strike has sealed about 270 settled rounds on Arkiv, players' own keys have written 100+ bets, and 6 batch entities point to proof files. one production batch of 18 rounds checks out end to end, Arkiv to Swarm to Arc, with [`scripts/verify-epoch.mjs`](../scripts/verify-epoch.mjs)

## after Mumbai

we're three people and we want to keep building it:

- move to Arc mainnet when it opens, with real USDC and EURC
- more markets, and the AI agent for everyone
- keep the history public on Arkiv so others can build on it, and add a page anyone can use to check a round by its id
