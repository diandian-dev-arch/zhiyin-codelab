import {test,expect} from '@playwright/test';
const runPath='/runs/00000000-0000-4000-8000-000000000003';
test('lost adoption receipt retries the same revision and only replaces the selected feedback',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.goto(runPath);
  await page.getByRole('navigation',{name:'验收条目'}).getByRole('button').filter({hasText:'新增任务'}).click();
  await page.getByRole('button',{name:'确认本条内容',exact:true}).click();
  await expect(page.getByRole('button',{name:'本条已确认',exact:true})).toBeDisabled();
  const before=await(await page.request.get('/api/v2'+runPath+'/review')).json();
  const candidate=before.candidates[0];expect(candidate).toBeTruthy();
  await page.getByText('模型候选（需明确采纳）',{exact:true}).click();
  const keys:string[]=[],receipts:any[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/v2'+runPath+'/review/adopt',async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    receipts.push(await response.json());if(keys.length===1)await gate;
    await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByRole('button',{name:'采纳本条候选',exact:true}).click();
    await expect.poll(()=>receipts.length).toBe(1);await page.clock.fastForward(15001);
    await expect(page.getByRole('region',{name:'修订冲突处理'})).toContainText('操作结果待核对');
    expect(keys).toHaveLength(1);
    await expect(page.getByLabel('建议的下一步')).toHaveValue(before.revision.feedback.find((item:any)=>item.criterionId==='create').nextStep);
    await page.getByRole('button',{name:'采纳本条候选',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'已采纳本条候选'})).toBeVisible();
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
    expect(receipts[1].replayed).toBe(true);
    expect(receipts[1].revision.revisionId).toBe(receipts[0].revision.revisionId);
    release();await page.clock.fastForward(100);
    const after=await(await page.request.get('/api/v2'+runPath+'/review')).json();
    expect(after.revision.revisionNo).toBe(before.revision.revisionNo+1);
    expect(after.revision.feedback.find((item:any)=>item.criterionId==='create')).toEqual(candidate.feedback.find((item:any)=>item.criterionId==='create'));
    expect(after.revision.feedback.filter((item:any)=>item.criterionId!=='create')).toEqual(before.revision.feedback.filter((item:any)=>item.criterionId!=='create'));
    expect(after.revision.teacherJudgments).toEqual(before.revision.teacherJudgments);
    expect(after.baseResults).toEqual(before.baseResults);expect(after.baseManifest).toEqual(before.baseManifest);
    expect(after.revision.confirmations.some((item:any)=>item.criterionId==='create')).toBe(false);
    await expect(page.getByRole('button',{name:'确认本条内容',exact:true})).toBeEnabled();
  }finally{release();}
});
test('lost analysis and cancellation receipts reconcile without allocating another attempt or losing edits',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.goto(runPath);await expect(page.getByLabel('建议的下一步')).toBeVisible();
  const before=await(await page.request.get('/api/v2'+runPath+'/review')).json();
  await page.locator('.analysis-drawer > summary').click();
  let analysisWrites=0,cancelWrites=0,attemptId='',cancelled=false;
  let releaseAnalysis!:()=>void,releaseCancel!:()=>void;
  const analysisGate=new Promise<void>(resolve=>releaseAnalysis=resolve);
  const cancelGate=new Promise<void>(resolve=>releaseCancel=resolve);
  await page.route('**/api/v2'+runPath+'/analyses',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    analysisWrites++;const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    attemptId=(await response.json()).analysis.analysisAttemptId;
    await analysisGate;await route.fulfill({response}).catch(()=>{});
  });
  await page.route('**/api/v2'+runPath+'/analyses/*/cancel',async route=>{
    cancelWrites++;const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    cancelled=true;await cancelGate;await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByRole('button',{name:'重新分析存档',exact:true}).click();
    await expect.poll(()=>!!attemptId).toBe(true);await page.clock.fastForward(15001);
    const recovery=page.getByRole('region',{name:'修订冲突处理'});
    await expect(recovery).toContainText('操作结果待核对');expect(analysisWrites).toBe(1);
    await recovery.getByRole('button',{name:'保留草稿并载入最新修订'}).click();
    await expect(recovery).toHaveCount(0);
    await expect(page.getByRole('button',{name:'重新分析存档',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'取消分析',exact:true})).toBeEnabled();
    releaseAnalysis();await page.clock.fastForward(100);expect(analysisWrites).toBe(1);
    await page.getByLabel('建议的下一步').fill('取消回执丢失后必须保留的教师编辑');
    await page.getByRole('button',{name:'取消分析',exact:true}).click();
    await expect.poll(()=>cancelled).toBe(true);await page.clock.fastForward(15001);
    await expect(recovery).toContainText('操作结果待核对');expect(cancelWrites).toBe(1);
    await expect(page.getByLabel('建议的下一步')).toHaveValue('取消回执丢失后必须保留的教师编辑');
    await recovery.getByRole('button',{name:'保留草稿并载入最新修订'}).click();
    await expect(recovery).toHaveCount(0);
    const copies=page.getByRole('region',{name:'保留的本地草稿'});
    await copies.locator('summary').click();await expect(copies).toContainText('取消回执丢失后必须保留的教师编辑');
    releaseCancel();await page.clock.fastForward(100);
    const after=await(await page.request.get('/api/v2'+runPath+'/review')).json();
    expect(after.analyses).toHaveLength(before.analyses.length+1);
    expect(after.analyses.find((item:any)=>item.id===attemptId)?.status).toBe('cancelled');
    expect(after.revision).toEqual(before.revision);
    expect(analysisWrites).toBe(1);expect(cancelWrites).toBe(1);
  }finally{releaseAnalysis();releaseCancel();}
});
test('lost save receipt preserves edits and explicit recovery retains a copy without another write',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.goto(runPath);
  await page.getByLabel('建议的下一步').fill('保存回执丢失时保留的教师建议');
  let accepted=false,writes=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/v2'+runPath+'/review',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    writes++;const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    accepted=true;await gate;await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect.poll(()=>accepted).toBe(true);await page.clock.fastForward(15001);
    await expect(page.getByRole('alert')).toContainText('结果未知');
    await expect(page.getByLabel('建议的下一步')).toHaveValue('保存回执丢失时保留的教师建议');
    await expect(page.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
    const recovery=page.getByRole('region',{name:'修订冲突处理'});
    await expect(recovery).toContainText('操作结果待核对');expect(writes).toBe(1);
    await recovery.getByRole('button',{name:'保留草稿并载入最新修订'}).click();
    await expect(recovery).toHaveCount(0);
    const copies=page.getByRole('region',{name:'保留的本地草稿'});
    await copies.locator('summary').click();await expect(copies).toContainText('保存回执丢失时保留的教师建议');
    await expect(page.getByLabel('建议的下一步')).toHaveValue('保存回执丢失时保留的教师建议');
    release();await page.clock.fastForward(100);expect(writes).toBe(1);
    await expect(page.getByRole('status')).toContainText('已载入最新修订');
    const keys:string[]=[];let confirmed=false,releaseConfirm!:()=>void;
    const confirmGate=new Promise<void>(resolve=>releaseConfirm=resolve);
    await page.route('**/api/v2'+runPath+'/review/confirm',async route=>{
      keys.push(route.request().headers()['idempotency-key']);
      const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
      if(keys.length===1){confirmed=true;await confirmGate;}
      await route.fulfill({response}).catch(()=>{});
    });
    try{
      await page.getByRole('button',{name:'确认本条内容',exact:true}).click();
      await expect.poll(()=>confirmed).toBe(true);await page.clock.fastForward(15001);
      await expect(page.getByRole('alert')).toContainText('结果未知');expect(keys).toHaveLength(1);
      await page.getByRole('button',{name:'确认本条内容',exact:true}).click();
      await expect(page.getByRole('button',{name:'本条已确认',exact:true})).toBeDisabled();
      expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
      releaseConfirm();await page.clock.fastForward(100);
      await expect(page.getByRole('status')).toContainText('本条内容已确认');
    }finally{releaseConfirm();}
  }finally{release();}
});

