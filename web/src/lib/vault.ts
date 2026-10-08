import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { vaultAbi } from '../abi';
import { publicClient, PAY_GAS_HEADROOM } from './chain';
import { pqSign } from './pq';
import { walletClient } from './wallet';

export type AgentRow = {
  agent: Address;
  dailyCap: bigint;
  spent: bigint;
  remaining: bigint;
  windowStart: bigint;
  expiresAt: bigint;
  active: boolean;
};

export type Receipt = {
  agent: Address;
  gasRefund: bigint;
  to: Address;
  time: number;
  blockNumber: bigint;
  amount: bigint;
  memo: Hex;
};

export type VaultState = {
  address: Address;
  owner: Address;
  pqKey: Hex;
  pqNonce: bigint;
  frozen: boolean;
  payeeAllowlistOn: boolean;
  recoveryDelay: bigint;
  recoveryReadyAt: bigint;
  pendingOwner: Address;
  paymentCount: bigint;
  balance: bigint;
  agents: AgentRow[];
  receipts: Receipt[];
};

const ZERO = '0x0000000000000000000000000000000000000000';

export async function loadVault(address: Address): Promise<VaultState> {
  const c = { address, abi: vaultAbi } as const;
  const [owner, pqKey, pqNonce, frozen, payeeAllowlistOn, recoveryDelay, recoveryReadyAt, pendingOwner, paymentCount, agents, receipts] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...c, functionName: 'owner' },
        { ...c, functionName: 'pqKey' },
        { ...c, functionName: 'pqNonce' },
        { ...c, functionName: 'frozen' },
        { ...c, functionName: 'payeeAllowlistOn' },
        { ...c, functionName: 'recoveryDelay' },
        { ...c, functionName: 'recoveryReadyAt' },
        { ...c, functionName: 'pendingOwner' },
        { ...c, functionName: 'paymentCount' },
        { ...c, functionName: 'agents' },
        { ...c, functionName: 'recentPayments', args: [64n] },
      ],
    });
  const balance = await publicClient.getBalance({ address });
  return {
    address,
    owner,
    pqKey,
    pqNonce,
    frozen,
    payeeAllowlistOn,
    recoveryDelay: BigInt(recoveryDelay),
    recoveryReadyAt: BigInt(recoveryReadyAt),
    pendingOwner,
    paymentCount,
    balance,
    agents: agents.map((a) => ({ ...a, windowStart: BigInt(a.windowStart), expiresAt: BigInt(a.expiresAt) })),
    receipts: receipts.map((r) => ({ ...r, time: Number(r.time), blockNumber: BigInt(r.blockNumber) })),
  };
}

export const hasRecovery = (v: VaultState) => v.pendingOwner !== ZERO;

export function useVault(address: Address | null, pollMs = 4000) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      setState(await loadVault(address));
      setError(null);
    } catch (e: any) {
      setError(e?.shortMessage ?? String(e));
    }
  }, [address]);
  useEffect(() => {
    setState(null);
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  return { state, error, refresh };
}

export type Status = (msg: string | null, kind?: 'info' | 'ok' | 'error', hash?: Hex) => void;

type VaultFn = (typeof vaultAbi)[number] extends infer T ? (T extends { type: 'function'; name: infer N } ? N : never) : never;

/** Send a plain owner or agent transaction from the connected wallet. */
export async function ownerTx(vault: Address, functionName: VaultFn, args: readonly unknown[], status: Status) {
  const w = await walletClient();
  status('Confirm in your wallet...');
  const hash = await w.writeContract({ address: vault, abi: vaultAbi, functionName, args, chain: w.chain, account: w.account } as any);
  status('Waiting for Arc to finalize...', 'info', hash);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('Transaction reverted');
  status('Done. Final on Arc.', 'ok', hash);
  return hash;
}

/** Sign `functionName(args)` with the PQ key, then send it through guarded() from the owner wallet. */
export async function guardedTx(vault: Address, secretKey: Hex, functionName: VaultFn, args: readonly unknown[], status: Status) {
  const call = encodeFunctionData({ abi: vaultAbi, functionName, args } as any);
  const digest = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'guardDigest', args: [call] });
  status('Signing with your post-quantum key (SLH-DSA-SHA2-128s)...');
  const t = performance.now();
  const sig = await pqSign(secretKey, digest);
  status(`Signed in ${Math.round(performance.now() - t)} ms. Confirm in your wallet...`);
  return ownerTx(vault, 'guarded', [call, sig], status);
}

export async function startRecoveryTx(vault: Address, secretKey: Hex, newOwner: Address, status: Status) {
  const digest = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'recoveryDigest', args: [newOwner] });
  status('Signing recovery with your post-quantum key...');
  const sig = await pqSign(secretKey, digest);
  return ownerTx(vault, 'startRecovery', [newOwner, sig], status);
}

export { PAY_GAS_HEADROOM };
