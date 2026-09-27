import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D2C_CONFIG_KEYS, parseD2cConfig } from '../d2c/preflight.mjs';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { acquireCollectionLock } from '../d2c/collector-lock.mjs';
import { loadD2kConfiguration } from '../d2k/config.mjs';
import { readAllocationRetirement } from '../d2h/allocation-retirement.mjs';
import { evaluateHistoryDispatch, historyBackoffMs, planUsdcHistoricalJobs, recoverSettledDispatch, summarizeUsdcHistory } from './bounded-history.mjs';
import {
  NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS,
  createHistoricalBaseUsdcOhlcvQuery, createNansenClient, createNansenQueryManager,
  initializeCreditLedger, initializeNansenObservationStore, openCreditLedger, openNansenObservationStore,
  historicalBaseUsdcOhlcvCacheKey,
} from '../../packages/nansen/dist/index.js';

const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const OLD_BUDGET='d2l-weth-research-20260926T143050-5facfbeb';
const NEW_BUDGET='deadline-usdc-history-20260927';
const HISTORY_CAP=570;
const DEMO_RESERVE=30;
const BASELINE_SUCCESS=550;
const OLD_RUN_SUCCESS=544;
const PRIOR_DIAGNOSTIC_ALLOCATED=11;
const ENVELOPE_CAP=2700;
const MAX_RESPONSE=1_048_576;
const DEADLINE=Date.parse('2026-09-27T23:59:00.000Z');
const OFF=['LIVE_EXECUTION_ENABLED','D2_BASE_READS_ENABLED','D2_DEPLOYMENT_REVIEWED','ALCHEMY_BUDGET_VERIFIED','G3C_REVIEWED_MODE',
 'D2_EXECUTION_REVIEWED','D2_SIGNING_ENABLED','D2_BROADCAST_ENABLED','G3C_SIGNER_DEPLOYED','BASE_BROADCASTER_DEPLOYED',
 'D2_G1D_ANALYSIS_HANDOFF_ENABLED','D2_G1D_ANALYSIS_ENABLED'];
const SAFE=new Set(['DEADLINE_HISTORY_CONFIG_INVALID','DEADLINE_HISTORY_EXTERNAL_STATE_INVALID','DEADLINE_HISTORY_GATES_NOT_OFF',
 'DEADLINE_HISTORY_RETIREMENT_REQUIRED','DEADLINE_HISTORY_ACCOUNTING_HALTED','DEADLINE_HISTORY_LEDGER_INVALID','DEADLINE_HISTORY_STORE_INVALID',
 'DEADLINE_HISTORY_SOURCE_PERIOD_INVALID','DEADLINE_HISTORY_TARGET_REACHED','DEADLINE_HISTORY_CREDIT_CAP','DEADLINE_HISTORY_ATTEMPT_CAP',
 'DEADLINE_HISTORY_RATE_LIMIT_WAIT','DEADLINE_HISTORY_AMBIGUOUS_ATTEMPT','DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT',
 'DEADLINE_HISTORY_ALREADY_COMPLETE','DEADLINE_HISTORY_CREDENTIAL_UNAVAILABLE','DEADLINE_HISTORY_MANIFEST_WRITE_FAILED',
 'DEADLINE_HISTORY_STORE_LOCKED','DEADLINE_HISTORY_INTERRUPTED','DEADLINE_HISTORY_PREFLIGHT_CHANGED']);
