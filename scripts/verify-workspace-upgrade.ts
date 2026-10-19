import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
const [taskId, oldRunId] = process.argv.slice(2);
if (![taskId,oldRunId].every(value => /^[0-9a-f-]{36}$/.test(value ?? ''))) throw new Error('Provide the old task ID and published run ID');
const { loginPassword } = JSON.parse(await readFile(path.join(root,'.data/business-v2/development-credentials.json'),'utf8'));
const output = path.join(root,'output/workspace-verification',`upgrade-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
  const teacher = await browser.newPage({baseURL:'http://127.0.0.1:5174',viewport:{width:1440,height:1000}});
  const student = await browser.newPage({baseURL:'http://127.0.0.1:5174'});
  for (const [page,role] of [[teacher,'teacher'],[student,'student']] as const) {
    await page.goto('/');
    await page.getByLabel('邮箱',{exact:true}).fill(`${role}@codelab.local`);
    await page.getByLabel('密码',{exact:true}).fill(loginPassword);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  }
  await teacher.goto(`/tasks/${taskId}`);
  await teacher.getByText('选择验收包并发布新规则',{exact:true}).click();
  await teacher.getByLabel('我已确认以上要求与本次课程任务一致').check();
  await teacher.getByRole('button',{name:'发布新规则',exact:true}).click();
  await expect(teacher.getByRole('status')).toContainText('新规则已发布');
  await student.goto(`/tasks/${taskId}`);
  await student.getByLabel('项目 ZIP').setInputFiles(path.join(root,'fixtures/correct-independent.zip'));
  await student.getByRole('button',{name:'保存提交',exact:true}).click();
  await expect(student.getByRole('status')).toContainText('提交已保存');
  await student.getByRole('button',{name:'创建检查',exact:true}).click();
  await expect(student.getByRole('status')).toContainText('已进入检查队列');
  await student.locator('.v2-submission').first().getByRole('link',{name:'进度与反馈',exact:true}).click();
  const newRunUrl = student.url();
  await teacher.goto(newRunUrl);
  await expect(teacher.getByRole('navigation',{name:'验收条目'})).toBeVisible({timeout:120000});
  await expect(teacher.getByRole('navigation',{name:'验收条目'}).getByRole('button')).toHaveCount(6);
  await expect(teacher.getByText(/两次检查的规则、案例或实测环境不能确认一致/)).toBeVisible();
  await expect(teacher.locator('.comparison table')).toHaveCount(0);
  await teacher.screenshot({path:path.join(output,'upgraded-pack-incompatible.png'),fullPage:true});
  await student.goto(`/runs/${oldRunId}`);
  await expect(student.getByRole('navigation',{name:'验收条目'}).getByRole('button')).toHaveCount(3);
  await student.getByRole('button',{name:'NEW-01 · 截图',exact:true}).click();
  await expect(student.getByAltText('当前报告的运行截图')).toBeVisible();
  const result = {state:'passed',source:'constructed_execution',taskId,oldRunId,newRunUrl,checks:['old-task-new-pack-selectable','new-eight-case-execution','incompatible-without-change-labels','old-three-item-publication-and-evidence-preserved']};
  await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,output}));
} finally { await browser.close(); }
