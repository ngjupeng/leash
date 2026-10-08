import { useState } from 'react';
import { decodeEventLog, type Address, type Hex } from 'viem';
import { factoryAbi } from '../abi';
import { StatusLine, useStatus } from '../components/ui';
import { deployment } from '../deployment';
import { publicClient } from '../lib/chain';
import { parseUsd } from '../lib/format';
import { downloadKeyFile, fingerprint, pqKeygen, type PqKeyFile } from '../lib/pq';
import { useAccount, walletClient, connect } from '../lib/wallet';

export function Create() {
  const account = useAccount();
  const [key, setKey] = useState<PqKeyFile | null>(null);
  const [saved, setSaved] = useState(false);
  const [deposit, setDeposit] = useState('1');
  const [delayH, setDelayH] = useState('24');
  const [vault, setVault] = useState<Address | null>(null);
  const [s, status, run, busy] = useStatus();

  const gen = () =>
    run(async () => {
      status('Generating an SLH-DSA-SHA2-128s key in your browser...');
      const k = await pqKeygen();
      setKey(k);
      setSaved(false);
      downloadKeyFile(k, `leash-pq-key-${k.publicKey.slice(2, 10)}.json`);
      status('Key generated and downloaded.', 'ok');
    });

  const create = () =>
    run(async () => {
      if (!deployment.factory) throw new Error('Leash is not deployed yet');
      const hours = Number(delayH);
      if (!(hours >= 1)) throw new Error('Recovery delay must be at least 1 hour');
      const value = deposit.trim() === '' ? 0n : parseUsd(deposit);
      const w = await walletClient();
      status('Confirm in your wallet...');
      const hash = await w.writeContract({
        address: deployment.factory,
        abi: factoryAbi,
        functionName: 'createVault',
        args: [key!.publicKey as Hex, BigInt(Math.round(hours * 3600))],
        value,
        chain: w.chain,
        account: w.account,
      });
      status('Waiting for Arc to finalize...', 'info', hash);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: factoryAbi, ...log });
          if (ev.eventName === 'VaultCreated') setVault(ev.args.vault);
        } catch {}
      }
      status('Vault created.', 'ok', hash);
    });

  const step = (n: number, done: boolean, title: string, body: React.ReactNode) => (
    <div className={`step ${done ? 'done' : ''}`}>
      <span className="n">{done ? '✓' : n}</span>
      <div className="stack">
        <h3>{title}</h3>
        {body}
      </div>
    </div>
  );

  return (
    <div className="wrap section" style={{ maxWidth: 760 }}>
      <h2 style={{ fontSize: 28, marginBottom: 6 }}>Create a vault</h2>
      <p className="sub" style={{ marginBottom: 24, fontSize: 15 }}>
        Your vault gets two keys. Your normal wallet runs it day to day. A post-quantum SLH-DSA key, kept offline, is the
        only thing that can add agents, raise caps or move money out.
      </p>
      <div className="card">
        <div className="steps">
          {step(
            1,
            !!key && saved,
            'Generate your post-quantum key',
            <>
              <p className="sub">
                Generated here with @noble/post-quantum and downloaded as a JSON file. Nothing is sent anywhere. For more
                safety, generate it on an offline machine with <code>node tools/pq.mjs keygen</code> from the repo.
              </p>
              {key ? (
                <div className="keybox">
                  <div className="sub">Public key fingerprint</div>
                  <div className="fp">{fingerprint(key.publicKey)}</div>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <button className="btn small" onClick={() => downloadKeyFile(key, `leash-pq-key-${key.publicKey.slice(2, 10)}.json`)}>
                      Download again
                    </button>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I stored the key file somewhere safe
                    </label>
                  </div>
                </div>
              ) : (
                <div>
                  <button className="btn pq" disabled={busy} onClick={gen}>Generate key</button>
                </div>
              )}
            </>,
          )}
          {step(
            2,
            !!vault,
            'Fund and create the vault',
            <>
              <div className="row">
                <label className="field">
                  Opening deposit (USDC)
                  <input className="input" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
                </label>
                <label className="field">
                  Recovery delay (hours, min 1)
                  <input className="input" value={delayH} onChange={(e) => setDelayH(e.target.value)} inputMode="numeric" />
                </label>
              </div>
              <p className="sub">Creating a vault costs about $0.06 in gas, paid in USDC.</p>
              <div>
                {account ? (
                  <button className="btn primary" disabled={!key || !saved || busy || !!vault} onClick={create}>
                    Create vault
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => run(connect)}>
                    Connect wallet
                  </button>
                )}
              </div>
            </>,
          )}
          {step(
            3,
            false,
            'Add your first agent',
            vault ? (
              <>
                <p className="sub">
                  Vault <code>{vault}</code> is live. Open it, load your key file and add an agent address with a daily cap.
                </p>
                <div className="row">
                  <a className="btn primary" href={`#/vault/${vault}`}>Open vault</a>
                  <a className="btn" href={`#/agent/${vault}`}>Create a test agent</a>
                </div>
              </>
            ) : (
              <p className="sub">After the vault exists, add agents from its page. The agent console can make a throwaway agent key for testing.</p>
            ),
          )}
        </div>
        <div style={{ marginTop: 16 }}>
          <StatusLine s={s} />
        </div>
      </div>
    </div>
  );
}
