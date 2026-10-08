# Leash

**Quantum-safe spending limits for AI agents, live on Arc mainnet.**

Leash is a USDC vault for AI agents. An agent spends with its own hot key under a hard daily cap in dollars, and that cap already includes the agent's gas. Anything that raises risk (adding an agent, raising a cap, withdrawing, unfreezing) needs a post-quantum SLH-DSA signature from the owner's cold key, verified on-chain by Arc's PQ precompile.

- Live app: https://ngjupeng.github.io/leash/
- Live demo vault: see [Mainnet deployment](#mainnet-deployment)

## The problem

Agents need money to be useful, and an agent's key is a hot key that lives on a server next to a model that can be prompt-injected. Today you either give an agent a wallet (and hope) or keep a human in the loop (and lose the point). Meanwhile the owner's own key is a classical ECDSA key, which is the long-lived secret most exposed to future quantum attacks.

## How Leash works

Three keys, three levels of power:

| Key | Can do | Can't do |
| --- | --- | --- |
| **Agent key** (classical, hot) | `pay(to, amount, data, memo)` within its daily cap, before its expiry, to allowed payees | Exceed the cap, touch the vault's admin, call the USDC ERC-20 interface |
| **Owner wallet** (classical) | Reduce risk: `freeze`, `revokeAgent`, `lowerCap`, `removePayee`, `cancelRecovery` | Anything that raises risk |
| **Owner wallet + SLH-DSA key** (post-quantum, cold) | `guarded(call, pqSig)`: `setAgent`, `withdraw`, `unfreeze`, `setPayee`, `setPayeeAllowlist`, `rotatePqKey`, `transferOwnership`, `setRecoveryDelay` | |
| **SLH-DSA key alone** | `startRecovery(newOwner, pqSig)`: moves ownership after a timelock, freezing agents meanwhile | Skip the timelock, or beat the owner's `cancelRecovery` |

A stolen agent key costs at most one day's cap. A stolen owner key can only freeze and shrink things. Raising the stakes always needs both the classical owner transaction and the post-quantum signature, which is exactly the hybrid pattern Arc's precompile docs recommend.

### The cap is all-in

After each payment the vault measures the agent's gas, refunds it **in USDC** to the agent and counts the refund against the cap. On Arc gas is USDC, so the payment and its gas are the same dollars:

- A $5 cap means the vault can lose at most $5 a day to that agent, gas included.
- The agent's gas float never drains, so an agent needs a few cents once and then runs indefinitely.
- Measured on Arc mainnet: refunds match the real gas cost to within 0.1%.

On a chain with a volatile gas token you can't express "this agent may cost me at most $5 a day", because part of its cost is in a different asset.

### The audit log is in the vault

Arc's RPC limits `eth_getLogs` to about 5,000 blocks (roughly 40 minutes), and the explorer API sits behind bot protection. Because Arc gas is priced in fractions of a cent, every vault simply keeps its last 64 payments (agent, payee, amount, gas refund, memo, time, block) in contract storage. The dashboard reads it with one `eth_call`, no indexer needed.

## Why this only works on Arc

| Arc feature | What Leash does with it |
| --- | --- |
| **PQ Signature Verify precompile** (`0x1800000000000000000000000000000000000004`, SLH-DSA-SHA2-128s, FIPS 205) | Every risk-raising action is gated on a 7,856-byte hash-based signature, checked for 230k gas (about $0.008). Other EVM chains have no such precompile, and verifying SLH-DSA in Solidity is impractically expensive. |
| **USDC is the native gas token** | Gas refunds in the same asset as payments, so the daily cap is a true dollar bound. `msg.value` is USDC, so agents can pay any allowlisted contract with USDC attached and no approvals. |
| **Deterministic sub-second finality** | A freeze is final in under a second with no reorg risk. Payees can deliver as soon as the receipt lands. |
| **Stable, dollar-priced fees** | On-chain receipts cost about a third of a cent per payment, so the vault is its own audit log. |

## Architecture

```
src/
  IPQ.sol            Arc PQ precompile interface (mirrors circlefin/arc-node)
  LeashVault.sol     The vault: policies, pay(), gas refunds, guarded(), recovery, receipt ring
  LeashFactory.sol   Deploys vaults and indexes them by creator
test/
  LeashVault.t.sol   27 tests under Arc rules with real SLH-DSA signatures
tools/
  pq.mjs             Offline SLH-DSA keygen and signing (works air-gapped)
  demo.mjs           Deploys and runs the end-to-end demo on Arc
  export-web.mjs     Copies ABIs and deployment into the web app
web/                 Vite + React + viem dashboard, PQ signing in a Web Worker
```

### Post-quantum guard

```solidity
function guarded(bytes calldata call, bytes calldata pqSig) external onlyOwner nonReentrant returns (bytes memory) {
    uint256 nonce = pqNonce;
    _verifyPq(guardDigest(call), pqSig);   // Arc precompile 0x1800...0004
    pqNonce = nonce + 1;                   // each signature is single use
    _inGuard = true;
    (bool ok, bytes memory ret) = address(this).call(call);
    ...
}

function guardDigest(bytes calldata call) public view returns (bytes32) {
    return keccak256(abi.encode(GUARD_TYPEHASH, block.chainid, address(this), pqNonce, keccak256(call)));
}
```

The signature binds the chain, the vault, a nonce and the exact calldata, so it can't be replayed, redirected or reused for a different call. Guarded functions check `msg.sender == address(this)` and a transient flag set only inside `guarded()`.

### Signing

SLH-DSA signatures come from [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) (FIPS 205 pure mode, empty context), which is compatible with Arc's precompile (it uses the RustCrypto `slh-dsa` crate). Signing takes about one second, so the web app signs in a Web Worker. The key file never leaves the browser tab. For stronger setups, generate and sign on an offline machine:

```sh
node tools/pq.mjs keygen - my-vault.pqkey.json      # prints the 32-byte public key
node tools/pq.mjs sign my-vault.pqkey.json 0x<guardDigest>
```

## Run it

Requirements: [Arc Foundry](https://github.com/circlefin/arc-foundry) (`arc-forge`), Node 20+.

```sh
npm install
arc-forge test                  # runs under Arc rules, PQ precompile included
cp .env.example .env            # add a funded Arc key
node tools/demo.mjs             # deploys and runs the demo on Arc mainnet
node tools/export-web.mjs
cd web && npm install && npm run dev
```

To rehearse against a mainnet fork first:

```sh
arc-anvil --fork-url https://rpc.mainnet.arc.io --port 8547
RPC=http://127.0.0.1:8547 node tools/demo.mjs
```

## Mainnet deployment

Arc mainnet, chain id 5042.

DEPLOYMENT_TABLE

## Gas on Arc mainnet

| Action | Gas | Cost in USDC |
| --- | --- | --- |
GAS_TABLE

## Security notes

- Unaudited, experimental software built for the Arc Microgrants program. Use small amounts.
- The SLH-DSA key in the browser flow is generated with `crypto.getRandomValues`. For real funds, generate it offline with `tools/pq.mjs`.
- `eth_estimateGas` runs at a zero gas price, which makes `pay()` skip its refund while estimating. Clients add 60k gas of headroom (see `PAY_GAS_HEADROOM`).
- The gas refund price is capped at twice the base fee, and every refund counts against the agent's cap, so an agent can't drain the vault by bidding up gas.
- Agents can't call the vault or the USDC ERC-20 interface (`0x3600...`), which moves the same native balance outside `pay()` accounting. Calldata is only allowed to owner-allowlisted payees.

## Roadmap

- x402 middleware so agents pay HTTP 402 paywalls straight from a vault
- ERC-8004 agent identity (the registries are already on Arc mainnet) shown next to each agent
- Per-payee caps and category budgets
- Circle Wallets integration for agents and hardware-backed PQ signing for owners
- Native post-quantum transaction signing once Arc ships EIP-8141 frame transactions

## License

MIT
