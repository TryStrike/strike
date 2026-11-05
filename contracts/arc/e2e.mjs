/**
 * On-chain check for StrikeTreasury on Arc.
 *
 * Exercises USDC deposits, payouts and the safety controls against a deployed
 * treasury (see deploy.mjs). Spends a few micro-USDC.
 *
 * Usage:
 *   node contracts/arc/e2e.mjs   (reads .env.local/.env like deploy.mjs)
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

for (const file of ['.env.local', '.env']) {
  const envPath = resolve(root, file);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// No implicit chain default: silently reading (or worse, funding) the wrong
// chain's deployment is a fund-safety issue, so the chain id must be stated.
const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? process.env.ARC_CHAIN_ID);
if (!Number.isInteger(chainId) || chainId <= 0) {
  console.error(
    'ARC chain id is not configured. Set NEXT_PUBLIC_ARC_CHAIN_ID explicitly ' +
      '(5042 = Arc mainnet, 5042002 = Arc Testnet) in .env.local or the environment.'
  );
  process.exit(1);
}
const net = {
  chainId,
  name: chainId === 5042 ? 'Arc' : 'Arc Testnet',
  rpc: process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT || 'https://rpc.mainnet.arc.io',
};

const deploymentPath = join(__dirname, `deployments/arc-${net.chainId}.json`);
if (!existsSync(deploymentPath)) {
  console.error(
    `No deployment record for ${net.name} (${net.chainId}) at ${deploymentPath}.\n` +
      `Deploy first (node contracts/arc/deploy.mjs) or set NEXT_PUBLIC_ARC_CHAIN_ID to a deployed chain.`
  );
  process.exit(1);
}
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const abi = JSON.parse(readFileSync(join(__dirname, 'deployments/StrikeTreasury.abi.json'), 'utf8'));

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
const wallet = new ethers.Wallet(process.env.ARC_TREASURY_SECRET_KEY, provider);
const treasury = new ethers.Contract(deployment.strikeTreasury, abi, wallet);
const token = new ethers.Contract(deployment.token, ERC20_ABI, wallet);

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err.shortMessage || err.message}`);
  }
};

console.log(`StrikeTreasury e2e on ${net.name} (${net.chainId})`);
console.log(`Treasury ${deployment.strikeTreasury}`);
console.log(`Signer   ${wallet.address}\n`);

const TOKEN_DECIMALS = Number(await token.decimals());
const AMOUNT = ethers.parseUnits('0.00001', TOKEN_DECIMALS);
const parseEvent = (receipt, name) =>
  receipt.logs
    .map((l) => { try { return treasury.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === name);

await check('deployer owns the treasury and it points at the right token', async () => {
  assert.equal((await treasury.owner()).toLowerCase(), deployment.owner.toLowerCase());
  assert.equal((await treasury.token()).toLowerCase(), deployment.token.toLowerCase());
  assert.equal(await treasury.paused(), false);
});

await check('USDC deposit needs an allowance, then is credited', async () => {
  const balance = await token.balanceOf(wallet.address);
  assert.ok(balance >= AMOUNT * 4n, `signer holds too little USDC (${balance})`);

  await assert.rejects(() => treasury.depositToken.staticCall(AMOUNT));
  await (await token.approve(deployment.strikeTreasury, AMOUNT)).wait();

  const before = await treasury.getTokenBalance();
  const receipt = await (await treasury.depositToken(AMOUNT)).wait();
  assert.equal(await treasury.getTokenBalance(), before + AMOUNT);
  const event = parseEvent(receipt, 'Deposited');
  assert.ok(event, 'no Deposited event');
  assert.equal(event.args.amount, AMOUNT);
});

await check('a plain ERC-20 transfer also lands in the treasury', async () => {
  const before = await treasury.getTokenBalance();
  await (await token.transfer(deployment.strikeTreasury, AMOUNT * 2n)).wait();
  assert.equal(await treasury.getTokenBalance(), before + AMOUNT * 2n);
});

await check('native value sent to the treasury is refused', async () => {
  await assert.rejects(() =>
    wallet.call({ to: deployment.strikeTreasury, value: 1n })
  );
});

await check('a zero deposit is rejected', async () => {
  await assert.rejects(() => treasury.depositToken.staticCall(0));
});

await check('owner pays USDC out to a player', async () => {
  const to = ethers.Wallet.createRandom().address;
  const receipt = await (await treasury.withdrawTokenTo(to, AMOUNT)).wait();
  assert.equal(await token.balanceOf(to), AMOUNT);
  assert.ok(parseEvent(receipt, 'Withdrawn'), 'no Withdrawn event');
});

await check('batch payout reaches every recipient', async () => {
  const a = ethers.Wallet.createRandom().address;
  const b = ethers.Wallet.createRandom().address;
  await (await treasury.withdrawBatch([a, b], [AMOUNT, AMOUNT])).wait();
  assert.equal(await token.balanceOf(a), AMOUNT);
  assert.equal(await token.balanceOf(b), AMOUNT);
});

await check('a payout beyond the balance is refused', async () => {
  const tooMuch = (await treasury.getTokenBalance()) + 1n;
  await assert.rejects(() => treasury.withdrawTokenTo.staticCall(wallet.address, tooMuch));
});

await check('a non-owner cannot pay anything out', async () => {
  const stranger = ethers.Wallet.createRandom().connect(provider);
  const asStranger = new ethers.Contract(deployment.strikeTreasury, abi, stranger);
  await assert.rejects(() => asStranger.withdrawTokenTo.staticCall(stranger.address, AMOUNT));
  await assert.rejects(() => asStranger.pause.staticCall());
});

await check('pause stops deposits and payouts, unpause restores them', async () => {
  await (await treasury.pause()).wait();
  assert.equal(await treasury.paused(), true);
  await assert.rejects(() => treasury.depositToken.staticCall(AMOUNT));
  await assert.rejects(() => treasury.withdrawTokenTo.staticCall(wallet.address, AMOUNT));
  await (await treasury.unpause()).wait();
  assert.equal(await treasury.paused(), false);
});

await check('ownership transfer needs the new owner to accept', async () => {
  const nominee = ethers.Wallet.createRandom();
  await (await treasury.transferOwnership(nominee.address)).wait();
  assert.equal((await treasury.owner()).toLowerCase(), wallet.address.toLowerCase());
  assert.equal((await treasury.pendingOwner()).toLowerCase(), nominee.address.toLowerCase());
  await assert.rejects(() => treasury.acceptOwnership.staticCall());
  // Cancel the handover so the treasury stays operable.
  await (await treasury.transferOwnership(wallet.address)).wait();
});

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
