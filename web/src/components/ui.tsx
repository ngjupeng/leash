import { useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { explorerAddress, explorerTx } from '../lib/chain';
import { short } from '../lib/format';
import type { Status } from '../lib/vault';
import { errorText } from '../lib/format';

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M9 7v13a5 5 0 0 0 5 5h9" fill="none" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="23" cy="25" r="3" fill="var(--pq)" />
    </svg>
  );
}

export function Addr({ a, full }: { a: string; full?: boolean }) {
  return (
    <a className="mono" href={explorerAddress(a)} target="_blank" rel="noreferrer" title={a}>
      {full ? a : short(a)}
    </a>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

export function Meter({ used, total }: { used: bigint; total: bigint }) {
  const pct = total === 0n ? 0 : Number((used * 10000n) / total) / 100;
  return (
    <div className={`meter ${pct >= 99.9 ? 'full' : pct >= 75 ? 'hot' : ''}`} title={`${pct.toFixed(1)}% used`}>
      <span style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export type StatusState = { msg: string; kind: 'info' | 'ok' | 'error'; hash?: Hex } | null;

export function useStatus(): [StatusState, Status, (fn: () => Promise<unknown>) => Promise<void>, boolean] {
  const [s, setS] = useState<StatusState>(null);
  const [busy, setBusy] = useState(false);
  const status: Status = (msg, kind = 'info', hash) => setS(msg ? { msg, kind, hash } : null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setS({ msg: errorText(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return [s, status, run, busy];
}

export function StatusLine({ s }: { s: StatusState }) {
  if (!s) return null;
  return (
    <div className={`status ${s.kind === 'info' ? '' : s.kind}`}>
      <span>{s.msg}</span>
      {s.hash && (
        <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer">
          {short(s.hash)}
        </a>
      )}
    </div>
  );
}
