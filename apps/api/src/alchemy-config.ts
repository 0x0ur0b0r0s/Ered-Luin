import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_CONFIG_BYTES = 8_192;
const MAX_PROTECTED_KEY_BYTES = 4_096;
const POWERSHELL_TIMEOUT_MS = 5_000;
const DPAPI_SCRIPT = "$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $cipher=[Console]::In.ReadToEnd().Trim(); if ($cipher.Length -gt 4096 -or $cipher -notmatch '^01000000[0-9a-fA-F]+$') { throw 'invalid protected value' }; $secure=ConvertTo-SecureString -String $cipher -ErrorAction Stop; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";
const ACL_SCRIPT = `$ErrorActionPreference='Stop'; $path=[Console]::In.ReadToEnd() | ConvertFrom-Json; $code=@'
using System;
using System.Runtime.InteropServices;
public static class EredLuinAclReader {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  private static extern uint GetNamedSecurityInfo(string name, int objectType, uint securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,
    uint revision, uint securityInfo, out IntPtr result, out uint length);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
  public static string Get(string path) {
    IntPtr owner, group, dacl, sacl, descriptor, result;
    uint length;
    uint status=GetNamedSecurityInfo(path,1,7,out owner,out group,out dacl,out sacl,out descriptor);
    if(status!=0) throw new InvalidOperationException("ACL_QUERY_FAILED");
    try {
      if(!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,7,out result,out length))
        throw new InvalidOperationException("ACL_SERIALIZE_FAILED");
      try { return Marshal.PtrToStringUni(result) ?? String.Empty; }
      finally { LocalFree(result); }
    } finally { LocalFree(descriptor); }
  }
}
'@; Add-Type -TypeDefinition $code -ErrorAction Stop; [Console]::Out.Write([EredLuinAclReader]::Get($path))`;

interface AlchemyUsageLimit {
  readonly currency: 'USD';
  readonly reportedAmount: 25;
  readonly source: 'user-reported';
  readonly providerVerified: false;
  readonly scope: 'unverified';
  readonly billingPeriod: 'unverified';
  readonly remainingAllowance: null;
  readonly enforcement: 'unverified';
  readonly sharedCredential: true;
}
interface ExternalAlchemyConfig {
  readonly provider: 'alchemy';
  readonly chain: 'base-mainnet';
  readonly chainId: 8453;
  readonly rpcUrlTemplate: string;
  readonly apiKeyFile: string;
  readonly apiKeyProtection: 'windows-dpapi-current-user';
  readonly rpcValidated: boolean;
  readonly liveExecutionEnabled: false;
  readonly usageLimit: AlchemyUsageLimit;
}
export type DpapiDecryptor = (protectedValue: string) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function checkedConfig(value: unknown): ExternalAlchemyConfig {
  if (!isRecord(value)) throw new Error('ALCHEMY_CONFIG_INVALID');
  const expectedKeys = ['apiKeyFile', 'apiKeyProtection', 'chain', 'chainId', 'liveExecutionEnabled',
    'provider', 'rpcUrlTemplate', 'rpcValidated', 'usageLimit'];
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',') ||
      value.provider !== 'alchemy' || value.chain !== 'base-mainnet' || value.chainId !== 8453 ||
      typeof value.rpcUrlTemplate !== 'string' || typeof value.apiKeyFile !== 'string' ||
      value.apiKeyProtection !== 'windows-dpapi-current-user' || typeof value.rpcValidated !== 'boolean' ||
      value.liveExecutionEnabled !== false || !isRecord(value.usageLimit)) {
    throw new Error('ALCHEMY_CONFIG_INVALID');
  }
  const usage = value.usageLimit;
  const usageKeys = ['billingPeriod', 'currency', 'enforcement', 'providerVerified', 'remainingAllowance',
    'reportedAmount', 'scope', 'sharedCredential', 'source'];
  if (Object.keys(usage).sort().join(',') !== usageKeys.sort().join(',') ||
      usage.currency !== 'USD' || usage.reportedAmount !== 25 || usage.source !== 'user-reported' ||
      usage.providerVerified !== false || usage.scope !== 'unverified' || usage.billingPeriod !== 'unverified' ||
      usage.remainingAllowance !== null || usage.enforcement !== 'unverified' || usage.sharedCredential !== true) {
    throw new Error('ALCHEMY_CONFIG_INVALID');
  }
  const template = value.rpcUrlTemplate;
  if (template.split('{apiKey}').length !== 2) throw new Error('ALCHEMY_ENDPOINT_TEMPLATE_INVALID');
  let url: URL;
  try { url = new URL(template.replace('{apiKey}', 'placeholder-api-key')); }
  catch { throw new Error('ALCHEMY_ENDPOINT_TEMPLATE_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'base-mainnet.g.alchemy.com' ||
      url.pathname !== '/v2/placeholder-api-key' || url.username || url.password || url.search || url.hash) {
    throw new Error('ALCHEMY_ENDPOINT_TEMPLATE_INVALID');
  }
  if (!value.apiKeyFile || value.apiKeyFile.includes(String.fromCharCode(0))) {
    throw new Error('ALCHEMY_SECRET_PATH_INVALID');
  }
  return value as unknown as ExternalAlchemyConfig;
}