const COST=1;
function fail(code){throw new Error(code)}
function obj(v){return typeof v==='object'&&v!==null&&!Array.isArray(v)}
function exact(v,keys){return obj(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',')}
function inside(root,path){const r=relative(resolve(root),resolve(path));return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r))}
function safeJson(path,max=2_000_000){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');return JSON.parse(readFileSync(path,'utf8'))}catch(e){if(e instanceof Error&&SAFE.has(e.message))throw e;fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}}
function writeOnly(path,value){let fd;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd)}catch(e){if(e&&typeof e==='object'&&e.code==='EEXIST')fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');fail('DEADLINE_HISTORY_MANIFEST_WRITE_FAILED')}finally{if(fd!==undefined)closeSync(fd)}}
function ensureDir(path){try{mkdirSync(path,{mode:0o700})}catch(e){if(!(e&&typeof e==='object'&&e.code==='EEXIST'))fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}try{const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}catch{fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}}
function ensureTree(root,path){const base=resolve(root),target=resolve(path);if(!inside(base,target))fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');try{const s=lstatSync(base);if(!s.isDirectory()||s.isSymbolicLink())fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}catch{fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}let cursor=base;for(const part of relative(base,target).split(sep).filter(Boolean)){cursor=join(cursor,part);let stat;try{stat=lstatSync(cursor)}catch(e){if(e&&typeof e==='object'&&e.code==='ENOENT'){ensureDir(cursor);stat=lstatSync(cursor)}else fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}if(!stat.isDirectory()||stat.isSymbolicLink())fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}}
function safeFile(path){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');return true}catch(e){if(e&&typeof e==='object'&&e.code==='ENOENT')return false;if(e instanceof Error&&SAFE.has(e.message))throw e;fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID')}}
function readSourcePeriod(path,storeId){let db;try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())fail('DEADLINE_HISTORY_SOURCE_PERIOD_INVALID');db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON');
 const v=Number(db.prepare('PRAGMA user_version').get()?.user_version),meta=db.prepare('SELECT schema_version,store_id FROM store_meta WHERE singleton=1').get();
 const integrity=db.prepare('PRAGMA integrity_check').all(),fk=db.prepare('PRAGMA foreign_key_check').all();
 if(v!==2||Number(meta?.schema_version)!==2||meta.store_id!==storeId||integrity.length!==1||integrity[0]?.integrity_check!=='ok'||fk.length)fail('DEADLINE_HISTORY_SOURCE_PERIOD_INVALID');
 const range=db.prepare("SELECT MIN(observed_at) AS first_at, MAX(observed_at) AS last_at FROM observations WHERE provider='nansen' AND asset='WETH' AND endpoint IN ('TOKEN_SCREENER','SMART_MONEY_NETFLOW') AND quality='COMPLETE'").get();
 if(typeof range?.first_at!=='string'||typeof range?.last_at!=='string'||!Number.isSafeInteger(Date.parse(range.first_at))||!Number.isSafeInteger(Date.parse(range.last_at))||Date.parse(range.last_at)<=Date.parse(range.first_at))fail('DEADLINE_HISTORY_SOURCE_PERIOD_INVALID');
 return {firstAt:range.first_at,lastAt:range.last_at};
 }catch(e){if(e instanceof Error&&SAFE.has(e.message))throw e;fail('DEADLINE_HISTORY_SOURCE_PERIOD_INVALID')}finally{try{db?.close()}catch{/* Preserve the fail-closed read result. */}}}
