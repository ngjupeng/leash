import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { factoryAbi } from '../abi';
import { Addr } from '../components/ui';
import { deployment } from '../deployment';
import { publicClient } from '../lib/chain';
import { usd } from '../lib/format';
import { connect, useAccount } from '../lib/wallet';

export function MyVaults() {
  const account = useAccount();
  const [vaults, setVaults] = useState<{ address: Address; balance: bigint }[] | null>(null);
  const [open, setOpen] = useState('');

  useEffect(() => {
    if (!account || !deployment.factory) return;
    setVaults(null);
    (async () => {
      const list = await publicClient.readContract({ address: deployment.factory!, abi: factoryAbi, functionName: 'vaultsOf', args: [account] });
      const balances = await Promise.all(list.map((a) => publicClient.getBalance({ address: a })));
      setVaults(list.map((a, i) => ({ address: a, balance: balances[i] })).reverse());
    })().catch(() => setVaults([]));
  }, [account]);

  return (
    <div className="wrap section" style={{ maxWidth: 760 }}>
      <h2 style={{ fontSize: 28, marginBottom: 18 }}>My vaults</h2>
      <div className="card stack">
        {!account ? (
          <div>
            <button className="btn primary" onClick={() => connect()}>Connect wallet</button>
          </div>
        ) : vaults === null ? (
          <p className="sub">Reading from Arc...</p>
        ) : vaults.length === 0 ? (
          <p className="sub">
            No vaults created from this wallet. <a href="#/create">Create one</a>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Vault</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vaults.map((v) => (
                <tr key={v.address}>
                  <td><Addr a={v.address} full /></td>
                  <td className="num">{usd(v.balance)}</td>
                  <td className="num"><a className="btn small" href={`#/vault/${v.address}`}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="divider" />
        <div className="row">
          <label className="field">
            Open any vault by address
            <input className="input mono" value={open} onChange={(e) => setOpen(e.target.value.trim())} placeholder="0x..." />
          </label>
          <a className="btn" href={isAddress(open) ? `#/vault/${open}` : undefined} aria-disabled={!isAddress(open)}>Open</a>
        </div>
        <p className="sub">This list shows vaults created by the connected wallet. A vault that changed owner still opens by address.</p>
      </div>
    </div>
  );
}
