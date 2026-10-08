import { formatEther, parseEther } from 'viem';

export function usd(wei: bigint | undefined | null, digits = 2): string {
  if (wei === undefined || wei === null) return '...';
  const n = Number(formatEther(wei));
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(digits === 2 ? 4 : digits)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 2) })}`;
}

export function usdPrecise(wei: bigint): string {
  return `$${Number(formatEther(wei)).toFixed(6)}`;
}

export function parseUsd(s: string): bigint {
  const clean = s.replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') throw new Error('Enter an amount like 1.50');
  return parseEther(clean);
}

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function until(ts: number): string {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}

export function memoText(memo: `0x${string}`): string {
  const bytes = memo.slice(2).match(/../g) ?? [];
  const chars = bytes.map((b) => parseInt(b, 16)).filter((c) => c !== 0);
  if (chars.every((c) => c >= 32 && c < 127)) return String.fromCharCode(...chars);
  return memo;
}

const FRIENDLY: Record<string, string> = {
  OverCap: "Refused by the vault: this would go over the agent's daily cap, gas included.",
  VaultFrozen: 'Refused: the owner froze this vault.',
  NotAgent: 'Refused: this address is not an active agent of the vault.',
  AgentExpired: "Refused: this agent's authorisation has expired.",
  PayeeNotAllowed: 'Refused: this payee is not on the allowlist.',
  BadPayee: 'Refused: agents cannot pay the vault itself or the USDC token contract.',
  BadPqSignature: 'The post-quantum signature did not verify against the vault key.',
  NotOwner: 'Only the vault owner can do this.',
  RecoveryNotReady: 'The recovery delay has not passed yet.',
  BadArgument: 'The vault rejected these values.',
};

export function errorText(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const name = any?.cause?.data?.errorName;
  if (name) return FRIENDLY[name] ? `${FRIENDLY[name]} (${name})` : name;
  return any?.shortMessage ?? any?.message ?? String(e);
}
