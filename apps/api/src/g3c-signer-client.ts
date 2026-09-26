import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { G3cSigningRequest } from '@ered-luin/contracts';
import type { G3cEvidenceTrust } from './g3c-evidence.js';
import type { G3cSigner, G3cSignedResult } from './g3c-execution-store.js';
import { createG3cSignerMessage } from './g3c-signer-protocol.js';

export interface G3cIsolatedSigner extends G3cSigner { close(): Promise<void>; }
export interface SyntheticG3cSignerConfiguration {
  readonly privateKey: `0x${string}`; readonly hmacSecret: Buffer; readonly trust: G3cEvidenceTrust;
  readonly statePath: string; readonly repositoryRoot: string;
}
export interface ProductionG3cSignerConfiguration {
  readonly privateKeyPath: string; readonly hmacSecretPath: string; readonly trustPath: string;
  readonly statePath: string; readonly repositoryRoot: string;
}
interface Pending { resolve(value: G3cSignedResult): void; reject(error: Error): void; timer: NodeJS.Timeout; }
type SignerChild = ChildProcess & { stdin: Writable; stdout: Readable };
function assertExternalPath(value: string, repositoryRoot: string): string {
  if (!isAbsolute(value)) throw new Error('G3C_PRIVATE_CONFIGURATION_PATH_MUST_BE_ABSOLUTE');
  const path = resolve(value);
  const realRoot = resolve(realpathSync(repositoryRoot));
  const exists = existsSync(path);
  if (exists && lstatSync(path).isSymbolicLink()) throw new Error('G3C_PRIVATE_CONFIGURATION_PATH_INVALID');
  const target = exists ? realpathSync(path) : resolve(realpathSync(dirname(path)), basename(path));
  const rel = relative(realRoot, target);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw new Error('G3C_PRIVATE_CONFIGURATION_MUST_BE_OUTSIDE_REPOSITORY');
  return path;
}
function loadHmacSecret(path: string, repositoryRoot: string): Buffer {
  const externalPath = assertExternalPath(path, repositoryRoot);
  const stat = lstatSync(externalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  const contents = readFileSync(externalPath, 'utf8').trim().replace(/^0x/u, '');
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(contents)) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  const secret = Buffer.from(contents, 'hex');
  if (secret.length < 32) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  return secret;
}
function startClient(configuration: {
  readonly mode: 'test' | 'production'; readonly hmacSecret: Buffer; readonly statePath: string; readonly repositoryRoot: string;
  readonly testPrivateKey?: `0x${string}`; readonly testTrust?: G3cEvidenceTrust;
  readonly privateKeyPath?: string; readonly trustPath?: string;
}): G3cIsolatedSigner {
  if (configuration.hmacSecret.length < 32) throw new Error('G3C_SIGNER_AUTH_CONFIGURATION_INVALID');
  const statePath = assertExternalPath(configuration.statePath, configuration.repositoryRoot);
  const repositoryRoot = resolve(configuration.repositoryRoot);
  const workerPath = fileURLToPath(new URL('../../signer/dist/g3c-worker.js', import.meta.url));
  let child: SignerChild | null = null; let output = ''; let queue = Promise.resolve();
  const pending: Pending[] = [];
  const rejectPending = (message: string) => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(new Error(message)); } };
  const ensureWorker = () => {
    if (child) return child;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: configuration.mode === 'test' ? 'test' : 'production',
      ERED_LUIN_G3C_MODE: configuration.mode,
      ERED_LUIN_G3C_HMAC_KEY: configuration.hmacSecret.toString('hex'),
      ERED_LUIN_G3C_STATE_PATH: statePath,
      ERED_LUIN_G3C_REPOSITORY_ROOT: repositoryRoot,
      ...(configuration.mode === 'test' ? {
        ERED_LUIN_G3C_TEST_PRIVATE_KEY: configuration.testPrivateKey,
        ERED_LUIN_G3C_TEST_TRUST_KEYS: JSON.stringify(configuration.testTrust?.publicKeys ?? {}),
      } : {
        ERED_LUIN_G3C_PRIVATE_KEY_PATH: assertExternalPath(configuration.privateKeyPath!, repositoryRoot),
        ERED_LUIN_G3C_TRUST_PATH: assertExternalPath(configuration.trustPath!, repositoryRoot),
        LIVE_EXECUTION_ENABLED: process.env.LIVE_EXECUTION_ENABLED,
        EXECUTION_MODE: process.env.EXECUTION_MODE,
        G3C_REVIEWED_MODE: process.env.G3C_REVIEWED_MODE,
      }),
    };
    const started = spawn(process.execPath, [workerPath], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    if (!started.stdin || !started.stdout) throw new Error('G3C_SIGNER_PROCESS_FAILED');
    child = started as SignerChild; const active = child; active.stdout.setEncoding('utf8');
    active.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 8192) { active.kill(); rejectPending('G3C_SIGNER_RESPONSE_TOO_LARGE'); return; }
      for (;;) {
        const newline = output.indexOf('\n'); if (newline < 0) break;
        const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
        const item = pending.shift();
        if (!item) { active.kill(); rejectPending('G3C_SIGNER_PROTOCOL_INVALID'); return; }
        clearTimeout(item.timer);
        try {
          const response = JSON.parse(line) as Record<string, unknown>;
          if (response.ok !== true || typeof response.signedBytesHex !== 'string' || typeof response.transactionHash !== 'string' ||
              !/^0x[0-9a-f]{64}$/u.test(response.transactionHash)) item.reject(new Error('G3C_SIGNER_REJECTED'));
          else item.resolve({ signedBytesHex: response.signedBytesHex, transactionHash: response.transactionHash as `0x${string}` });
        } catch { item.reject(new Error('G3C_SIGNER_PROTOCOL_INVALID')); }
      }
    });
    active.once('error', () => rejectPending('G3C_SIGNER_PROCESS_FAILED'));
    active.once('close', (code) => { child = null; rejectPending(code === 0 ? 'G3C_SIGNER_CLOSED' : 'G3C_SIGNER_REJECTED'); });
    return active;
  };
  function exchange(request: G3cSigningRequest): Promise<G3cSignedResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      let worker: SignerChild;
      try { worker = ensureWorker(); } catch (error) { rejectPromise(error instanceof Error ? error : new Error('G3C_SIGNER_PROCESS_FAILED')); return; }
      const timer = setTimeout(() => { worker.kill(); rejectPromise(new Error('G3C_SIGNER_TIMEOUT')); }, 10_000);
      pending.push({ resolve: resolvePromise, reject: rejectPromise, timer });
      worker.stdin.write(`${createG3cSignerMessage(request, configuration.hmacSecret)}\n`, (error) => {
        if (error) { const item = pending.pop(); if (item) { clearTimeout(item.timer); item.reject(new Error('G3C_SIGNER_PROCESS_FAILED')); } }
      });
    });
  }
  return {
    sign(request) {
      const result = queue.then(() => exchange(request)); queue = result.then(() => undefined, () => undefined); return result;
    },
    async close() {
      await queue; if (!child) return; const worker = child;
      await new Promise<void>((done) => { worker.once('close', () => done()); worker.stdin.end(); }); child = null;
    },
  };
}
export function createSyntheticIsolatedG3cSigner(configuration: SyntheticG3cSignerConfiguration): G3cIsolatedSigner {
  if (process.env.NODE_ENV !== 'test' || !/^0x[0-9a-fA-F]{64}$/u.test(configuration.privateKey) ||
      configuration.trust.environment !== 'synthetic-test' || configuration.trust.allowSyntheticTestEvidence !== true) {
    throw new Error('G3C_TEST_SIGNER_IS_TEST_ONLY');
  }
  return startClient({ mode: 'test', hmacSecret: configuration.hmacSecret, statePath: configuration.statePath,
    repositoryRoot: configuration.repositoryRoot, testPrivateKey: configuration.privateKey, testTrust: configuration.trust });
}
export function createProductionG3cSigner(configuration: ProductionG3cSignerConfiguration): G3cIsolatedSigner {
  if (process.env.LIVE_EXECUTION_ENABLED !== 'true' || process.env.EXECUTION_MODE !== 'live-reviewed' || process.env.G3C_REVIEWED_MODE !== 'true') {
    throw new Error('G3C_PRODUCTION_SIGNER_REQUIRES_REVIEWED_MODE');
  }
  return startClient({ mode: 'production', hmacSecret: loadHmacSecret(configuration.hmacSecretPath, configuration.repositoryRoot),
    statePath: configuration.statePath, repositoryRoot: configuration.repositoryRoot,
    privateKeyPath: configuration.privateKeyPath, trustPath: configuration.trustPath });
}
