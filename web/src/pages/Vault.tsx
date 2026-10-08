import { useState } from 'react';
import { isAddress, type Address, type Hex } from 'viem';
import { Addr, Meter, Stat, StatusLine, useStatus } from '../components/ui';
import { PqKeyLoader } from '../components/PqKeyLoader';
import { deployment } from '../deployment';
import { explorerBlock, publicClient } from '../lib/chain';
import { ago, memoText, parseUsd, until, usd, usdPrecise } from '../lib/format';
import { downloadKeyFile, fingerprint, pqKeygen, type PqKeyFile } from '../lib/pq';
import { guardedTx, hasRecovery, ownerTx, startRecoveryTx, useVault, type VaultState } from '../lib/vault';
import { useAccount, useNow, walletClient } from '../lib/wallet';

const hours = (secs: bigint) => {
  const h = Number(secs) / 3600;
  return `${h} hour${h === 1 ? '' : 's'}`;
};

export function VaultPage({ address }: { address: Address }) {
  const { state: v, error, refresh } = useVault(address);
  const account = useAccount();
  const now = useNow(5000);

  if (error && !v) {
    return (
      <div className="wrap section">
        <div className="card">
          <h3>Couldn&apos;t read this vault</h3>
          <p className="sub">{error}</p>
          <p className="sub" style={{ marginTop: 8 }}>
            The app tried every Arc RPC endpoint. If this keeps happening, a browser extension or network filter may be blocking requests to
            rpc.mainnet.arc.io. Try a private window or another network.
          </p>
        </div>
      </div>
    );
  }
  if (!v) return <div className="wrap section sub">Reading vault from Arc...</div>;

  const isOwner = !!account && account.toLowerCase() === v.owner.toLowerCase();
  const isDemo = deployment.demoVault?.toLowerCase() === address.toLowerCase();
  const activeAgents = v.agents.filter((a) => a.active);

  return (
    <div className="wrap">
      <section className="vault-head">
        <h1>
          Vault
          {v.frozen ? <span className="chip danger">Frozen</span> : <span className="chip"><span className="dot" /> Active</span>}
          {hasRecovery(v) && <span className="chip warn">Recovery pending</span>}
          {isDemo && <span className="chip muted">Live demo</span>}
          {isOwner && <span className="chip pq">You own this vault</span>}
        </h1>
        <div className="card">
          <div className="grid four">
            <Stat label="Balance" value={usd(v.balance)} note="Native USDC on Arc" />
            <Stat label="Active agents" value={activeAgents.length} note={`${v.agents.length} ever added`} />
            <Stat label="Payments" value={v.paymentCount.toString()} note="Last 64 kept on-chain" />
            <Stat label="PQ approvals" value={v.pqNonce.toString()} note="SLH-DSA signatures used" />
          </div>
          <div className="divider" style={{ margin: '18px 0' }} />
          <div className="facts">
            <div className="kv"><span className="k">Vault address</span><span className="v"><Addr a={v.address} full /></span></div>
            <div className="kv"><span className="k">Owner (classical key)</span><span className="v"><Addr a={v.owner} full /></span></div>
            <div className="kv"><span className="k">Post-quantum key fingerprint</span><span className="v" title={v.pqKey}>{fingerprint(v.pqKey)}</span></div>
            <div className="kv"><span className="k">Recovery delay</span><span className="v">{hours(v.recoveryDelay)}</span></div>
            <div className="kv"><span className="k">Payees</span><span className="v">{v.payeeAllowlistOn ? 'Allowlist only' : 'Any address'}</span></div>
          </div>
        </div>
      </section>

      <div className="grid" style={{ gap: 16 }}>
        <AgentsCard v={v} now={now} />
        <ActivityCard v={v} />
        {isOwner && <OwnerPanel v={v} onDone={refresh} />}
        <div className="grid pairs">
          <DepositCard v={v} onDone={refresh} />
          <RecoveryCard v={v} now={now} isOwner={isOwner} onDone={refresh} />
        </div>
        {!isOwner && (
          <p className="sub" style={{ textAlign: 'center' }}>
            {account ? 'The connected wallet does not own this vault, so owner controls are hidden.' : 'Connect the owner wallet to manage this vault.'}{' '}
            Agents use the <a href={`#/agent/${v.address}`}>agent console</a>.
          </p>
        )}
      </div>
    </div>
  );
}

