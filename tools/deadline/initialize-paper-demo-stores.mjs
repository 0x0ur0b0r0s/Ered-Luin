import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializePaperStore } from '../../apps/api/dist/paper-store.js';
import { initializeD2AuditStore } from '../../apps/api/dist/d2-audit-store.js';

const id = process.argv[2];
if (!id || !/^paper-demo-\d{14}-[a-f0-9]{8}$/u.test(id)) throw new Error('DEMO_ID_INVALID');
const dir = resolve(process.env.LOCALAPPDATA ?? '', 'Ered-Luin', 'paper-demo-allocations', id);
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (dir.toLowerCase().startsWith(repo.toLowerCase())) throw new Error('DEMO_PATH_INVALID');
const paperPath = join(dir, 'paper-v2.sqlite'), auditPath = join(dir, 'd2-audit.sqlite');
if (existsSync(paperPath)) throw new Error('DEMO_STORE_ALREADY_EXISTS');
const paper = initializePaperStore({ databasePath: paperPath });
try {
  const audit = initializeD2AuditStore({ databasePath: auditPath });
  audit.close();
} finally { paper.close(); }
process.stdout.write(JSON.stringify({ initialized: true, paperStore: 'paper-v2.sqlite', d2AuditStore: 'd2-audit.sqlite' }) + '\n');
