import { openCreditLedger } from '../dist/index.js';

const [databasePath, serializedOptions, serializedInput] = process.argv.slice(2);
const ledger = openCreditLedger({ ...JSON.parse(serializedOptions), databasePath });
ledger.reserveAttempt(JSON.parse(serializedInput));
process.exit(0);
