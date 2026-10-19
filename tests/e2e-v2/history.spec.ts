import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';

test('loads older tasks without hiding the next-page action under a filter',async({page})=>{
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const original=await(await page.request.get('/api/v2/tasks')).json();
  const items=Array.from({length:201},(_,i)=>({...original.items[0],taskId:randomUUID(),title:`分页任务 ${i}`,overview:{latestSubmission:null,latestPublication:null}}));
  let firstReads=0,olderStarted=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v2/tasks*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname!=='/api/v2/tasks')return route.continue();
    const after=url.searchParams.get('after');
    if(after){olderStarted=true;await gate;}else firstReads++;
    return route.fulfill({json:{items:after?items.slice(200):items.slice(0,200),total:201,nextCursor:after?null:items[199].taskId}});
  });
  await page.reload();
  await expect(page.locator('.task-card')).toHaveCount(200);
  await page.getByRole('group',{name:'按待办筛选',exact:true}).getByRole('button',{name:/^有已发布反馈/}).click();
  await expect(page.locator('.task-card')).toHaveCount(0);
  await page.getByRole('button',{name:'加载更早任务'}).click();
  await expect.poll(()=>olderStarted).toBe(true);
  await page.getByRole('button',{name:'刷新任务列表'}).click();
  release();
  await expect.poll(()=>firstReads).toBeGreaterThan(1);
  await expect(page.getByText('已加载 201 / 201 项；搜索、筛选与统计仅针对已加载任务。')).toBeVisible();
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await expect(page.locator('.task-card')).toHaveCount(201);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('loads older history and preserves it during live refresh',async({page})=>{
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const tasks=await(await page.request.get('/api/v2/tasks')).json();
  const taskId=tasks.items[0].taskId;
  const original=await(await page.request.get(`/api/v2/tasks/${taskId}/submissions`)).json();
  expect(original.items.length).toBeGreaterThan(0);
  // Synthetic list only: the API pagination/permissions are covered separately.
  const items=Array.from({length:201},(_,i)=>({...original.items[0],submissionId:randomUUID(),
    latestRun:i===0?{...original.items[0].latestRun,status:'queued'}:null}));
  let firstReads=0;
  await page.route(`**/api/v2/tasks/${taskId}/submissions*`,route=>{
    const after=new URL(route.request().url()).searchParams.get('after');
    if(!after)firstReads++;
    return route.fulfill({json:{contractVersion:2,total:201,items:after?items.slice(200):items.slice(0,200),nextCursor:after?null:items[199].submissionId}});
  });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByText('已加载 200 / 201 份提交；搜索和状态筛选作用于已加载记录。')).toBeVisible();
  await page.getByRole('button',{name:'加载更早提交'}).click();
  await expect(page.locator('.v2-submission')).toHaveCount(201);
  await expect(page.getByRole('button',{name:'加载更早提交'})).toHaveCount(0);
  await expect.poll(()=>firstReads,{timeout:10000}).toBeGreaterThan(1);
  await expect(page.locator('.v2-submission')).toHaveCount(201);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
