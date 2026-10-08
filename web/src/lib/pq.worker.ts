import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js';

type Req = { id: number; op: 'keygen' } | { id: number; op: 'sign'; secretKey: Uint8Array; message: Uint8Array };

self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.op === 'keygen') {
      const k = slh.keygen();
      self.postMessage({ id: req.id, publicKey: k.publicKey, secretKey: k.secretKey });
    } else {
      self.postMessage({ id: req.id, signature: slh.sign(req.message, req.secretKey) });
    }
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err) });
  }
};