test('lost publication and correction receipts recover the committed version without duplicate writes',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.goto(runPath);
  for(const title of ['新增任务','筛选任务','人工可读性']){
    await page.getByRole('navigation',{name:'验收条目'}).getByRole('button').filter({hasText:title}).click();
    const confirm=page.getByRole('button',{name:'确认本条内容',exact:true});
    if(await confirm.count()) await confirm.click();
    await expect(page.getByRole('button',{name:'本条已确认',exact:true})).toBeDisabled();
  }
  const keys:string[]=[],receipts:any[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/v2'+runPath+'/publications',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    receipts.push(await response.json());
    if(keys.length===1)await gate;
    await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByRole('button',{name:'发布报告 3/3',exact:true}).click();
    await expect.poll(()=>receipts.length).toBe(1);
    const published=receipts[0].publication;
    expect(published.publicationNo).toBe(1);
    await page.clock.fastForward(15001);
    await expect(page.getByRole('region',{name:'修订冲突处理'})).toContainText('操作结果待核对');
    await expect(page.getByRole('alert')).toContainText('结果未知');
    expect(keys).toHaveLength(1);
    await page.getByRole('button',{name:'发布报告 3/3',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'报告已发布，版本 1'})).toBeVisible();
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
    expect(receipts[1].replayed).toBe(true);
    expect(receipts[1].publication).toEqual(published);
    release();await page.clock.fastForward(100);
    await expect(page.getByRole('region',{name:'修订冲突处理'})).toHaveCount(0);
    const original=await(await page.request.get('/api/v2/publications/'+published.publicationId)).json();

    // A correction committed without a receipt is recovered with a GET, not another POST.
    let correctionWrites=0,acceptedCorrection:any,releaseCorrection!:()=>void;
    const correctionGate=new Promise<void>(resolve=>releaseCorrection=resolve);
    await page.route('**/api/v2/publications/*/corrections',async route=>{
      correctionWrites++;
      const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
      acceptedCorrection=await response.json();await correctionGate;
      await route.fulfill({response}).catch(()=>{});
    });
    try{
      await page.getByLabel('更正原因',{exact:true}).fill('ui_fixture：回执丢失后的更正草稿核对');
      await page.getByRole('button',{name:'从已发布版本建立更正草稿',exact:true}).click();
      await expect.poll(()=>!!acceptedCorrection).toBe(true);
      const committed=await(await page.request.get('/api/v2'+runPath+'/review')).json();
      expect(committed.revision.originPublicationId).toBe(published.publicationId);
      await page.clock.fastForward(15001);
      const recovery=page.getByRole('region',{name:'修订冲突处理'});
      await expect(recovery).toContainText('操作结果待核对');
      await recovery.getByRole('button',{name:'保留草稿并载入最新修订'}).click();
      await expect(recovery).toHaveCount(0);
      await expect(page.getByRole('button',{name:'发布更正报告 0/3',exact:true})).toBeDisabled();
      releaseCorrection();await page.clock.fastForward(100);
      expect(correctionWrites).toBe(1);
      const recovered=await(await page.request.get('/api/v2'+runPath+'/review')).json();
      expect(recovered.revision.revisionId).toBe(committed.revision.revisionId);
      expect(recovered.latestPublication.publicationId).toBe(published.publicationId);
      expect(await(await page.request.get('/api/v2/publications/'+published.publicationId)).json()).toEqual(original);
      expect(keys).toHaveLength(2);
    }finally{releaseCorrection();}
  }finally{release();}
});
