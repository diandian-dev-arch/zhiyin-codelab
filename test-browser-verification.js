/**
 * 浏览器验证脚本 - 验证两条核心链路
 * 使用系统 Chrome 浏览器 + Puppeteer
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://127.0.0.1:5173';
const OUTPUT_DIR = path.join(__dirname, 'test-output');

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const log = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  fs.appendFileSync(
    path.join(OUTPUT_DIR, 'verification.log'),
    `[${timestamp}] ${message}\n`
  );
};

async function verifyCoreLinkA(browser) {
  log('开始验证核心链路 A: 项目分析');

  const page = await browser.newPage();

  try {
    // A1: 未登录保护验证
    log('A1: 测试未登录保护');
    await page.goto(`${BASE_URL}/#/projects`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'A1-login-redirect.png') });

    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      log('✅ A1: 未登录正确重定向到登录页');
      log(`   当前 URL: ${currentUrl}`);
    } else {
      log('❌ A1: 未登录未重定向');
      log(`   当前 URL: ${currentUrl}`);
    }

    // A2: 登录流程验证
    log('A2: 测试登录流程');

    // 检查是否有 email 和 password 输入框
    const emailInput = await page.$('input[type="email"], input[name="email"]');
    const passwordInput = await page.$('input[type="password"], input[name="password"]');

    if (emailInput && passwordInput) {
      log('✅ A2: 登录表单存在（email 和 password 字段）');
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'A2-login-form.png') });
    } else {
      log('❌ A2: 登录表单缺失字段');
    }

    // A3: 检查新入口是否加载
    log('A3: 验证新入口 (main-codelab.ts)');
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    });

    const hasNewEntry = scripts.some(src => src.includes('main-codelab.ts'));
    if (hasNewEntry) {
      log('✅ A3: 新入口 main-codelab.ts 已加载');
      log(`   加载的脚本: ${scripts.filter(s => s.includes('main')).join(', ')}`);
    } else {
      log('❌ A3: 新入口未找到');
      log(`   加载的脚本: ${scripts.join(', ')}`);
    }

    // A4: 检查控制台错误
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.reload({ waitUntil: 'networkidle0' });

    if (errors.length === 0) {
      log('✅ A4: 无控制台错误');
    } else {
      log(`❌ A4: 发现 ${errors.length} 个控制台错误`);
      errors.forEach(err => log(`   - ${err}`));
    }

    log('核心链路 A 验证完成\n');

  } catch (error) {
    log(`❌ 核心链路 A 验证失败: ${error.message}`);
  } finally {
    await page.close();
  }
}

async function verifyCoreLinkB(browser) {
  log('开始验证核心链路 B: 教学任务');

  const page = await browser.newPage();

  try {
    // B1: 任务列表访问
    log('B1: 测试任务列表访问');
    await page.goto(`${BASE_URL}/#/tasks`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'B1-tasks-access.png') });

    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      log('✅ B1: 未登录正确重定向到登录页');
      log(`   当前 URL: ${currentUrl}`);
    } else if (currentUrl.includes('/tasks')) {
      log('✅ B1: 任务页面可访问（已登录）');
      log(`   当前 URL: ${currentUrl}`);
    } else {
      log('❌ B1: 意外的 URL');
      log(`   当前 URL: ${currentUrl}`);
    }

    // B2: 检查路由保护
    log('B2: 验证路由保护');
    const hasRedirect = currentUrl.includes('redirect=');
    if (hasRedirect) {
      log('✅ B2: 路由保护正确实现（带 redirect 参数）');
    } else {
      log('⚠️ B2: 路由保护可能未完全实现');
    }

    // B3: 检查页面结构
    log('B3: 检查页面基本结构');
    const hasAppRoot = await page.$('#app');
    const hasRouterView = await page.evaluate(() => {
      return document.querySelector('#app')?.innerHTML.length > 0;
    });

    if (hasAppRoot && hasRouterView) {
      log('✅ B3: 页面结构正常（#app 存在且有内容）');
    } else {
      log('❌ B3: 页面结构异常');
    }

    log('核心链路 B 验证完成\n');

  } catch (error) {
    log(`❌ 核心链路 B 验证失败: ${error.message}`);
  } finally {
    await page.close();
  }
}

async function main() {
  log('========================================');
  log('开始浏览器验证');
  log('========================================\n');

  let browser;
  try {
    // 尝试使用系统 Chrome
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    log('✅ 成功启动 Chrome 浏览器\n');

    // 验证两条核心链路
    await verifyCoreLinkA(browser);
    await verifyCoreLinkB(browser);

    log('========================================');
    log('浏览器验证完成');
    log('========================================');
    log(`验证结果已保存到: ${OUTPUT_DIR}`);
    log('截图文件:');
    log('  - A1-login-redirect.png');
    log('  - A2-login-form.png');
    log('  - B1-tasks-access.png');
    log('验证日志:');
    log('  - verification.log');

  } catch (error) {
    log(`❌ 浏览器验证失败: ${error.message}`);
    log('错误详情:');
    log(error.stack);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
