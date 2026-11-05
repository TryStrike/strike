/**
 * On-chain check for StrikeTreasury on Arc.
 *
 * Exercises the native USDC path and token safety controls after the Arc USDC
 * contract address has been configured.
 *
 * Usage:
 *   ARC_TREASURY_SECRET_KEY=... ARC_USDC_ADDRESS=0x... node contracts/arc/e2e.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const net = { chainId: 5042, name: 'Arc', rpc: process.env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io' };
const usdcAddress = process.env.ARC_USDC_ADDRESS || process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS;
assert.ok(ethers.isAddress(usdcAddress), 'ARC_USDC_ADDRESS must be configured');

const deployment = JSON.parse(
  readFileSync(join(__dirname, `deployments/arc-${net.chainId}.json`), 'utf8')
);
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

const NATIVE_AMOUNT = ethers.parseUnits('0.00001', 6);
const TOKEN_DECIMALS = Number(await token.decimals());
const TOKEN_AMOUNT = ethers.parseUnits('0.00001', TOKEN_DECIMALS);

await check('deployer owns the treasury and it points at the right token', async () => {
  assert.equal((await treasury.owner()).toLowerCase(), deployment.owner.toLowerCase());
  assert.equal((await treasury.token()).toLowerCase(), deployment.token.toLowerCase());
  assert.equal(await treasury.paused(), false);
});

await check('native deposit is recorded and credited', async () => {
  const before = await treasury.getBalance();
  const receipt = await (await treasury.deposit({ value: NATIVE_AMOUNT })).wait();
  assert.equal(await treasury.getBalance(), before + NATIVE_AMOUNT);

  const event = receipt.logs
    .map((l) => { try { return treasury.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === 'Deposited');
  assert.ok(event, 'no Deposited event');
  assert.equal(event.args.asset, ethers.ZeroAddress, 'native deposit should report the zero asset');
  assert.equal(event.args.amount, NATIVE_AMOUNT);
});

await check('a plain transfer counts as a native deposit', async () => {
  const before = await treasury.getBalance();
  await (await wallet.sendTransaction({ to: deployment.strikeTreasury, value: NATIVE_AMOUNT })).wait();
  assert.equal(await treasury.getBalance(), before + NATIVE_AMOUNT);
});

await check('a zero native deposit is rejected', async () => {
  await assert.rejects(() => treasury.deposit.staticCall({ value: 0 }));
});

await check('token deposit needs an allowance, then is credited', async () => {
  const balance = await token.balanceOf(wallet.address);
  assert.ok(balance >= TOKEN_AMOUNT, `signer holds no USDC (${balance})`);

  // Without an allowance the transferFrom must fail.
  await assert.rejects(() => treasury.depositToken.staticCall(TOKEN_AMOUNT));

  await (await token.approve(deployment.strikeTreasury, TOKEN_AMOUNT)).wait();

  const before = await treasury.getTokenBalance();
  const receipt = await (await treasury.depositToken(TOKEN_AMOUNT)).wait();
  assert.equal(await treasury.getTokenBalance(), before + TOKEN_AMOUNT);

  const event = receipt.logs
    .map((l) => { try { return treasury.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === 'Deposited');
  assert.ok(event, 'no Deposited event');
  assert.equal(event.args.asset.toLowerCase(), deployment.token.toLowerCase());
});

await check('owner pays native out to a player', async () => {
  const to = ethers.Wallet.createRandom().address;
  await (await treasury.withdrawTo(to, NATIVE_AMOUNT)).wait();
  assert.equal(await provider.getBalance(to), NATIVE_AMOUNT);
});

await check('owner pays the token out to a player', async () => {
  const to = ethers.Wallet.createRandom().address;
  await (await treasury.withdrawTokenTo(to, TOKEN_AMOUNT)).wait();
  assert.equal(await token.balanceOf(to), TOKEN_AMOUNT);
});

await check('batch payout reaches every recipient', async () => {
  // Earlier payouts drained the balance; top it up for the batch.
  await (await treasury.deposit({ value: NATIVE_AMOUNT * 2n })).wait();

  const a = ethers.Wallet.createRandom().address;
  const b = ethers.Wallet.createRandom().address;
  await (await treasury.withdrawBatch([a, b], [NATIVE_AMOUNT, NATIVE_AMOUNT])).wait();
  assert.equal(await provider.getBalance(a), NATIVE_AMOUNT);
  assert.equal(await provider.getBalance(b), NATIVE_AMOUNT);
});

await check('a payout beyond the balance is refused', async () => {
  await assert.rejects(() =>
    treasury.withdrawTo.staticCall(wallet.address, ethers.parseEther('1000000'))
  );
});

await check('a non-owner cannot pay anything out', async () => {
  const stranger = ethers.Wallet.createRandom().connect(provider);
  const asStranger = new ethers.Contract(deployment.strikeTreasury, abi, stranger);
  await assert.rejects(() => asStranger.withdrawTo.staticCall(stranger.address, NATIVE_AMOUNT));
  await assert.rejects(() => asStranger.pause.staticCall());
});

await check('pause stops deposits and payouts, unpause restores them', async () => {
  await (await treasury.pause()).wait();
  assert.equal(await treasury.paused(), true);

  await assert.rejects(() => treasury.deposit.staticCall({ value: NATIVE_AMOUNT }));
  await assert.rejects(() => treasury.withdrawTo.staticCall(wallet.address, NATIVE_AMOUNT));

  await (await treasury.unpause()).wait();
  assert.equal(await treasury.paused(), false);
});

await check('ownership transfer needs the new owner to accept', async () => {
  const nominee = ethers.Wallet.createRandom();
  await (await treasury.transferOwnership(nominee.address)).wait();

  // Not yet the owner — the handover is incomplete until accepted.
  assert.equal((await treasury.owner()).toLowerCase(), wallet.address.toLowerCase());
  assert.equal((await treasury.pendingOwner()).toLowerCase(), nominee.address.toLowerCase());

  // Nobody else can accept on the nominee's behalf.
  await assert.rejects(() => treasury.acceptOwnership.staticCall());

  // Cancel the handover so the treasury stays operable.
  await (await treasury.transferOwnership(wallet.address)).wait();
});

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
