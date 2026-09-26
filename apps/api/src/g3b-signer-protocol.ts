import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson, g3bSignerPayloadSchema, g3bSignerMessageSchema, type G3bSignerPayload } from '@ered-luin/contracts';

export function createG3bSignerMessage(payload: G3bSignerPayload, secret: Buffer): string {
  const checked = g3bSignerPayloadSchema.parse(payload);
  const mac = createHmac('sha256', secret).update(canonicalJson(checked)).digest('hex');
  return JSON.stringify({ payload: checked, mac });
}

export function verifyG3bSignerMessage(value: unknown, secret: Buffer): G3bSignerPayload {
  const checked = g3bSignerMessageSchema.safeParse(value);
  if (!checked.success) throw new Error('G3B_SIGNER_MESSAGE_INVALID');
  const expected = createHmac('sha256', secret).update(canonicalJson(checked.data.payload)).digest();
  const supplied = Buffer.from(checked.data.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('G3B_SIGNER_MESSAGE_AUTH_FAILED');
  return checked.data.payload;
}

export function makeG3bSignerPayload(input: Omit<G3bSignerPayload, 'version' | 'requestId' | 'requestAt' | 'stopped'>): G3bSignerPayload {
  return g3bSignerPayloadSchema.parse({ ...input, version: 1, requestId: randomUUID(), requestAt: new Date().toISOString(), stopped: false });
}
