import { useEffect, useMemo, useState } from 'react';
import { createWalletClient, isAddress, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { vaultAbi } from '../abi';
import { Addr, Meter, Stat, StatusLine, useStatus } from '../components/ui';
import { deployment } from '../deployment';
import { arc, arcTransport, explorerTx, PAY_GAS_HEADROOM, publicClient } from '../lib/chain';
import { parseUsd, short, usd, usdPrecise } from '../lib/format';
import { useVault } from '../lib/vault';
import { walletClient } from '../lib/wallet';

const STORE = 'leash.agentKey';

function loadAgentKey(): Hex {
  try {
    const k = localStorage.getItem(STORE);
    if (k && /^0x[0-9a-f]{64}$/i.test(k)) return k as Hex;
  } catch {}
  const k = generatePrivateKey();
  try {
    localStorage.setItem(STORE, k);
  } catch {}
  return k;
}

type Result = { amount: bigint; gasCost: bigint; refund: bigint; ms: number; hash: Hex };

export function AgentConsole({ initialVault }: { initialVault: Address | null }) {
  const [pk, setPk] = useState<Hex>(loadAgentKey);
  const account = useMemo(() => privateKeyToAccount(pk), [pk]);
  const agent = useMemo(() => createWalletClient({ chain: arc, transport: arcTransport(), account }), [account]);
  const [vaultInput, setVaultInput] = useState<string>(initialVault ?? '');
  const vaultAddr = isAddress(vaultInput) ? (vaultInput as Address) : null;
  const { state: v, refresh } = useVault(vaultAddr, 3000);
  const [bal, setBal] = useState<bigint | null>(null);
  const [to, setTo] = useState('0x000000000000000000000000000000000000dEaD');
  const [amt, setAmt] = useState('0.01');
  const [memo, setMemo] = useState('api: weather lookup');
  const [results, setResults] = useState<Result[]>([]);
  const [s, status, run, busy] = useStatus();
  const [fs, fstatus, frun, fbusy] = useStatus();

  useEffect(() => {
    const tick = () => publicClient.getBalance({ address: account.address }).then(setBal).catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [account.address]);

  const me = v?.agents.find((a) => a.agent.toLowerCase() === account.address.toLowerCase());
  const isDemo = vaultAddr && deployment.demoVault?.toLowerCase() === vaultAddr.toLowerCase();

  const pay = (amount: string, note: string) =>
    run(async () => {
      if (!vaultAddr) throw new Error('Enter a vault address');
      if (!isAddress(to)) throw new Error('Enter a valid recipient');
      const value = parseUsd(amount);
      const args = [to as Address, value, '0x', stringToHex(note.slice(0, 32), { size: 32 })] as const;
      const { request } = await publicClient.simulateContract({ address: vaultAddr, abi: vaultAbi, functionName: 'pay', args, account });
      const gas = (await publicClient.estimateContractGas({ address: vaultAddr, abi: vaultAbi, functionName: 'pay', args, account })) + PAY_GAS_HEADROOM;
      status('Agent signing and sending (no wallet popup, this is the agent’s own key)...');
      const t0 = performance.now();
      const hash = await agent.writeContract({ ...request, gas });
      const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 150 });
      const ms = Math.round(performance.now() - t0);
      if (r.status !== 'success') throw new Error('Payment reverted');
      const [latest] = await publicClient.readContract({ address: vaultAddr, abi: vaultAbi, functionName: 'recentPayments', args: [1n] });
      setResults((rs) => [{ amount: value, gasCost: r.gasUsed * r.effectiveGasPrice, refund: latest.gasRefund, ms, hash }, ...rs].slice(0, 8));
      status(`Paid ${usd(value)} and final on Arc, ${ms} ms from send to receipt.`, 'ok', hash);
      refresh();
    });

  return (
    <div className="wrap section">
      <h2 style={{ fontSize: 28, marginBottom: 6 }}>Agent console</h2>
      <p className="sub" style={{ marginBottom: 24, fontSize: 15, maxWidth: '70ch' }}>
        This page acts as an AI agent with its own hot key, kept in this browser. It can only spend what a vault owner
        allows, and every payment it makes is checked against its daily cap on-chain. Try to overspend: the vault refuses.
      </p>

      <div className="grid two">
        <div className="card stack">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3>1. This agent&apos;s key</h3>
          </div>
          <div className="kv"><span className="k">Agent address</span><span className="v"><Addr a={account.address} full /></span></div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="btn small" onClick={() => navigator.clipboard.writeText(account.address)}>Copy address</button>
            <button
              className="btn small"
              onClick={() => {
                if (!confirm('Replace this agent key with a new one? Any USDC on the current key stays with it.')) return;
                const k = generatePrivateKey();
                try { localStorage.setItem(STORE, k); } catch {}
                setPk(k);
                setResults([]);
              }}
            >
              New agent key
            </button>
          </div>
          <p className="sub">
            Give this address to the vault owner. They add it on the vault page with a daily cap, signed by their post-quantum key.
          </p>
          <div className="divider" />
          <Stat label="Gas float" value={usd(bal, 4)} note="Needs a few cents once. The vault refunds gas after every payment." />
          <div className="row">
            <button
              className="btn"
              disabled={fbusy}
              onClick={() =>
                frun(async () => {
                  const w = await walletClient();
                  fstatus('Confirm in your wallet...');
                  const hash = await w.sendTransaction({ to: account.address, value: parseUsd('0.02'), chain: w.chain, account: w.account });
                  await publicClient.waitForTransactionReceipt({ hash });
                  fstatus('Sent $0.02 for gas.', 'ok', hash);
                })
              }
            >
              Send $0.02 gas float from my wallet
            </button>
          </div>
          <StatusLine s={fs} />
        </div>

        <div className="card stack">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3>2. Vault to spend from</h3>
          </div>
          <label className="field">
            Vault address
            <input className="input mono" value={vaultInput} onChange={(e) => setVaultInput(e.target.value.trim())} placeholder="0x..." />
          </label>
          {deployment.demoVault && !vaultInput && (
            <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => setVaultInput(deployment.demoVault!)}>
              Use the live demo vault
            </button>
          )}
          {v && (
            me?.active ? (
              <>
                <div className="grid two" style={{ gap: 12 }}>
                  <Stat label="Remaining today" value={usd(me.remaining, 4)} />
                  <Stat label="Daily cap" value={usd(me.dailyCap)} />
                </div>
                <Meter used={me.spent} total={me.dailyCap} />
                {v.frozen && <div className="status error">The owner froze this vault. Payments will be refused.</div>}
              </>
            ) : (
              <div className="status">
                This agent is not authorised on this vault yet.{' '}
                {isDemo ? 'The demo vault only funds its own demo agent, so create your own vault to try this end to end.' : 'Ask the owner to add it.'}{' '}
                <a href={vaultAddr ? `#/vault/${vaultAddr}` : '#/'}>Open vault</a>
              </div>
            )
          )}
        </div>
      </div>

      <div className="card stack" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h3>3. Spend</h3>
          <span className="spacer" />
          <StatusLine s={s} />
        </div>
        <div className="row">
          <label className="field" style={{ flexBasis: 320 }}>
            Pay to
            <input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          </label>
          <label className="field">
            Amount (USDC)
            <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            Memo (stored on-chain)
            <input className="input" value={memo} maxLength={32} onChange={(e) => setMemo(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy || !me?.active} onClick={() => pay(amt, memo)}>Pay</button>
        </div>
        <div className="row">
          <button className="btn small" disabled={busy || !me?.active} onClick={() => pay('0.01', 'api: search query')}>Buy an API call for $0.01</button>
          <button className="btn small" disabled={busy || !me?.active} onClick={() => pay('0.05', 'data: market feed 1h')}>Buy a data feed for $0.05</button>
          <button className="btn small danger" disabled={busy || !me?.active} onClick={() => pay(me ? (Number(me.remaining) / 1e18 + 1).toFixed(2) : '1000', 'try to overspend')}>
            Try to overspend the cap
          </button>
        </div>
        {results.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Paid</th>
                  <th className="num">Gas the agent paid</th>
                  <th className="num">Refunded by vault</th>
                  <th className="num">Send to final</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.hash}>
                    <td className="num">{usd(r.amount)}</td>
                    <td className="num mono">{usdPrecise(r.gasCost)}</td>
                    <td className="num mono">{usdPrecise(r.refund)}</td>
                    <td className="num">{r.ms} ms</td>
                    <td>
                      <a className="mono" href={explorerTx(r.hash)} target="_blank" rel="noreferrer">{short(r.hash)}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
