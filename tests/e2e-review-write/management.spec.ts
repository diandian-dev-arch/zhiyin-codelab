import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
test('accepted class and student creations can be reconciled after lost receipts',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'班级与账号'}).click();
  const name='回执核对班级-'+randomUUID(),keys:string[]=[];let classId='',release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/v1/classes',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
    classId=(await response.json()).id;if(keys.length===1)await gate;
    await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByLabel('新班级名称').fill(name);
    await page.getByRole('button',{name:'创建班级',exact:true}).click();
    await expect.poll(()=>classId).not.toBe('');await page.clock.fastForward(15001);
    await expect(page.getByRole('alert')).toContainText('结果未知');expect(keys).toHaveLength(1);
    await page.getByRole('button',{name:'创建班级',exact:true}).click();
    await expect(page.getByLabel('新班级名称')).toHaveValue('');
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
    const classes=(await(await page.request.get('/api/v1/classes')).json()).items;
    expect(classes.filter((c:any)=>c.name===name)).toHaveLength(1);
    release();await page.clock.fastForward(100);
    await page.getByLabel('所属班级',{exact:true}).selectOption(classId);
    const email=`receipt-${randomUUID()}@test.local`;
    await page.getByLabel('姓名',{exact:true}).fill('核对学生');await page.getByLabel('邮箱',{exact:true}).fill(email);
    await page.getByLabel('初始密码').fill('Fixture-test-password-123!');
    let accepted=false,writes=0,releaseStudent!:()=>void;const studentGate=new Promise<void>(resolve=>releaseStudent=resolve);
    await page.route(`**/api/v1/classes/${classId}/students`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      writes++;const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
      accepted=true;await studentGate;await route.fulfill({response}).catch(()=>{});
    });
    try{
      await page.getByRole('button',{name:'创建学生账号',exact:true}).click();await expect.poll(()=>accepted).toBe(true);
      await page.clock.fastForward(15001);await expect(page.getByRole('alert')).toContainText('结果未知');
      await page.getByLabel('核对邮箱（留空查看成员）').fill(email);
      await page.getByRole('button',{name:'查询班级成员',exact:true}).click();
      await expect(page.getByRole('region',{name:'班级成员核对'})).toContainText(email);expect(writes).toBe(1);
      releaseStudent();await page.clock.fastForward(100);expect(writes).toBe(1);
      await expect(page.getByLabel('初始密码')).toHaveValue('Fixture-test-password-123!');
    }finally{releaseStudent();}
  }finally{release();}
});
test('management writes release hung forms without replay, clearing inputs or accepting late receipts',async({page})=>{
  await page.goto('/');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'班级与账号'}).click();
  await page.getByLabel('新班级名称').fill('回执未知班级');
  await page.getByLabel('姓名',{exact:true}).fill('回执测试学生');
  await page.getByLabel('邮箱',{exact:true}).fill('receipt-test@example.com');
  await page.getByLabel('初始密码').fill('Test-only-password-123!');
  await page.getByRole('button',{name:'创建任务',exact:true}).click();
  await page.getByLabel('任务名称',{exact:true}).fill('回执未知任务');
  await page.getByLabel('任务说明',{exact:true}).fill('保留此说明');
  let writes=0;const releases:Array<()=>void>=[];
  await page.route('**/api/v*/**',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    writes++;await new Promise<void>(resolve=>releases.push(resolve));
    await route.fulfill({json:{id:'late-result'}}).catch(()=>{});
  });
  await page.clock.install();
  try{
    for(const label of ['创建班级','创建学生账号','创建任务']){
      const button=label==='创建任务'?page.locator('form').filter({has:page.getByLabel('任务名称',{exact:true})}).getByRole('button',{name:label,exact:true}):page.getByRole('button',{name:label,exact:true});
      const before=writes;await button.click();await expect.poll(()=>writes).toBe(before+1);
      await expect(button).toBeDisabled();await page.clock.fastForward(15001);
      await expect(page.getByRole('alert')).toContainText('结果未知');await expect(button).toBeEnabled();
      releases.at(-1)!();await page.clock.fastForward(100);
      expect(writes).toBe(before+1);await expect(page.getByRole('alert')).toContainText('结果未知');
    }
    await expect(page.getByLabel('新班级名称')).toHaveValue('回执未知班级');
    await expect(page.getByLabel('初始密码')).toHaveValue('Test-only-password-123!');
    await expect(page.getByLabel('任务名称',{exact:true})).toHaveValue('回执未知任务');
    await expect(page.getByLabel('任务说明',{exact:true})).toHaveValue('保留此说明');
    await expect(page.getByRole('status')).not.toContainText('学生账号已创建');
  }finally{releases.forEach(release=>release());}
});
