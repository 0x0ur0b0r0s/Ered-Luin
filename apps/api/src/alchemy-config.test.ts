import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAlchemyBaseRpcUrl, loadAlchemyBaseRpcUrl } from './alchemy-config.js';

const API_KEY = 'synthetic_test_alchemy_key_1234567890';
const PROTECTED_VALUE = '01000000aabbccddeeff';
let directory = '';

type StagedConfig = {
  provider: 'alchemy';
  chain: 'base-mainnet';
  chainId: 8453;
  rpcUrlTemplate: string;
  apiKeyFile: string;
  apiKeyProtection: 'windows-dpapi-current-user';
  rpcValidated: boolean;
  liveExecutionEnabled: false;
  usageLimit: {
    currency: 'USD';
    reportedAmount: 25;
    source: 'user-reported';
    providerVerified: false;
    scope: 'unverified';
    billingPeriod: 'unverified';
    remainingAllowance: null;
    enforcement: 'unverified';
    sharedCredential: true;
  };
};

function stagedConfig(endpoint = 'https://base-mainnet.g.alchemy.com/v2/{apiKey}'): StagedConfig {
  return {
    provider: 'alchemy',
    chain: 'base-mainnet',
    chainId: 8453,
    rpcUrlTemplate: endpoint,
    apiKeyFile: 'secrets/alchemy-key.dpapi',
    apiKeyProtection: 'windows-dpapi-current-user',
    rpcValidated: false,
    liveExecutionEnabled: false,
    usageLimit: {
      currency: 'USD', reportedAmount: 25, source: 'user-reported', providerVerified: false,
      scope: 'unverified', billingPeriod: 'unverified', remainingAllowance: null,
      enforcement: 'unverified', sharedCredential: true,
    },
  };
}

function runPowerShell(script: string, input: string): string {
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const executable = resolve(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    input, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8_192,
    env: Object.assign(
      Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
      {
        PSModulePath: [
          resolve(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
          resolve(programFiles, 'WindowsPowerShell', 'Modules'),
        ].join(';'),
      },
    ),
  });
  if (result.error || result.status !== 0) throw new Error('SYNTHETIC_ALCHEMY_POWERSHELL_FIXTURE_FAILED: ' + String(result.error?.message ?? result.stderr ?? result.status));
  return result.stdout;
}

function makePrivateAcl(paths: readonly string[]): void {
  if (process.platform !== 'win32') return;
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const whoami = spawnSync(resolve(windowsRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 2_048,
  });
  const sid = whoami.stdout?.match(/S-1-[0-9-]+/u)?.[0];
  if (whoami.error || whoami.status !== 0 || !sid) throw new Error('SYNTHETIC_ALCHEMY_ACL_FIXTURE_FAILED');
  const icacls = resolve(windowsRoot, 'System32', 'icacls.exe');
  for (const path of paths) {
    const directoryPath = path.endsWith('secrets') || path === directory;
    const permission = '*' + sid + (directoryPath ? ':(OI)(CI)F' : ':F');
    const result = spawnSync(icacls, [path, '/inheritance:r', '/grant:r', permission], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 2_048,
    });
    if (result.error || result.status !== 0) throw new Error('SYNTHETIC_ALCHEMY_ACL_FIXTURE_FAILED');
  }
}

function grantBroadAcl(path: string): void {
  if (process.platform !== 'win32') return;
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const icacls = resolve(windowsRoot, 'System32', 'icacls.exe');
  const result = spawnSync(icacls, [path, '/grant', '*S-1-1-0:R'], {
    encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 2_048,
  });
  if (result.error || result.status !== 0) throw new Error('SYNTHETIC_ALCHEMY_ACL_FIXTURE_FAILED');
}

function stageFakeConfig(config = stagedConfig()): string {
  const secrets = join(directory, 'secrets');
  mkdirSync(secrets, { recursive: true });
  const configPath = join(directory, 'alchemy-rpc.json');
  const secretPath = join(secrets, 'alchemy-key.dpapi');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(secretPath, PROTECTED_VALUE, { mode: 0o600 });
  makePrivateAcl([directory, secrets, configPath, secretPath]);
  return configPath;
}