function runPowerShell(script: string, input: string, maxOutputChars: number): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('ALCHEMY_WINDOWS_SECURITY_UNAVAILABLE'));
  return new Promise((resolveValue, reject) => {
    const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const executable = resolve(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
    Object.assign(env, {
      // Use inbox Windows PowerShell modules. Extra PSModulePath entries can
      // register duplicate ObjectSecurity type data and block ACL/DPAPI cmdlets.
      PSModulePath: [
        resolve(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        resolve(programFiles, 'WindowsPowerShell', 'Modules'),
      ].join(';'),
    });
    const child = spawn(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('ALCHEMY_POWERSHELL_TIMEOUT'));
    }, POWERSHELL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > maxOutputChars && !settled) {
        settled = true;
        child.kill();
        clearTimeout(timer);
        reject(new Error('ALCHEMY_POWERSHELL_OUTPUT_INVALID'));
      }
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('ALCHEMY_WINDOWS_SECURITY_UNAVAILABLE'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error('ALCHEMY_POWERSHELL_CHECK_FAILED'));
      else resolveValue(output);
    });
    child.stdin.end(input, 'utf8');
  });
}

async function assertPrivateWindowsAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const sddl = await runPowerShell(ACL_SCRIPT, JSON.stringify(path), 4_096);
    const owner = sddl.match(/O:([^:]+?)(?=G:|D:|S:|$)/u)?.[1];
    const dacl = sddl.slice(sddl.indexOf('D:') + 2);
    const aces = [...dacl.matchAll(/\(([^()]*)\)/gu)];
    const flags = dacl.replace(/\([^()]*\)/gu, '');
    const current = await runPowerShell("[Console]::Out.Write(([Security.Principal.WindowsIdentity]::GetCurrent().User.Value))", '', 128);
    const allowed = new Set([current, 'S-1-5-18', 'S-1-5-32-544', 'SY', 'BA']);
    if (!owner || !allowed.has(owner) || !aces.length || !/^(?:P|AI|AR)*$/u.test(flags) ||
        aces.some((match) => {
          const fields = match[1]?.split(';') ?? [];
          return fields.length !== 6 || fields[0] !== 'A' || !allowed.has(fields[5] ?? '');
        })) throw new Error();
  } catch {
    throw new Error('ALCHEMY_FILE_ACL_INVALID');
  }
}

function assertSafeExternalFile(path: string, maxBytes: number, code: string) {
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new Error(code);
  const absolute = resolve(path);
  const rootRelative = relative(REPOSITORY_ROOT, absolute);
  if (rootRelative === '' || (rootRelative !== '..' && !rootRelative.startsWith('..' + sep) && !isAbsolute(rootRelative))) {
    throw new Error(code);
  }
  if (!existsSync(absolute)) throw new Error(code === 'ALCHEMY_CONFIG_INVALID' ? 'ALCHEMY_CONFIG_NOT_FOUND' : 'ALCHEMY_SECRET_NOT_FOUND');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || resolve(realpathSync(absolute)) !== absolute || stat.size < 1 || stat.size > maxBytes) {
    throw new Error(code);
  }
  return absolute;
}

function assertSafeExternalDirectory(path: string, code: string): void {
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new Error(code);
  const absolute = resolve(path);
  const rootRelative = relative(REPOSITORY_ROOT, absolute);
  if (rootRelative === '' || (rootRelative !== '..' && !rootRelative.startsWith('..' + sep) && !isAbsolute(rootRelative))) {
    throw new Error(code);
  }
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(realpathSync(absolute)) !== absolute) throw new Error(code);
}
async function decryptCurrentUserDpapi(protectedValue: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('ALCHEMY_DPAPI_UNAVAILABLE');
  return runPowerShell(DPAPI_SCRIPT, protectedValue, 512);
}

function checkProtectedValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROTECTED_KEY_BYTES ||
      !/^01000000[0-9a-fA-F]+$/u.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('ALCHEMY_PROTECTED_KEY_INVALID');
  }
  return normalized;
}

export async function buildAlchemyBaseRpcUrl(
  value: unknown,
  protectedValue: string,
  decrypt: DpapiDecryptor = decryptCurrentUserDpapi,
): Promise<string> {
  const config = checkedConfig(value);
  let apiKey: string;
  try { apiKey = (await decrypt(checkProtectedValue(protectedValue))).trim(); }
  catch { throw new Error('ALCHEMY_DPAPI_DECRYPT_FAILED'); }
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(apiKey)) throw new Error('ALCHEMY_API_KEY_INVALID');
  return config.rpcUrlTemplate.replace('{apiKey}', apiKey);
}

function resolveProtectedKeyPath(configPath: string, config: ExternalAlchemyConfig): string {
  const configDirectory = dirname(configPath);
  const protectedPath = isAbsolute(config.apiKeyFile)
    ? resolve(config.apiKeyFile)
    : resolve(configDirectory, config.apiKeyFile);
  const pathRelativeToConfig = relative(configDirectory, protectedPath);
  if (!pathRelativeToConfig || pathRelativeToConfig === '..' || pathRelativeToConfig.startsWith('..' + sep) ||
      isAbsolute(pathRelativeToConfig)) throw new Error('ALCHEMY_SECRET_PATH_INVALID');
  const repoRelative = relative(REPOSITORY_ROOT, protectedPath);
  if (repoRelative === '' || (repoRelative !== '..' && !repoRelative.startsWith('..' + sep) && !isAbsolute(repoRelative))) {
    throw new Error('ALCHEMY_SECRET_PATH_INVALID');
  }
  return protectedPath;
}

export async function loadAlchemyBaseRpcUrl(input: {
  readonly configPath?: string;
  readonly decrypt?: DpapiDecryptor;
} = {}): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA;
  const path = input.configPath ?? (localAppData ? resolve(localAppData, 'Ered-Luin', 'alchemy-rpc.json') : '');
  if (!path || !isAbsolute(path) || path.includes(String.fromCharCode(0))) throw new Error('ALCHEMY_CONFIG_PATH_INVALID');
  const candidatePath = resolve(path);
  const configRelativeToRepository = relative(REPOSITORY_ROOT, candidatePath);
  if (configRelativeToRepository === '' || (configRelativeToRepository !== '..' && !configRelativeToRepository.startsWith('..' + sep) && !isAbsolute(configRelativeToRepository))) {
    throw new Error('ALCHEMY_CONFIG_PATH_INVALID');
  }
  const absolute = assertSafeExternalFile(candidatePath, MAX_CONFIG_BYTES, 'ALCHEMY_CONFIG_INVALID');
  assertSafeExternalDirectory(dirname(absolute), 'ALCHEMY_CONFIG_PATH_INVALID');
  await assertPrivateWindowsAcl(dirname(absolute));
  await assertPrivateWindowsAcl(absolute);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(absolute, 'utf8')); }
  catch { throw new Error('ALCHEMY_CONFIG_INVALID'); }
  const config = checkedConfig(parsed);
  const protectedPath = resolveProtectedKeyPath(absolute, config);
  const safeProtectedPath = assertSafeExternalFile(protectedPath, MAX_PROTECTED_KEY_BYTES, 'ALCHEMY_SECRET_INVALID');
  assertSafeExternalDirectory(dirname(safeProtectedPath), 'ALCHEMY_SECRET_PATH_INVALID');
  await assertPrivateWindowsAcl(dirname(safeProtectedPath));
  await assertPrivateWindowsAcl(safeProtectedPath);
  let protectedValue: string;
  try { protectedValue = readFileSync(safeProtectedPath, 'utf8'); }
  catch { throw new Error('ALCHEMY_SECRET_INVALID'); }
  return buildAlchemyBaseRpcUrl(config, protectedValue, input.decrypt);
}
