#!/usr/bin/env node
// SLH-DSA-SHA2-128s helper for Leash. Works offline, so it can run on an air-gapped machine.
//
//   node tools/pq.mjs keygen [seedHex48] [outFile]   new key (prints JSON, or writes outFile)
//   node tools/pq.mjs sign <keyFile|secretKeyHex> <digestHex>   prints the 7856-byte signature as hex
//   node tools/pq.mjs pubkey <keyFile|secretKeyHex>              prints the 32-byte public key
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

function loadSecret(arg) {
  if (existsSync(arg)) return bytes(JSON.parse(readFileSync(arg, 'utf8')).secretKey);
  return bytes(arg);
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'keygen') {
  const seed = a && a !== '-' ? bytes(a) : undefined;
  const { publicKey, secretKey } = slh.keygen(seed);
  const key = {
    scheme: 'SLH-DSA-SHA2-128s',
    publicKey: hex(publicKey),
    secretKey: hex(secretKey),
    createdAt: new Date().toISOString(),
  };
  if (b) {
    writeFileSync(b, JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
    console.log(key.publicKey);
  } else {
    console.log(JSON.stringify(key));
  }
} else if (cmd === 'sign') {
  const digest = bytes(b);
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  process.stdout.write(hex(slh.sign(digest, loadSecret(a))));
} else if (cmd === 'pubkey') {
  process.stdout.write(hex(slh.getPublicKey(loadSecret(a))));
} else {
  console.error('usage: pq.mjs keygen [seedHex] [outFile] | sign <key> <digest> | pubkey <key>');
  process.exit(1);
}
