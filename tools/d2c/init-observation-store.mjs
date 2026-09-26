import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeNansenObservationStore } from '../../packages/nansen/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
function insideRepository(path) {
  const rel = relative(ROOT, resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function parse(argv) {
  if (argv.length !== 4 || argv[0] !== '--path' || argv[2] !== '--store-id') {
    throw new Error('USAGE: d2c:init-observation-store --path <external-absolute-file> --store-id <stable-id>');
  }
  if (!isAbsolute(argv[1])) throw new Error('OBSERVATION_STORE_PATH_MUST_BE_ABSOLUTE');
  const databasePath = resolve(argv[1]);
  const storeId = argv[3];
  if (insideRepository(databasePath)) throw new Error('OBSERVATION_STORE_PATH_MUST_BE_EXTERNAL');
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(storeId)) throw new Error('OBSERVATION_STORE_ID_INVALID');
  return { databasePath, storeId };
}

try {
  const store = initializeNansenObservationStore(parse(process.argv.slice(2)));
  store.close();
  process.stdout.write('External Nansen observation store initialized. Existing paths are never overwritten.\n');
} catch (error) {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'INITIALIZATION_FAILED';
  process.stderr.write('D2c observation store initialization stopped: ' + code + '. No paths or credentials are printed.\n');
  process.exitCode = 1;
}
