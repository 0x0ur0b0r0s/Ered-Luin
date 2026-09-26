import { initializeD2AuditStore } from './d2-audit-store.js';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('Pass an absolute D2 audit database path outside the repository.');
const store = initializeD2AuditStore({ databasePath });
store.close();
process.stdout.write('D2 audit store initialized.\n');
