import { isWithinSignalFreshness } from '../../packages/nansen/dist/index.js';

import { createHash } from 'node:crypto';

const WINDOW_MS=10*60_000;
const MAX_JOBS=600;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function fail(){throw new Error('DEADLINE_HISTORY_PLAN_INVALID')}
function isoMs(value){if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isSafeInteger(ms)&&new Date(ms).toISOString()===value?ms:null}
function idFor(from,to){return createHash('sha256').update(JSON.stringify({chain:'base',token:'USDC',timeframe:'1m',date:{from,to},pageBound:1,retryBound:0}), 'utf8').digest('hex')}
export function planUsdcHistoricalJobs({from,to,now=new Date(),maxJobs=MAX_JOBS}){
  const start=isoMs(from),end=isoMs(to),current=now instanceof Date?now.getTime():NaN;
  if(start===null||end===null||!Number.isSafeInteger(current)||current<0||!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>MAX_JOBS||
      start%WINDOW_MS!==0||end%WINDOW_MS!==0||end<=start||end>Math.floor(current/WINDOW_MS)*WINDOW_MS||(end-start)%WINDOW_MS!==0)fail();
  const count=(end-start)/WINDOW_MS;if(count>maxJobs)fail();
  const jobs=[];for(let at=start;at<end;at+=WINDOW_MS){const windowFrom=new Date(at).toISOString(),windowTo=new Date(at+WINDOW_MS).toISOString();
    jobs.push(Object.freeze({jobId:idFor(windowFrom,windowTo),operation:'TOKEN_OHLCV',asset:'USDC',timeframe:'1m',
      date:Object.freeze({from:windowFrom,to:windowTo}),pageBound:1,retryBound:0,perPage:1,expectedCredits:1}));}
  if(new Set(jobs.map(job=>job.jobId)).size!==jobs.length)fail();
  return Object.freeze(jobs);
}
export function summarizeUsdcHistory({jobs,jobResults,baselineSuccesses=550,targetSuccesses=1050,now=new Date()}){
  if(!Array.isArray(jobs)||!Array.isArray(jobResults)||!Number.isSafeInteger(baselineSuccesses)||baselineSuccesses<0||
      !Number.isSafeInteger(targetSuccesses)||targetSuccesses<1||!(now instanceof Date)||!Number.isSafeInteger(now.getTime()))fail();
  const jobsById=new Map(jobs.map(job=>[job.jobId,job]));if(jobsById.size!==jobs.length)fail();
  const seenAttempts=new Map(),successes=new Set(),samples=[],status={COMPLETE:0,INCOMPLETE:0,FAILED:0,UNKNOWN:0};let attemptCount=0,unknownCharges=0,reportedCredits=0;
  for(const entry of jobResults){if(!entry||!jobsById.has(entry.jobId)||!Array.isArray(entry.attempts)||!Array.isArray(entry.observations))fail();
    for(const attempt of entry.attempts){if(!attempt||typeof attempt.attemptId!=='string')continue;const priorJob=seenAttempts.get(attempt.attemptId);if(priorJob!==undefined){if(priorJob!==entry.jobId)fail();continue;}seenAttempts.set(attempt.attemptId,entry.jobId);attemptCount++;
      if(attempt.chargedCredits===null||attempt.chargedCredits===undefined)unknownCharges++;else if(Number.isSafeInteger(attempt.chargedCredits)&&attempt.chargedCredits>=0)reportedCredits+=attempt.chargedCredits;
      if(attempt.operation==='TOKEN_OHLCV'&&attempt.outcome==='SUCCESS'&&Number.isSafeInteger(attempt.httpStatus)&&attempt.httpStatus>=200&&attempt.httpStatus<300&&Number.isSafeInteger(attempt.chargedCredits))successes.add(attempt.attemptId);}
    const snapshotCompleteness=entry.snapshotCompleteness??entry.completeness;
    const jobStatus=entry.snapshotFailure||entry.resultStatus==='failed'?'FAILED':snapshotCompleteness==='complete'||entry.resultStatus==='fresh'||entry.resultStatus==='cached'?'COMPLETE':snapshotCompleteness==='incomplete'||entry.resultStatus==='incomplete'?'INCOMPLETE':'UNKNOWN';
    status[jobStatus]++;
    for(const signal of entry.observations){if(signal?.endpoint!=='TOKEN_OHLCV'||signal.asset!=='USDC'||signal.metric!=='price_usd'||signal.unit!=='usd_micros'||signal.quality!=='COMPLETE'||
        !/^(0|[1-9][0-9]*)$/u.test(signal.value??''))continue;
      const observed=isoMs(signal.observedAt),windowFrom=isoMs(jobsById.get(entry.jobId).date.from),windowTo=isoMs(jobsById.get(entry.jobId).date.to),fetched=isoMs(signal.fetchedAt);if(observed===null||windowFrom===null||windowTo===null||observed<windowFrom||observed>=windowTo||fetched===null||fetched<observed)continue;
      const micros=BigInt(signal.value),deviation=micros>=1_000_000n?micros-1_000_000n:1_000_000n-micros;
      samples.push({observedAt:signal.observedAt,valueMicros:micros, deviationBps:Number((deviation*10_000n+500_000n)/1_000_000n),freshAtCapture:isWithinSignalFreshness('TOKEN_OHLCV',observed,Date.parse(signal.fetchedAt)),freshNow:isWithinSignalFreshness('TOKEN_OHLCV',observed,now.getTime())});
    }
  }
  samples.sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
  const deviations=samples.map(sample=>sample.deviationBps).sort((a,b)=>a-b);
  const median=deviations.length?deviations[Math.floor((deviations.length-1)/2)]:null;
  const providerSuccesses=successes.size,remaining=Math.max(0,targetSuccesses-baselineSuccesses-providerSuccesses);
  return Object.freeze({schemaVersion:1,windowCount:jobs.length,uniqueProviderSuccesses:providerSuccesses,baselineSuccesses,targetSuccesses,
    totalVerifiedSuccesses:baselineSuccesses+providerSuccesses,remainingToTarget:remaining,coverage:{usableCandles:samples.length,completeJobs:status.COMPLETE,
      incompleteJobs:status.INCOMPLETE,failedJobs:status.FAILED,unknownJobs:status.UNKNOWN,firstCandleAt:samples[0]?.observedAt??null,lastCandleAt:samples.at(-1)?.observedAt??null},
    deviationFromPegBps:{min:deviations[0]??null,median,max:deviations.at(-1)??null},
    firewallReplay:{freshAtCapture:samples.filter(x=>x.freshAtCapture).length,currentFresh:samples.filter(x=>x.freshNow).length,
      historicalEvidenceUsableForCurrentProposal:samples.some(x=>x.freshNow)},
    accounting:{uniqueAttempts:attemptCount,reportedCredits,unknownCharges},limits:{onePage:true,retries:0,inFlight:1,minimumIntervalMs:2_000},attemptIds:[...successes].sort()});
}

