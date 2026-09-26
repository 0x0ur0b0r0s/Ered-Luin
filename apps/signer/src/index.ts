import { createHash } from 'node:crypto';

export const signerStatus = { implementation: 'g3b-isolated-worker', liveSigningEnabled: false, broadcastEnabled: false } as const;
export function signedBytesDigest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
