import type { SummaryProviderV2 } from '../../apps/api/src/model-provider-v2';
import { setTimeout as delay } from 'node:timers/promises';

// Deterministic model substitute only. ZIP/HTTP/auth/database/worker/citations
// remain real. This module is never imported by a production entry point.
const section = {
  title: '测试入口', body: '合成分析：程序输出固定问候，未执行代码。',
  citations: [{path:'hello/app.py',start:1,end:1}],
};
const report = {
  overview: '合成模型集成测试报告', stack:['Python'], modules:[section],
  flows:[section], findings:[], readingPath:[section], limitations:['合成模型，不代表真实质量评测'],
};
export const sourceUIProvider: SummaryProviderV2 = {
  configuration:{provider:'test-only',model:'source_ui_fixture',endpoint:'http://127.0.0.1/unused'},
  async complete(input) {
    await delay(500, undefined, {signal:input.signal});
    const request = JSON.parse(input.user);
    return {
      content:JSON.stringify(request.draft
        ? request.shape || request.checkShape ? {report,checks:[]} : {searches:[],reads:[]}
        : request.shape ? report : {paths:['hello/app.py']}),
      raw:'source_ui_fixture',requestId:null,usage:null,
    };
  },
};
