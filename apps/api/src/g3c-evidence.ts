import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify,
  type KeyObject,
} from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  assertG3cEvidenceSourceFreshness, canonicalJson, g3cEvidenceAttestationSchema, g3cEvidencePayloadSchema,
  type G3cEvidenceAttestation, type G3cEvidencePayload, type G3cSourceFinality,
} from '@ered-luin/contracts';

export interface G3cEvidenceTrust {
  readonly environment: 'production' | 'synthetic-test';
  readonly publicKeys: Readonly<Record<string, string>>;
  readonly allowSyntheticTestEvidence?: boolean;
}
type G3cHeadField = 'sourceBlockNumber' | 'sourceBlockHash' | 'sourceBlockTimestamp' |
  'latestHeadNumber' | 'latestHeadHash' | 'latestHeadTimestamp' | 'safeHeadNumber' | 'safeHeadHash' |
  'safeHeadTimestamp' | 'finalizedHeadNumber' | 'finalizedHeadHash' | 'finalizedHeadTimestamp' |
  'feeValuationBlockNumber' | 'feeValuationBlockHash' | 'feeValuationBlockTimestamp';
export type G3cEvidenceDraft = (G3cEvidencePayload extends infer Payload ? Payload extends object ?
  Omit<Payload, 'version' | 'serviceId' | 'environment' | 'keyId' | 'observedAt' | 'expiresAt' | G3cHeadField> : never : never) &
  Partial<Pick<G3cEvidencePayload, G3cHeadField>>;

function defaultSourceFinality(payload: G3cEvidenceDraft): G3cSourceFinality | null {
  if (payload.kind === 'ACCOUNT_SNAPSHOT') return payload.blockFinality;
  if (payload.kind === 'FUNDING_ADJUSTMENT') return 'historical-finalized';
  if (payload.kind === 'RECEIPT') {
    if (payload.finality === null) return null;
    if (payload.finality === 'finalized' && (payload.outcome === 'CONFIRMED' || payload.outcome === 'REVERTED')) {
      return 'historical-finalized';
    }
    return payload.finality;
  }
  return 'unsafe';
}
export interface G3cEvidenceAuthority {
  readonly trust: G3cEvidenceTrust;
  attest(payload: G3cEvidenceDraft): G3cEvidenceAttestation;
}
export function canonicalG3cEvidenceDigest(attestation: G3cEvidenceAttestation): string {
  return createHash('sha256').update(canonicalJson(g3cEvidenceAttestationSchema.parse(attestation))).digest('hex');
}
export function signG3cEvidence(payload: G3cEvidencePayload, privateKey: KeyObject): G3cEvidenceAttestation {
  const checked = g3cEvidencePayloadSchema.parse(payload);
  if (checked.serviceId !== 'ered-luin-g3c-evidence') throw new Error('G3C_EVIDENCE_SERVICE_INVALID');
  const signature = sign(null, Buffer.from(canonicalJson(checked)), privateKey).toString('hex');
  return g3cEvidenceAttestationSchema.parse({ payload: checked, signature: '0x' + signature });
}
export function verifyG3cEvidenceAttestation(value: unknown, trust: G3cEvidenceTrust): G3cEvidenceAttestation {
  const checked = g3cEvidenceAttestationSchema.safeParse(value);
  if (!checked.success) throw new Error('G3C_EVIDENCE_INVALID');
  const evidence = checked.data;
  if (evidence.payload.environment !== trust.environment ||
      (evidence.payload.environment === 'synthetic-test' && trust.allowSyntheticTestEvidence !== true)) throw new Error('G3C_EVIDENCE_ENVIRONMENT_MISMATCH');
  const pem = trust.publicKeys[evidence.payload.keyId];
  if (!pem) throw new Error('G3C_EVIDENCE_KEY_UNTRUSTED');
  try {
    if (!verify(null, Buffer.from(canonicalJson(evidence.payload)), createPublicKey(pem), Buffer.from(evidence.signature.slice(2), 'hex'))) {
      throw new Error('G3C_EVIDENCE_SIGNATURE_INVALID');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('G3C_')) throw error;
    throw new Error('G3C_EVIDENCE_SIGNATURE_INVALID');
  }
  return evidence;
}
export function assertFreshG3cEvidence(attestation: G3cEvidenceAttestation, nowMs: number, maxTtlMs = 15_000): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('G3C_CLOCK_INVALID');
  const payload = attestation.payload;
  const observedAt = Date.parse(payload.observedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(expiresAt) ||
      new Date(observedAt).toISOString() !== payload.observedAt || new Date(expiresAt).toISOString() !== payload.expiresAt ||
      observedAt > nowMs || expiresAt <= nowMs || expiresAt <= observedAt || expiresAt - observedAt > maxTtlMs) {
    throw new Error('G3C_EVIDENCE_STALE');
  }
  assertG3cEvidenceSourceFreshness(payload, nowMs);
}
export function loadProductionG3cEvidenceTrust(configuration: {
  readonly publicKeysPath: string; readonly repositoryRoot: string;
}): G3cEvidenceTrust {
  if (!configuration || !isAbsolute(configuration.publicKeysPath)) throw new Error('G3C_TRUST_CONFIGURATION_INVALID');
  const keyPath = resolve(configuration.publicKeysPath);
  const repoRoot = resolve(configuration.repositoryRoot);
  if (pathIsInside(repoRoot, keyPath)) throw new Error('G3C_TRUST_MUST_BE_OUTSIDE_REPOSITORY');
  const stat = lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('G3C_TRUST_FILE_INVALID');
  let value: unknown;
  try { value = JSON.parse(readFileSync(keyPath, 'utf8')); } catch { throw new Error('G3C_TRUST_FILE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('G3C_TRUST_FILE_INVALID');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) throw new Error('G3C_TRUST_FILE_INVALID');
  const publicKeys: Record<string, string> = {};
  for (const [keyId, pem] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/u.test(keyId) || typeof pem !== 'string' || pem.length > 8192) {
      throw new Error('G3C_TRUST_FILE_INVALID');
    }
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('G3C_TRUST_KEY_TYPE_INVALID');
    } catch { throw new Error('G3C_TRUST_FILE_INVALID'); }
    publicKeys[keyId] = pem;
  }
  return { environment: 'production', publicKeys };
}