function loadConfig(path){
 if(!process.env.LOCALAPPDATA||typeof path!=='string'||!isAbsolute(path)||inside(ROOT,path))fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');
 const appRoot=resolve(process.env.LOCALAPPDATA,'Ered-Luin'),dir=resolve(appRoot,'d2m-usdc-history',NEW_BUDGET),expected=join(dir,'runner.json');
 if(resolve(path)!==expected)fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');
 if(!safeFile(path))fail('DEADLINE_HISTORY_CONFIG_INVALID');const raw=readFileSync(path);let v;try{v=JSON.parse(raw.toString('utf8'))}catch{fail('DEADLINE_HISTORY_CONFIG_INVALID')}
 const top=['schemaVersion','allocation','environment'];const alloc=['budgetId','maxAttempts','maxCredits','demoReserveCredits','baselineActualHttpSuccesses','targetTotalSuccesses','supersedesBudgetId'];
 if(!exact(v,top)||v.schemaVersion!==1||!exact(v.allocation,alloc)||v.allocation.budgetId!==NEW_BUDGET||v.allocation.supersedesBudgetId!==OLD_BUDGET||
   v.allocation.maxAttempts!==HISTORY_CAP||v.allocation.maxCredits!==HISTORY_CAP||v.allocation.demoReserveCredits!==DEMO_RESERVE||
   v.allocation.baselineActualHttpSuccesses!==BASELINE_SUCCESS||v.allocation.targetTotalSuccesses!==1050||!obj(v.environment))fail('DEADLINE_HISTORY_CONFIG_INVALID');
 const e=parseD2cConfig({schemaVersion:1,environment:v.environment});
 if(!e||e.NANSEN_API_ENABLED!=='true'||e.NANSEN_COLLECTION_REVIEWED!=='true'||e.NANSEN_COLLECTION_ENABLED!=='true'||
    OFF.some(k=>e[k]!=='false')||e.EXECUTION_MODE!=='paper'||e.NANSEN_COST_PROFILE_VERSION!==NANSEN_COST_PROFILE_VERSION||
    e.NANSEN_LEDGER_BUDGET_ID!==NEW_BUDGET||e.NANSEN_LEDGER_LIMIT_CREDITS!==String(HISTORY_CAP)||e.NANSEN_CREDIT_BUDGET!==String(HISTORY_CAP)||
    e.NANSEN_LEDGER_PATH!==join(dir,'credits.sqlite')||e.NANSEN_OBSERVATION_STORE_PATH!==join(dir,'usdc-history.sqlite')||
    e.NANSEN_OBSERVATION_STORE_ID!==NEW_BUDGET+'-store'||NANSEN_OPERATION_COSTS.TOKEN_OHLCV!==1)fail('DEADLINE_HISTORY_CONFIG_INVALID');
 const original=loadD2kConfiguration(appRoot).validationEnvironment;
 if(resolve(original.NANSEN_OBSERVATION_STORE_PATH)===resolve(e.NANSEN_OBSERVATION_STORE_PATH)||original.NANSEN_API_ENABLED!=='false'||original.NANSEN_CREDIT_BUDGET!=='0'||
    original.NANSEN_COLLECTION_ENABLED!=='false'||original.EXECUTION_MODE!=='paper')fail('DEADLINE_HISTORY_GATES_NOT_OFF');
 const oldConfigPath=resolve(appRoot,OLD_BUDGET,'collection.json');const old=readD2cExternalConfig(oldConfigPath);
 const retirement=readAllocationRetirement(appRoot,OLD_BUDGET,old.NANSEN_LEDGER_PATH);
 if(!retirement||retirement.originalLimitCredits!==2700||retirement.allocatedCredits!==1636||retirement.retiredCredits!==1064||retirement.unknownChargeAttempts!==1||retirement.pendingAttempts!==0)fail('DEADLINE_HISTORY_RETIREMENT_REQUIRED');
 if(retirement.allocatedCredits+PRIOR_DIAGNOSTIC_ALLOCATED+HISTORY_CAP+DEMO_RESERVE>ENVELOPE_CAP)fail('DEADLINE_HISTORY_CONFIG_INVALID');
 const sourcePeriod=readSourcePeriod(original.NANSEN_OBSERVATION_STORE_PATH,original.NANSEN_OBSERVATION_STORE_ID);
 const startMs=Math.floor(Date.parse(sourcePeriod.firstAt)/(10*60_000))*(10*60_000);
 const endMs=Math.min(Math.floor(Date.parse(sourcePeriod.lastAt)/(10*60_000))*(10*60_000),Math.floor(Date.now()/(10*60_000))*(10*60_000));
 if(endMs<=startMs)fail('DEADLINE_HISTORY_SOURCE_PERIOD_INVALID');
 const jobs=planUsdcHistoricalJobs({from:new Date(startMs).toISOString(),to:new Date(endMs).toISOString(),now:new Date(),maxJobs:HISTORY_CAP});
 const planIdentity=createHash('sha256').update(JSON.stringify({budgetId:NEW_BUDGET,baseline:BASELINE_SUCCESS,target:1050,from:jobs[0].date.from,to:jobs.at(-1).date.to,jobIds:jobs.map(j=>j.jobId)}),'utf8').digest('hex');
 return {dir,appRoot,allocation:v.allocation,environment:e,sourcePeriod,jobs,planIdentity,configSha256:createHash('sha256').update(raw).digest('hex'),sourceStorePath:original.NANSEN_OBSERVATION_STORE_PATH,sourceStoreId:original.NANSEN_OBSERVATION_STORE_ID};
}
function inspectLedger(path,budgetId,limit){if(!safeFile(path))return {exists:false,allocatedCredits:0,attemptCount:0,pendingAttempts:0,unknownCharges:0,halted:false};let db;try{db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON');
 const ver=Number(db.prepare('PRAGMA user_version').get()?.user_version),meta=db.prepare('SELECT schema_version,budget_id,limit_credits,allocated_credits,profile_version,halted FROM ledger_meta WHERE singleton=1').get();
 const integrity=db.prepare('PRAGMA integrity_check').all(),fk=db.prepare('PRAGMA foreign_key_check').all(),rows=db.prepare('SELECT reserved_credits,charged_credits,outcome FROM attempts').all();
 if(ver!==3||Number(meta?.schema_version)!==3||meta.budget_id!==budgetId||Number(meta.limit_credits)!==limit||meta.profile_version!==NANSEN_COST_PROFILE_VERSION||integrity.length!==1||integrity[0]?.integrity_check!=='ok'||fk.length)fail('DEADLINE_HISTORY_LEDGER_INVALID');
 const allocated=rows.reduce((n,x)=>n+Math.max(Number(x.reserved_credits),Number(x.charged_credits??0)),0),pending=rows.filter(x=>x.outcome===null).length,unknown=rows.filter(x=>x.outcome!==null&&x.charged_credits===null).length;
 if(allocated!==Number(meta.allocated_credits))fail('DEADLINE_HISTORY_LEDGER_INVALID');return {exists:true,allocatedCredits:allocated,attemptCount:rows.length,pendingAttempts:pending,unknownCharges:unknown,halted:Number(meta.halted)!==0};
 }catch(e){if(e instanceof Error&&SAFE.has(e.message))throw e;fail('DEADLINE_HISTORY_LEDGER_INVALID')}finally{try{db?.close()}catch{/* Preserve the fail-closed read result. */}}}
