import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_ASSET_ADDRESSES, BASE_USDC_OHLCV_PRICE_CACHE_KEY, NANSEN_COST_PROFILE_VERSION, NANSEN_OPERATION_COSTS,
  createBaseUsdcOhlcvPriceQuery, createNansenClient, createNansenQueryManager, openCreditLedger, openNansenObservationStore,
} from '../../packages/nansen/dist/index.js';
import { readD2cExternalConfig } from '../d2c/manual-collect.mjs';
import { acquireCollectionLock, collectionProcessIsAlive } from '../d2c/collector-lock.mjs';
import { readRunManifest, createStateIdentity, resolveExternalManifestPath } from '../d2h/bounded-session.mjs';
import { parseD2cConfig } from '../d2c/preflight.mjs';
import { loadD2kConfiguration } from '../d2k/config.mjs';
import { D2U_RUN_ID } from '../d2u/diagnostic.mjs';
import { classifyD2vPrice } from './diagnostic.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ALLOC = 'd2v-usdc-refresh';
const MAX_RAW = 1_048_576;
const OFF = ['LIVE_EXECUTION_ENABLED','D2_BASE_READS_ENABLED','D2_DEPLOYMENT_REVIEWED','ALCHEMY_BUDGET_VERIFIED','G3C_REVIEWED_MODE',
  'D2_EXECUTION_REVIEWED','D2_SIGNING_ENABLED','D2_BROADCAST_ENABLED','G3C_SIGNER_DEPLOYED','BASE_BROADCASTER_DEPLOYED',
  'D2_G1D_ANALYSIS_HANDOFF_ENABLED','D2_G1D_ANALYSIS_ENABLED'];
const SAFE = new Set(['D2V_REFRESH_USAGE','D2V_REFRESH_CONFIG_INVALID','D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE','D2V_REFRESH_ALLOCATION_INVALID',
  'D2V_REFRESH_COST_PROFILE_MISMATCH','D2V_REFRESH_ORIGINAL_ALLOCATION_REJECTED','D2V_REFRESH_IDENTITY_CONFLICT',
  'D2V_REFRESH_LEDGER_INVALID','D2V_REFRESH_STORE_INVALID','D2V_REFRESH_COLLECTOR_STATE_AMBIGUOUS','D2V_REFRESH_COLLECTOR_NOT_STOPPED',
  'D2V_REFRESH_COLLECTOR_ACCOUNTING_MISMATCH','D2V_REFRESH_STORE_LOCKED','D2V_REFRESH_INVOCATION_REUSED','D2V_REFRESH_ATTEMPT_CAP_REACHED',
  'D2V_REFRESH_BUDGET_INSUFFICIENT','D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED','D2V_REFRESH_CREDENTIAL_UNAVAILABLE',
  'D2V_REFRESH_CONFIG_CHANGED','D2V_REFRESH_GATES_NOT_OFF','D2V_REFRESH_PERSISTENCE_FAILED']);

