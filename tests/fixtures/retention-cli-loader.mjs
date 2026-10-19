// Test-only boundary: run the unchanged CLI against a disposable PostgreSQL schema.
import {registerHooks} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
const dbModule=new URL('../../apps/api/src/db.ts',import.meta.url).href;
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='../apps/api/src/template.js'&&context.parentURL?.endsWith('/scripts/course-retention.ts')){
      const root=process.env.CODELAB_TEST_CLI_ROOT;
      if(!root||path.dirname(root)!==tmpdir()||!path.basename(root).startsWith('codelab-retention-cli-'))
        throw new Error('ISOLATED_STORAGE_REQUIRED');
      return {url:'data:text/javascript,'+encodeURIComponent(`export const root=${JSON.stringify(root)};`),shortCircuit:true};
    }
    if(specifier==='./desktop-database.js'&&context.parentURL?.endsWith('/scripts/course-retention.ts')){
      if(!process.env.CODELAB_TEST_POSTGRES_URL)throw new Error('ISOLATED_DATABASE_REQUIRED');
      const source=`import {postgres} from ${JSON.stringify(dbModule)};
        export async function connectDesktopDatabase(){return postgres(process.env.CODELAB_TEST_POSTGRES_URL);}`;
      return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
    }
    return next(specifier,context);
  }
});
