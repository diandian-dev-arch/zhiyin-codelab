import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testDir:'./tests/e2e-source-flow',outputDir:'test-results/source-flow',
  webServer:servers.map((server,index)=> index===0
    ? {...server,env:{...server.env,CODELAB_UI_SOURCE:'1'}} : server),
});
