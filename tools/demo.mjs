#!/usr/bin/env node
// Deploys Leash and runs the end-to-end demo on Arc: create a vault, give an agent a daily cap with a
// post-quantum signature, let the agent pay, show the cap and freeze holding, then unfreeze with PQ.
//
//   node tools/demo.mjs            uses ARC_RPC_URL and DEPLOYER_PRIVATE_KEY from .env
//   RPC=http://127.0.0.1:8545 node tools/demo.mjs    against a local arc-anvil fork
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, parseEther, toHex, stringToHex, BaseError, ContractFunctionRevertedError } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';
import { root, loadEnv, clients, artifact, pqSign, usd } from './lib.mjs';

loadEnv();
const rpc = process.env.RPC || process.env.ARC_RPC_URL;
const { chain, pub, wallet } = await clients(rpc);
const deployer = wallet(process.env.DEPLOYER_PRIVATE_KEY);
const Factory = artifact('LeashFactory');
const Vault = artifact('LeashVault');

const outDir = join(root, 'deployments');
mkdirSync(outDir, { recursive: true });
// A local fork keeps chain id 5042, so tag its files separately from the real deployment.
const tag = process.env.RPC ? `${chain.id}-local` : `${chain.id}`;
const outFile = join(outDir, `${tag}.json`);
const state = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { chainId: chain.id, txs: {} };
const save = () => writeFileSync(outFile, JSON.stringify(state, null, 2) + '\n');

// Demo secrets stay out of git (see .gitignore): the vault's PQ key and the agent's key.
const secretsFile = join(root, `.demo-secrets.${tag}.json`);
const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};
if (!secrets.pqSecretKey) {
  const k = slh.keygen();
  secrets.pqPublicKey = toHex(k.publicKey);
  secrets.pqSecretKey = toHex(k.secretKey);
}
secrets.agentPrivateKey ??= generatePrivateKey();
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
const agent = wallet(secrets.agentPrivateKey);
const merchant = '0x000000000000000000000000000000000000dEaD';

