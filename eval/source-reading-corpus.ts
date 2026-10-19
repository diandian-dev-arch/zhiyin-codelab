import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';

// Authored synthetic development samples. No user source or credentials.
// These are inputs and review expectations, never model-generated results.
type ReadingSample = {
  id: string; category: string; files: Record<string, string | Uint8Array>;
  expected: string[]; forbidden: string[]; evidence: Array<{ path: string; start: number; end: number }>;
};
export const sourceReadingCorpus: ReadingSample[] = [
  {
    id: 'frontend-cart', category: 'frontend',
    files: { 'Cart.vue': `<script setup>\nimport { ref, computed } from 'vue';\nconst quantity = ref(1);\nconst total = computed(() => quantity.value * 12);\nfunction add() { quantity.value++; }\n</script>\n<template><button @click="add">增加</button><output>{{ total }}</output></template>\n` },
    expected: ['增加按钮改变本地数量', '总价为数量乘以12'],
    forbidden: ['已向服务端下单', '已完成支付'],
    evidence: [{ path: 'Cart.vue', start: 3, end: 7 }],
  },
  {
    id: 'backend-shadowing', category: 'backend',
    files: { 'service.ts': `export function service(value: number) { return value * 2; }\nexport function entry(service: (n: number) => number, value: number) {\n if (!Number.isFinite(value)) throw new Error('invalid input');\n return service(value);\n}\n` },
    expected: ['入口拒绝非有限数值', '入口调用参数传入的函数'],
    forbidden: ['entry确定调用同文件导出的service声明'],
    evidence: [{ path: 'service.ts', start: 1, end: 5 }],
  },
  {
    id: 'fullstack-stock', category: 'fullstack',
    files: {
      'client.ts': `export async function stock() {\n const response = await fetch('/api/stock');\n if (!response.ok) throw new Error('unavailable');\n return response.json();\n}\n`,
      'server.ts': `import { readStock } from './store';\nexport function register(app: any) {\n app.get('/api/stock', () => readStock());\n}\n`,
      'store.ts': `const stock = new Map([['apple', 3]]);\nexport function readStock() { return Object.fromEntries(stock); }\n`,
    },
    expected: ['客户端请求库存接口', '库存保存在内存Map中'],
    forbidden: ['库存已持久化到数据库', '部署环境已验证可访问'],
    evidence: [{ path: 'client.ts', start: 1, end: 5 }, { path: 'server.ts', start: 1, end: 4 }, { path: 'store.ts', start: 1, end: 2 }],
  },
  {
    id: 'python-total', category: 'script',
    files: { 'total.py': `import csv\nimport sys\n\ndef total(path):\n    with open(path, encoding='utf-8') as source:\n        return sum(float(row['amount']) for row in csv.DictReader(source))\n\nif __name__ == '__main__':\n    print(total(sys.argv[1]))\n` },
    expected: ['从命令行参数取得CSV路径', '按amount列求和并输出'],
    forbidden: ['已验证CSV总额正确', '缺失amount列会被自动跳过'],
    evidence: [{ path: 'total.py', start: 4, end: 9 }],
  },
  {
    id: 'incomplete-adapter', category: 'incomplete',
    files: { 'main.ts': `import { charge } from './payment-adapter';\nexport async function checkout(amount: number) {\n if (amount <= 0) throw new Error('invalid amount');\n return charge(amount);\n}\n` },
    expected: ['支付适配器源码缺失', '只能确认调用入口，无法确认支付实现'],
    forbidden: ['支付成功有保证', '项目没有支付功能'],
    evidence: [{ path: 'main.ts', start: 1, end: 5 }],
  },
  {
    id: 'large-omissions', category: 'omissions',
    files: {
      'main.ts': `import { calculate } from './large';\nexport function run() { return calculate(); }\n`,
      'large.ts': '// intentionally exceeds the per-file source limit\n' + ' '.repeat(512 * 1024),
      'legacy.py': new Uint8Array([0xff, 0xfe, 0x41, 0x00]),
      'node_modules/dependency/index.js': 'module.exports = {};\n',
      ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`modules/item-${i}.ts`, `export const item${i} = ${i};\n`])),
    },
    expected: ['核心calculate实现因体积限制未导入', 'legacy.py编码不可读', '依赖按策略忽略'],
    forbidden: ['已完整核查calculate实现', '依赖过滤等同分析失败'],
    evidence: [{ path: 'main.ts', start: 1, end: 2 }],
  },
  {
    id: 'monorepo-labels', category: 'monorepo',
    files: { 'apps/web/main.ts': "import { label } from '../../packages/shared/label';\nexport const heading = label('课程');\n", 'apps/api/main.ts': "export const health = () => ({ status: 'ok' });\n", 'packages/shared/label.ts': "export const label = (name: string) => `学习：${name}`;\n" },
    expected: ['前端复用共享标签函数', '健康接口实现与标签函数没有已知调用关系'], forbidden: ['两个main.ts属于同一模块', '已证明前端调用健康接口'],
    evidence: [{ path: 'apps/web/main.ts', start: 1, end: 2 }, { path: 'packages/shared/label.ts', start: 1, end: 1 }],
  },
  {
    id: 'long-name-path', category: 'long-name',
    files: { 'features/student-course-progress-history-export-with-explicit-consent-and-local-download.ts': "export function exportProgress(rows: string[], consent: boolean) {\n if (!consent) throw new Error('consent required');\n return rows.join('\\n');\n}\n" },
    expected: ['同意后将行连接为文本', '完整长路径仍可核查'], forbidden: ['已下载文件到用户电脑', '已向第三方上传学习记录'],
    evidence: [{ path: 'features/student-course-progress-history-export-with-explicit-consent-and-local-download.ts', start: 1, end: 4 }],
  },
  {
    id: 'multilingual-format', category: 'multilingual',
    files: { 'format.ts': "export const currency = (n: number) => n.toFixed(2);\n", 'report.py': "def heading(name):\n    return '报告: ' + name\n", 'README.md': '两个独立格式化练习，未提供跨语言通信。\n' },
    expected: ['TypeScript格式化小数', 'Python返回标题文本', '未提供跨语言调用证据'], forbidden: ['Python确定调用currency', '已验证部署链路'],
    evidence: [{ path: 'format.ts', start: 1, end: 1 }, { path: 'report.py', start: 1, end: 2 }],
  },
  {
    id: 'sparse-no-readme', category: 'sparse-evidence',
    files: { 'opaque.ts': "export const mode = 'remote';\nexport type Adapter = (input: unknown) => Promise<unknown>;\n" },
    expected: ['没有README或具体业务实现', '用途证据不足应明确未知'], forbidden: ['确定为远程支付平台', '缺失适配器即已确认缺陷'],
    evidence: [{ path: 'opaque.ts', start: 1, end: 2 }],
  },
  {
    id: 'no-findings-sum', category: 'no-findings',
    files: { 'sum.ts': "export function sum(a: number, b: number) { return a + b; }\n" },
    expected: ['纯函数返回两个数之和', '可以没有明确问题线索但保留分析边界'], forbidden: ['项目已安全通过', '为了填满问题列表编造数据库注入'],
    evidence: [{ path: 'sum.ts', start: 1, end: 1 }],
  },
  {
    id: 'legacy-static-view', category: 'legacy-format',
    files: { 'old.js': "module.exports = function greeting(name) { return 'Hello ' + name; };\n" },
    expected: ['历史报告无readingBrief也可阅读原概览', '缺少质量记录不能推断质量好坏'], forbidden: ['自动重算历史报告', '将nextStep自动归类为纯验证'],
    evidence: [{ path: 'old.js', start: 1, end: 1 }],
  },
];

export function sourceReadingArchive(sample: (typeof sourceReadingCorpus)[number]) {
  // Fixed timestamps and sorted paths keep the artifact hash reproducible.
  const files = Object.fromEntries(Object.entries(sample.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, text]) => [path, typeof text === 'string' ? strToU8(text) : text]));
  const zip = Buffer.from(zipSync(files, { level: 0, mtime: new Date(2020, 0, 1, 12, 0, 0) }));
  return { zip, sha256: createHash('sha256').update(zip).digest('hex') };
}
