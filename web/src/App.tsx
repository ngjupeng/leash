import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { Logo } from './components/ui';
import { deployment } from './deployment';
import { explorerAddress } from './lib/chain';
import { short } from './lib/format';
import { connect, useAccount } from './lib/wallet';
import { Home } from './pages/Home';
import { Create } from './pages/Create';
import { VaultPage } from './pages/Vault';
import { AgentConsole } from './pages/Agent';
import { MyVaults } from './pages/MyVaults';

export const REPO_URL = 'https://github.com/ngjupeng/leash';

function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash.slice(1));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^\//, '');
}

export function App() {
  const route = useRoute();
  const account = useAccount();
  const [connectErr, setConnectErr] = useState<string | null>(null);

  let page;
  const [head, arg] = route.split('/');
  if (head === 'vault' && arg && isAddress(arg)) page = <VaultPage address={arg as Address} />;
  else if (head === 'create') page = <Create />;
  else if (head === 'agent') page = <AgentConsole initialVault={arg && isAddress(arg) ? (arg as Address) : null} />;
  else if (head === 'vaults') page = <MyVaults />;
  else page = <Home />;

  const on = (h: string) => (head === h ? 'on' : '');

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="#/">
            <Logo /> Leash
          </a>
          <nav className="nav">
            {deployment.demoVault && (
              <a className={head === 'vault' && arg === deployment.demoVault ? 'on' : ''} href={`#/vault/${deployment.demoVault}`}>
                Live demo
              </a>
            )}
            <a className={on('create')} href="#/create">Create vault</a>
            <a className={on('vaults')} href="#/vaults">My vaults</a>
            <a className={on('agent')} href="#/agent">Agent console</a>
          </nav>
          <span className="spacer" />
          <span className="chip">
            <span className="dot" /> Arc mainnet
          </span>
          {account ? (
            <a className="btn small" href={explorerAddress(account)} target="_blank" rel="noreferrer">
              {short(account)}
            </a>
          ) : (
            <button className="btn small" onClick={() => connect().catch((e) => setConnectErr(e.message))} title={connectErr ?? ''}>
              Connect wallet
            </button>
          )}
        </div>
      </header>
      <main>{page}</main>
      <footer className="foot">
        <div className="wrap">
          <div className="links">
            <a href={REPO_URL} target="_blank" rel="noreferrer">Source on GitHub</a>
            {deployment.factory && (
              <a href={explorerAddress(deployment.factory)} target="_blank" rel="noreferrer">
                LeashFactory {short(deployment.factory)}
              </a>
            )}
            <a href={explorerAddress('0x1800000000000000000000000000000000000004')} target="_blank" rel="noreferrer">
              Arc PQ precompile
            </a>
            <a href="https://docs.arc.io/arc/concepts/post-quantum-security" target="_blank" rel="noreferrer">
              Arc post-quantum docs
            </a>
          </div>
          <p>Leash is experimental software. Arc recommends pairing post-quantum signatures with classical ones, which is exactly what Leash does.</p>
        </div>
      </footer>
    </>
  );
}
