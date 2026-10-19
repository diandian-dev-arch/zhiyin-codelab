import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base='http://localhost:5348',out='output/assignments-polish-2026-10-19';
mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome'}),errors=[],measurements=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  async function login(p,role) {
    await p.goto(base+'/assignments');
    await p.getByLabel('邮箱',{exact:true}).fill(`${role}@codelab.local`);
    await p.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
    await p.getByRole('button',{name:'登录',exact:true}).click();
    await p.getByRole('heading',{name:'课程作业',exact:true}).waitFor();
  }
  async function capture(name) {
    for(const width of [320,375,390,414,768,960,1280,1440]) {
      await page.setViewportSize({width,height:1000}); await page.waitForTimeout(200);
      const state=await page.evaluate(()=>{
        const sidebar=document.querySelector('.sidebar'),s=sidebar.getBoundingClientRect();
        const main=document.querySelector('.course-page').getBoundingClientRect();
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
          sidebarClear:getComputedStyle(sidebar).display==='none'||main.left>=s.right,
          overflow:[...document.querySelectorAll('.course-page,.course-panel,.course-form,.assignment-fields,.assignment-toolbar,.course-row,.course-task-options,fieldset,input:not([type=checkbox]),select,textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.left < -1||r.right>innerWidth+1);}).map(e=>e.className||e.tagName)};
      });
      measurements.push({name,...state});
      assert(state.scrollWidth<=width,`${name}: page overflow at ${width}`);
      assert(state.sidebarClear,`${name}: sidebar overlap at ${width}`);
      assert.deepEqual(state.overflow,[],`${name}: element overflow at ${width}`);
    }
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/${name}-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/${name}-mobile.png`,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
  }
  async function fill(title) {
    await page.getByRole('button',{name:'创建作业',exact:true}).click();
    await page.getByLabel('作业名称',{exact:true}).fill(title);
    await page.getByLabel('首个子任务名称',{exact:true}).fill('实现搜索与空状态');
    await page.getByLabel('目标与说明',{exact:true}).fill('合成视觉验收：固定成果快照，保留源码与评价依据。');
    await page.getByLabel('评价标准（每行一条）',{exact:true}).fill('搜索结果与输入一致\n空列表时显示清晰反馈\n提交成果可以追溯到固定版本');
  }
  await login(page,'teacher');
  await page.locator('.assignment-empty').waitFor(); await capture('empty-teacher');
  await fill('[视觉验收] Vue 项目实训 · 搜索与状态反馈');
  await page.getByText('起始材料、来源与分析范围',{exact:true}).click();
  await page.getByLabel('必需文件（每行一个）',{exact:true}).fill('src/search.ts');
  await page.getByLabel('起始材料',{exact:true}).fill('合成演示材料，不包含真实学生项目。');
  await page.getByRole('button',{name:'预览学生视图',exact:true}).click();
  await capture('create-preview');
  await page.getByRole('button',{name:'创建并发布',exact:true}).click();
  await page.waitForURL(/\/assignments\/[\w-]+$/); await page.locator('.course-row').first().waitFor();
  await page.locator('summary').filter({hasText:'添加子任务'}).click();
  await capture('assignment-detail');
  for(const [title,action] of [['[视觉验收] 团队成果 · 尚未发布','保存草稿'],['[视觉验收] 课程作品连续迭代与代码引用反馈的较长名称展示','创建并发布']]) {
    await page.goto(base+'/assignments'); await page.getByRole('button',{name:'创建作业',exact:true}).waitFor();
    await fill(title); if(action==='保存草稿')await page.getByLabel('提交方式',{exact:true}).selectOption('team');
    await page.getByRole('button',{name:action,exact:true}).click();await page.waitForURL(/\/assignments\/[\w-]+$/);
  }
  await page.goto(base+'/assignments'); await page.locator('.assignment-row').first().waitFor();
  assert.equal(await page.locator('.assignment-row').count(),3);
  await capture('populated-teacher');
  await page.getByRole('button',{name:'草稿',exact:true}).click();assert.equal(await page.locator('.assignment-row').count(),1);
  await page.getByRole('button',{name:'已发布',exact:true}).click();assert.equal(await page.locator('.assignment-row').count(),2);
  await page.getByLabel('搜索作业或班级',{exact:true}).fill('不存在的作业');
  await page.getByRole('heading',{name:'没有匹配的作业',exact:true}).waitFor();await capture('filtered-empty');
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await page.locator('.assignment-row').count(),3);
  await page.getByLabel('筛选班级',{exact:true}).selectOption({index:1});assert.equal(await page.locator('.assignment-row').count(),3);
  await page.getByLabel('搜索作业或班级',{exact:true}).fill('尚未发布');assert.equal(await page.locator('.assignment-row').count(),1);
  await page.getByRole('button',{name:'清空搜索',exact:true}).click();
  for(const theme of ['bronze','celadon','ochre','rose']) {
    await page.addInitScript(t=>localStorage.setItem('codelab-theme',t),theme);await page.reload();await page.locator('.assignment-row').first().waitFor();await page.waitForTimeout(800);await page.screenshot({path:`${out}/theme-${theme}.png`});
  }
  const studentContext=await browser.newContext(),student=await studentContext.newPage();await login(student,'student');
  await student.locator('.assignment-row').first().waitFor();
  assert.equal(await student.getByRole('button',{name:'创建作业',exact:true}).count(),0);
  assert.equal(await student.getByRole('button',{name:'草稿',exact:true}).count(),0);
  assert.equal(await student.locator('.assignment-row').count(),2);
  await student.screenshot({path:`${out}/populated-student.png`,fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.getByRole('button',{name:'创建作业',exact:true}).evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
  await page.getByRole('button',{name:'创建作业',exact:true}).click();await page.getByLabel('作业名称',{exact:true}).focus();
  assert.notEqual(await page.getByLabel('作业名称',{exact:true}).evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.route('**/api/v2/assignments',route=>route.fulfill({status:503,json:{error:'合成验收：暂时无法读取作业'}}));
  await page.reload();await page.getByRole('alert').waitFor();await capture('load-error');
  await page.unroute('**/api/v2/assignments');await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.locator('.assignment-row').first().waitFor();
  assert.deepEqual(errors,[]);
  writeFileSync(`${out}/results.json`,JSON.stringify({errors,measurements,filtering:'pass',studentBoundary:'pass',retry:'pass',focus:'visible',reducedMotion:'0s'},null,2));
  console.log(JSON.stringify({errors,checks:measurements.length,filtering:'pass',studentBoundary:'pass',retry:'pass'}));
}finally{await browser.close();}
