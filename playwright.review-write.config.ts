import {defineConfig} from '@playwright/test';
import base from './playwright.v2.config';
export default defineConfig({...base,testDir:'./tests/e2e-review-write',outputDir:'test-results/review-write',
  webServer:(Array.isArray(base.webServer)?base.webServer:[]).map((server,index)=>index===0
    ? {...server,env:{...server.env,CODELAB_UI_CANDIDATE:'1'}} : server),
});
