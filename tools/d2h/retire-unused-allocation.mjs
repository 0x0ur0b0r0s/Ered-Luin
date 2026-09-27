import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import { readRunManifest } from './bounded-session.mjs';
import { ledgerPathDigest, readAllocationRetirement, writeAllocationRetirement } from './allocation-retirement.mjs';

const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
function fail(code){throw new Error(code)}
function load({configPath,manifestPath}){
  if(typeof configPath!=='string'||typeof manifestPath!=='string'||!process.env.LOCALAPPDATA)fail('RETIREMENT_INPUT_INVALID');
  const environment=readD2cExternalConfig(configPath),manifest=readRunManifest(manifestPath,ROOT);
  if(!['weth-research-v1','weth-research-v2'].includes(manifest.profile)||manifest.status==='RUNNING'||collectionProcessIsAlive(manifest.pid))fail('RETIREMENT_RUN_NOT_STOPPED');
  if(manifest.stateIdentity.length!==64||!environment.NANSEN_LEDGER_BUDGET_ID||!environment.NANSEN_LEDGER_PATH)fail('RETIREMENT_IDENTITY_INVALID');
  const store=resolve(environment.NANSEN_OBSERVATION_STORE_PATH);if(store===resolve(environment.NANSEN_LEDGER_PATH))fail('RETIREMENT_IDENTITY_INVALID');
  let db;try{
    const stat=lstatSync(environment.NANSEN_LEDGER_PATH);if(!stat.isFile()||stat.isSymbolicLink())fail('RETIREMENT_LEDGER_INVALID');
    db=new DatabaseSync(environment.NANSEN_LEDGER_PATH,{readOnly:true});db.exec('PRAGMA query_only=ON');
    const integrity=db.prepare('PRAGMA integrity_check').all(),fk=db.prepare('PRAGMA foreign_key_check').all();
    const meta=db.prepare('SELECT budget_id,limit_credits,allocated_credits,profile_version,halted FROM ledger_meta WHERE singleton=1').get();
    const attempts=db.prepare('SELECT attempt_id,operation,reserved_credits,charged_credits,outcome,http_status FROM attempts').all();
    if(integrity.length!==1||integrity[0].integrity_check!=='ok'||fk.length||meta?.budget_id!==environment.NANSEN_LEDGER_BUDGET_ID||
      Number(meta.limit_credits)!==Number(environment.NANSEN_LEDGER_LIMIT_CREDITS)||Number(meta.halted)!==0||
      Number(meta.limit_credits)!==manifest.ledger.limitCredits)fail('RETIREMENT_LEDGER_INVALID');
    const pending=attempts.filter(a=>a.outcome===null).length,unknown=attempts.filter(a=>a.outcome!==null&&a.charged_credits===null).length;
    const allocated=attempts.reduce((sum,a)=>sum+Math.max(Number(a.reserved_credits),Number(a.charged_credits??0)),0);
    const reported=attempts.filter(a=>a.charged_credits!==null).reduce((sum,a)=>sum+Number(a.charged_credits),0);
    const successes=attempts.filter(a=>a.outcome==='SUCCESS'&&Number(a.http_status)>=200&&Number(a.http_status)<300).length;
    if(pending!==0||unknown!==manifest.stats.unknownChargeAttempts||allocated!==manifest.ledger.allocatedCredits||
      Number(meta.allocated_credits)!==allocated||reported!==manifest.ledger.reportedChargedCreditsTotal||
      attempts.length!==manifest.stats.providerAttempts||manifest.stats.qualifyingSuccesses-successes!==1)fail('RETIREMENT_ACCOUNTING_MISMATCH');
    const retirement={schemaVersion:1,budgetId:environment.NANSEN_LEDGER_BUDGET_ID,ledgerPathSha256:ledgerPathDigest(environment.NANSEN_LEDGER_PATH),
      originalLimitCredits:Number(meta.limit_credits),allocatedCredits:allocated,retiredCredits:Number(meta.limit_credits)-allocated,actualHttpSuccesses:successes,
      unknownChargeAttempts:unknown,pendingAttempts:pending,createdAt:new Date().toISOString(),reason:'SUPERSEDED_BOUNDED_ALLOCATION'};
    if(retirement.retiredCredits<0)fail('RETIREMENT_ACCOUNTING_MISMATCH');
    const prior=readAllocationRetirement(resolve(process.env.LOCALAPPDATA,'Ered-Luin'),retirement.budgetId,environment.NANSEN_LEDGER_PATH);
    return {environment,manifest,retirement,prior};
  }catch(error){if(error instanceof Error&&error.message.startsWith('RETIREMENT_'))throw error;fail('RETIREMENT_LEDGER_INVALID')}
  finally{try{db?.close()}catch{/* read-only close */}}
}
export function buildRetirementDryRun(input){const s=load(input);if(s.prior)fail('ALLOCATION_RETIREMENT_ALREADY_EXISTS');return Object.freeze({mode:'DRY_RUN',providerCalls:0,stateMutation:false,processAlive:false,
  oldRun:{state:s.manifest.status,attempts:s.manifest.stats.providerAttempts,actualHttpSuccesses:s.retirement.actualHttpSuccesses,
    reportedCredits:s.manifest.ledger.reportedChargedCreditsTotal,allocatedCredits:s.retirement.allocatedCredits,
    remainingCredits:s.retirement.retiredCredits,unknownChargeAttempts:s.retirement.unknownChargeAttempts},retirementWillBlockBudgetId:s.retirement.budgetId});}
export function retireUnusedAllocation(input){const s=load(input);if(s.prior)fail('ALLOCATION_RETIREMENT_ALREADY_EXISTS');
  writeAllocationRetirement(resolve(process.env.LOCALAPPDATA,'Ered-Luin'),s.retirement);
  return Object.freeze({mode:'RETIRED',providerCalls:0,stateMutation:true,processAlive:false,oldRun:{state:s.manifest.status,
    attempts:s.manifest.stats.providerAttempts,actualHttpSuccesses:s.retirement.actualHttpSuccesses,reportedCredits:s.manifest.ledger.reportedChargedCreditsTotal,
    allocatedCredits:s.retirement.allocatedCredits,retiredCredits:s.retirement.retiredCredits,unknownChargeAttempts:s.retirement.unknownChargeAttempts},
    oldAllocationResumable:false});}
function parse(argv){let configPath=null,manifestPath=null,retire=false;for(let i=0;i<argv.length;i++){
  if(argv[i]==='--config'&&argv[i+1]&&configPath===null)configPath=resolve(argv[++i]);
  else if(argv[i]==='--manifest'&&argv[i+1]&&manifestPath===null)manifestPath=resolve(argv[++i]);
  else if(argv[i]==='--retire'&&!retire)retire=true;else fail('RETIREMENT_USAGE');}
  if(!configPath||!manifestPath)fail('RETIREMENT_USAGE');return {configPath,manifestPath,retire};}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  try{const args=parse(process.argv.slice(2));const result=args.retire?retireUnusedAllocation(args):buildRetirementDryRun(args);process.stdout.write(JSON.stringify(result,null,2)+'\n');}
  catch(error){const code=error instanceof Error&&/^(RETIREMENT_[A-Z_]+|ALLOCATION_RETIREMENT_[A-Z_]+)$/u.test(error.message)?error.message:'RETIREMENT_FAILED_SAFE';
    process.stderr.write('Allocation retirement stopped safely: '+code+'. No credential or private path was printed.\n');process.exitCode=1;}
}
