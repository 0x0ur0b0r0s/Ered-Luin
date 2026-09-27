import { describe, expect, it } from 'vitest';
import { evaluateHistoryDispatch, historyBackoffMs, planUsdcHistoricalJobs, recoverSettledDispatch, summarizeUsdcHistory } from './bounded-history.mjs';

const NOW=new Date('2026-09-27T14:00:00.000Z');
describe('bounded USDC historical validation manifest',()=>{
  it('creates deterministic, adjacent nonoverlapping ten-minute windows',()=>{
    const options={from:'2026-09-26T10:00:00.000Z',to:'2026-09-26T11:00:00.000Z',now:NOW};
    const first=planUsdcHistoricalJobs(options),again=planUsdcHistoricalJobs(options);
    expect(first).toEqual(again);expect(first).toHaveLength(6);
    expect(new Set(first.map(x=>x.jobId)).size).toBe(first.length);
    for(let i=1;i<first.length;i++) expect(first[i-1].date.to).toBe(first[i].date.from);
    expect(first.every(x=>x.pageBound===1&&x.retryBound===0&&x.expectedCredits===1)).toBe(true);
  });
  it('rejects future, misaligned, overlapping-length and oversized ranges',()=>{
    expect(()=>planUsdcHistoricalJobs({from:'2026-09-26T10:01:00.000Z',to:'2026-09-26T10:11:00.000Z',now:NOW})).toThrow('DEADLINE_HISTORY_PLAN_INVALID');
    expect(()=>planUsdcHistoricalJobs({from:'2026-09-26T10:00:00.000Z',to:'2026-09-26T10:20:00.000Z',now:NOW,maxJobs:1})).toThrow('DEADLINE_HISTORY_PLAN_INVALID');
    expect(()=>planUsdcHistoricalJobs({from:'2026-09-27T14:00:00.000Z',to:'2026-09-27T14:10:00.000Z',now:NOW})).toThrow('DEADLINE_HISTORY_PLAN_INVALID');
  });
  it('deduplicates actual HTTP success IDs and keeps unknown accounting separate from freshness replay',()=>{
    const jobs=planUsdcHistoricalJobs({from:'2026-09-26T10:00:00.000Z',to:'2026-09-26T10:20:00.000Z',now:NOW});
    const report=summarizeUsdcHistory({jobs,baselineSuccesses:544,targetSuccesses:1050,now:NOW,jobResults:[
      {jobId:jobs[0].jobId,resultStatus:'fresh',attempts:[{attemptId:'a',operation:'TOKEN_OHLCV',outcome:'SUCCESS',httpStatus:200,chargedCredits:1},{attemptId:'a',operation:'TOKEN_OHLCV',outcome:'SUCCESS',httpStatus:200,chargedCredits:1},{attemptId:'b',operation:'TOKEN_OHLCV',outcome:'TRANSPORT_ERROR',httpStatus:null,chargedCredits:null}],
        observations:[{endpoint:'TOKEN_OHLCV',asset:'USDC',metric:'price_usd',unit:'usd_micros',quality:'COMPLETE',value:'1001000',observedAt:'2026-09-26T10:08:00.000Z',fetchedAt:'2026-09-26T10:10:04.000Z'}]},
      {jobId:jobs[1].jobId,resultStatus:'failed',attempts:[],observations:[]},
    ]});
    expect(report).toMatchObject({uniqueProviderSuccesses:1,totalVerifiedSuccesses:545,remainingToTarget:505,
      accounting:{uniqueAttempts:2,reportedCredits:1,unknownCharges:1},coverage:{usableCandles:1,completeJobs:1,failedJobs:1},
      deviationFromPegBps:{min:10,median:10,max:10},firewallReplay:{freshAtCapture:1,currentFresh:0,historicalEvidenceUsableForCurrentProposal:false}});
    expect(report.attemptIds).toEqual(['a']);
  });
});


describe('bounded history dispatch controls',()=>{
  const from='2026-09-26T10:00:00.000Z',to='2026-09-26T10:10:00.000Z';
  const job={jobId:'job-1',date:{from,to}};
  const query={operation:'TOKEN_OHLCV',historical:true,asset:'USDC',timeframe:'1m',date:{from,to},pageBound:1,retryBound:0,perPage:1};
  const ledger={pendingAttemptCount:0,reconciliationRequired:false,remainingCredits:570};
  const base={job,query,ledger,attemptCount:0,allocatedCredits:0,unknownChargeCount:0,dispatchCount:0,maxAttempts:570,maxCredits:570,costCredits:1};
  it('admits one exact historical window only while all durable limits permit it',()=>{
    expect(evaluateHistoryDispatch(base)).toEqual({allowed:true,reason:null});
    expect(evaluateHistoryDispatch({...base,query:{...query,date:{from,to:'2026-09-26T10:20:00.000Z'}}})).toMatchObject({allowed:false,reason:'QUERY_IDENTITY'});
    expect(evaluateHistoryDispatch({...base,ledger:{...ledger,pendingAttemptCount:1}})).toMatchObject({allowed:false,reason:'ACCOUNTING'});
    expect(evaluateHistoryDispatch({...base,unknownChargeCount:1})).toMatchObject({allowed:false,reason:'ACCOUNTING'});
    expect(evaluateHistoryDispatch({...base,attemptCount:570})).toMatchObject({allowed:false,reason:'LIMIT'});
    expect(evaluateHistoryDispatch({...base,allocatedCredits:570})).toMatchObject({allowed:false,reason:'LIMIT'});
    expect(evaluateHistoryDispatch({...base,dispatchCount:570})).toMatchObject({allowed:false,reason:'LIMIT'});
  });
  it('never replays a dispatch without a settled, known ledger result',()=>{
    const marker={jobId:'job-1',attemptId:'attempt-1'};
    expect(recoverSettledDispatch({marker,attempt:null})).toMatchObject({recoverable:false,reason:'AMBIGUOUS'});
    expect(recoverSettledDispatch({marker,attempt:{attemptId:'attempt-1',outcome:'PENDING',reportedChargedCredits:null}})).toMatchObject({recoverable:false,reason:'AMBIGUOUS'});
    expect(recoverSettledDispatch({marker,attempt:{attemptId:'attempt-1',outcome:'TRANSPORT_ERROR',reportedChargedCredits:null}})).toMatchObject({recoverable:false,reason:'AMBIGUOUS'});
    expect(recoverSettledDispatch({marker,attempt:{attemptId:'attempt-1',operation:'TOKEN_OHLCV',outcome:'SUCCESS',httpStatus:200,reportedChargedCredits:1,completedAt:'2026-09-27T12:00:00.000Z'}})).toMatchObject({recoverable:true,entry:{resultStatus:'recovered',outcome:'SUCCESS'}});
  });
  it('honors Retry-After and bounds fallback 429 waits',()=>{
    expect(historyBackoffMs({status:429,retryAfterMs:4_000,rateLimitCount:0})).toBe(4_000);
    expect(historyBackoffMs({status:429,retryAfterMs:200_000,rateLimitCount:0})).toBe(200_000);
    expect(historyBackoffMs({status:429,retryAfterMs:2_000_000_000,rateLimitCount:0})).toBe(86_400_000);
    expect(historyBackoffMs({status:429,retryAfterMs:null,rateLimitCount:9})).toBe(60_000);
    expect(historyBackoffMs({status:200,retryAfterMs:null,rateLimitCount:0})).toBe(0);
  });
});
