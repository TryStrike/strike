import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bandMultiplierCeiling } from './bandCeiling';

// Fixture rows come from the Rust side: inputs plus the ceiling it computed.
// Field names are read in camelCase or snake_case; boost is optional (default 1).
const file = join(__dirname, 'bandCeiling.fixture.json');
if (!existsSync(file)) {
  console.log('skip: bandCeiling.fixture.json not generated yet');
  process.exit(0);
}

type Row = Record<string, number | number[]>;
const raw = JSON.parse(readFileSync(file, 'utf8'));
const rows: Row[] = Array.isArray(raw) ? raw : raw.cases;
const pick = (r: Row, ...keys: string[]) => {
  for (const k of keys) if (typeof r[k] === 'number') return r[k] as number;
  throw new Error(`fixture row missing ${keys[0]}: ${JSON.stringify(r)}`);
};

assert.ok(rows.length > 0, 'fixture has no cases');
for (const r of rows) {
  const got = bandMultiplierCeiling(
    pick(r, 'strike'),
    pick(r, 'top', 'priceTop'),
    pick(r, 'bottom', 'priceBottom'),
    pick(r, 'range'),
    pick(r, 'windowMs', 'window_ms'),
    pick(r, 'leftMs', 'left_ms'),
    typeof r.boost === 'number' ? r.boost : 1,
  );
  const want = pick(r, 'ceiling', 'expected');
  assert.ok(Math.abs(got - want) <= 1e-9, `ceiling mismatch ${got} vs ${want} for ${JSON.stringify(r)}`);
}
console.log(`ok: bandCeiling parity (${rows.length} cases)`);
