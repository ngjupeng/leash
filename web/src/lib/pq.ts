import { bytesToHex, hexToBytes, type Hex } from 'viem';

// SLH-DSA-SHA2-128s runs in a worker: signing takes about a second and would freeze the page.
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (v: any) => void>();

function call<T>(msg: Record<string, unknown>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./pq.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const fn = pending.get(e.data.id);
      pending.delete(e.data.id);
      fn?.(e.data);
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
    worker!.postMessage({ id, ...msg });
  });
}

export type PqKeyFile = { scheme: 'SLH-DSA-SHA2-128s'; publicKey: Hex; secretKey: Hex; createdAt: string; vault?: string };

export async function pqKeygen(): Promise<PqKeyFile> {
  const r = await call<{ publicKey: Uint8Array; secretKey: Uint8Array }>({ op: 'keygen' });
  return { scheme: 'SLH-DSA-SHA2-128s', publicKey: bytesToHex(r.publicKey), secretKey: bytesToHex(r.secretKey), createdAt: new Date().toISOString() };
}

export async function pqSign(secretKey: Hex, digest: Hex): Promise<Hex> {
  const r = await call<{ signature: Uint8Array }>({ op: 'sign', secretKey: hexToBytes(secretKey), message: hexToBytes(digest) });
  return bytesToHex(r.signature);
}

export function parseKeyFile(text: string): PqKeyFile {
  const k = JSON.parse(text);
  if (k.scheme !== 'SLH-DSA-SHA2-128s' || !/^0x[0-9a-f]{64}$/i.test(k.publicKey) || !/^0x[0-9a-f]{128}$/i.test(k.secretKey)) {
    throw new Error('Not a Leash SLH-DSA-SHA2-128s key file');
  }
  return k;
}

export function downloadKeyFile(k: PqKeyFile, name: string) {
  const blob = new Blob([JSON.stringify(k, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Short visual fingerprint of a 32-byte public key. */
export const fingerprint = (pk: string) => `${pk.slice(2, 10)} ${pk.slice(10, 18)} ${pk.slice(-8)}`.toUpperCase();
