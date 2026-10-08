import { createWalletClient, custom, type Address, type WalletClient } from 'viem';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { arc } from './chain';

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<any>; on?: (e: string, f: (...a: any[]) => void) => void };
  }
}

let account: Address | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useAccount(): Address | null {
  useEffect(() => {
    window.ethereum?.request({ method: 'eth_accounts' }).then((a: Address[]) => {
      account = a[0] ?? null;
      emit();
    });
    window.ethereum?.on?.('accountsChanged', (a: Address[]) => {
      account = a[0] ?? null;
      emit();
    });
  }, []);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => account,
  );
}

async function ensureArc() {
  const eth = window.ethereum!;
  const hex = `0x${arc.id.toString(16)}`;
  if ((await eth.request({ method: 'eth_chainId' })) === hex) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e: any) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: 'Arc',
        nativeCurrency: arc.nativeCurrency,
        rpcUrls: arc.rpcUrls.default.http,
        blockExplorerUrls: [arc.blockExplorers.default.url],
      }],
    });
  }
}

export async function connect(): Promise<Address> {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.');
  const a: Address[] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = a[0];
  emit();
  await ensureArc();
  return account;
}

export async function walletClient(): Promise<WalletClient & { account: { address: Address } }> {
  const addr = account ?? (await connect());
  await ensureArc();
  return createWalletClient({ chain: arc, transport: custom(window.ethereum!), account: addr }) as any;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
