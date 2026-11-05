/**
 * Deploy StrikeTreasury to Arc.
 *
 * Usage:
 *   ARC_TREASURY_SECRET_KEY=... node contracts/arc/deploy.mjs
 *
 * Reads ARC_TREASURY_SECRET_KEY and NEXT_PUBLIC_ARC_* from .env.local/.env and
 * writes contracts/arc/deployments/arc-<chainId>.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import solc from 'solc';

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

const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || 5042;
const net = {
  chainId,
  name: chainId === 5042 ? 'Arc' : 'Arc Testnet',
  rpc: process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT || 'https://rpc.mainnet.arc.io',
  explorer: process.env.NEXT_PUBLIC_ARC_EXPLORER || 'https://explorer.arc.io',
  usdc:
    process.env.ARC_USDC_ADDRESS ||
    process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS ||
    '0x3600000000000000000000000000000000000000',
};

function compile() {
  const source = readFileSync(resolve(__dirname, 'StrikeTreasury.sol'), 'utf8');
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { 'StrikeTreasury.sol': { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      })
    )
  );
  const fatal = (output.errors || []).filter((e) => e.severity === 'error');
  if (fatal.length) {
    for (const e of fatal) console.error(e.formattedMessage);
    throw new Error('Solidity compilation failed');
  }
  return output.contracts['StrikeTreasury.sol'].StrikeTreasury;
}

async function main() {
  const key = process.env.ARC_TREASURY_SECRET_KEY || process.env.PRIVATE_KEY;
  if (!key) throw new Error('ARC_TREASURY_SECRET_KEY is not set');
  if (!ethers.isAddress(net.usdc)) {
    throw new Error('ARC_USDC_ADDRESS is not set to a valid USDC contract address');
  }

  const provider = new ethers.JsonRpcProvider(net.rpc, {
    chainId: net.chainId,
    name: net.name,
  });
  const wallet = new ethers.Wallet(key, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Network   ${net.name} (${net.chainId})`);
  console.log(`Deployer  ${wallet.address}`);
  console.log(`Balance   ${ethers.formatEther(balance)} USDC (native, 18 decimals)`);
  console.log(`USDC      ${net.usdc}`);
  if (balance === 0n) throw new Error('Deployer has no USDC to pay for gas');

  const artifact = compile();
  const factory = new ethers.ContractFactory(
    artifact.abi,
    `0x${artifact.evm.bytecode.object}`,
    wallet
  );
  const treasury = await factory.deploy(net.usdc);
  console.log(`\nDeploying… tx ${treasury.deploymentTransaction().hash}`);
  await treasury.waitForDeployment();

  const address = await treasury.getAddress();
  const receipt = await treasury.deploymentTransaction().wait();

  const outDir = join(__dirname, 'deployments');
  mkdirSync(outDir, { recursive: true });
  const out = {
    chainId: net.chainId,
    network: net.name,
    strikeTreasury: address,
    token: net.usdc,
    owner: wallet.address,
    txHash: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedAt: new Date().toISOString(),
    explorer: `${net.explorer}/address/${address}`,
  };
  writeFileSync(join(outDir, `arc-${net.chainId}.json`), JSON.stringify(out, null, 2) + '\n');
  writeFileSync(join(outDir, `StrikeTreasury.abi.json`), JSON.stringify(artifact.abi, null, 2) + '\n');

  console.log(`\nStrikeTreasury  ${address}`);
  console.log(`Gas used        ${receipt.gasUsed}`);
  console.log(`Explorer        ${out.explorer}`);
  console.log(`\nSet NEXT_PUBLIC_TREASURY_ADDRESS=${address} in .env`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