function AgentsCard({ v, now }: { v: VaultState; now: number }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Agents</h3>
        <span className="spacer" />
        <span className="sub">Caps reset 24 hours after an agent&apos;s window opens</span>
      </div>
      {v.agents.length === 0 ? (
        <div className="empty">No agents yet. The owner adds one with a post-quantum signature.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th className="num">Daily cap</th>
                <th className="num">Spent incl. gas</th>
                <th>Used</th>
                <th className="num">Remaining</th>
                <th>Window resets</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {v.agents.map((a) => {
                const expired = a.expiresAt !== 0n && Number(a.expiresAt) < now;
                return (
                  <tr key={a.agent}>
                    <td><Addr a={a.agent} /></td>
                    <td>
                      {!a.active ? <span className="chip muted">Revoked</span> : expired ? <span className="chip warn">Expired</span> : v.frozen ? <span className="chip danger">Frozen</span> : <span className="chip">Live</span>}
                    </td>
                    <td className="num">{usd(a.dailyCap)}</td>
                    <td className="num">{usd(a.spent, 4)}</td>
                    <td><Meter used={a.spent} total={a.dailyCap} /></td>
                    <td className="num">{usd(a.remaining, 4)}</td>
                    <td>{until(Number(a.windowStart) + 86400)}</td>
                    <td>{a.expiresAt === 0n ? 'Never' : expired ? 'Expired' : until(Number(a.expiresAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityCard({ v }: { v: VaultState }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Agent payments</h3>
        <span className="spacer" />
        <span className="sub">Stored in the vault itself, newest first</span>
      </div>
      {v.receipts.length === 0 ? (
        <div className="empty">No payments yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Paid to</th>
                <th>Memo</th>
                <th className="num">Amount</th>
                <th className="num">Gas refunded</th>
                <th>Block</th>
              </tr>
            </thead>
            <tbody>
              {v.receipts.map((r, i) => (
                <tr key={`${r.blockNumber}-${i}`}>
                  <td title={new Date(r.time * 1000).toLocaleString()}>{ago(r.time)}</td>
                  <td><Addr a={r.agent} /></td>
                  <td><Addr a={r.to} /></td>
                  <td>{memoText(r.memo) || <span className="sub">None</span>}</td>
                  <td className="num">{usd(r.amount, 2)}</td>
                  <td className="num mono">{usdPrecise(r.gasRefund)}</td>
                  <td>
                    <a className="mono" href={explorerBlock(r.blockNumber)} target="_blank" rel="noreferrer">
                      {r.blockNumber.toString()}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OwnerPanel({ v, onDone }: { v: VaultState; onDone: () => void }) {
  const [key, setKey] = useState<PqKeyFile | null>(null);
  const [s, status, run, busy] = useStatus();
  const done = () => onDone();

  // Classical, risk-reducing
  const [agentSel, setAgentSel] = useState('');
  const [lower, setLower] = useState('');

  // Guarded
  const [newAgent, setNewAgent] = useState('');
  const [cap, setCap] = useState('5');
  const [expiryH, setExpiryH] = useState('');
  const [wTo, setWTo] = useState('');
  const [wAmt, setWAmt] = useState('');
  const [payee, setPayee] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [rotated, setRotated] = useState<PqKeyFile | null>(null);

  // Arguments are built inside run() so validation errors show in the status line.
  const g = (fn: Parameters<typeof guardedTx>[2], args: () => readonly unknown[]) =>
    run(async () => {
      if (!key) throw new Error('Load your post-quantum key file first');
      await guardedTx(v.address, key.secretKey, fn, args(), status);
      done();
    });
  const o = (fn: Parameters<typeof ownerTx>[1], args: readonly unknown[]) =>
    run(async () => {
      await ownerTx(v.address, fn, args, status);
      done();
    });
  const addr = (a: string) => {
    if (!isAddress(a)) throw new Error('Enter a valid 0x address');
    return a as Address;
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Owner controls</h3>
        <span className="spacer" />
        <StatusLine s={s} />
      </div>
      <div className="grid two">
        <div className="stack">
          <div className="panel-title"><span className="chip muted">Owner wallet only</span> Reduce risk</div>
          <div className="row">
            <button className="btn danger" disabled={busy || v.frozen} onClick={() => o('freeze', [])}>Freeze all agents</button>
            {hasRecovery(v) && <button className="btn" disabled={busy} onClick={() => o('cancelRecovery', [])}>Cancel recovery</button>}
          </div>
          <div className="row">
            <label className="field">
              Agent
              <select className="input mono" value={agentSel} onChange={(e) => setAgentSel(e.target.value)}>
                <option value="">Select an agent</option>
                {v.agents.filter((a) => a.active).map((a) => (
                  <option key={a.agent} value={a.agent}>{a.agent}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              New lower daily cap (USDC)
              <input className="input" value={lower} onChange={(e) => setLower(e.target.value)} placeholder="1.00" inputMode="decimal" />
            </label>
            <button className="btn" disabled={busy || !agentSel} onClick={() => run(async () => { await ownerTx(v.address, 'lowerCap', [agentSel, parseUsd(lower)], status); done(); })}>Lower cap</button>
            <button className="btn danger" disabled={busy || !agentSel} onClick={() => o('revokeAgent', [agentSel])}>Revoke</button>
          </div>
          {v.payeeAllowlistOn && (
            <p className="sub">Removing a payee also only needs the owner wallet. Use the address field on the right and press Remove.</p>
          )}
        </div>

        <div className="stack">
          <div className="panel-title"><span className="chip pq">Owner wallet + SLH-DSA key</span> Raise risk</div>
          <PqKeyLoader expected={v.pqKey} value={key} onChange={setKey} />
          <fieldset disabled={!key || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12, opacity: key ? 1 : 0.55 }}>
            <div className="row">
              <label className="field" style={{ flexBasis: '100%' }}>
                Agent address
                <input className="input mono" value={newAgent} onChange={(e) => setNewAgent(e.target.value)} placeholder="0x..." />
              </label>
              <label className="field">
                Daily cap (USDC, gas included)
                <input className="input" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" />
              </label>
              <label className="field">
                Expires after (hours, blank for never)
                <input className="input" value={expiryH} onChange={(e) => setExpiryH(e.target.value)} inputMode="numeric" placeholder="Never" />
              </label>
              <button className="btn pq" onClick={() => g('setAgent', () => [addr(newAgent), parseUsd(cap), expiryH ? BigInt(Math.floor(Date.now() / 1000) + Number(expiryH) * 3600) : 0n])}>
                Add or update agent
              </button>
            </div>
            <div className="divider" />
            <div className="row">
              <label className="field">
                Withdraw to
                <input className="input mono" value={wTo} onChange={(e) => setWTo(e.target.value)} placeholder="0x..." />
              </label>
              <label className="field">
                Amount (USDC)
                <input className="input" value={wAmt} onChange={(e) => setWAmt(e.target.value)} inputMode="decimal" placeholder={usd(v.balance).slice(1)} />
              </label>
              <button className="btn pq" onClick={() => g('withdraw', () => [addr(wTo), parseUsd(wAmt)])}>Withdraw</button>
            </div>
            <div className="divider" />
            <div className="row">
              <label className="field">
                Payee contract or address
                <input className="input mono" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="0x..." />
              </label>
              <button className="btn pq" onClick={() => g('setPayee', () => [addr(payee), true])}>Allow</button>
              <button className="btn" onClick={() => run(async () => { await ownerTx(v.address, 'removePayee', [addr(payee)], status); done(); })}>Remove</button>
            </div>
            <div className="row">
              <button className="btn pq" onClick={() => g('setPayeeAllowlist', () => [!v.payeeAllowlistOn])}>
                {v.payeeAllowlistOn ? 'Let agents pay any address' : 'Restrict agents to allowlisted payees'}
              </button>
              {v.frozen && <button className="btn pq" onClick={() => g('unfreeze', () => [])}>Unfreeze</button>}
            </div>
            <div className="divider" />
            <div className="row">
              <label className="field">
                Transfer ownership to
                <input className="input mono" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="0x..." />
              </label>
              <button className="btn pq" onClick={() => g('transferOwnership', () => [addr(newOwner)])}>Transfer</button>
            </div>
            <div className="row">
              <button
                className="btn pq"
                onClick={() =>
                  run(async () => {
                    status('Generating a new SLH-DSA key...');
                    const k = { ...(await pqKeygen()), vault: v.address };
                    downloadKeyFile(k, `leash-pq-key-${v.address.slice(2, 8)}-rotated.json`);
                    setRotated(k);
                    await guardedTx(v.address, key!.secretKey, 'rotatePqKey', [k.publicKey as Hex], status);
                    setKey(k);
                    done();
                  })
                }
              >
                Rotate post-quantum key
              </button>
              {rotated && <span className="sub">New key downloaded. Store it offline.</span>}
            </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}

function DepositCard({ v, onDone }: { v: VaultState; onDone: () => void }) {
  const [amt, setAmt] = useState('1');
  const [s, status, run, busy] = useStatus();
  return (
    <div className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h3>Deposit USDC</h3>
      </div>
      <p className="sub">Anyone can top up the vault. Sending USDC on Arc to the vault address works too, from any wallet or exchange.</p>
      <div className="row">
        <label className="field">
          Amount (USDC)
          <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
        </label>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const w = await walletClient();
              status('Confirm in your wallet...');
              const hash = await w.sendTransaction({ to: v.address, value: parseUsd(amt), chain: w.chain, account: w.account });
              status('Waiting for Arc to finalize...', 'info', hash);
              await publicClient.waitForTransactionReceipt({ hash });
              status('Deposited.', 'ok', hash);
              onDone();
            })
          }
        >
          Deposit
        </button>
      </div>
      <StatusLine s={s} />
    </div>
  );
}

function RecoveryCard({ v, now, isOwner, onDone }: { v: VaultState; now: number; isOwner: boolean; onDone: () => void }) {
  const [key, setKey] = useState<PqKeyFile | null>(null);
  const [to, setTo] = useState('');
  const [s, status, run, busy] = useStatus();
  const pending = hasRecovery(v);
  const ready = pending && now >= Number(v.recoveryReadyAt);

  return (
    <div className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h3>Recovery</h3>
      </div>
      {pending ? (
        <>
          <p className="sub">
            Ownership moves to <Addr a={v.pendingOwner} /> {ready ? 'now that the delay has passed.' : `${until(Number(v.recoveryReadyAt))}.`} Agents stay frozen
            until then. {isOwner ? 'If this was not you, cancel it in the owner controls.' : 'The current owner can still cancel it.'}
          </p>
          <button
            className="btn primary"
            disabled={!ready || busy}
            onClick={() => run(async () => { await ownerTx(v.address, 'finishRecovery', [], status); onDone(); })}
          >
            Finish recovery
          </button>
        </>
      ) : (
        <>
          <p className="sub">
            Lost the owner wallet? The post-quantum key alone can move ownership after a delay of {hours(v.recoveryDelay)}. Any wallet can submit it,
            and starting a recovery freezes all agents.
          </p>
          <PqKeyLoader expected={v.pqKey} value={key} onChange={setKey} />
          <div className="row">
            <label className="field">
              New owner address
              <input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x..." />
            </label>
            <button
              className="btn pq"
              disabled={!key || busy}
              onClick={() =>
                run(async () => {
                  if (!isAddress(to)) throw new Error('Enter a valid 0x address');
                  await startRecoveryTx(v.address, key!.secretKey, to, status);
                  onDone();
                })
              }
            >
              Start recovery
            </button>
          </div>
        </>
      )}
      <StatusLine s={s} />
    </div>
  );
}
