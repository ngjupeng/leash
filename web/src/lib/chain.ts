import { createPublicClient, defineChain, fallback, http } from 'viem';

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.arc.io';

// On Vercel, a same-origin proxy (vercel.json rewrite) comes first: content blockers with crypto filter
// lists cancel requests to *.mainnet.arc.io, but have nothing to match on a same-origin path.
// Then Circle's primary endpoint and the keyless node providers listed in Arc's docs. All allow CORS.
const sameOriginProxy =
  typeof location !== 'undefined' && location.hostname.endsWith('.vercel.app') ? [`${location.origin}/api/chain`] : [];

export const RPC_URLS: string[] = import.meta.env.VITE_RPC_URL
  ? [import.meta.env.VITE_RPC_URL]
  : [
      ...sameOriginProxy,
      'https://rpc.mainnet.arc.io',
      'https://rpc.quicknode.mainnet.arc.io',
      'https://rpc.drpc.mainnet.arc.io',
      'https://rpc.blockdaemon.mainnet.arc.io',
    ];

export const arcTransport = () => fallback(RPC_URLS.map((url) => http(url, { retryCount: 1, timeout: 12_000 })));
export const EXPLORER = 'https://explorer.arc.io';

export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: EXPLORER } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const publicClient = createPublicClient({ chain: arc, transport: arcTransport() });

export const PQ_PRECOMPILE = '0x1800000000000000000000000000000000000004' as const;

export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerBlock = (n: bigint | number) => `${EXPLORER}/block/${n}`;

/** eth_estimateGas runs at a zero gas price, so pay() skips its refund while estimating. */
export const PAY_GAS_HEADROOM = 60_000n;
