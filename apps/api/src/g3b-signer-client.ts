import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { G3bSignerPayload } from '@ered-luin/contracts';
import { createG3bSignerMessage } from './g3b-signer-protocol.js';

export interface G3bSignedResult { readonly signedBytesHex: string; readonly transactionHash: `0x${string}`; }
export interface G3bIsolatedSigner { sign(payload: G3bSignerPayload): Promise<G3bSignedResult>; close(): Promise<void>; }
export interface SyntheticSignerConfiguration {
  readonly privateKey: `0x${string}`; readonly hmacSecret: Buffer;
  readonly trustedEvidenceKeys: Readonly<Record<string, string>>;
  readonly evidenceEnvironment: 'synthetic-test'; readonly allowSyntheticTestEvidence: true;
}
interface Pending { resolve(value: G3bSignedResult): void; reject(error: Error): void; timer: NodeJS.Timeout; }
type SignerChild = ChildProcess & { stdin: Writable; stdout: Readable };

/** Test-only process adapter. Production wallet key delivery is intentionally not configured in G3b. */
export function createSyntheticIsolatedSigner(configuration: SyntheticSignerConfiguration): G3bIsolatedSigner {
  if (configuration.evidenceEnvironment !== 'synthetic-test' || configuration.allowSyntheticTestEvidence !== true ||
      configuration.hmacSecret.length < 32 || !/^0x[0-9a-f]{64}$/u.test(configuration.privateKey)) throw new Error('SYNTHETIC_SIGNER_CONFIGURATION_INVALID');
  const workerPath = fileURLToPath(new URL('../../signer/dist/worker.js', import.meta.url));
  let child: SignerChild | null = null; let output = ''; let queue = Promise.resolve();
  const pending: Pending[] = [];
  const rejectPending = (message: string) => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(new Error(message)); } };
  const ensureWorker = () => {
    if (child) return child;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
      ERED_LUIN_SIGNER_PRIVATE_KEY: configuration.privateKey,
      ERED_LUIN_SIGNER_HMAC_KEY: configuration.hmacSecret.toString('hex'),
      ERED_LUIN_SIGNER_EVIDENCE_ENV: configuration.evidenceEnvironment,
      ERED_LUIN_ALLOW_SYNTHETIC_TEST_EVIDENCE: '1',
      ERED_LUIN_SIGNER_EVIDENCE_KEYS: JSON.stringify(configuration.trustedEvidenceKeys),
    };
    const started = spawn(process.execPath, [workerPath], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    if (!started.stdin || !started.stdout) throw new Error('SIGNER_PROCESS_FAILED');
    child = started as SignerChild;
    const active = child;
    active.stdout.setEncoding('utf8');
    active.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8192) { active.kill(); rejectPending('SIGNER_RESPONSE_TOO_LARGE'); return; }
      for (;;) {
        const newline = output.indexOf('\n'); if (newline < 0) break;
        const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
        const item = pending.shift();
        if (!item) { active.kill(); rejectPending('SIGNER_PROTOCOL_INVALID'); return; }
        clearTimeout(item.timer);
        try {
          const response = JSON.parse(line) as Record<string, unknown>;
          if (response.ok !== true || typeof response.signedBytesHex !== 'string' || typeof response.transactionHash !== 'string' ||
              !/^0x[0-9a-f]{64}$/u.test(response.transactionHash)) item.reject(new Error(`SIGNER_REJECTED:${String(response.code ?? 'UNKNOWN')}`));
          else item.resolve({ signedBytesHex: response.signedBytesHex, transactionHash: response.transactionHash as `0x${string}` });
        } catch { item.reject(new Error('SIGNER_PROTOCOL_INVALID')); }
      }
    });
    active.once('error', () => rejectPending('SIGNER_PROCESS_FAILED'));
    active.once('close', (code) => { child = null; rejectPending(code === 0 ? 'SIGNER_CLOSED' : 'SIGNER_REJECTED'); });
    return active;
  };
  function exchange(payload: G3bSignerPayload): Promise<G3bSignedResult> {
    return new Promise((resolve, reject) => {
      const workerProcess = ensureWorker();
      const timer = setTimeout(() => { workerProcess.kill(); reject(new Error('SIGNER_TIMEOUT')); }, 10_000);
      pending.push({ resolve, reject, timer });
      workerProcess.stdin.write(`${createG3bSignerMessage(payload, configuration.hmacSecret)}\n`, (error) => {
        if (error) { const item = pending.pop(); if (item) { clearTimeout(item.timer); item.reject(new Error('SIGNER_PROCESS_FAILED')); } }
      });
    });
  }
  return {
    sign(payload) {
      const result = queue.then(() => exchange(payload));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async close() {
      await queue;
      if (!child) return;
      const workerProcess = child;
      await new Promise<void>((resolve) => { workerProcess.once('close', () => resolve()); workerProcess.stdin.end(); });
      child = null;
    },
  };
}
