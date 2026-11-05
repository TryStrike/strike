import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import solc from 'solc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

for (const file of ['.env.local', '.env']) {
  const envPath = resolve(root, file);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID);
if (!Number.isInteger(chainId) || chainId <= 0) {
  console.error(
    'ARC chain id is not configured. Set NEXT_PUBLIC_ARC_CHAIN_ID explicitly ' +
      '(5042 = Arc mainnet, 5042002 = Arc Testnet) in .env.local or the environment.'
  );
  process.exit(1);
}
const FORCE = process.argv.includes('--force');
const net = {
  chainId,
  name: chainId === 5042 ? 'Arc' : 'Arc Testnet',
  rpc: process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT || (chainId === 5042 ? 'https://rpc.mainnet.arc.io' : 'https://rpc.testnet.arc.io'),
  explorer: process.env.NEXT_PUBLIC_ARC_EXPLORER || (chainId === 5042 ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io'),
  usdc: process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
  eurc: process.env.ARC_EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  tokenMessenger: process.env.ARC_TOKEN_MESSENGER || '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
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

  const outFile = join(__dirname, 'deployments', `arc-${net.chainId}.json`);
  if (existsSync(outFile) && !FORCE) {
    const previous = JSON.parse(readFileSync(outFile, 'utf8'));
    throw new Error(
      `A deployment already exists for chain ${net.chainId}: ${outFile}\n` +
        `  Treasury ${previous.strikeTreasury} (deployed ${previous.deployedAt})\n` +
        `Redeploying orphans that contract and its funds. Reuse NEXT_PUBLIC_TREASURY_ADDRESS, ` +
        `or pass --force if you are sure this is a fresh deployment.`
    );
  }

  const provider = new ethers.JsonRpcProvider(net.rpc, {
    chainId: net.chainId,
    name: net.name,
  });
  const wallet = new ethers.Wallet(key, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Network   ${net.name} (${net.chainId})`);
  console.log(`Deployer  ${wallet.address}`);
  console.log(`Balance   ${ethers.formatEther(balance)} native USDC gas units (18 decimals; not the 6-dp ERC-20 balance)`);
  console.log(`USDC      ${net.usdc}`);
  if (balance === 0n) throw new Error('Deployer has no native USDC to pay for gas');

  const artifact = compile();
  const factory = new ethers.ContractFactory(
    artifact.abi,
    `0x${artifact.evm.bytecode.object}`,
    wallet
  );
  const owner = process.env.ARC_OWNER_ADDRESS || wallet.address;
  const operator = process.env.ARC_OPERATOR_ADDRESS || wallet.address;
  const treasury = await factory.deploy(net.usdc, net.eurc, net.tokenMessenger, owner, operator);
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
    usdc: net.usdc,
    eurc: net.eurc,
    tokenMessenger: net.tokenMessenger,
    owner,
    operator,
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
