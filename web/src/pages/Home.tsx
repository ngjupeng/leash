import { useEffect, useState } from 'react';
import { factoryAbi } from '../abi';
import { Stat } from '../components/ui';
import { deployment } from '../deployment';
import { publicClient } from '../lib/chain';
import { usd } from '../lib/format';
import { useVault } from '../lib/vault';

export function Home() {
  const demo = useVault(deployment.demoVault);
  const [vaultCount, setVaultCount] = useState<bigint | null>(null);
  useEffect(() => {
    if (!deployment.factory) return;
    publicClient.readContract({ address: deployment.factory, abi: factoryAbi, functionName: 'vaultCount' }).then(setVaultCount).catch(() => {});
  }, []);
  const v = demo.state;
  const agentSpend = v?.receipts.reduce((s, r) => s + r.amount, 0n);
  const gasRefunded = v?.receipts.reduce((s, r) => s + r.gasRefund, 0n);

  return (
    <div className="wrap">
      <section className="hero">
        <span className="chip pq" style={{ justifySelf: 'start' }}>
          <span className="dot" /> SLH-DSA verified on-chain by Arc
        </span>
        <h1>
          Give AI agents a dollar budget. Keep the keys <em>quantum-safe</em>.
        </h1>
        <p className="lede">
          Leash is a USDC vault on Arc. Agents spend under a hard daily cap that already includes their gas. Anything that
          raises risk, like adding an agent, raising a cap or withdrawing, needs a post-quantum signature from your cold
          key, checked on-chain by Arc&apos;s SLH-DSA precompile.
        </p>
        <div className="ctas">
          {deployment.demoVault && (
            <a className="btn primary" href={`#/vault/${deployment.demoVault}`}>
              Open the live demo vault
            </a>
          )}
          <a className="btn" href="#/create">
            Create your own vault
          </a>
          <a className="btn" href="#/agent">
            Try the agent console
          </a>
        </div>
      </section>

      {v && (
        <section className="section">
          <div className="card">
            <div className="card-head">
              <h3>Live on Arc mainnet</h3>
              <span className="spacer" />
              <span className="sub">Read straight from the chain, refreshed every few seconds</span>
            </div>
            <div className="grid four">
              <Stat label="Vaults created" value={vaultCount?.toString() ?? '...'} note="Through LeashFactory" />
              <Stat label="Agent payments" value={v.paymentCount.toString()} note={`${usd(agentSpend ?? 0n)} spent in the demo vault`} />
              <Stat label="Gas refunded to agents" value={usd(gasRefunded ?? 0n, 4)} note="Counted inside each agent's cap" />
              <Stat label="Post-quantum approvals" value={v.pqNonce.toString()} note="SLH-DSA signatures accepted" />
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <h2>Three keys, three levels of power</h2>
        <p className="sub">Losing a hot key costs at most one day&apos;s budget. Raising the stakes always takes the cold, post-quantum key.</p>
        <div className="grid three">
          <div className="card tier">
            <div className="who">
              <span className="chip">Agent key</span>
            </div>
            <h3>Spends inside its leash</h3>
            <ul>
              <li>Pays any address, or calls allowlisted contracts with USDC attached</li>
              <li>Hard daily cap in dollars, gas included</li>
              <li>Optional expiry, so a key dies on schedule</li>
              <li>Gas refunded in USDC, so its float never drains</li>
            </ul>
          </div>
          <div className="card tier">
            <div className="who">
              <span className="chip muted">Owner wallet</span>
            </div>
            <h3>Can only reduce risk</h3>
            <ul>
              <li>Freeze every agent instantly</li>
              <li>Revoke an agent or lower its cap</li>
              <li>Remove a payee</li>
              <li>Cancel a pending recovery</li>
            </ul>
          </div>
          <div className="card tier">
            <div className="who">
              <span className="chip pq">Owner wallet + SLH-DSA key</span>
            </div>
            <h3>Required to raise risk</h3>
            <ul>
              <li>Add an agent or raise a cap</li>
              <li>Withdraw, unfreeze, change payees</li>
              <li>Rotate keys or transfer ownership</li>
              <li>The PQ key alone can start a timelocked recovery</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Why this only works on Arc</h2>
        <p className="sub">Each of these is a protocol feature of Arc mainnet today, not something Leash bolts on.</p>
        <div className="grid pairs">
          <div className="card why">
            <span className="k">precompile 0x1800...0004</span>
            <h3>Post-quantum signatures for under a cent</h3>
            <p>
              Arc verifies SLH-DSA-SHA2-128s (FIPS 205) natively for 230k gas. A guarded action costs about $0.01 end to
              end. Other EVM chains have no such precompile, and checking a 7,856-byte hash-based signature in Solidity is
              impractically expensive.
            </p>
          </div>
          <div className="card why">
            <span className="k">USDC is the gas token</span>
            <h3>A cap that is really all-in</h3>
            <p>
              Gas and payments are the same dollars, so the vault refunds each agent&apos;s gas in USDC and counts it
              against the cap. A $5 cap is $5 total. On chains with a volatile gas token, an agent&apos;s true cost
              can&apos;t be bounded in dollars.
            </p>
          </div>
          <div className="card why">
            <span className="k">deterministic finality</span>
            <h3>A freeze is final in under a second</h3>
            <p>
              Arc blocks finalize with no reorgs. When you freeze a vault, no agent payment can land after it, and a
              merchant receiving from an agent can deliver immediately.
            </p>
          </div>
          <div className="card why">
            <span className="k">stable, dollar-priced fees</span>
            <h3>The audit log lives on-chain</h3>
            <p>
              Gas costs fractions of a cent, so every vault keeps its last 64 payments in contract storage, including the
              gas refund and a memo. The dashboard reads it directly from the vault, with no indexer.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
