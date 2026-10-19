// Static presentation-attribute migration; no rendered text or script is changed.
import{readFileSync,writeFileSync,readdirSync,realpathSync}from'node:fs';import{createRequire}from'node:module';import ts from'typescript';
const require=createRequire(realpathSync('apps/web/node_modules/vue/package.json')),{parse}=require('@vue/compiler-sfc'),{baseParse}=require('@vue/compiler-dom');
const skip=new Set(['Notifications.vue','PaperBackground.vue','ProjectChart.vue','CodeFlowAnimation.vue']);
const paths=['apps/web/src/App.vue',...['views','components'].flatMap(dir=>readdirSync(`apps/web/src/${dir}`).filter(n=>n.endsWith('.vue')&&!skip.has(n)).map(n=>`apps/web/src/${dir}/${n}`))];
let attributes=0,files=0;
for(const p of paths){const source=readFileSync(p,'utf8'),{descriptor}=parse(source);if(!descriptor.template)continue;const icons=new Set();
  for(const block of[descriptor.script,descriptor.scriptSetup].filter(Boolean)){const ast=ts.createSourceFile(p,block.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);for(const statement of ast.statements)if(ts.isImportDeclaration(statement)&&statement.moduleSpecifier.text==='lucide-vue-next'){for(const e of statement.importClause?.namedBindings?.elements??[])icons.add(e.name.text);}}
  const template=baseParse(descriptor.template.content),edits=[];
  const walk=node=>{if(node.type===1&&(icons.has(node.tag)||node.tag==='svg')){const named=node.props.some(p=>p.type===6&&['aria-hidden','aria-label','aria-labelledby','role'].includes(p.name)||p.type===7&&['aria-hidden','aria-label','aria-labelledby','role'].includes(p.arg?.content));if(!named)edits.push(descriptor.template.loc.start.offset+node.loc.start.offset+node.tag.length+1);}for(const child of node.children??[])walk(child);};walk(template);
  if(edits.length){let next=source;for(const offset of edits.sort((a,b)=>b-a))next=next.slice(0,offset)+' aria-hidden="true"'+next.slice(offset);writeFileSync(p,next);attributes+=edits.length;files++;}
}
console.log(JSON.stringify({files,attributes}));
