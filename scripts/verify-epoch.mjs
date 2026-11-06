// Checks one Strike epoch without trusting any Strike server:
// the Arkiv entity -> the proof file on Swarm -> StrikeTreasury.verifyRound on Arc, for every round.
//
//   cd frontend && npm ci && cd ..
//   node --experimental-strip-types scripts/verify-epoch.mjs <strike.epochs entity key>
//
// SWARM_GATEWAY defaults to Strike's public read-only route to its testnet Bee node.
// Any Bee node on Swarm testnet (network id 10) serves the same file.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const frontend = new URL('../frontend/', import.meta.url);
const require = createRequire(fileURLToPath(new URL('package.json', frontend)));
const { createPublicClient, defineChain, http, parseAbi } = require('viem');

const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
const SWARM = process.env.SWARM_GATEWAY ?? 'https://api-strike.fastship.studio/swarm';
const OPERATOR = '0x0f05df479fcb23b2281e28813fb47e57e47d1bb7';

const key = process.argv[2];
if (!/^0x[0-9a-f]{64}$/i.test(key ?? '')) {
  console.error('usage: node --experimental-strip-types scripts/verify-epoch.mjs <strike.epochs entity key>');
  process.exit(2);
}

const rpc = await fetch(ARKIV_RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'arkiv_getEntity', params: [key] }),
}).then((r) => r.json());
if (!rpc.result) throw new Error(`no Arkiv entity ${key}`);
const e = Object.fromEntries(rpc.result.attributes.map((a) => [a.name, a.value]));
console.log('arkiv entity', {
  schema: e['arkiv.schema'],
  writtenByStrike: rpc.result.creator?.toLowerCase() === OPERATOR,
  epoch: Number(e.epoch),
  rounds: Number(e.rounds),
  root: e.root,
  swarm: e.swarm,
});
if (e['arkiv.schema'] !== 'strike.epochs' || !e.swarm) throw new Error('not a strike.epochs entity with a swarm reference');

const bundle = await fetch(`${SWARM}/bytes/${e.swarm}`).then((r) => {
  if (!r.ok) throw new Error(`Swarm answered ${r.status}`);
  return r.json();
});
console.log('swarm file', {
  epoch: bundle.epoch,
  rounds: bundle.rounds.length,
  rootMatchesArkiv: bundle.root === e.root,
  treasury: bundle.treasury,
});

const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
});
const client = createPublicClient({ chain: arc, transport: http(undefined, { retryCount: 10, retryDelay: 2000 }) });
const abi = parseAbi([
  'function roundRoots(uint256) view returns (bytes32)',
  'function verifyRound(uint256 epoch, bytes32 leaf, bytes32[] proof) view returns (bool)',
]);
const onchainRoot = await client.readContract({
  address: bundle.treasury,
  abi,
  functionName: 'roundRoots',
  args: [BigInt(bundle.epoch)],
});
console.log('arc root matches', onchainRoot === bundle.root);

const { roundLeaf } = await import(new URL('lib/proofs/leaf.ts', frontend).href);
let ok = onchainRoot === bundle.root && bundle.root === e.root;
for (const r of bundle.rounds) {
  const rebuilt = roundLeaf(r.round) === r.leaf;
  const verified = await client.readContract({
    address: bundle.treasury,
    abi,
    functionName: 'verifyRound',
    args: [BigInt(bundle.epoch), r.leaf, r.proof],
  });
  ok &&= rebuilt && verified;
  console.log(' ', r.round.betId, r.round.outcome, '| leaf rebuilt:', rebuilt, '| verifyRound:', verified);
}
console.log(ok ? '\nVerified: every round in this epoch checks out against Arc.' : '\nMismatch found.');
process.exit(ok ? 0 : 1);
