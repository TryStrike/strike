#!/usr/bin/env node
/**
 * Single local stub for everything off-box, on 127.0.0.1:4300.
 *
 *   POST /rpc                Arc JSON-RPC. Deposits and payouts only ever see this.
 *   GET  /api/v3/ticker/price, /v7/finance/spark   Binance / Yahoo shaped quotes.
 *   CONNECT (any host)       HTTPS_PROXY catch-all: refused and counted, so
 *                            "no external calls" is a measured number.
 *   /__tx /__ctl /__stats /__reset /__price        test control. /__price sets a
 *                            Binance symbol's quote: { "BTCUSDT": 100 }.
 *
 * Payouts are recorded so a test can compare what left the "treasury" with what
 * the ledger debited.
 */
import { createServer } from 'node:http';
import { ethers } from 'ethers';

const PORT = Number(process.env.STUB_PORT || 4300);
const TREASURY_KEY = process.env.ARC_TREASURY_SECRET_KEY;
const TREASURY_OWNER = new ethers.Wallet(TREASURY_KEY).address;
const USDC = process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID);
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const HEAD = 1_000_000;
const SEL = {
  owner: ethers.id('owner()').slice(0, 10),
  balanceOf: ethers.id('balanceOf(address)').slice(0, 10),
  withdrawTokenTo: ethers.id('withdrawTokenTo(address,uint256)').slice(0, 10),
};

const quote = (seed) => String(Number((seed * 1.2345).toFixed(4)));
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const pad = (a) => ethers.zeroPadValue(a, 32);

let txs = new Map();
let sent = [];
let connects = [];
let rpcCalls = 0;
let priceCalls = 0;
// nonce 'strict' is what a node does: one tx per sender nonce, duplicates refused.
// nonce 'lenient' hands every reader a unique nonce, i.e. a working nonce manager,
// so every transfer lands and only the ledger logic is under test.
let mode = { rpc: 'ok', prices: 'ok', payoutDelayMs: 0, receiptDelayMs: 0, nonce: 'strict' };
let nextNonce = new Map();
let uniqueNonce = 0;
let rejected = [];
let pinned = new Map();

function txShape(hash, t) {
  return {
    hash, from: t.from, to: t.to, nonce: '0x1', gas: '0x5208', gasPrice: '0x1',
    maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', input: '0x', value: '0x0', type: '0x2',
    chainId: hex(CHAIN_ID), blockNumber: hex(t.block), blockHash: pad('0x01'),
    transactionIndex: '0x0', r: pad('0x01'), s: pad('0x02'), v: '0x0', yParity: '0x0',
    accessList: [],
  };
}

function receiptShape(hash, t) {
  return {
    transactionHash: hash, transactionIndex: '0x0', blockNumber: hex(t.block), blockHash: pad('0x01'),
    from: t.from, to: t.to, contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
    effectiveGasPrice: '0x1', logsBloom: `0x${'00'.repeat(256)}`, status: hex(t.status ?? 1), type: '0x2',
    logs: (t.logs ?? []).map((l, i) => ({
      address: l.address, topics: l.topics, data: l.data, blockNumber: hex(t.block), blockHash: pad('0x01'),
      transactionHash: hash, transactionIndex: '0x0', logIndex: hex(i), removed: false,
    })),
  };
}

