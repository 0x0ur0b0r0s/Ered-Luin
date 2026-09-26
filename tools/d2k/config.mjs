import { join, resolve } from 'node:path';

import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { NANSEN_COST_PROFILE_VERSION } from '../../packages/nansen/dist/index.js';

const GATES_THAT_MUST_STAY_OFF = [
  'NANSEN_API_ENABLED',
  'NANSEN_COLLECTION_REVIEWED',
  'NANSEN_COLLECTION_ENABLED',
  'LIVE_EXECUTION_ENABLED',
  'D2_BASE_READS_ENABLED',
  'D2_DEPLOYMENT_REVIEWED',
  'ALCHEMY_BUDGET_VERIFIED',
  'G3C_REVIEWED_MODE',
  'D2_EXECUTION_REVIEWED',
  'D2_SIGNING_ENABLED',
  'D2_BROADCAST_ENABLED',
  'G3C_SIGNER_DEPLOYED',
  'BASE_BROADCASTER_DEPLOYED',
  'D2_G1D_ANALYSIS_HANDOFF_ENABLED',
  'D2_G1D_ANALYSIS_ENABLED',
];

export function resolveD2kConfigPaths(eredLuinDirectory) {
  if (typeof eredLuinDirectory !== 'string' || !/^[A-Za-z]:[\\/]/u.test(eredLuinDirectory)) {
    throw new Error('D2K_CONFIG_INVALID');
  }
  const root = resolve(eredLuinDirectory);
  return Object.freeze({
    mainConfigPath: join(root, 'd2c-local.json'),
    originalValidationConfigPath: join(root, 'nansen-validation-20260925-01', 'collection.json'),
  });
}

function requireDisabled(environment, isMain) {
  if (GATES_THAT_MUST_STAY_OFF.some((key) => environment[key] !== 'false') ||
      environment.EXECUTION_MODE !== 'paper' || environment.NANSEN_CREDIT_BUDGET !== '0' ||
      environment.NANSEN_COST_PROFILE_VERSION !== NANSEN_COST_PROFILE_VERSION) {
    throw new Error('D2K_EXTERNAL_GATES_NOT_OFF');
  }
  if (isMain && (environment.NANSEN_LEDGER_LIMIT_CREDITS !== '0' ||
      environment.NANSEN_LEDGER_PATH !== '' || environment.NANSEN_LEDGER_BUDGET_ID !== '')) {
    throw new Error('D2K_MAIN_CONFIG_CHANGED');
  }
  if (!isMain && (environment.NANSEN_LEDGER_LIMIT_CREDITS !== '7' ||
      !environment.NANSEN_LEDGER_PATH || !environment.NANSEN_LEDGER_BUDGET_ID ||
      !environment.NANSEN_OBSERVATION_STORE_PATH || !environment.NANSEN_OBSERVATION_STORE_ID ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(environment.NANSEN_LEDGER_BUDGET_ID) ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(environment.NANSEN_OBSERVATION_STORE_ID))) {
    throw new Error('D2K_CONFIG_INVALID');
  }
}

export function loadD2kConfiguration(eredLuinDirectory, readExternalConfig = readD2cExternalConfig) {
  const paths = resolveD2kConfigPaths(eredLuinDirectory);
  if (typeof readExternalConfig !== 'function') throw new Error('D2K_CONFIG_INVALID');
  const mainEnvironment = readExternalConfig(paths.mainConfigPath);
  const validationEnvironment = readExternalConfig(paths.originalValidationConfigPath);
  requireDisabled(mainEnvironment, true);
  requireDisabled(validationEnvironment, false);
  return Object.freeze({ ...paths, mainEnvironment, validationEnvironment });
}