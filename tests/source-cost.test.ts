import {describe,it,expect,vi} from 'vitest';
import {createCostGuard,officialSourcePrice,priceTokens,sameAnalysisScope,summarizeSourceCost} from '../apps/api/src/source-cost';
import {sourceDelta} from '../apps/api/src/source-delta';
import {sourceOptionsSchema} from '../apps/api/src/source-options';
import {analyzeSource} from '../apps/api/src/source-agent';
import type {SummaryProviderV2} from '../apps/api/src/model-provider-v2';
const price={inputPerMillion:2,outputPerMillion:8,label:'fixture'};
const budget={inputBytes:1000,inputTokens:1000,outputTokens:1000,safetyTokens:2000,counting:'utf8-conservative-estimate' as const};
describe('money accounting and admission',()=>{
 it('reproduces audited token arithmetic without rounding fractions down',()=>{
   expect(priceTokens(price,88184,4394)).toBe(.211520);
   expect(priceTokens(price,263518,13759)).toBe(.637108);
 });
 it('applies official tariffs only to the exact HTTPS vendor origin and known models',()=>{
   const official={configuration:{provider:'openai-compatible',model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions'}};
   expect(officialSourcePrice(official)).toMatchObject({inputPerMillion:2,outputPerMillion:8});
   for(const endpoint of ['https://proxy.example/chat/completions','https://api.deepseek.com.evil.test','http://api.deepseek.com','https://api.deepseek.com:8443'])
     expect(officialSourcePrice({configuration:{...official.configuration,endpoint}})).toBeNull();
   expect(officialSourcePrice({configuration:{...official.configuration,model:'unknown'}})).toBeNull();
 });
 it('reserves output and framing, releases only when usage is known',()=>{
   const guard=createCostGuard({...price,limitCny:.02});
   guard.before(budget); // .014
   guard.received(budget,null);
   expect(()=>guard.before(budget)).toThrow('SOURCE_COST_BUDGET');
   const known=createCostGuard({...price,limitCny:.02});
   known.before(budget);known.received(budget,{inputTokens:100,outputTokens:10});
   expect(()=>known.before(budget)).not.toThrow();
   expect(summarizeSourceCost(price,[{budget,usage:null}])).toMatchObject({knownCny:0,reservedCny:.014,unknownCalls:1});
 });
 it('fits output to the remaining budget without dropping framing or overspending',()=>{
   const guard=createCostGuard({...price,limitCny:.01});
   const fitted=guard.allocate(budget,256);
   expect(fitted.outputTokens).toBe(500);
   expect(()=>guard.before(fitted)).not.toThrow();
   expect(()=>guard.before({...fitted,outputTokens:501})).toThrow('SOURCE_COST_BUDGET');
   expect(()=>guard.allocate(budget)).toThrow('SOURCE_COST_BUDGET');
   guard.received(fitted,null);
   expect(()=>guard.allocate(budget,1)).toThrow('SOURCE_COST_BUDGET');
 });
 it('rejects malformed rates and budgets instead of silently disabling protection',()=>{
   for(const cost of [{...price,limitCny:0},{...price,inputPerMillion:-1},{...price,outputPerMillion:NaN},{...price,limitCny:Infinity}])
     expect(sourceOptionsSchema.safeParse({cost}).success).toBe(false);
 });
 it('blocks the very first real provider invocation and ledger registration',async()=>{
   const complete=vi.fn(),begin=vi.fn();
   await expect(analyzeSource({files:{'app.py':'print(1)'},provider:{configuration:{provider:'test',model:'test',endpoint:'http://test'},complete},options:{version:1,mode:'quick',modules:[],cost:{...price,limitCny:.01,inputPerMillion:100000,outputPerMillion:100000}},signal:new AbortController().signal,emit:async()=>{},callLedger:{begin,finish:vi.fn()}})).rejects.toThrow('SOURCE_COST_BUDGET');
   expect(complete).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
 });
 it('stops before the second call after a high billed first reply',async()=>{
   const complete=vi.fn(async()=>({content:JSON.stringify({paths:['app.py']}),raw:'{}',requestId:null,usage:{inputTokens:1_000_000,outputTokens:0}}));
   const provider:SummaryProviderV2={configuration:{provider:'test',model:'test',endpoint:'http://test'},complete};
   await expect(analyzeSource({files:{'app.py':'print(1)'},provider,options:{version:1,mode:'quick',modules:[],cost:{...price,limitCny:.5}},signal:new AbortController().signal,emit:async()=>{}})).rejects.toThrow('SOURCE_COST_BUDGET');
   expect(complete).toHaveBeenCalledTimes(1);
 });
});
describe('incremental boundaries',()=>{
 it('detects additions, edits and deletions without inventing rename matches',()=>{
   expect(sourceDelta({'a':'1','b':'2','same':'x'},{'a':'new','c':'2','same':'x'})).toEqual({added:['c'],modified:['a'],removed:['b'],unchanged:1});
 });
 it('never treats a different mode, scope or baseline as a reusable report',()=>{
   const base={version:1 as const,mode:'deep' as const,modules:['a','b']};
   expect(sameAnalysisScope(base,{...base,modules:['b','a']})).toBe(true);
   expect(sameAnalysisScope(base,{...base,mode:'quick'})).toBe(false);
   expect(sameAnalysisScope(base,{...base,incrementalFrom:'different'})).toBe(false);
   expect(sameAnalysisScope(base,{...base,modules:['a']})).toBe(false);
 });
});
