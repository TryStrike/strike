// Run: npx tsx lib/proofs/leaf.check.ts <proofs.jsonl>  (one /api/proofs/bet response per line)
import { readFileSync } from 'node:fs';
import { roundLeaf } from './leaf';

const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
let n = 0;
for (const line of lines) {
  const body = JSON.parse(line);
  if (!body.round || !body.leaf) continue;
  const ours = roundLeaf(body.round);
  if (ours !== body.leaf) throw new Error(`leaf mismatch for ${body.round.betId}: ${ours} != ${body.leaf}`);
  n++;
}
if (n === 0) throw new Error('no rounds to check');
console.log(`ok: ${n} leaves match the server`);