export function evaluateHistoryDispatch({job,query,ledger,attemptCount,allocatedCredits,unknownChargeCount=0,dispatchCount=0,maxAttempts=570,maxCredits=570,costCredits=1}) {
  if(!job||!query||query.operation!=='TOKEN_OHLCV'||query.historical!==true||query.asset!=='USDC'||query.timeframe!=='1m'||
    query.date?.from!==job.date?.from||query.date?.to!==job.date?.to||query.pageBound!==1||query.retryBound!==0||query.perPage!==1)
    return Object.freeze({allowed:false,reason:'QUERY_IDENTITY'});
  if(!ledger||ledger.pendingAttemptCount!==0||ledger.reconciliationRequired===true||unknownChargeCount!==0)
    return Object.freeze({allowed:false,reason:'ACCOUNTING'});
  if(!Number.isSafeInteger(attemptCount)||!Number.isSafeInteger(allocatedCredits)||!Number.isSafeInteger(dispatchCount)||
    attemptCount<0||allocatedCredits<0||dispatchCount<0||attemptCount>=maxAttempts||dispatchCount>=maxAttempts||allocatedCredits+costCredits>maxCredits||
    ledger.remainingCredits<costCredits) return Object.freeze({allowed:false,reason:'LIMIT'});
  return Object.freeze({allowed:true,reason:null});
}

export function recoverSettledDispatch({marker,attempt}) {
  if(!marker||typeof marker.jobId!=='string'||typeof marker.attemptId!=='string'||!attempt||attempt.attemptId!==marker.attemptId||
    attempt.outcome==='PENDING'||attempt.reportedChargedCredits===null||attempt.reportedChargedCredits===undefined)
    return Object.freeze({recoverable:false,reason:'AMBIGUOUS'});
  return Object.freeze({recoverable:true,entry:Object.freeze({schemaVersion:1,jobId:marker.jobId,attemptId:attempt.attemptId,
    operation:attempt.operation,outcome:attempt.outcome,httpStatus:attempt.httpStatus,chargedCredits:attempt.reportedChargedCredits,
    resultStatus:'recovered',completeness:'unknown',retryAfterMs:null,completedAt:attempt.completedAt,recoveredFromLedger:true})});
}

export function historyBackoffMs({status,retryAfterMs,rateLimitCount=0}) {
  if(Number.isSafeInteger(retryAfterMs)&&retryAfterMs>0)return Math.min(86_400_000,retryAfterMs);
  if(status===429)return Math.min(60_000,2_000*(2**Math.min(Math.max(0,rateLimitCount),5)));
  return 0;
}