function fail(code) { throw new Error(code); }
function obj(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function inside(root, path) { const r = relative(resolve(root), resolve(path)); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); }
function extFile(path, max = Number.MAX_SAFE_INTEGER) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes(String.fromCharCode(0)) || inside(ROOT, path)) fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE');
  try { const checked = resolveExternalManifestPath(path, ROOT); const s = lstatSync(checked); if (!s.isFile() || s.isSymbolicLink() || s.size > max) fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE'); return checked; }
  catch { fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE'); }
}
function extDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(ROOT, path)) fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE');
  try { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE'); return resolve(path); }
  catch { fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE'); }
}
function hash(b) { return createHash('sha256').update(b).digest('hex'); }
function canonical(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (!obj(v)) fail('D2V_REFRESH_CONFIG_INVALID');
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function readJson(path, max=65536) { try { return JSON.parse(readFileSync(extFile(path,max),'utf8')); } catch { fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE'); } }
function writeOnly(path, data) {
  let fd;
  try { fd=openSync(path,'wx',0o600); writeFileSync(fd,data); fsyncSync(fd); closeSync(fd); fd=undefined; }
  catch { if(fd!==undefined)try{closeSync(fd)}catch{/* Descriptor cleanup is best-effort. */} fail('D2V_REFRESH_PERSISTENCE_FAILED'); }
}
function writeJson(path,value) { writeOnly(path,Buffer.from(JSON.stringify(value,null,2)+'\n','utf8')); }
function eastern(value) {
  const d=value instanceof Date?value:new Date(value); if(!Number.isSafeInteger(d.getTime()))return null;
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d);
  const z=new Intl.DateTimeFormat('en-US',{timeZone:'America/Toronto',timeZoneName:'short'}).formatToParts(d).find(x=>x.type==='timeZoneName')?.value??'ET';
  const get=n=>p.find(x=>x.type===n)?.value??''; return get('year')+'-'+get('month')+'-'+get('day')+' '+get('hour')+':'+get('minute')+':'+get('second')+' '+z;
}
function assertGates() {
  if (['NANSEN_API_ENABLED','NANSEN_COLLECTION_REVIEWED','NANSEN_COLLECTION_ENABLED',...OFF].some(k=>process.env[k]==='true') || (process.env.EXECUTION_MODE!==undefined && process.env.EXECUTION_MODE!=='paper')) fail('D2V_REFRESH_GATES_NOT_OFF');
}
function loadConfig(path) {
  const raw=readFileSync(extFile(path,65536)); let v;
  try{v=JSON.parse(raw.toString('utf8'))}catch{fail('D2V_REFRESH_CONFIG_INVALID')}
  if(!obj(v)||Object.keys(v).sort().join(',')!=='allocation,environment,schemaVersion'||v.schemaVersion!==1||
    !obj(v.allocation)||Object.keys(v.allocation).sort().join(',')!=='budgetId,maxAttempts,maxCredits'||
    typeof v.allocation.budgetId!=='string'||!/^[A-Za-z0-9._-]{1,64}$/u.test(v.allocation.budgetId)||
    !Number.isSafeInteger(v.allocation.maxAttempts)||v.allocation.maxAttempts<1||v.allocation.maxAttempts>10000||
    !Number.isSafeInteger(v.allocation.maxCredits)||v.allocation.maxCredits<1||v.allocation.maxCredits>10000)fail('D2V_REFRESH_CONFIG_INVALID');
  const e=parseD2cConfig({schemaVersion:1,environment:v.environment});
  if(!e||e.NANSEN_API_ENABLED!=='true'||e.NANSEN_COLLECTION_REVIEWED!=='true'||e.NANSEN_COLLECTION_ENABLED!=='true'||
    OFF.some(k=>e[k]!=='false')||e.EXECUTION_MODE!=='paper'||e.NANSEN_COST_PROFILE_VERSION!==NANSEN_COST_PROFILE_VERSION||
    e.NANSEN_LEDGER_BUDGET_ID!==v.allocation.budgetId||e.NANSEN_CREDIT_BUDGET!==String(v.allocation.maxCredits)||
    e.NANSEN_LEDGER_LIMIT_CREDITS!==String(v.allocation.maxCredits)||!e.NANSEN_LEDGER_PATH||!e.NANSEN_OBSERVATION_STORE_PATH||
    !e.NANSEN_OBSERVATION_STORE_ID||NANSEN_OPERATION_COSTS.TOKEN_OHLCV!==1) {
    fail(e?.NANSEN_COST_PROFILE_VERSION!==NANSEN_COST_PROFILE_VERSION?'D2V_REFRESH_COST_PROFILE_MISMATCH':'D2V_REFRESH_CONFIG_INVALID');
  }
  if(!process.env.LOCALAPPDATA)fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE');
  const dir=extDir(dirname(path)); const expected=resolve(process.env.LOCALAPPDATA,'Ered-Luin',ALLOC,v.allocation.budgetId);
  if(dir!==expected||resolve(path)!==join(expected,'refresh.json')||resolve(e.NANSEN_LEDGER_PATH)!==join(expected,'credits.sqlite'))fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE');
  return Object.freeze({allocation:v.allocation,environment:e,directory:dir,configSha256:hash(raw)});
}
function sqlite(path, code, fn) {
  let db; try { db=new DatabaseSync(extFile(path),{readOnly:true}); db.exec('PRAGMA query_only=ON'); return fn(db); }
  catch(err){if(err instanceof Error&&SAFE.has(err.message))throw err;fail(code)}
  finally{try{db?.close()}catch{/* Read-only close is best-effort. */}}
}
function readLedger(path,a,research=false) {
  return sqlite(path,'D2V_REFRESH_LEDGER_INVALID',db=>{
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
    const m=db.prepare('SELECT schema_version,budget_id,limit_credits,profile_version,allocated_credits,halted,halt_reason FROM ledger_meta WHERE singleton=1').get();
    const rows=db.prepare('SELECT attempt_id,operation,charged_credits,outcome FROM attempts ORDER BY attempt_id').all();
    const integrity=db.prepare('PRAGMA integrity_check').all(), fk=db.prepare('PRAGMA foreign_key_check').all();
    if(version!==3||Number(m?.schema_version)!==3||m?.budget_id!==a.budgetId||Number(m?.limit_credits)!==a.maxCredits||
      m?.profile_version!==NANSEN_COST_PROFILE_VERSION||Number(m?.halted)!==0||m?.halt_reason!==null||
      integrity.length!==1||integrity[0]?.integrity_check!=='ok'||fk.length)fail('D2V_REFRESH_LEDGER_INVALID');
    const pending=rows.filter(r=>r.outcome===null).length, unknown=rows.filter(r=>r.outcome!==null&&r.charged_credits===null).length;
    const allocated=rows.reduce((n,r)=>n+(Number(r.charged_credits)||0),0);
    if((!research&&rows.some(r=>r.operation!=='TOKEN_OHLCV'))||pending||unknown||String(allocated)!==m.allocated_credits)fail('D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED');
    return Object.freeze({limitCredits:Number(m.limit_credits),allocatedCredits:allocated,remainingCredits:Number(m.limit_credits)-allocated,
      attempts:Object.freeze(rows.map(r=>r.attempt_id)),pendingAttemptCount:pending,unknownChargeCount:unknown});
  });
}
function readStore(path,id,now=Date.now()) {
  return sqlite(path,'D2V_REFRESH_STORE_INVALID',db=>{
    const ver=Number(db.prepare('PRAGMA user_version').get()?.user_version),m=db.prepare('SELECT schema_version,store_id FROM store_meta WHERE singleton=1').get();
    const integrity=db.prepare('PRAGMA integrity_check').all(),fk=db.prepare('PRAGMA foreign_key_check').all();
    if(ver!==2||Number(m?.schema_version)!==2||m?.store_id!==id||integrity.length!==1||integrity[0]?.integrity_check!=='ok'||fk.length)fail('D2V_REFRESH_STORE_INVALID');
    const c=db.prepare('SELECT s.completeness,s.failure_code,s.source,s.observation_count,c.expires_at_ms FROM cache_entries c JOIN snapshots s ON s.snapshot_id=c.snapshot_id WHERE c.cache_key=?').get(BASE_USDC_OHLCV_PRICE_CACHE_KEY);
    return Object.freeze({storeId:id,cacheCandidate:Boolean(c&&c.source==='nansen'&&c.completeness==='complete'&&c.failure_code===null&&Number(c.observation_count)>0&&Number(c.expires_at_ms)>now)});
  });
}
function markers(dir) {
  const names=readdirSync(dir), inv=names.filter(n=>/^refresh-[A-Za-z0-9._-]{1,64}\.invocation\.json$/u.test(n));
  const disp=names.filter(n=>/^refresh-[A-Za-z0-9._-]{1,64}\.dispatch\.json$/u.test(n)), ids=new Set();
  for(const n of disp){const m=readJson(join(dir,n),16384);if(m.schemaVersion!==1||m.operation!=='TOKEN_OHLCV'||typeof m.attemptId!=='string'||ids.has(m.attemptId))fail('D2V_REFRESH_LEDGER_INVALID');ids.add(m.attemptId)}
  return {invocations:inv.map(n=>n.slice(8,-15)),dispatchIds:ids,count:disp.length};
}
function collector(privateRoot,e) {
  let dirs;try{dirs=readdirSync(privateRoot,{withFileTypes:true})}catch{return {present:false,state:'NO_MATCHING_RUN'}}
  const matches=[];
  for(const d of dirs){if(!d.isDirectory()||!d.name.startsWith('d2l-'))continue;let m;
    try{m=readRunManifest(join(privateRoot,d.name,'d2l-run.json'),ROOT)}catch{continue}
    if(m.profile!=='weth-research-v2')continue;
    let c;try{c=readD2cExternalConfig(join(privateRoot,d.name,'collection.json'))}catch{fail('D2V_REFRESH_COLLECTOR_STATE_AMBIGUOUS')}
    if(resolve(c.NANSEN_OBSERVATION_STORE_PATH)===resolve(e.NANSEN_OBSERVATION_STORE_PATH)&&c.NANSEN_OBSERVATION_STORE_ID===e.NANSEN_OBSERVATION_STORE_ID)matches.push({m,c});
  }
  if(matches.length>1)fail('D2V_REFRESH_COLLECTOR_STATE_AMBIGUOUS');
  if(!matches.length)return {present:false,state:'NO_MATCHING_RUN'};
  const {m,c}=matches[0];
  if(m.status!=='STOPPED'||collectionProcessIsAlive(m.pid))fail('D2V_REFRESH_COLLECTOR_NOT_STOPPED');
  if(m.stats.unknownChargeAttempts||m.ledger.pendingAttemptCount||m.ledger.reconciliationRequired)fail('D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED');
  const identity=createStateIdentity({ledgerPath:c.NANSEN_LEDGER_PATH,budgetId:c.NANSEN_LEDGER_BUDGET_ID,costProfileVersion:c.NANSEN_COST_PROFILE_VERSION,
    observationStorePath:c.NANSEN_OBSERVATION_STORE_PATH,observationStoreId:c.NANSEN_OBSERVATION_STORE_ID});
  if(identity!==m.stateIdentity)fail('D2V_REFRESH_COLLECTOR_ACCOUNTING_MISMATCH');
  const l=readLedger(c.NANSEN_LEDGER_PATH,{budgetId:c.NANSEN_LEDGER_BUDGET_ID,maxCredits:Number(c.NANSEN_LEDGER_LIMIT_CREDITS)},true);
  if(l.unknownChargeCount||l.pendingAttemptCount||l.allocatedCredits!==m.ledger.allocatedCredits)fail('D2V_REFRESH_COLLECTOR_ACCOUNTING_MISMATCH');
  return {present:true,state:m.status,processAlive:false,runId:m.runId};
}
function validate({configPath,invocationId,privateRoot}) {
  if(typeof invocationId!=='string'||!/^[A-Za-z0-9._-]{1,64}$/u.test(invocationId))fail('D2V_REFRESH_CONFIG_INVALID');
  if(typeof configPath!=='string'||!isAbsolute(configPath)||!process.env.LOCALAPPDATA)fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE');
  const path=resolve(configPath),c=loadConfig(path); assertGates();
  const root=privateRoot??resolve(process.env.LOCALAPPDATA,'Ered-Luin'); let prior;
  try{prior=loadD2kConfiguration(root).validationEnvironment}catch{fail('D2V_REFRESH_EXTERNAL_STATE_UNAVAILABLE')}
  if(c.allocation.budgetId===D2U_RUN_ID||c.allocation.budgetId===prior.NANSEN_LEDGER_BUDGET_ID||
    resolve(c.environment.NANSEN_LEDGER_PATH)===resolve(prior.NANSEN_LEDGER_PATH)||
    resolve(c.environment.NANSEN_LEDGER_PATH)===resolve(root,D2U_RUN_ID,'credits.sqlite')||
    resolve(c.environment.NANSEN_OBSERVATION_STORE_PATH)!==resolve(prior.NANSEN_OBSERVATION_STORE_PATH)||
    c.environment.NANSEN_OBSERVATION_STORE_ID!==prior.NANSEN_OBSERVATION_STORE_ID)fail('D2V_REFRESH_ORIGINAL_ALLOCATION_REJECTED');
  const allocRoot=dirname(dirname(path));
  for(const d of readdirSync(allocRoot,{withFileTypes:true})){if(!d.isDirectory()||d.name===c.allocation.budgetId)continue;
    const other=join(allocRoot,d.name,'refresh.json');if(existsSync(other)){try{if(loadConfig(other).allocation.budgetId===c.allocation.budgetId)fail('D2V_REFRESH_IDENTITY_CONFLICT')}catch(err){if(err instanceof Error&&SAFE.has(err.message))throw err}}}
  const l=readLedger(c.environment.NANSEN_LEDGER_PATH,c.allocation),mk=markers(c.directory);
  if(l.attempts.length!==mk.dispatchIds.size||l.attempts.some(id=>!mk.dispatchIds.has(id)))fail('D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED');
  const s=readStore(c.environment.NANSEN_OBSERVATION_STORE_PATH,c.environment.NANSEN_OBSERVATION_STORE_ID);
  const col=collector(root,c.environment);
  if(mk.invocations.includes(invocationId)||existsSync(join(c.directory,'refresh-'+invocationId+'.result.json'))||
    existsSync(join(c.directory,'refresh-'+invocationId+'.dispatch.json')))fail('D2V_REFRESH_INVOCATION_REUSED');
  if(mk.count>=c.allocation.maxAttempts)fail('D2V_REFRESH_ATTEMPT_CAP_REACHED');
  if(l.remainingCredits<NANSEN_OPERATION_COSTS.TOKEN_OHLCV)fail('D2V_REFRESH_BUDGET_INSUFFICIENT');
  const q=createBaseUsdcOhlcvPriceQuery(),body={chain:'base',token_address:BASE_ASSET_ADDRESSES.USDC,timeframe:'1m',date:q.date};
  return {...c,privateRoot:root,invocationId,attemptId:'d2v-refresh:'+invocationId,ledger:l,markers:mk,store:s,collector:col,query:q,body,bodyHash:hash(Buffer.from(canonical(body)))};
}
export function buildD2vRefreshDryRun(args) {
  const s=validate(args);
  return Object.freeze({gate:'D2v',command:'d2v:refresh',mode:'DRY_RUN',dispatchReady:true,providerCalls:0,transportAttempts:0,
    credentialRead:false,persistentWrite:false,lockAcquired:false,configSha256:s.configSha256,invocationId:s.invocationId,collector:s.collector,
    cacheCandidate:s.store.cacheCandidate,allocation:{budgetId:s.allocation.budgetId,maxAttempts:s.allocation.maxAttempts,maxCredits:s.allocation.maxCredits,
      attemptsUsed:s.markers.count,allocatedCredits:s.ledger.allocatedCredits,remainingCredits:s.ledger.remainingCredits},
    request:{method:'POST',endpoint:'/api/v1/tgm/token-ohlcv',chain:'base',asset:'USDC',timeframe:'1m',window:'ten completed minutes',
      date:s.query.date,pageBound:1,retryBound:0,expectedCredits:1,cacheKey:BASE_USDC_OHLCV_PRICE_CACHE_KEY,costProfileVersion:NANSEN_COST_PROFILE_VERSION},
    preserved:{mainAppConfiguration:true,originalDiagnostic:true,priorLedgersAndMarkers:true}});
}
function rawObserver(dir,attemptId,bodyHash,state) {
  return o=>{try{
    if(o.operation!=='TOKEN_OHLCV'||!(o.body instanceof Uint8Array)||o.body.byteLength>MAX_RAW||!Number.isSafeInteger(o.status))throw new Error();
    const bytes=new Uint8Array(o.body),name='refresh-'+attemptId.replaceAll(':','-')+'-raw.bin';writeOnly(join(dir,name),bytes);
    state.status='CAPTURED';state.metadata={attemptId,endpoint:'/api/v1/tgm/token-ohlcv',httpStatus:o.status,providerRequestId:o.providerRequestId,
      chargedCredits:o.chargedCredits,capturedAt:o.capturedAt,requestBodySha256:bodyHash,matchesApprovedRequest:o.requestBodySha256===bodyHash,
      responseSha256:o.sha256,byteLength:bytes.byteLength,rawFile:name};
  }catch{state.status='CAPTURE_FAILED';state.reasonCode='RAW_CAPTURE_WRITE_FAILED'}};
}
function cached(store,now) {
  const s=store.getFreshCache(BASE_USDC_OHLCV_PRICE_CACHE_KEY,now);
  return s&&s.source==='nansen'&&s.completeness==='complete'&&s.failure===null?
    {observations:s.signals,status:'cached',source:'nansen',completeness:s.completeness,cacheHit:true,failure:null,storeError:null,attemptPageReferences:[]}:null;
}
export async function runD2vRefresh({configPath,invocationId,dispatch=false,apiKey=process.env.NANSEN_API_KEY,expectedConfigSha256=null,
  privateRoot,now=()=>new Date(),createClient=createNansenClient,createManager=createNansenQueryManager}={}) {
  let s=validate({configPath,invocationId,privateRoot});
  if(expectedConfigSha256!==null&&expectedConfigSha256!==s.configSha256)fail('D2V_REFRESH_CONFIG_CHANGED');
  if(!dispatch)return buildD2vRefreshDryRun({configPath,invocationId,privateRoot});
  const originalHash=s.configSha256,opts={databasePath:s.environment.NANSEN_LEDGER_PATH,budgetId:s.allocation.budgetId,
    limitCredits:s.allocation.maxCredits,costProfileVersion:NANSEN_COST_PROFILE_VERSION};
  const invPath=join(s.directory,'refresh-'+invocationId+'.invocation.json'),dispPath=join(s.directory,'refresh-'+invocationId+'.dispatch.json');
  const resultPath=join(s.directory,'refresh-'+invocationId+'.result.json'),capture={status:'NOT_CAPTURED',reasonCode:null,metadata:null};
  const started=now();let lock,ledger,store;
  if(!(started instanceof Date)||!Number.isSafeInteger(started.getTime()))fail('D2V_REFRESH_CONFIG_INVALID');
  try{
    try{lock=acquireCollectionLock(s.environment.NANSEN_OBSERVATION_STORE_PATH,{runId:'d2v-refresh-'+invocationId})}catch{fail('D2V_REFRESH_STORE_LOCKED')}
    s=validate({configPath,invocationId,privateRoot});
    if(s.configSha256!==originalHash||(expectedConfigSha256!==null&&s.configSha256!==expectedConfigSha256))fail('D2V_REFRESH_CONFIG_CHANGED');
    ledger=openCreditLedger(opts);store=openNansenObservationStore({databasePath:s.environment.NANSEN_OBSERVATION_STORE_PATH,storeId:s.environment.NANSEN_OBSERVATION_STORE_ID});
    writeJson(invPath,{schemaVersion:1,gate:'D2v',budgetId:s.allocation.budgetId,invocationId,attemptId:s.attemptId,operation:'TOKEN_OHLCV',
      requestBodySha256:s.bodyHash,createdAt:started.toISOString(),createdAtEastern:eastern(started)});
    let result=cached(store,started),sends=0;
    if(!result){
      if(typeof apiKey!=='string'||!apiKey.length)fail('D2V_REFRESH_CREDENTIAL_UNAVAILABLE');
      const client=createClient({ledger,enabled:true,apiKey,maxPages:1,timeoutMs:8000,maxResponseBytes:MAX_RAW,attemptIdFactory:()=>s.attemptId,onRawResponse:rawObserver(s.directory,s.attemptId,s.bodyHash,capture)});
      const manager=createManager({client,store,enabled:true,maxPageBound:1,maxRetryBound:0,clock:now,beforeDispatch(){
        if(sends)return 'D2V_REFRESH_ATTEMPT_CAP_REACHED';
        const a=ledger.getSnapshot();
        if(a.pendingAttemptCount||a.reconciliationRequired||ledger.listUnknownChargeAttempts().length)return 'D2V_REFRESH_ACCOUNTING_RECONCILIATION_REQUIRED';
        if(s.markers.count>=s.allocation.maxAttempts)return 'D2V_REFRESH_ATTEMPT_CAP_REACHED';
        if(a.remainingCredits<1)return 'D2V_REFRESH_BUDGET_INSUFFICIENT';
        writeJson(dispPath,{schemaVersion:1,gate:'D2v',budgetId:s.allocation.budgetId,invocationId,attemptId:s.attemptId,
          operation:'TOKEN_OHLCV',requestBodySha256:s.bodyHash,pageBound:1,retryBound:0,reservedCredits:1,createdAt:now().toISOString()});
        sends=1;return null;
      }});
      try{result=await manager.query(s.query)}catch{result=null}
    }
    const done=now(),a=ledger.getSnapshot(),unknown=ledger.listUnknownChargeAttempts().length;
    const refs=Array.isArray(result?.attemptPageReferences)?result.attemptPageReferences:[];
    const price=classifyD2vPrice({result,now:done});let failure=null;
    if(a.pendingAttemptCount||a.reconciliationRequired||unknown)failure='ACCOUNTING_RECONCILIATION_REQUIRED';
    if(refs.length>1||(sends===1&&refs.length!==1))failure='ATTEMPT_BOUND_MISMATCH';
    if(sends===1&&capture.status!=='CAPTURED')failure='RAW_CAPTURE_FAILED';
    const status=failure??(result?.cacheHit?(price.usable?'CACHE_HIT_USABLE':price.status):result?.failure?'DISPATCH_FAILED':price.status);
    const report={schemaVersion:1,gate:'D2v',allocationId:s.allocation.budgetId,invocationId,mode:result?.cacheHit?'CACHE_HIT_NO_DISPATCH':sends?'BOUNDED_DISPATCH':'NO_DISPATCH',
      status,failureClass:failure,cacheHit:result?.cacheHit===true,dispatches:sends,transportAttempts:refs.length,
      request:{method:'POST',endpoint:'/api/v1/tgm/token-ohlcv',chain:'base',tokenAddress:BASE_ASSET_ADDRESSES.USDC,timeframe:'1m',date:s.query.date,
        requestBodySha256:s.bodyHash,cacheKey:BASE_USDC_OHLCV_PRICE_CACHE_KEY,pageBound:1,retryBound:0,expectedCredits:1},
      attempts:refs.map(r=>({page:r.page,retry:r.retry,received:r.received,httpStatus:r.status,chargedCredits:r.chargedCredits})),
      providerResult:{status:result?.status??'unavailable',completeness:result?.completeness??'unknown',failureCode:result?.failure?.code??null,storeError:result?.storeError??null},
      price,rawCapture:capture,accounting:{limitCredits:a.limitCredits,allocatedCredits:a.allocatedCredits,remainingCredits:a.remainingCredits,
        reportedChargeCount:a.reportedChargeCount,pendingAttemptCount:a.pendingAttemptCount,unknownChargeAttempts:unknown,halted:a.haltReason!==null},
      startedAt:started.toISOString(),startedAtEastern:eastern(started),finishedAt:done.toISOString(),finishedAtEastern:eastern(done),
      boundaries:{maxAttemptsPerInvocation:1,maxPages:1,retries:0,cacheEviction:false,execution:'paper-only',walletAccess:false,trading:false}};
    writeJson(resultPath,report);return report;
  }finally{try{store?.close()}finally{try{ledger?.close()}finally{lock?.release()}}}
}
export function safeD2vRefreshFailure(error){const c=error instanceof Error?error.message:'';return SAFE.has(c)?c:'D2V_REFRESH_FAILED_SAFE'}
