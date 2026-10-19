import {test,expect} from '@playwright/test';

for (const view of ['detail','list'] as const) {
  test(`project ${view} status polling recovers from a hung read without model writes`, async ({page}) => {
    await page.goto('/');
    await page.getByLabel('邮箱').fill('student@codelab.local');
    await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
    const id='00000000-0000-4000-8000-000000000092';
    const url=view==='detail'?`/projects/${id}`:'/projects';
    const projectName=(name:string)=>view==='detail'
      ? page.getByRole('heading',{name,level:1,exact:true})
      : page.locator('.project-history').getByRole('link').filter({hasText:name});
    const data=(name:string)=>view==='detail'
      ? {id,name,available:false,files:[],omitted:[],analyses:[]}
      : {available:false,projects:[{id,name,status:'succeeded'}]};
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let recover!:()=>void;
    const recoveryGate=new Promise<void>(resolve=>{recover=resolve;});
    let count=0;
    const writes:string[]=[];
    page.on('request',request=>{
      if(request.method()!=='GET' && new URL(request.url()).pathname.startsWith('/api/v2/projects')) writes.push(request.method());
    });
    await page.route(`**/api/v2${url}`,async route=>{
      count++;
      if(count===2) {
        await gate;
        await route.fulfill({json:data('过期内容不得出现')}).catch(()=>{});
      } else {
        if(count===3 && view==='detail') await recoveryGate;
        await route.fulfill({json:data(count===1?'已有项目':'恢复后的项目')});
      }
    });
    await page.clock.install();
    try {
      await page.goto(url);
      await expect(projectName('已有项目')).toBeVisible();
      await page.clock.fastForward(2501);
      await expect.poll(()=>count).toBe(2);
      await page.clock.fastForward(15001);
      await expect(page.getByRole('alert').filter({hasText:'项目状态读取超过15秒'})).toBeVisible();
      await expect(projectName('已有项目')).toBeVisible();
      if(view==='detail') {
        await page.getByRole('button',{name:'重新连接',exact:true}).click();
        await expect.poll(()=>count).toBe(3);
        await expect(page.getByRole('button',{name:'正在重新连接…',exact:true})).toBeDisabled();
        // The scheduled poll shares the still-pending explicit recovery request.
        await page.clock.fastForward(2501);
        expect(count).toBe(3);
        recover();
      } else await page.clock.fastForward(2501);
      await expect(projectName('恢复后的项目')).toBeVisible();
      release();
      await page.clock.fastForward(100);
      await expect(projectName('过期内容不得出现')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(count).toBe(3);
    } finally {release();recover();}
  });
}
