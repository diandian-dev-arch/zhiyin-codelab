<script setup lang="ts">
import {ref,watch} from 'vue';
import type {RuleSnapshot} from '@codelab/contracts/v2';
import {apiV2} from '../api';
const props=defineProps<{taskId:string;currentVersion:number}>();
const rules=ref<RuleSnapshot[]>([]),next=ref<number|null>(null),loading=ref(false),loaded=ref(false),error=ref('');
let generation=0;
async function load(){
  if(loading.value)return;
  const current=generation;loading.value=true;error.value='';
  try{const data=await apiV2(`/tasks/${props.taskId}/rules${next.value?'?beforeVersion='+next.value:''}`);
    if(current!==generation)return;
    rules.value=[...rules.value,...data.items.filter((item:RuleSnapshot)=>!rules.value.some(rule=>rule.ruleId===item.ruleId))];next.value=data.nextBeforeVersion;loaded.value=true;
  }catch(e){if(current===generation)error.value=(e as Error).message;}
  finally{if(current===generation)loading.value=false;}
}
watch(()=>[props.taskId,props.currentVersion],()=>{generation++;rules.value=[];next.value=null;loading.value=false;loaded.value=false;error.value='';});
</script>
<template>
  <details class="rule-history" @toggle="event => {if((event.target as HTMLDetailsElement).open && !loaded)load()}">
    <summary>历史规则 <span>查看各版本的验收要求</span></summary>
    <p>新提交使用当前规则 v{{currentVersion}}。历史提交保持原规则，查看旧版本不会改变当前提交要求。</p>
    <p v-if="error" role="alert">{{error}} <button :disabled="loading" @click="load">重试读取规则</button></p>
    <p v-if="loading" role="status">正在读取规则…</p>
    <details v-for="rule in rules" :key="rule.ruleId" class="rule-version">
      <summary>规则 v{{rule.version}}{{rule.version===currentVersion?' · 当前版本':''}} · {{new Date(rule.confirmedAt).toLocaleString('zh-CN')}}</summary>
      <p>模板：{{rule.packManifest.templateVersion}} · 自动检查案例：{{rule.requiredCaseIds.length}} 项</p>
      <ul><li v-for="criterion in rule.packManifest.criteria.filter(item=>rule.enabledCriterionIds.includes(item.criterionId))" :key="criterion.criterionId"><strong>{{criterion.title}}</strong> · {{criterion.mode==='manual'?'人工判断':'自动检查'}}<p>{{criterion.expectedBehavior}}</p></li></ul>
      <dl v-if="Object.keys(rule.parameterValues).length"><template v-for="(value,key) in rule.parameterValues" :key="key"><dt>{{key}}</dt><dd>{{value}}</dd></template></dl>
      <small>规则标识 {{rule.ruleId}} · 发布新版本不会覆盖此记录。</small>
    </details>
    <button v-if="next" :disabled="loading" @click="load">加载更早规则</button>
    <button v-else-if="!loaded && !loading && !error" @click="load">读取规则历史</button>
    <p v-else-if="loaded && !next">已显示全部 {{rules.length}} 个规则版本。</p>
  </details>
</template>
<style scoped>
.rule-history{margin:20px 0;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--paper);color:var(--ink);font-size:13px;line-height:1.8;overflow-wrap:anywhere}.rule-history summary{cursor:pointer;font-weight:600}.rule-history summary span,.rule-history small{color:var(--muted);font-weight:400}.rule-history summary span{margin-left:10px}.rule-version{padding:12px 0;border-top:1px solid var(--line)}.rule-version p{margin:6px 0}.rule-history button{border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:9px 14px;border-radius:6px;cursor:pointer}.rule-history :is(button,summary):focus-visible{outline:3px solid var(--accent);outline-offset:3px}.rule-history dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.rule-history dd{margin:0}@media(max-width:600px){.rule-history{padding:14px}.rule-history summary span{display:block;margin-left:0}}
</style>