export function createSyntheticG3cEvidenceAuthority(clock: () => Date = () => new Date()): G3cEvidenceAuthority {
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'synthetic-g3c-runtime';
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const trust: G3cEvidenceTrust = { environment: 'synthetic-test', publicKeys: { [keyId]: publicKeyPem }, allowSyntheticTestEvidence: true };
  return {
    trust,
    attest(payload) {
      const now = clock();
      if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('G3C_CLOCK_INVALID');
      const p = payload as unknown as Record<string, unknown>;
      const sourceNumber = typeof p.blockNumber === 'string' ? BigInt(p.blockNumber) : 1000n;
      const sourceFinality = payload.sourceFinality !== undefined ? payload.sourceFinality : defaultSourceFinality(payload);
      const latest = sourceNumber + (sourceFinality === 'historical-finalized' ? 6n : sourceFinality === 'unsafe' ? 0n : 3n);
      const safe = sourceNumber + (sourceFinality === 'historical-finalized' ? 5n : sourceFinality === 'unsafe' ? -2n : 2n);
      const finalized = sourceFinality === 'finalized' ? sourceNumber :
        sourceFinality === 'historical-finalized' ? sourceNumber + 3n :
          sourceNumber > (sourceFinality === 'unsafe' ? 5n : 3n) ? sourceNumber - (sourceFinality === 'unsafe' ? 5n : 3n) : 0n;
      const latestTimestamp = Math.floor(now.getTime() / 1000);
      const safeTimestamp = latestTimestamp - (sourceFinality === 'historical-finalized' ? 4 : sourceFinality === 'unsafe' ? 4 : 2);
      const finalizedTimestamp = latestTimestamp - (sourceFinality === 'unsafe' ? 10 : 6);
      const headHash = (number: bigint) => '0x' + createHash('sha256').update('synthetic-base-head:' + number.toString()).digest('hex');
      const sourceBlockNumber = typeof p.blockNumber === 'string' ? p.blockNumber : null;
      const sourceBlockHash = typeof p.blockHash === 'string' ? p.blockHash : null;
      const sourceBlockTimestamp = sourceBlockNumber === null ? null :
        sourceFinality === 'finalized' ? finalizedTimestamp :
          sourceFinality === 'historical-finalized' ? finalizedTimestamp - Number(finalized - sourceNumber) * 2 :
            sourceFinality === 'unsafe' ? latestTimestamp - Number(latest - sourceNumber) * 2 :
              safeTimestamp - Number(safe - sourceNumber) * 2;
      return signG3cEvidence({ ...payload,
        sourceBlockNumber: payload.sourceBlockNumber ?? sourceBlockNumber,
        sourceBlockHash: payload.sourceBlockHash ?? sourceBlockHash,
        sourceBlockTimestamp: payload.sourceBlockTimestamp ?? sourceBlockTimestamp,
        latestHeadNumber: payload.latestHeadNumber ?? latest.toString(),
        latestHeadHash: payload.latestHeadHash ?? headHash(latest),
        latestHeadTimestamp: payload.latestHeadTimestamp ?? latestTimestamp,
        safeHeadNumber: payload.safeHeadNumber ?? safe.toString(),
        safeHeadHash: payload.safeHeadHash ?? headHash(safe),
        safeHeadTimestamp: payload.safeHeadTimestamp ?? safeTimestamp,
        finalizedHeadNumber: payload.finalizedHeadNumber ?? finalized.toString(),
        finalizedHeadHash: payload.finalizedHeadHash ?? headHash(finalized),
        finalizedHeadTimestamp: payload.finalizedHeadTimestamp ?? finalizedTimestamp,
        sourceFinality: payload.sourceFinality ?? (sourceBlockNumber === null ? null : sourceFinality),
        feeValuationBlockNumber: payload.feeValuationBlockNumber ??
          (p.kind === 'RECEIPT' && (p.outcome === 'CONFIRMED' || p.outcome === 'REVERTED')
            ? sourceBlockNumber ?? String(p.blockNumber) : null),
        feeValuationBlockHash: payload.feeValuationBlockHash ??
          (p.kind === 'RECEIPT' && (p.outcome === 'CONFIRMED' || p.outcome === 'REVERTED')
            ? sourceBlockHash ?? String(p.blockHash) : null),
        feeValuationBlockTimestamp: payload.feeValuationBlockTimestamp ??
          (p.kind === 'RECEIPT' && (p.outcome === 'CONFIRMED' || p.outcome === 'REVERTED')
            ? sourceBlockTimestamp ?? (typeof p.sourceBlockTimestamp === 'number' ? p.sourceBlockTimestamp : sourceBlockTimestamp) : null),
        version: 3, serviceId: 'ered-luin-g3c-evidence', environment: 'synthetic-test',
        keyId, observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10_000).toISOString() } as G3cEvidencePayload, pair.privateKey);
    },
  };
}
function pathIsInside(parent: string, child: string): boolean {
  const isInside = (resolvedParent: string, resolvedChild: string) => {
    const rel = relative(resolvedParent, resolvedChild);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  };
  const lexicalParent = resolve(parent);
  const lexicalChild = resolve(child);
  if (isInside(lexicalParent, lexicalChild)) return true;
  const realParent = resolve(realpathSync(lexicalParent));
  const realChild = resolve(realpathSync(lexicalChild));
  return isInside(realParent, realChild);
}
export function loadProductionG3cEvidenceAuthority(configuration: {
  readonly privateKeyPath: string; readonly keyId: string; readonly repositoryRoot: string; readonly clock?: () => Date;
}): G3cEvidenceAuthority {
  if (!configuration || !isAbsolute(configuration.privateKeyPath) || !/^[A-Za-z0-9._:-]{1,80}$/u.test(configuration.keyId)) throw new Error('G3C_EVIDENCE_CONFIGURATION_INVALID');
  const keyPath = resolve(configuration.privateKeyPath);
  const repoRoot = resolve(configuration.repositoryRoot);
  if (pathIsInside(repoRoot, keyPath)) throw new Error('G3C_PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY');
  const keyStat = lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink()) throw new Error('G3C_PRIVATE_KEY_FILE_INVALID');
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('G3C_EVIDENCE_KEY_TYPE_INVALID');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return {
    trust: { environment: 'production', publicKeys: { [configuration.keyId]: publicKeyPem } },
    attest(payload) {
      const now = (configuration.clock ?? (() => new Date()))();
      if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime())) throw new Error('G3C_CLOCK_INVALID');
      const sourceFinality = payload.sourceFinality !== undefined ? payload.sourceFinality : defaultSourceFinality(payload);
      return signG3cEvidence({ ...payload, sourceFinality, version: 3, serviceId: 'ered-luin-g3c-evidence', environment: 'production',
        keyId: configuration.keyId, observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10_000).toISOString() } as G3cEvidencePayload, privateKey);
    },
  };
}