async function rpc(method, params) {
  rpcCalls += 1;
  switch (method) {
    case 'eth_chainId': return hex(CHAIN_ID);
    case 'net_version': return String(CHAIN_ID);
    case 'eth_blockNumber': return hex(HEAD);
    case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
    case 'eth_estimateGas': return '0x186a0';
    case 'eth_getTransactionCount':
      if (mode.nonce === 'lenient') { uniqueNonce += 1; return hex(uniqueNonce); }
      return hex(nextNonce.get(params[0].toLowerCase()) ?? 0);
    case 'eth_getBalance': return hex(10n ** 21n);
    case 'eth_getLogs': return [];
    case 'eth_feeHistory': return { oldestBlock: hex(HEAD), baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0.5], reward: [['0x1']] };
    case 'eth_getBlockByNumber':
      return {
        number: hex(HEAD), hash: pad('0x01'), parentHash: pad('0x02'), timestamp: hex(1_700_000_000),
        nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
        miner: ethers.ZeroAddress, extraData: '0x', baseFeePerGas: '0x1', transactions: [],
      };
    case 'eth_call': {
      const data = params[0].data || params[0].input || '';
      if (data.startsWith(SEL.owner)) return pad(TREASURY_OWNER);
      if (data.startsWith(SEL.balanceOf)) return ethers.toBeHex(10n ** 15n, 32);
      throw Object.assign(new Error('execution reverted'), { code: 3 });
    }
    case 'eth_getTransactionByHash': {
      const t = txs.get(params[0].toLowerCase());
      return t ? txShape(params[0], t) : null;
    }
    case 'eth_getTransactionReceipt': {
      const t = txs.get(params[0].toLowerCase());
      if (t?.sentAt && Date.now() - t.sentAt < mode.receiptDelayMs) return null;
      return t ? receiptShape(params[0], t) : null;
    }
    case 'eth_sendRawTransaction': {
      const raw = params[0];
      const parsed = ethers.Transaction.from(raw);
      const hash = ethers.keccak256(raw);
      if (mode.payoutDelayMs) await new Promise((r) => setTimeout(r, mode.payoutDelayMs));
      if (mode.nonce === 'strict') {
        const sender = parsed.from.toLowerCase();
        const next = nextNonce.get(sender) ?? 0;
        if (parsed.nonce !== next) {
          const message = txs.has(hash) ? 'already known' : parsed.nonce < next ? 'nonce too low' : 'nonce gap';
          rejected.push({ hash, nonce: parsed.nonce, message });
          throw Object.assign(new Error(message), { code: -32000 });
        }
        nextNonce.set(sender, next + 1);
      }
      const to = parsed.data.startsWith(SEL.withdrawTokenTo) ? `0x${parsed.data.slice(34, 74)}` : parsed.to;
      const amount = parsed.data.startsWith(SEL.withdrawTokenTo) ? String(BigInt(`0x${parsed.data.slice(74, 138)}`)) : '0';
      sent.push({ hash, from: parsed.from, to: to.toLowerCase(), amount, nonce: parsed.nonce, server: 'unknown' });
      txs.set(hash, { from: parsed.from, to: parsed.to, block: HEAD - 5, sentAt: Date.now() });
      return hash;
    }
    default:
      throw Object.assign(new Error(`stub: unsupported ${method}`), { code: -32601 });
  }
}

const body = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(JSON.stringify(value));
};

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, {}); // a browser reading the chain
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const raw = await body(req);

  if (url.pathname === '/__stats') return send(res, 200, { sent, rejected, connects, rpcCalls, priceCalls, mode });
  if (url.pathname === '/__reset') { txs = new Map(); sent = []; connects = []; rpcCalls = 0; priceCalls = 0; mode = { rpc: 'ok', prices: 'ok', payoutDelayMs: 0, receiptDelayMs: 0, nonce: 'strict' }; nextNonce = new Map(); rejected = []; pinned = new Map(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/__price') { for (const [symbol, price] of Object.entries(JSON.parse(raw))) pinned.set(symbol, price); return send(res, 200, { ok: true }); }
  if (url.pathname === '/__ctl') { mode = { ...mode, ...JSON.parse(raw) }; return send(res, 200, mode); }
  if (url.pathname === '/__tx') {
    // { hash, from, to?, amount (base units), payTo, status?, confirmations?, wrongToken? }
    const t = JSON.parse(raw);
    txs.set(t.hash.toLowerCase(), {
      from: t.txFrom ?? t.from, to: USDC, status: t.status ?? 1,
      block: HEAD - (t.confirmations ?? 10) + 1,
      logs: t.amount === undefined ? [] : [{
        address: t.wrongToken ? ethers.ZeroAddress : USDC,
        topics: [TRANSFER, pad(t.from), pad(t.payTo)],
        data: ethers.toBeHex(BigInt(t.amount), 32),
      }],
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/rpc' || url.pathname === '/rpc/rs') {
    if (mode.rpc === 'down') return send(res, 503, { error: 'stub rpc down' });
    const one = async (r) => {
      try { return { jsonrpc: '2.0', id: r.id, result: await rpc(r.method, r.params ?? []) }; }
      catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code ?? -32000, message: e.message } }; }
    };
    const parsed = JSON.parse(raw);
    return send(res, 200, Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed));
  }

  if (url.pathname === '/api/v3/ticker/price') {
    priceCalls += 1;
    if (mode.prices === 'down') return send(res, 503, {});
    const symbols = JSON.parse(url.searchParams.get('symbols') || '[]');
    return send(res, 200, symbols.map((symbol, i) => ({ symbol, price: String(pinned.get(symbol) ?? quote(100 + symbol.length * 7 + i)) })));
  }
  if (url.pathname === '/v7/finance/spark') {
    priceCalls += 1;
    if (mode.prices === 'down') return send(res, 503, {});
    const symbols = (url.searchParams.get('symbols') || '').split(',');
    return send(res, 200, { spark: { result: symbols.map((symbol, i) => ({
      symbol, response: [{ meta: { regularMarketPrice: Number(quote(50 + symbol.length * 3 + i)) } }],
    })) } });
  }
  send(res, 404, { error: 'stub: no route' });
});

// Anything that tries HTTPS to the outside world lands here via HTTPS_PROXY.
server.on('connect', (req, socket) => {
  connects.push(req.url);
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub listening on ${PORT}`));
