import { useRef, useState } from 'react';
import { fingerprint, parseKeyFile, type PqKeyFile } from '../lib/pq';

/** Loads an SLH-DSA key file into memory only. It never leaves the page or touches storage. */
export function PqKeyLoader({ expected, value, onChange }: { expected: string; value: PqKeyFile | null; onChange: (k: PqKeyFile | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async (f: File) => {
    try {
      const k = parseKeyFile(await f.text());
      if (k.publicKey.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`This key (${fingerprint(k.publicKey)}) is not this vault's key (${fingerprint(expected)})`);
      }
      setErr(null);
      onChange(k);
    } catch (e: any) {
      onChange(null);
      setErr(e.message);
    }
  };

  if (value) {
    return (
      <div className="keybox">
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <div className="sub">Post-quantum key loaded, matches this vault</div>
            <div className="fp">{fingerprint(value.publicKey)}</div>
          </div>
          <button className="btn small" onClick={() => onChange(null)}>Unload</button>
        </div>
      </div>
    );
  }
  return (
    <div className="keybox">
      <div className="sub">Load your SLH-DSA key file to sign. It stays in this tab&apos;s memory and is never uploaded.</div>
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="btn small" onClick={() => input.current?.click()}>Choose key file</button>
        <span className="fp" style={{ fontSize: 12 }}>expects {fingerprint(expected)}</span>
      </div>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      {err && <div className="status error">{err}</div>}
    </div>
  );
}
