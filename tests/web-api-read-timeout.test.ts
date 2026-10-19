import {afterEach,describe,it,expect,vi} from 'vitest';
import {apiV2} from '../apps/web/src/api';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('browser API read deadlines',()=>{
  it.each(['headers','body'])('bounds a hung %s read and does not retry',async stage=>{
    vi.useFakeTimers();
    const fetch=vi.fn(async (_url:any,options:any)=>{
      const pending=new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));
      return stage==='headers'?pending:{ok:true,json:()=>pending};
    });
    vi.stubGlobal('fetch',fetch);
    const result=expect(apiV2('/tasks')).rejects.toMatchObject({code:'READ_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(15001); await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves HTTP errors and clears the read timer',async()=>{
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:403,json:async()=>({error:{code:'FORBIDDEN',message:'不可访问'}})})));
    await expect(apiV2('/tasks')).rejects.toMatchObject({status:403,code:'FORBIDDEN'});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves caller-owned deadlines and does not add a write deadline',async()=>{
    vi.useFakeTimers(); const controller=new AbortController();
    const fetch=vi.fn(async()=>({ok:true,json:async()=>({ok:true})}));vi.stubGlobal('fetch',fetch);
    await apiV2('/tasks',{signal:controller.signal});
    expect((fetch.mock.calls as any)[0][1].signal).toBe(controller.signal);
    await apiV2('/tasks',{method:'POST',body:'{}'});
    expect((fetch.mock.calls as any)[1][1].signal).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
