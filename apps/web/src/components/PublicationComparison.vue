<script setup lang="ts">
import StudioSelect from './StudioSelect.vue';
import {ref,watch} from 'vue';
import {apiV2} from '../api';
const props=defineProps<{publicationId:string}>();
const options=ref<any[]>([]),cursor=ref<string|null>(null),before=ref(''),result=ref<any>(null);
const loading=ref(false),comparing=ref(false),error=ref('');
let generation=0;
const verdicts:Record<string,string>={passed:'已通过',failed:'未通过',manual:'待人工判断',not_run:'未执行'};
const changes:Record<string,string>={resolved:'本次已通过',regression:'出现回归',remaining:'仍未满足',unchanged:'仍通过',unknown:'尚不能判断'};
const date=(v:string)=>new Date(v).toLocaleString('zh-CN');
async function loadMore(){
  if(loading.value)return;
  const current=generation;loading.value=true;error.value='';
  try{
    const data=await apiV2(`/publications/${props.publicationId}/comparison-options${cursor.value?'?after='+cursor.value:''}`);
    if(current!==generation)return;
    options.value=[...options.value,...data.items.filter((item:any)=>!options.value.some(x=>x.publicationId===item.publicationId))];cursor.value=data.nextCursor;
  }catch(e){if(current===generation)error.value=(e as Error).message;}
  finally{if(current===generation)loading.value=false;}
}
async function compare(){
  if(!before.value||comparing.value)return;
  const current=generation,selected=before.value;comparing.value=true;error.value='';result.value=null;
  try{const data=await apiV2(`/publications/${props.publicationId}/comparison?before=${selected}`);
    if(current===generation&&selected===before.value)result.value=data;
  }catch(e){if(current===generation)error.value=(e as Error).message;}
  finally{if(current===generation)comparing.value=false;}
}
watch(()=>props.publicationId,()=>{generation++;options.value=[];cursor.value=null;before.value='';result.value=null;loading.value=false;comparing.value=false;void loadMore();},{immediate:true});
</script>

<template>
  <details class="publication-comparison">
    <summary>已发布版本比较 <span>查看修改前后的反馈</span></summary>
    <p class="scope">仅列出你在同一任务中的已发布报告。基准由你选择；原报告内容保持不变。</p>
    <div class="comparison-picker">
      <label>基准发布版本<StudioSelect v-model="before" :disabled="comparing || loading" @change="result=null">
        <option value="">请选择一份已发布报告</option>
        <option v-for="item in options" :key="item.publicationId" :value="item.publicationId">{{date(item.submittedAt)}} 提交 · {{date(item.publishedAt)}} 发布 · 第{{item.publicationNo}}版 · {{item.publicationId.slice(0,8)}}</option>
      </StudioSelect></label>
      <button :disabled="!before || comparing" @click="compare">{{comparing?'正在比较…':'比较这两个版本'}}</button>
    </div>
    <button v-if="cursor" :disabled="loading" @click="loadMore">{{loading?'读取中…':'加载更早的发布版本'}}</button>
    <p v-if="loading" role="status">正在读取已发布版本…</p>
    <p v-else-if="!options.length && !error" class="scope">目前只有这一份已发布报告。下一次提交获得反馈，或老师发布更正后，就可以进行比较。</p>
    <p v-if="error" role="alert">{{error}} <button v-if="!options.length" @click="loadMore">重试读取版本</button></p>
    <section v-if="result" aria-label="发布版本差异" aria-live="polite">
      <div class="version-pair"><RouterLink :to="'/publications/'+result.before.publicationId">基准 · {{date(result.before.publishedAt)}} ↗</RouterLink><span aria-hidden="true">→</span><span>当前 · {{date(result.after.publishedAt)}}</span></div>
      <p v-if="result.sameSubmission" class="scope">这两份报告属于同一次提交，展示的是报告更正，不能据此认定你修改了代码。</p>
      <h3>自动检查变化</h3>
      <div v-if="result.automatic.status==='compatible'" class="result-scroll"><table><thead><tr><th>案例</th><th>基准</th><th>当前</th><th>变化</th></tr></thead><tbody><tr v-for="item in result.automatic.caseDiffs" :key="item.caseId"><th>{{item.caseId}}</th><td>{{verdicts[item.before]}}</td><td>{{verdicts[item.after]}}</td><td>{{changes[item.change] || item.change}}</td></tr></tbody></table></div>
      <p v-else class="scope">两份报告的规则、案例或执行环境不能确认一致，暂不判定修复与回归。你仍可分别阅读下面的已发布反馈。</p>
      <h3>教师判断变化</h3>
      <ul v-if="result.teacherJudgments.some((item:any)=>item.changed)"><li v-for="item in result.teacherJudgments.filter((item:any)=>item.changed)" :key="item.targetType+item.targetId">{{item.targetId}}：{{verdicts[item.before] || '未作判断'}} → {{verdicts[item.after] || '未作判断'}}（包含判断内容的更改）</li></ul>
      <p v-else class="scope">教师判断没有变化。</p>
      <h3>文字反馈对照</h3>
      <p class="scope">文字变化不等于自动检查结果变化。不同规则下的同名条目也不保证要求一致。</p>
      <details v-for="item in result.feedback" :key="item.criterionId" class="feedback-pair"><summary>{{item.criterionId}} · {{item.changed?'反馈有变化':'反馈未变'}}</summary><div class="feedback-columns"><article v-for="(entry,index) in [item.before,item.after]" :key="index"><h4>{{index===0?'基准反馈':'当前反馈'}}</h4><template v-if="entry"><p>{{entry.observation}}</p><p v-if="entry.possibleCause">可能原因：{{entry.possibleCause}}</p><p>下一步：{{entry.nextStep}}</p></template><p v-else>此版本没有该条反馈。</p></article></div></details>
    </section>
  </details>
</template>

<style scoped>
.publication-comparison{color:var(--ink);border:1px solid var(--line);border-radius:12px;background:var(--paper);padding:20px;margin:20px 0;font-family:inherit}
summary{cursor:pointer;font-weight:650}summary span{font-size:12px;font-weight:400;margin-left:12px;color:var(--muted)}.scope{color:var(--muted);font-size:13px;line-height:1.8}.comparison-picker{display:flex;gap:12px;align-items:end;margin:16px 0}.comparison-picker label{display:grid;gap:8px;min-width:0;flex:1;font-size:13px}select{width:100%;min-width:0;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink)}button{padding:10px 14px;background:var(--gl-solid);color:var(--gl-text);border:0;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}button:disabled{opacity:.5;cursor:not-allowed}:is(button,select,summary,a):focus-visible{outline:3px solid var(--teal);outline-offset:3px}.version-pair{display:flex;gap:14px;flex-wrap:wrap;background:var(--mist);padding:14px;font-size:13px;line-height:1.7}.version-pair a{color:var(--teal)}h3{font-size:15px;margin-top:24px}.result-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}.feedback-pair{border-top:1px solid var(--line);padding:14px 0;font-size:13px}.feedback-columns{display:grid;grid-template-columns:1fr 1fr;gap:20px;line-height:1.8;overflow-wrap:anywhere}.feedback-columns article{min-width:0}h4{font:600 12px ui-monospace,monospace;color:var(--teal)}li{font-size:13px;line-height:1.8}@media(max-width:680px){.comparison-picker{align-items:stretch;flex-direction:column}.feedback-columns{grid-template-columns:1fr}.publication-comparison{padding:14px}summary span{display:block;margin:6px 0 0}}
</style>
