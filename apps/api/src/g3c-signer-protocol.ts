import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, g3cSignerMessageSchema, g3cSigningRequestSchema, type G3cSigningRequest } from '@ered-luin/contracts';

export function createG3cSignerMessage(value: G3cSigningRequest, secret: Buffer): string {
  if (secret.length < 32) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  const payload = g3cSigningRequestSchema.parse(value);
  const mac = createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
  return JSON.stringify({ payload, mac });
}

export function verifyG3cSignerMessage(value: unknown, secret: Buffer): G3cSigningRequest {
  if (secret.length < 32) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  const checked = g3cSignerMessageSchema.safeParse(value);
  if (!checked.success) throw new Error('G3C_SIGNER_MESSAGE_INVALID');
  const expected = createHmac('sha256', secret).update(canonicalJson(checked.data.payload)).digest();
  const supplied = Buffer.from(checked.data.mac, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('G3C_SIGNER_MESSAGE_AUTH_FAILED');
  return checked.data.payload;
}
