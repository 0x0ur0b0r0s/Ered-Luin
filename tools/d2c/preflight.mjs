import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createD2cCollectionPlan } from './collection-plan.mjs';

export const D2C_CONFIG_KEYS = Object.freeze([
  'NODE_ENV', 'NANSEN_API_ENABLED', 'NANSEN_CREDIT_BUDGET', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
  'LIVE_EXECUTION_ENABLED', 'EXECUTION_MODE', 'PORT', 'PAPER_STATE_PATH',
  'NANSEN_OBSERVATION_STORE_PATH', 'NANSEN_OBSERVATION_STORE_ID', 'D2_AUDIT_STORE_PATH',
  'D2_OPERATOR_SECRET', 'D2_OPERATOR_ALLOWED_ORIGIN', 'D2_EXECUTION_REVIEWED', 'D2_SIGNING_ENABLED',
  'D2_BROADCAST_ENABLED', 'G3C_SIGNER_DEPLOYED', 'BASE_BROADCASTER_DEPLOYED', 'G3C_SIGNER_PRIVATE_KEY_PATH',
  'G3C_SIGNER_HMAC_SECRET_PATH', 'G3C_SIGNER_STATE_PATH', 'G3C_EVIDENCE_TRUST_PATH',
  'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED', 'ALCHEMY_BUDGET_VERIFIED', 'D2_RPC_MAX_REQUESTS',
  'D2_RPC_RECOVERY_RESERVE', 'G3C_EVIDENCE_SIGNING_KEY_PATH', 'G3C_EVIDENCE_KEY_ID',
  'D2_G1D_ANALYSIS_HANDOFF_ENABLED', 'D2_G1D_ANALYSIS_ENABLED', 'G1D_SHADOW_AUDIT_STORE_PATH', 'G1D_SHADOW_AUDIT_STORE_ID',
  'NANSEN_LEDGER_PATH', 'NANSEN_LEDGER_BUDGET_ID', 'NANSEN_LEDGER_LIMIT_CREDITS', 'NANSEN_COST_PROFILE_VERSION',
  'D2C_PUBLIC_WALLET_ADDRESS', 'D2C_WALLET_USDC_BALANCE', 'D2C_WALLET_ETH_BALANCE', 'G3C_REVIEWED_MODE',
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENABLED_GATES = Object.freeze([
  'LIVE_EXECUTION_ENABLED', 'D2_BASE_READS_ENABLED', 'D2_DEPLOYMENT_REVIEWED', 'ALCHEMY_BUDGET_VERIFIED',
  'G3C_REVIEWED_MODE', 'D2_EXECUTION_REVIEWED', 'D2_SIGNING_ENABLED', 'D2_BROADCAST_ENABLED', 'D2_G1D_ANALYSIS_ENABLED',
  'G3C_SIGNER_DEPLOYED', 'BASE_BROADCASTER_DEPLOYED', 'NANSEN_COLLECTION_REVIEWED', 'NANSEN_COLLECTION_ENABLED',
]);

function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function inside(root, path) {
  const rel = relative(root, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function status(name, value, detail) { return Object.freeze({ name, status: value, detail }); }
export function parseD2cConfig(value) {
  if (!record(value) || Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !record(value.environment) ||
      Object.values(value.environment).some((entry) => typeof entry !== 'string')) return null;
  const legacy = !Object.hasOwn(value.environment, 'D2_G1D_ANALYSIS_ENABLED');
  const acceptedKeys = legacy ? D2C_CONFIG_KEYS.filter((key) => key !== 'D2_G1D_ANALYSIS_ENABLED') : D2C_CONFIG_KEYS;
  if (Object.keys(value.environment).length !== acceptedKeys.length || acceptedKeys.some((key) => !Object.hasOwn(value.environment, key))) return null;
  if (legacy) return { ...value.environment, D2_G1D_ANALYSIS_ENABLED: 'false' };
  return value.environment;
}
function pathCheck(value, required = false) {
  if (typeof value !== 'string' || value.length === 0) return status('path', required ? 'NOT_VERIFIED' : 'NOT_VERIFIED', required ? 'required external file is not configured' : 'optional external file is not configured');
  if (!isAbsolute(value) || inside(ROOT, value)) return status('path', 'FAIL', 'path must be absolute and outside the repository');
  try {
    const stat = lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) return status('path', 'FAIL', 'path must be a regular non-linked file');
    return status('path', 'PASS', 'external regular file exists; database schema, access controls and backup durability are not verified');
  } catch { return status('path', 'FAIL', 'configured external file is unavailable'); }
}
function supportedNode(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 24 && minor >= 20 && (minor > 20 || patch >= 0);
}
function supportedPnpm(agent) {
  if (typeof agent !== 'string') return 'NOT_VERIFIED';
  const match = /(?:^|\s)pnpm\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(agent);
  if (!match) return 'FAIL';
  return Number(match[1]) === 11 && Number(match[2]) >= 0 ? 'PASS' : 'FAIL';
}
function pairValid(pathValue, idValue) {
  return (typeof pathValue === 'string' && pathValue.length > 0) === (typeof idValue === 'string' && idValue.length > 0);
}

export function createD2cPreflightReport({ configValue = null, configPath = null, runtime = process.version, pnpmUserAgent = null, allowTypeSafeAnalysis = false } = {}) {
  const env = parseD2cConfig(configValue);
  let configStatus = 'NOT_VERIFIED';
  if (configValue !== null && env === null) configStatus = 'FAIL';
  else if (env && configPath && (!isAbsolute(configPath) || inside(ROOT, configPath))) configStatus = 'FAIL';
  else if (env && configPath) {
    try {
      const stat = lstatSync(configPath);
      configStatus = stat.isFile() && !stat.isSymbolicLink() ? 'PASS' : 'FAIL';
    } catch { configStatus = 'FAIL'; }
  }
  const runtimeStatus = supportedNode(runtime) ? 'PASS' : 'FAIL';
  const pnpmStatus = supportedPnpm(pnpmUserAgent);
  const safeValues = env ? [
    env.NODE_ENV === 'development', env.NANSEN_API_ENABLED === 'false', env.NANSEN_CREDIT_BUDGET === '0',
    env.NANSEN_COLLECTION_ENABLED === 'false', env.NANSEN_COLLECTION_REVIEWED === 'false',
    env.LIVE_EXECUTION_ENABLED === 'false', env.EXECUTION_MODE === 'paper',
    ...ENABLED_GATES.map((key) => env[key] === 'false' ||
      (key === 'D2_G1D_ANALYSIS_ENABLED' && allowTypeSafeAnalysis === true && env[key] === 'true')),
    env.G3C_REVIEWED_MODE === 'false',
    env.D2_RPC_MAX_REQUESTS === '896', env.D2_RPC_RECOVERY_RESERVE === '192',
  ] : [];
  const gatesStatus = env ? (safeValues.every(Boolean) ? 'PASS' : 'FAIL') : 'NOT_VERIFIED';
  const paper = env ? pathCheck(env.PAPER_STATE_PATH, true) : status('paper state', 'NOT_VERIFIED', 'local configuration is unavailable');
  const observations = env ? pathCheck(env.NANSEN_OBSERVATION_STORE_PATH, true) : status('observations', 'NOT_VERIFIED', 'local configuration is unavailable');
  const audit = env ? pathCheck(env.D2_AUDIT_STORE_PATH, true) : status('D2 audit', 'NOT_VERIFIED', 'local configuration is unavailable');
  const g1dAudit = env && env.G1D_SHADOW_AUDIT_STORE_PATH.length > 0 ? pathCheck(env.G1D_SHADOW_AUDIT_STORE_PATH)
    : status('G1d audit', 'NOT_VERIFIED', 'optional external store is not configured');
  const g1dAuditRequired = env?.D2_G1D_ANALYSIS_HANDOFF_ENABLED === 'true' || env?.D2_G1D_ANALYSIS_ENABLED === 'true';
  const pathsPair = env && pairValid(env.NANSEN_OBSERVATION_STORE_PATH, env.NANSEN_OBSERVATION_STORE_ID) &&
    pairValid(env.G1D_SHADOW_AUDIT_STORE_PATH, env.G1D_SHADOW_AUDIT_STORE_ID) && (!g1dAuditRequired || g1dAudit.status === 'PASS');
  const requiredPaths = [paper, observations, audit, ...(g1dAuditRequired ? [g1dAudit] : [])];
  const externalFilesStatus = requiredPaths.some((item) => item.status === 'FAIL') || !pathsPair
    ? 'FAIL' : requiredPaths.every((item) => item.status === 'PASS') ? 'PASS' : 'NOT_VERIFIED';
  const originValid = env && (() => {
    try {
      const url = new URL(env.D2_OPERATOR_ALLOWED_ORIGIN);
      return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.origin === env.D2_OPERATOR_ALLOWED_ORIGIN && !url.username && !url.password;
    } catch { return false; }
  })();
  const originStatus = !env ? 'NOT_VERIFIED' : originValid ? 'PASS' : 'FAIL';
  const portNumber = env && /^[1-9][0-9]{0,4}$/u.test(env.PORT) ? Number(env.PORT) : 0;
  const listenerStatus = !env ? 'NOT_VERIFIED' : Number.isSafeInteger(portNumber) && portNumber <= 65_535 ? 'PASS' : 'FAIL';
  const operatorSecretStatus = !env ? 'NOT_VERIFIED' : env.D2_OPERATOR_SECRET.length === 0 ? 'NOT_VERIFIED'
    : /^[A-Za-z0-9_-]{43,128}$/u.test(env.D2_OPERATOR_SECRET) ? 'PASS' : 'FAIL';
  const trust = env ? pathCheck(env.G3C_EVIDENCE_TRUST_PATH) : status('trust', 'NOT_VERIFIED', 'local configuration is unavailable');
  const trustStatus = trust.status === 'FAIL' ? 'FAIL' : 'NOT_VERIFIED';
  const signerPaths = env ? [env.G3C_SIGNER_PRIVATE_KEY_PATH, env.G3C_SIGNER_HMAC_SECRET_PATH, env.G3C_SIGNER_STATE_PATH,
    env.G3C_EVIDENCE_SIGNING_KEY_PATH].filter((item) => item.length > 0).map((item) => pathCheck(item)) : [];
  const signerStatus = gatesStatus === 'FAIL' || signerPaths.some((item) => item.status === 'FAIL') ? 'FAIL' : 'NOT_VERIFIED';
  const budgetStatus = !env || env.NANSEN_CREDIT_BUDGET !== '0' ? (env ? 'FAIL' : 'NOT_VERIFIED') : 'NOT_VERIFIED';
  const walletStatus = 'NOT_VERIFIED';
  const localConfigStatus = configStatus === 'FAIL' || gatesStatus === 'FAIL' || originStatus === 'FAIL' || operatorSecretStatus === 'FAIL' || listenerStatus === 'FAIL' || trustStatus === 'FAIL' || signerStatus === 'FAIL'
    ? 'FAIL' : configStatus === 'PASS' ? 'PASS' : 'NOT_VERIFIED';
  const checks = Object.freeze([
    status('local configuration', localConfigStatus, localConfigStatus === 'PASS' ? 'strict external JSON config parsed; no secret values are included in this report' : 'external config is missing, invalid, or violates a local safety invariant'),
    status('supported runtime', runtimeStatus === 'FAIL' || pnpmStatus === 'FAIL' ? 'FAIL' : runtimeStatus === 'PASS' && pnpmStatus === 'PASS' ? 'PASS' : 'NOT_VERIFIED', 'requires Node.js 24.20.x or later within major 24 and pnpm 11; runtime details are reported without file paths'),
    status('external durable paths', externalFilesStatus, 'regular external files are checked without opening databases; schemas, ACLs, backup policy and retained data are not verified'),
    status('operator origin and access', originStatus === 'FAIL' || operatorSecretStatus === 'FAIL' ? 'FAIL' : originStatus === 'PASS' && operatorSecretStatus === 'PASS' ? 'PASS' : 'NOT_VERIFIED', 'loopback Origin and secret shape only; the secret is never printed'),
    status('local listener port', listenerStatus, 'API process binds to 127.0.0.1; the configured TCP port is checked without opening a socket'),
    status('evidence trust', trustStatus, trustStatus === 'FAIL' ? trust.detail : 'trust contents and key match are not inspected by zero-call preflight'),
    status('signer and custody', signerStatus, signerStatus === 'FAIL' ? 'unsafe execution gate or invalid signer path detected' : 'signer keys are not read/decrypted; custody remains unverified and no host separation is claimed'),
    status('independent execution gates', gatesStatus, gatesStatus === 'PASS'
      ? `Base reads, signing, submission, reviewed deployment and collection remain disabled${env?.D2_G1D_ANALYSIS_ENABLED === 'true' ? '; fresh TypeSafe advisory invocation is explicitly enabled by the CLI opt-in' : '; TypeSafe analysis is disabled'}`
      : 'one or more paid/live gates differ from required disabled defaults'),
    status('provider budget allocation', budgetStatus, 'Nansen active allocation is zero; shared Alchemy scope, period, usage, remaining allowance and hard-stop behavior remain unverified'),
    status('wallet inputs', walletStatus, 'dedicated public wallet and verified ETH/USDC balances are not supplied or independently checked'),
  ]);
  const safeToStartLocal = localConfigStatus === 'PASS' && runtimeStatus === 'PASS' && pnpmStatus === 'PASS' &&
    externalFilesStatus === 'PASS' && originStatus === 'PASS' && operatorSecretStatus === 'PASS' && listenerStatus === 'PASS' &&
    trustStatus !== 'FAIL' && signerStatus !== 'FAIL' && gatesStatus === 'PASS';
  const liveRehearsalReady = false;
  const collectionPlan = createD2cCollectionPlan(env?.NANSEN_OBSERVATION_STORE_ID || null);
  return Object.freeze({
    mode: 'ZERO_CALL_PREFLIGHT',
    providerCalls: 0, secretDecryption: 0, signerInvocations: 0, broadcastInvocations: 0, stateMutation: false,
    runtime: Object.freeze({ node: runtime, nodeStatus: runtimeStatus, pnpmStatus }),
    checks, collectionPlan, safeToStartLocal, liveRehearsalReady,
    freshTypeSafeAnalysisInvocationEnabled: env?.D2_G1D_ANALYSIS_ENABLED === 'true',
  });
}

function defaultConfigPath() {
  const root = process.env.LOCALAPPDATA || resolve(homedir(), '.config');
  return resolve(root, 'Ered-Luin', 'd2c-local.json');
}
function parseArgs(args) {
  let configPath = defaultConfigPath();
  let allowTypeSafeAnalysis = false;
  let sawConfig = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--config' && !sawConfig && args[index + 1]) {
      configPath = resolve(args[index + 1]);
      sawConfig = true;
      index += 1;
    } else if (args[index] === '--allow-typesafe-analysis' && !allowTypeSafeAnalysis) {
      allowTypeSafeAnalysis = true;
    } else {
      throw new Error('USAGE: d2c:preflight [--config <external-json>] [--allow-typesafe-analysis]');
    }
  }
  return { configPath, allowTypeSafeAnalysis };
}
function loadConfig(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) return { configValue: { invalid: true }, configPath: path };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { configValue: parsed, configPath: path };
  } catch { return { configValue: null, configPath: null }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const loaded = loadConfig(args.configPath);
    const report = createD2cPreflightReport({ ...loaded, ...args, runtime: process.version, pnpmUserAgent: process.env.npm_config_user_agent ?? null });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.checks.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    else if (!report.safeToStartLocal) process.exitCode = 2;
  } catch {
    process.stderr.write('D2c preflight could not produce a report; check the command syntax and local configuration.\n');
    process.exitCode = 1;
  }
}