describe('external Alchemy configuration', () => {
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ered-luin-alchemy-config-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('builds only the pinned Base Mainnet endpoint from the staged schema', async () => {
    const decrypt = vi.fn(async (protectedValue: string) => {
      expect(protectedValue).toBe(PROTECTED_VALUE);
      return API_KEY;
    });
    await expect(buildAlchemyBaseRpcUrl(stagedConfig(), PROTECTED_VALUE, decrypt))
      .resolves.toBe('https://base-mainnet.g.alchemy.com/v2/' + API_KEY);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('rejects an unpinned endpoint before invoking the decryptor', async () => {
    const decrypt = vi.fn(async () => API_KEY);
    await expect(buildAlchemyBaseRpcUrl(stagedConfig('https://attacker.example/{apiKey}'), PROTECTED_VALUE, decrypt))
      .rejects.toThrow('ALCHEMY_ENDPOINT_TEMPLATE_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('rejects altered shared-budget claims and any live-enabled configuration', async () => {
    const decrypt = vi.fn(async () => API_KEY);
    const wrongBudget = { ...stagedConfig(), usageLimit: { ...stagedConfig().usageLimit, remainingAllowance: 25 } };
    const liveEnabled = { ...stagedConfig(), liveExecutionEnabled: true };
    await expect(buildAlchemyBaseRpcUrl(wrongBudget, PROTECTED_VALUE, decrypt)).rejects.toThrow('ALCHEMY_CONFIG_INVALID');
    await expect(buildAlchemyBaseRpcUrl(liveEnabled, PROTECTED_VALUE, decrypt)).rejects.toThrow('ALCHEMY_CONFIG_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('loads the external staged metadata and sibling protected-key file', async () => {
    const configPath = stageFakeConfig();
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt: async () => API_KEY }))
      .resolves.toBe('https://base-mainnet.g.alchemy.com/v2/' + API_KEY);
  });

  it('loads a contained absolute protected-key path from the staged configuration', async () => {
    const config = { ...stagedConfig(), apiKeyFile: join(directory, 'secrets', 'alchemy-key.dpapi') };
    const configPath = stageFakeConfig(config);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt: async () => API_KEY }))
      .resolves.toBe('https://base-mainnet.g.alchemy.com/v2/' + API_KEY);
  });

  it('rejects a protected-key traversal path before invoking the decryptor', async () => {
    const config = { ...stagedConfig(), apiKeyFile: join('..', 'outside.dpapi') };
    const configPath = stageFakeConfig(config);
    const decrypt = vi.fn(async () => API_KEY);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt }))
      .rejects.toThrow('ALCHEMY_SECRET_PATH_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('rejects an absolute protected-key path outside the config directory before decryption', async () => {
    const config = { ...stagedConfig(), apiKeyFile: join(directory, '..', 'outside.dpapi') };
    const configPath = stageFakeConfig(config);
    const decrypt = vi.fn(async () => API_KEY);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt }))
      .rejects.toThrow('ALCHEMY_SECRET_PATH_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('rejects a configuration path inside the repository before reading it', async () => {
    await expect(loadAlchemyBaseRpcUrl({
      configPath: resolve(process.cwd(), '.env.example'),
      decrypt: async () => API_KEY,
    })).rejects.toThrow('ALCHEMY_CONFIG_PATH_INVALID');
  });

  it('rejects malformed metadata without attempting decryption', async () => {
    const configPath = stageFakeConfig();
    writeFileSync(configPath, '{broken');
    const decrypt = vi.fn(async () => API_KEY);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt })).rejects.toThrow('ALCHEMY_CONFIG_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('rejects a protected-key path that traverses a directory junction', async () => {
    const configPath = stageFakeConfig();
    const linkedDirectory = join(directory, 'secrets');
    const targetDirectory = join(directory, 'vault-secrets');
    mkdirSync(targetDirectory);
    const targetKeyPath = join(targetDirectory, 'alchemy-key.dpapi');
    writeFileSync(targetKeyPath, PROTECTED_VALUE, { mode: 0o600 });
    rmSync(linkedDirectory, { recursive: true, force: true });
    symlinkSync(targetDirectory, linkedDirectory, 'junction');
    makePrivateAcl([directory, targetDirectory, targetKeyPath, configPath]);
    const decrypt = vi.fn(async () => API_KEY);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt }))
      .rejects.toThrow('ALCHEMY_SECRET_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('rejects a protected-key file with a broad ACL', async () => {
    const configPath = stageFakeConfig();
    grantBroadAcl(join(directory, 'secrets', 'alchemy-key.dpapi'));
    const decrypt = vi.fn(async () => API_KEY);
    await expect(loadAlchemyBaseRpcUrl({ configPath, decrypt }))
      .rejects.toThrow('ALCHEMY_FILE_ACL_INVALID');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('round-trips a synthetic key using real CurrentUser ConvertFrom-SecureString DPAPI', async () => {
    const secrets = join(directory, 'secrets');
    mkdirSync(secrets, { recursive: true });
    const configPath = join(directory, 'alchemy-rpc.json');
    const secretPath = join(secrets, 'alchemy-key.dpapi');
    writeFileSync(configPath, JSON.stringify(stagedConfig()), { mode: 0o600 });
    const protectScript = "$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $data=[Console]::In.ReadToEnd() | ConvertFrom-Json; $secure=ConvertTo-SecureString -String $data.syntheticKey -AsPlainText -Force; $protected=ConvertFrom-SecureString -SecureString $secure; [IO.File]::WriteAllText($data.secretPath,$protected,[Text.UTF8Encoding]::new($false))";
    runPowerShell(protectScript, JSON.stringify({ syntheticKey: API_KEY, secretPath }));
    makePrivateAcl([directory, secrets, configPath, secretPath]);

    await expect(loadAlchemyBaseRpcUrl({ configPath }))
      .resolves.toBe('https://base-mainnet.g.alchemy.com/v2/' + API_KEY);
  });
});
