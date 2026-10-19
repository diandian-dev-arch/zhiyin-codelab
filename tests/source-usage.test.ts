import { expect,it } from 'vitest';
import { summarizeSourceUsage } from '../apps/api/src/source-usage';
import { analyzeSource } from '../apps/api/src/source-agent';
import type { SummaryProviderV2 } from '../apps/api/src/model-provider-v2';

it('keeps absent, partial, pending, failed and unknown accounting distinct',()=>{
  expect(summarizeSourceUsage(null,'failed',[])).toMatchObject({recording:'historical-unavailable',knownInputTokens:null});
  const calls=[{state:'returned',usage:{inputTokens:10,outputTokens:2}},{state:'returned',usage:null},{state:'started',usage:null},{state:'failed',usage:null},{state:'unknown',usage:null}];
  expect(summarizeSourceUsage(1,'running',calls)).toMatchObject({registeredCalls:5,returnedCalls:2,failedCalls:1,pendingCalls:1,unknownCalls:1,callsWithUsage:1,callsWithoutUsage:4,knownInputTokens:10,knownOutputTokens:2});
  expect(summarizeSourceUsage(1,'cancelled',calls)).toMatchObject({pendingCalls:0,unknownCalls:2,knownInputTokens:10});
  expect(summarizeSourceUsage(1,'failed',[{state:'returned',usage:{inputTokens:0,outputTokens:0}}])).toMatchObject({knownInputTokens:0,knownOutputTokens:0});
  expect(summarizeSourceUsage(1,'failed',[{state:'unknown',usage:null}])).toMatchObject({knownInputTokens:null,knownOutputTokens:null});
});
it('does not report rounded token totals when safe-integer aggregation overflows',()=>{
  expect(summarizeSourceUsage(1,'failed',[{state:'returned',usage:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1}},{state:'returned',usage:{inputTokens:1,outputTokens:1}}])).toMatchObject({knownInputTokens:null,knownOutputTokens:2});
});
it('never dispatches if durable call registration fails',async()=>{
  let calls=0;
  const provider:SummaryProviderV2={configuration:{provider:'fixture',model:'fixture',endpoint:'http://test.invalid'},complete:async()=>{calls++;throw new Error('must not call');}};
  await expect(analyzeSource({files:{'a.ts':'console.log(1)'},provider,signal:new AbortController().signal,emit:async()=>{},callLedger:{begin:async()=>{throw new Error('DB_UNAVAILABLE');},finish:async()=>{throw new Error('must not finish');}}})).rejects.toThrow('DB_UNAVAILABLE');
  expect(calls).toBe(0);
});
it('does not disguise a receipt write failure as a provider failure or issue another request',async()=>{
  let calls=0, finishes=0;
  const provider:SummaryProviderV2={configuration:{provider:'fixture',model:'fixture',endpoint:'http://test.invalid'},complete:async()=>{calls++;return {raw:'fixture',content:'{"paths":["a.ts"]}',requestId:null,usage:{inputTokens:3,outputTokens:1}};}};
  await expect(analyzeSource({files:{'a.ts':'console.log(1)'},provider,signal:new AbortController().signal,emit:async()=>{},callLedger:{begin:async()=> 'call-id',finish:async()=>{finishes++;throw new Error('DB_WRITE_UNAVAILABLE');}}})).rejects.toThrow('DB_WRITE_UNAVAILABLE');
  expect(calls).toBe(1);expect(finishes).toBe(1);
});