function readMarkers(runDir,jobs,ledger){const done=new Map();let dispatched=0;for(const job of jobs){const resultPath=join(runDir,job.jobId+'.result.json'),dispatchPath=join(runDir,job.jobId+'.dispatch.json');
  if(safeFile(resultPath)){const r=safeJson(resultPath,16384);if(r.jobId!==job.jobId||r.attemptId!==('deadline-history:'+job.jobId))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');done.set(job.jobId,r)}
  else if(safeFile(dispatchPath)){dispatched++;const r=safeJson(dispatchPath,16384);if(r.jobId!==job.jobId||r.attemptId!==('deadline-history:'+job.jobId))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');
    const a=ledger.getAttempt(r.attemptId);const recovered=recoverSettledDispatch({marker:r,attempt:a});if(!recovered.recoverable)fail('DEADLINE_HISTORY_AMBIGUOUS_ATTEMPT');
    done.set(job.jobId,recovered.entry);
  }
 }
 return {done,dispatched};}
function createManifest(runDir,config,jobs){const path=join(runDir,'manifest.json'),manifest={schemaVersion:1,gate:'deadline-history',budgetId:NEW_BUDGET,planIdentity:config.planIdentity,
 from:jobs[0].date.from,to:jobs.at(-1).date.to,jobCount:jobs.length,baselineActualHttpSuccesses:BASELINE_SUCCESS,targetTotalSuccesses:1050,
 maxAttempts:HISTORY_CAP,maxCredits:HISTORY_CAP,demoReserveCredits:DEMO_RESERVE,createdAt:new Date().toISOString()};
 if(!safeFile(path))writeOnly(path,manifest);else{const prior=safeJson(path,1_000_000);if(JSON.stringify(prior)!==JSON.stringify(manifest)&&prior.planIdentity!==manifest.planIdentity)fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');}
 return manifest;}
function reportFromState(config,jobs,runDir,ledger,store,done,stopReason){const jobResults=[];for(const job of jobs){const entry=done.get(job.jobId);if(!entry)continue;
  const query=createHistoricalBaseUsdcOhlcvQuery(new Date(job.date.from),new Date(job.date.to));const cacheKey=historicalBaseUsdcOhlcvCacheKey(query);const snapshot=store.getMostRecentWithObservations(cacheKey);
  const attempt=ledger.getAttempt(entry.attemptId);jobResults.push({jobId:job.jobId,resultStatus:entry.resultStatus,snapshotCompleteness:snapshot?.completeness??null,snapshotFailure:snapshot?.failure??null,
   attempts:attempt?[{attemptId:attempt.attemptId,operation:attempt.operation,outcome:attempt.outcome,httpStatus:attempt.httpStatus,chargedCredits:attempt.reportedChargedCredits}]:[],observations:snapshot?.signals??[]});}
 const summary=summarizeUsdcHistory({jobs,jobResults,baselineSuccesses:BASELINE_SUCCESS,targetSuccesses:1050,now:new Date()});
 return Object.freeze({schemaVersion:1,gate:'deadline-history',runId:config.planIdentity.slice(0,20),status:stopReason,
 period:{from:jobs[0].date.from,to:jobs.at(-1).date.to},allocation:{budgetId:NEW_BUDGET,maxCredits:HISTORY_CAP,maxAttempts:HISTORY_CAP,
 allocatedCredits:ledger.getSnapshot().allocatedCredits,remainingCredits:ledger.getSnapshot().remainingCredits,demoReserveCredits:DEMO_RESERVE},
 accounting:{attempts:summary.accounting.uniqueAttempts,reportedCredits:summary.accounting.reportedCredits,unknownCharges:summary.accounting.unknownCharges,
 actualHttpSuccesses:summary.uniqueProviderSuccesses,verifiedTotalSuccesses:summary.totalVerifiedSuccesses,remainingToTarget:summary.remainingToTarget},
 coverage:summary.coverage,deviationFromPegBps:summary.deviationFromPegBps,firewallReplay:summary.firewallReplay,
 policy:{paidNansenScope:'bounded research only',liveExecution:false,trading:false,rawPayloadInReport:false},limits:summary.limits});}
function makePreflight(configPath){const c=loadConfig(configPath),runDir=join(c.dir,'runs',c.planIdentity);
 const ledger=inspectLedger(c.environment.NANSEN_LEDGER_PATH,NEW_BUDGET,HISTORY_CAP);if(ledger.pendingAttempts||ledger.unknownCharges||ledger.halted)fail('DEADLINE_HISTORY_ACCOUNTING_HALTED');
 if(ledger.attemptCount>HISTORY_CAP||ledger.allocatedCredits>HISTORY_CAP)fail('DEADLINE_HISTORY_CREDIT_CAP');
 const manifestPath=join(runDir,'manifest.json');if(safeFile(manifestPath)){const m=safeJson(manifestPath,1_000_000);if(m.planIdentity!==c.planIdentity)fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');}
 return {config:c,runDir,ledger,report:Object.freeze({gate:'deadline-history',mode:'DRY_RUN',providerCalls:0,credentialRead:false,stateMutation:false,
 period:{from:c.jobs[0].date.from,to:c.jobs.at(-1).date.to},jobCount:c.jobs.length,baselineActualHttpSuccesses:BASELINE_SUCCESS,targetTotalSuccesses:1050,
 maxNewHistoryCredits:HISTORY_CAP,demoReserveCredits:DEMO_RESERVE,combinedNewCreditCap:HISTORY_CAP+DEMO_RESERVE,
 combinedAllocatedExposureUpperBound:1636+PRIOR_DIAGNOSTIC_ALLOCATED+HISTORY_CAP+DEMO_RESERVE,
 oldAllocation:{allocatedCredits:1636,retiredCredits:1064,unknownChargeAttempts:1,preserved:true},priorDiagnosticAllocations:{allocatedCredits:PRIOR_DIAGNOSTIC_ALLOCATED,verifiedAdditionalUniqueSuccesses:BASELINE_SUCCESS-OLD_RUN_SUCCESS},
 existingHistoryAllocation:{allocatedCredits:ledger.allocatedCredits,attempts:ledger.attemptCount},separateObservationStore:true,
 request:{endpoint:'/api/v1/tgm/token-ohlcv',chain:'base',asset:'USDC',timeframe:'1m',windowMinutes:10,pageBound:1,retries:0,minimumIntervalMs:2_000},
 deadlineEastern:'2026-09-27 19:59 EDT',configSha256:c.configSha256})};}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function buildDeadlineHistoryDryRun(configPath){return makePreflight(configPath).report;}
export function buildDeadlineHistoryReport(configPath){
 const prepared=makePreflight(configPath),manifestPath=join(prepared.runDir,'manifest.json');if(!safeFile(manifestPath))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');
 const manifest=safeJson(manifestPath,1_000_000);if(manifest.planIdentity!==prepared.config.planIdentity||!safeFile(prepared.config.environment.NANSEN_OBSERVATION_STORE_PATH)||!safeFile(prepared.config.environment.NANSEN_LEDGER_PATH))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');
 let ledger,store;try{ledger=openCreditLedger({databasePath:prepared.config.environment.NANSEN_LEDGER_PATH,budgetId:NEW_BUDGET,limitCredits:HISTORY_CAP,costProfileVersion:NANSEN_COST_PROFILE_VERSION});
  store=openNansenObservationStore({databasePath:prepared.config.environment.NANSEN_OBSERVATION_STORE_PATH,storeId:prepared.config.environment.NANSEN_OBSERVATION_STORE_ID});
  const state=readMarkers(prepared.runDir,prepared.config.jobs,ledger);
  const provisional=reportFromState(prepared.config,prepared.config.jobs,prepared.runDir,ledger,store,state.done,'INTERRUPTED');
  const stopReason=provisional.accounting.remainingToTarget===0?'SUCCESS_TARGET_REACHED':
    state.done.size===prepared.config.jobs.length?'MANIFEST_EXHAUSTED':
    provisional.accounting.unknownCharges>0?'ACCOUNTING_RECONCILIATION_REQUIRED':'INTERRUPTED';
  return reportFromState(prepared.config,prepared.config.jobs,prepared.runDir,ledger,store,state.done,stopReason);
 }finally{try{store?.close()}finally{ledger?.close()}}
}
export async function runDeadlineHistory({configPath,dispatch=false,apiKey,expectedConfigSha256=null,now=()=>new Date(),sleepFn=sleep,
 createClient=createNansenClient,createManager=createNansenQueryManager,openLedger=openCreditLedger,openStore=openNansenObservationStore,initStore=initializeNansenObservationStore}={}){
 const prepared=makePreflight(configPath);if(expectedConfigSha256!==null&&prepared.config.configSha256!==expectedConfigSha256)fail('DEADLINE_HISTORY_PREFLIGHT_CHANGED');if(!dispatch)return prepared.report;
 const credential=apiKey??process.env.NANSEN_API_KEY;if(typeof credential!=='string'||!credential)fail('DEADLINE_HISTORY_CREDENTIAL_UNAVAILABLE');
 const c=prepared.config;let lock,ledger,store,currentAttemptId=null,retryAfterMs=null,dispatchTime=null,rateLimitCount=0,reason='MANIFEST_EXHAUSTED';
 try{ensureTree(c.appRoot,prepared.runDir);createManifest(prepared.runDir,c,c.jobs);
  const storeOptions={databasePath:c.environment.NANSEN_OBSERVATION_STORE_PATH,storeId:c.environment.NANSEN_OBSERVATION_STORE_ID};
  if(safeFile(c.environment.NANSEN_OBSERVATION_STORE_PATH)){try{lock=acquireCollectionLock(c.environment.NANSEN_OBSERVATION_STORE_PATH,{runId:'deadline-history-'+c.planIdentity.slice(0,20)})}catch{fail('DEADLINE_HISTORY_STORE_LOCKED')}store=openStore(storeOptions)}
  else{store=initStore(storeOptions);try{lock=acquireCollectionLock(c.environment.NANSEN_OBSERVATION_STORE_PATH,{runId:'deadline-history-'+c.planIdentity.slice(0,20)})}catch{fail('DEADLINE_HISTORY_STORE_LOCKED')}}
  ledger=safeFile(c.environment.NANSEN_LEDGER_PATH)?openLedger({databasePath:c.environment.NANSEN_LEDGER_PATH,budgetId:NEW_BUDGET,limitCredits:HISTORY_CAP,costProfileVersion:NANSEN_COST_PROFILE_VERSION}):initializeCreditLedger({databasePath:c.environment.NANSEN_LEDGER_PATH,budgetId:NEW_BUDGET,limitCredits:HISTORY_CAP,costProfileVersion:NANSEN_COST_PROFILE_VERSION});
  const state=readMarkers(prepared.runDir,c.jobs,ledger);let totalSuccesses=0;
  const priorPauses=[...state.done.values()].map(x=>typeof x.pauseUntil==='string'?Date.parse(x.pauseUntil):NaN).filter(Number.isSafeInteger);
  const waitUntil=Math.max(0,...priorPauses);if(waitUntil>Date.now()){if(waitUntil>=DEADLINE){reason='DEADLINE_HISTORY_RATE_LIMIT_WAIT';}else await sleepFn(waitUntil-Date.now());}
  for(const job of c.jobs){if(reason==='DEADLINE_HISTORY_RATE_LIMIT_WAIT')break;if(Date.now()>=DEADLINE){reason='DEADLINE_REACHED';break;}const prior=state.done.get(job.jobId);if(prior){if(prior.operation==='TOKEN_OHLCV'&&prior.outcome==='SUCCESS'&&prior.httpStatus>=200&&prior.httpStatus<300&&prior.chargedCredits!==null)totalSuccesses++;continue;}
   if(BASELINE_SUCCESS+totalSuccesses>=1050){reason='SUCCESS_TARGET_REACHED';break;}
   const snapshot=ledger.getSnapshot();if(snapshot.pendingAttemptCount||snapshot.reconciliationRequired||ledger.listUnknownChargeAttempts().length){reason='ACCOUNTING_RECONCILIATION_REQUIRED';break;}
   const persisted=inspectLedger(c.environment.NANSEN_LEDGER_PATH,NEW_BUDGET,HISTORY_CAP);
   const admission=evaluateHistoryDispatch({job,query:createHistoricalBaseUsdcOhlcvQuery(new Date(job.date.from),new Date(job.date.to)),ledger:snapshot,
     attemptCount:persisted.attemptCount,allocatedCredits:snapshot.allocatedCredits,unknownChargeCount:ledger.listUnknownChargeAttempts().length,dispatchCount:state.dispatched,
     maxAttempts:HISTORY_CAP,maxCredits:HISTORY_CAP,costCredits:COST});
   if(!admission.allowed){reason=admission.reason==='ACCOUNTING'?'ACCOUNTING_RECONCILIATION_REQUIRED':'CREDIT_OR_ATTEMPT_CAP_REACHED';break;}
   if(snapshot.remainingCredits<COST){reason='CREDIT_CAP_REACHED';break;}
   const attemptId='deadline-history:'+job.jobId;if(ledger.getAttempt(attemptId)){reason='DEADLINE_HISTORY_AMBIGUOUS_ATTEMPT';break;}
   if(dispatchTime!==null){const pause=Math.max(0,2_000-(Date.now()-dispatchTime));if(pause)await sleepFn(pause);}
   currentAttemptId=attemptId;retryAfterMs=null;dispatchTime=null;
   const query=createHistoricalBaseUsdcOhlcvQuery(new Date(job.date.from),new Date(job.date.to));
   const client=createClient({ledger,enabled:true,apiKey:credential,maxPages:1,timeoutMs:8_000,maxResponseBytes:MAX_RESPONSE,attemptIdFactory:()=>currentAttemptId,
     onRawResponse:o=>{retryAfterMs=o.retryAfterMs??null;if(o.operation!=='TOKEN_OHLCV')fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT')}});
   const manager=createManager({client,store,enabled:true,maxPageBound:1,maxRetryBound:0,beforeDispatch:q=>{
     if(q.operation!=='TOKEN_OHLCV'||q.historical!==true||q.date.from!==job.date.from||q.date.to!==job.date.to||q.pageBound!==1||q.retryBound!==0)return 'DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT';
     const l=ledger.getSnapshot(),persisted=inspectLedger(c.environment.NANSEN_LEDGER_PATH,NEW_BUDGET,HISTORY_CAP);
     const gate=evaluateHistoryDispatch({job,query:q,ledger:l,attemptCount:persisted.attemptCount,allocatedCredits:l.allocatedCredits,
       unknownChargeCount:ledger.listUnknownChargeAttempts().length,dispatchCount:state.dispatched,maxAttempts:HISTORY_CAP,maxCredits:HISTORY_CAP,costCredits:COST});
     if(!gate.allowed)return gate.reason==='ACCOUNTING'?'DEADLINE_HISTORY_ACCOUNTING_HALTED':'DEADLINE_HISTORY_CREDIT_CAP';
     const file=join(prepared.runDir,job.jobId+'.dispatch.json');writeOnly(file,{schemaVersion:1,jobId:job.jobId,attemptId,requestedAt:now().toISOString(),operation:'TOKEN_OHLCV',date:job.date,estimatedCredits:1});
     state.dispatched++;dispatchTime=Date.now();return null;
   }});
   const result=await manager.query(query);const attempt=ledger.getAttempt(attemptId);const refs=result.attemptPageReferences??[];
   if(refs.length>1||refs.some(r=>r.attemptId!==attemptId)||attempt&&refs.length!==1)fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');
   const completedAt=now();const rateLimited=result.failure?.status===429||refs.some(r=>r.status===429);
   const backoffMs=historyBackoffMs({status:rateLimited?429:result.failure?.status,retryAfterMs,rateLimitCount});if(rateLimited&&retryAfterMs===null)rateLimitCount++;
   const pauseUntil=backoffMs>0?new Date(completedAt.getTime()+backoffMs).toISOString():null;
   const entry={schemaVersion:1,jobId:job.jobId,attemptId,operation:attempt?.operation??'TOKEN_OHLCV',outcome:attempt?.outcome??null,
     httpStatus:attempt?.httpStatus??null,chargedCredits:attempt?.reportedChargedCredits??null,resultStatus:result.status,completeness:result.completeness,
     retryAfterMs,backoffMs,pauseUntil,completedAt:completedAt.toISOString()};
   writeOnly(join(prepared.runDir,job.jobId+'.result.json'),entry);state.done.set(job.jobId,entry);
   if(attempt?.outcome==='SUCCESS'&&attempt.httpStatus!==null&&attempt.httpStatus>=200&&attempt.httpStatus<300&&attempt.reportedChargedCredits!==null)totalSuccesses++;
   if(!attempt||attempt.outcome==='PENDING'||attempt.reportedChargedCredits===null){reason='UNKNOWN_CHARGE_REQUIRES_RECONCILIATION';break;}
   if(backoffMs>0){if(Date.now()+backoffMs>=DEADLINE){reason='DEADLINE_REACHED';break;}await sleepFn(backoffMs);}
   if(result.status==='disabled'&&result.failure?.code==='DISABLED'){reason=result.managerError??'DISPATCH_DENIED';break;}
   if(BASELINE_SUCCESS+totalSuccesses>=1050){reason='SUCCESS_TARGET_REACHED';break;}
  }
  const report=reportFromState(c,c.jobs,prepared.runDir,ledger,store,state.done,reason);
  const stamp=now().toISOString().replaceAll(':','').replaceAll('.','');
  try{writeOnly(join(prepared.runDir,'report-'+stamp+'.json'),report)}catch(e){if(!(e instanceof Error&&e.message==='DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT'))throw e;}
  return report;
 }catch(error){if(error instanceof Error&&SAFE.has(error.message))throw error;fail('DEADLINE_HISTORY_INTERRUPTED')}
 finally{try{store?.close()}finally{try{ledger?.close()}finally{lock?.release()}}}
}
function provision(){
 if(!process.env.LOCALAPPDATA)fail('DEADLINE_HISTORY_EXTERNAL_STATE_INVALID');const root=resolve(process.env.LOCALAPPDATA,'Ered-Luin');
 const oldConfig=readD2cExternalConfig(resolve(root,OLD_BUDGET,'collection.json'));
 const retired=readAllocationRetirement(root,OLD_BUDGET,oldConfig.NANSEN_LEDGER_PATH);
 if(!retired||retired.allocatedCredits!==1636||retired.retiredCredits!==1064||retired.unknownChargeAttempts!==1)fail('DEADLINE_HISTORY_RETIREMENT_REQUIRED');
 const current=loadD2kConfiguration(root).mainEnvironment;
 if(current.NANSEN_API_ENABLED!=='false'||current.NANSEN_CREDIT_BUDGET!=='0'||current.NANSEN_COLLECTION_ENABLED!=='false'||current.EXECUTION_MODE!=='paper')fail('DEADLINE_HISTORY_GATES_NOT_OFF');
 const dir=resolve(root,'d2m-usdc-history',NEW_BUDGET);ensureTree(resolve(process.env.LOCALAPPDATA),dir);
 const historyStore=join(dir,'usdc-history.sqlite'),ledger=join(dir,'credits.sqlite');if(safeFile(historyStore))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');if(safeFile(ledger))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');
 const environment=Object.fromEntries(D2C_CONFIG_KEYS.map(k=>[k,'']));
 Object.assign(environment,{NODE_ENV:'development',NANSEN_API_ENABLED:'true',NANSEN_CREDIT_BUDGET:String(HISTORY_CAP),NANSEN_COLLECTION_REVIEWED:'true',NANSEN_COLLECTION_ENABLED:'true',
  LIVE_EXECUTION_ENABLED:'false',EXECUTION_MODE:'paper',PORT:'3000',PAPER_STATE_PATH:'',NANSEN_OBSERVATION_STORE_PATH:historyStore,NANSEN_OBSERVATION_STORE_ID:NEW_BUDGET+'-store',
  D2_AUDIT_STORE_PATH:'',D2_OPERATOR_SECRET:'',D2_OPERATOR_ALLOWED_ORIGIN:'http://127.0.0.1:5173',D2_EXECUTION_REVIEWED:'false',D2_SIGNING_ENABLED:'false',D2_BROADCAST_ENABLED:'false',
  G3C_SIGNER_DEPLOYED:'false',BASE_BROADCASTER_DEPLOYED:'false',G3C_SIGNER_PRIVATE_KEY_PATH:'',G3C_SIGNER_HMAC_SECRET_PATH:'',G3C_SIGNER_STATE_PATH:'',G3C_EVIDENCE_TRUST_PATH:'',
  D2_BASE_READS_ENABLED:'false',D2_DEPLOYMENT_REVIEWED:'false',ALCHEMY_BUDGET_VERIFIED:'false',D2_RPC_MAX_REQUESTS:'896',D2_RPC_RECOVERY_RESERVE:'192',
  G3C_EVIDENCE_SIGNING_KEY_PATH:'',G3C_EVIDENCE_KEY_ID:'',D2_G1D_ANALYSIS_HANDOFF_ENABLED:'false',D2_G1D_ANALYSIS_ENABLED:'false',G1D_SHADOW_AUDIT_STORE_PATH:'',G1D_SHADOW_AUDIT_STORE_ID:'',
  NANSEN_LEDGER_PATH:ledger,NANSEN_LEDGER_BUDGET_ID:NEW_BUDGET,NANSEN_LEDGER_LIMIT_CREDITS:String(HISTORY_CAP),NANSEN_COST_PROFILE_VERSION:NANSEN_COST_PROFILE_VERSION,
  D2C_PUBLIC_WALLET_ADDRESS:'',D2C_WALLET_USDC_BALANCE:'',D2C_WALLET_ETH_BALANCE:'',G3C_REVIEWED_MODE:'false'});
 if(!parseD2cConfig({schemaVersion:1,environment}))fail('DEADLINE_HISTORY_CONFIG_INVALID');
 const value={schemaVersion:1,allocation:{budgetId:NEW_BUDGET,maxAttempts:HISTORY_CAP,maxCredits:HISTORY_CAP,demoReserveCredits:DEMO_RESERVE,
  baselineActualHttpSuccesses:BASELINE_SUCCESS,targetTotalSuccesses:1050,supersedesBudgetId:OLD_BUDGET},environment};
 const configPath=join(dir,'runner.json');if(safeFile(configPath))fail('DEADLINE_HISTORY_RUN_IDENTITY_CONFLICT');writeOnly(configPath,value);
 return Object.freeze({mode:'PROVISIONED',providerCalls:0,ledgerCreated:false,observationStoreCreated:false,retiredOldAllocated:retired.allocatedCredits,
  oldUnusedCapacityRetired:retired.retiredCredits,oldUnknownChargePreserved:true,newHistoryCredits:HISTORY_CAP,demoCreditsReserved:DEMO_RESERVE,
  totalNewExposure:HISTORY_CAP+DEMO_RESERVE,priorDiagnosticAllocated:PRIOR_DIAGNOSTIC_ALLOCATED,combinedExposureUpperBound:retired.allocatedCredits+PRIOR_DIAGNOSTIC_ALLOCATED+HISTORY_CAP+DEMO_RESERVE,configCreated:true});
}
function parse(argv){let configPath=null,dispatch=false,doProvision=false,doReport=false,hash=null;for(let i=0;i<argv.length;i++){
 if(argv[i]==='--config'&&argv[i+1]&&!configPath)configPath=resolve(argv[++i]);else if(argv[i]==='--preflight-sha256'&&argv[i+1]&&hash===null)hash=argv[++i];else if(argv[i]==='--dispatch'&&!dispatch)dispatch=true;
 else if(argv[i]==='--provision'&&!doProvision)doProvision=true;else if(argv[i]==='--report'&&!doReport)doReport=true;else fail('DEADLINE_HISTORY_CONFIG_INVALID');}
 if((dispatch?1:0)+(doProvision?1:0)+(doReport?1:0)>1||hash!==null&&!/^[0-9a-f]{64}$/u.test(hash))fail('DEADLINE_HISTORY_CONFIG_INVALID');return {configPath,dispatch,doProvision,doReport,hash};}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
 try{const a=parse(process.argv.slice(2));const configPath=a.configPath??join(process.env.LOCALAPPDATA,'Ered-Luin','d2m-usdc-history',NEW_BUDGET,'runner.json');const result=a.doProvision?provision():a.doReport?buildDeadlineHistoryReport(configPath):buildDeadlineHistoryDryRun(configPath);
  if(a.dispatch)runDeadlineHistory({configPath:a.configPath??join(process.env.LOCALAPPDATA,'Ered-Luin','d2m-usdc-history',NEW_BUDGET,'runner.json'),dispatch:true,expectedConfigSha256:a.hash}).then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n'))
    .catch(e=>{const code=e instanceof Error&&SAFE.has(e.message)?e.message:'DEADLINE_HISTORY_INTERRUPTED';process.stderr.write('Bounded history runner stopped safely: '+code+'. No credentials, paths, raw payloads or prices are printed.\n');process.exitCode=1;});
  else process.stdout.write(JSON.stringify(result,null,2)+'\n');
 }catch(e){const code=e instanceof Error&&SAFE.has(e.message)?e.message:'DEADLINE_HISTORY_INTERRUPTED';process.stderr.write('Bounded history runner stopped safely: '+code+'. No credentials, paths, raw payloads or prices are printed.\n');process.exitCode=1;}
}
