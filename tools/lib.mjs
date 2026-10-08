import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineChain, createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export function arcChain(rpcUrl, id = 5042) {
  return defineChain({
    id,
    name: id === 5042 ? 'Arc' : 'Arc (local)',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  });
}

export async function clients(rpcUrl) {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chain = arcChain(rpcUrl, await probe.getChainId());
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = (pk) => createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(pk) });
  return { chain, pub, wallet };
}

export function artifact(name) {
  const a = JSON.parse(readFileSync(join(root, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** Sign a 32-byte digest with an SLH-DSA-SHA2-128s secret key, returning 0x-hex. */
export function pqSign(secretKeyHex, digestHex) {
  return '0x' + Buffer.from(slh.sign(bytes(digestHex), bytes(secretKeyHex))).toString('hex');
}

export const usd = (wei) => `$${(Number(wei) / 1e18).toFixed(6)}`;
