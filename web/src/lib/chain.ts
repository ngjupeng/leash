import { createPublicClient, defineChain, http } from 'viem';

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.arc.io';
export const EXPLORER = 'https://explorer.arc.io';

export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: EXPLORER } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const publicClient = createPublicClient({ chain: arc, transport: http(RPC_URL, { batch: true }) });

export const PQ_PRECOMPILE = '0x1800000000000000000000000000000000000004' as const;

export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerBlock = (n: bigint | number) => `${EXPLORER}/block/${n}`;

/** eth_estimateGas runs at a zero gas price, so pay() skips its refund while estimating. */
export const PAY_GAS_HEADROOM = 60_000n;
