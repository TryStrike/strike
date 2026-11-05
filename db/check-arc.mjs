/**
 * Validate the Arc USDC configuration used by the application.
 *
 * This is intentionally configuration-only while the Arc USDC contract
 * address is unset. It never invents an address or sends a transaction.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const ts = (await import('typescript')).default;
const source = readFileSync(resolve(root, 'lib/arc/config.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const config = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const arc = config.getArcConfig();

assert.deepEqual(config.ARC_ASSETS, ['USDC']);
assert.equal(config.isArcAsset('usdc'), true);
assert.equal(config.isArcAsset('usdt'), false);
assert.equal(arc.assets.USDC.symbol, 'USDC');
assert.equal(arc.assets.USDC.decimals, 6);
assert.equal(arc.assets.USDC.logo, '/logos/usdc.png');
assert.equal(typeof arc.chainId, 'number');
assert.ok(arc.rpcEndpoint);
assert.ok(arc.explorer);

console.log(`Arc USDC configuration check passed (${arc.name}, chain ${arc.chainId}).`);
console.log(`USDC contract: ${arc.assets.USDC.address || '(not configured)'}`);
