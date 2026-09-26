import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, g3bEvidenceAttestationSchema, g3bEvidencePayloadSchema, type G3bEvidenceAttestation, type G3bEvidencePayload } from '@ered-luin/contracts';

export interface G3bEvidenceTrust {
  readonly environment: 'synthetic-test' | 'production';
  readonly publicKeys: Readonly<Record<string, string | KeyObject>>;
  readonly allowSyntheticTestEvidence?: boolean;
}

export function canonicalEvidenceDigest(attestation: G3bEvidenceAttestation): string {
  return createHash('sha256').update(canonicalJson(attestation)).digest('hex');
}

export function verifyG3bEvidenceAttestation(value: unknown, trust: G3bEvidenceTrust): G3bEvidenceAttestation {
  const checked = g3bEvidenceAttestationSchema.safeParse(value);
  if (!checked.success) throw new Error('G3B_EVIDENCE_INVALID');
  const attestation = checked.data;
  const payload = g3bEvidencePayloadSchema.parse(attestation.payload);
  if (payload.environment !== trust.environment || (payload.environment === 'synthetic-test' && trust.allowSyntheticTestEvidence !== true)) {
    throw new Error('G3B_EVIDENCE_ENVIRONMENT_MISMATCH');
  }
  const key = trust.publicKeys[payload.keyId];
  if (!key || !verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(attestation.signature.slice(2), 'hex'))) {
    throw new Error('G3B_EVIDENCE_SIGNATURE_INVALID');
  }
  return attestation;
}

export function signG3bEvidence(payload: G3bEvidencePayload, privateKey: string | KeyObject): G3bEvidenceAttestation {
  const checked = g3bEvidencePayloadSchema.parse(payload);
  const signature = sign(null, Buffer.from(canonicalJson(checked)), privateKey).toString('hex');
  return g3bEvidenceAttestationSchema.parse({ payload: checked, signature: `0x${signature}` });
}

export function assertFreshG3bEvidence(attestation: G3bEvidenceAttestation, nowMs: number): void {
  const payload = attestation.payload;
  if (payload.kind === 'APPROVAL_RECEIPT') return;
  const observed = Date.parse(payload.observedAt);
  const expires = Date.parse(payload.expiresAt);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(observed) || !Number.isSafeInteger(expires) ||
      new Date(observed).toISOString() !== payload.observedAt || new Date(expires).toISOString() !== payload.expiresAt ||
      observed > nowMs || expires <= nowMs || expires <= observed || expires - observed > 15_000) throw new Error('G3B_EVIDENCE_STALE');
}