const log = (...a) => console.log(...a);
// eth_estimateGas runs with a zero gas price, so pay() skips its gas refund during estimation and the
// estimate comes out low. Add headroom for the refund transfer and receipt patch.
const REFUND_HEADROOM = 60_000n;
async function send(label, w, req) {
  const gas = (await pub.estimateContractGas({ ...req, account: w.account })) + REFUND_HEADROOM;
  const hash = await w.writeContract({ ...req, gas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  state.txs[label] = hash;
  save();
  log(`  ${label.padEnd(28)} ${hash}  gas ${r.gasUsed} (${usd(r.gasUsed * r.effectiveGasPrice)})`);
  return r;
}
async function expectRevert(label, w, req) {
  try {
    await pub.simulateContract({ ...req, account: w.account });
  } catch (e) {
    const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    log(`  ${label.padEnd(28)} reverted as expected: ${rev?.data?.errorName ?? e.shortMessage}`);
    return;
  }
  throw new Error(`${label} should have reverted`);
}

log(`Arc chain ${chain.id}, deployer ${deployer.account.address}, balance ${usd(await pub.getBalance({ address: deployer.account.address }))}`);

// 1. Factory
if (!state.factory) {
  const hash = await deployer.deployContract({ abi: Factory.abi, bytecode: Factory.bytecode });
  const r = await pub.waitForTransactionReceipt({ hash });
  state.factory = r.contractAddress;
  state.factoryBlock = Number(r.blockNumber);
  state.txs.deployFactory = hash;
  save();
  log(`  deployFactory                ${hash}  -> ${state.factory}`);
}

// 2. Vault, funded at creation
const VAULT_FUNDING = parseEther(process.env.VAULT_FUNDING ?? '1.5');
if (!state.vault) {
  const r = await send('createVault', deployer, {
    address: state.factory, abi: Factory.abi, functionName: 'createVault',
    args: [secrets.pqPublicKey, 3600n], value: VAULT_FUNDING,
  });
  state.vault = (await pub.readContract({ address: state.factory, abi: Factory.abi, functionName: 'vaultsOf', args: [deployer.account.address] })).at(-1);
  state.vaultBlock = Number(r.blockNumber);
  state.pqPublicKey = secrets.pqPublicKey;
  state.agent = agent.account.address;
  save();
  log(`  vault                        ${state.vault}`);
}
const V = { address: state.vault, abi: Vault.abi };
const read = (functionName, args = []) => pub.readContract({ ...V, functionName, args });

async function guarded(label, functionName, args) {
  const call = encodeFunctionData({ abi: Vault.abi, functionName, args });
  const digest = await read('guardDigest', [call]);
  const t = Date.now();
  const sig = pqSign(secrets.pqSecretKey, digest);
  log(`  (SLH-DSA signature ${(sig.length - 2) / 2} bytes, signed in ${Date.now() - t} ms)`);
  return send(label, deployer, { ...V, functionName: 'guarded', args: [call, sig] });
}

// 3. Agent gets a $0.25/day cap, authorised by the post-quantum key
const CAP = parseEther('0.25');
const [cap, , , , active] = await read('policies', [agent.account.address]);
if (!active || cap !== CAP) await guarded('pqAddAgent', 'setAgent', [agent.account.address, CAP, 0n]);

// 4. Give the agent a small gas float. The vault refunds its gas after every payment.
const agentBal = await pub.getBalance({ address: agent.account.address });
if (agentBal < parseEther('0.01')) {
  const hash = await deployer.sendTransaction({ to: agent.account.address, value: parseEther('0.02') });
  await pub.waitForTransactionReceipt({ hash });
  state.txs.agentGasFloat = hash;
  save();
  log(`  agentGasFloat                ${hash}`);
}

// 5. Agent pays for things. Each receipt shows the vault's refund against the real gas cost.
const purchases = [
  ['0.01', 'api: weather lookup'],
  ['0.02', 'api: flight search'],
  ['0.05', 'data: market feed 1h'],
];
for (const [i, [amt, memo]] of purchases.entries()) {
  const r = await send(`agentPay${i + 1}`, agent, {
    ...V, functionName: 'pay', args: [merchant, parseEther(amt), '0x', stringToHex(memo, { size: 32 })],
  });
  const [rc] = await read('recentPayments', [1n]);
  const actual = r.gasUsed * r.effectiveGasPrice;
  log(`    paid ${amt} USDC, gas actually ${usd(actual)}, refunded ${usd(rc.gasRefund)} (${((Number(rc.gasRefund) / Number(actual)) * 100).toFixed(1)}%)`);
}
log(`  remaining today: ${usd(await read('remaining', [agent.account.address]))} of ${usd(CAP)}`);

// 6. The cap holds, all-in
await expectRevert('overCap', agent, { ...V, functionName: 'pay', args: [merchant, parseEther('0.5'), '0x', stringToHex('too much', { size: 32 })] });

// 7. Owner freezes with the classical key, agents stop instantly; unfreezing needs the PQ key
await send('ownerFreeze', deployer, { ...V, functionName: 'freeze' });
await expectRevert('payWhileFrozen', agent, { ...V, functionName: 'pay', args: [merchant, parseEther('0.01'), '0x', stringToHex('frozen?', { size: 32 })] });
await expectRevert('unfreezeWithoutPq', deployer, { ...V, functionName: 'unfreeze' });
await guarded('pqUnfreeze', 'unfreeze', []);
await send('agentPay4', agent, { ...V, functionName: 'pay', args: [merchant, parseEther('0.01'), '0x', stringToHex('api: news digest', { size: 32 })] });

log(`\nvault ${state.vault}\n  balance ${usd(await pub.getBalance({ address: state.vault }))}, payments ${await read('paymentCount')}, pqNonce ${await read('pqNonce')}`);
log(`saved ${outFile}`);
