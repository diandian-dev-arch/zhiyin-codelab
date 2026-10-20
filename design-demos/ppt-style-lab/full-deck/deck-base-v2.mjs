// One source of content and geometry for the HTML presentation and editable PPTX.
export const colors={paper:'#FCFDFE',ice:'#EEF3FA',ink:'#182334',blue:'#2454DB',deep:'#173B9F',muted:'#56667C',line:'#D6E0EE',tint:'#E5EDFF'};
export const slides=[];
let current;
const text=(value,x,y,w,size=30,color='ink',bold=false,extra={})=>current.nodes.push({type:'text',value,x,y,w,h:size*1.5,size,color,bold,...extra});
const rect=(x,y,w,h,color='ice',extra={})=>current.nodes.push({type:'rect',x,y,w,h,color,...extra});
const rule=(x,y,w,color='line',h=1)=>rect(x,y,w,h,color);
const lines=(values,x,y,w,size=30,color='muted',step=47,extra={})=>values.forEach((v,i)=>text(v,x,y+i*step,w,size,color,false,extra));
const bracket=(x,y,w,h,t=24,color='blue',extra={})=>{rect(x,y,w,t,color,extra);rect(x+w-t,y,t,h,color,extra);rect(x,y+h-t,w,t,color,extra);};
const table=(values,x,y,widths,heights,size=27)=>current.nodes.push({type:'table',values,x,y,w:widths.reduce((a,b)=>a+b,0),h:heights.reduce((a,b)=>a+b,0),widths,heights,size,enter:450});
function start(id,label,title,accent,kicker,notes,focus=[]){
 current={id,label,title,notes,focus,nodes:[]};slides.push(current);
 bracket(112,69,12,28,4);text('知因',143,60,90,31,'ink',true);text('CodeLab',238,59,190,34,'ink',false,{font:'Bahnschrift'});
 text(kicker,1270,71,538,20,'muted',false,{align:'right',tracking:2});
 if(title){text(title,108,174,1695,72,'ink',true,{enter:0,tracking:-2});if(accent)text(accent,108,268,1695,72,'blue',true,{enter:140,tracking:-2});}
 rule(112,984,1696);text('知因 CodeLab  /  教育智能体应用',112,1004,1030,21,'muted');text(`${String(slides.length).padStart(2,'0')}  /  10`,1645,1002,163,24,'deep',false,{font:'Bahnschrift',align:'right'});
 return current;
}
const task='来源：output/知因CodeLab_初赛任务书_2026-09-29.md。功能内容沿用任务书；新前端接线和验证范围以 docs/engineering/FRONTEND-REPAIR-ACCEPTANCE.md 与 docs/verification/2026-09-29/CURRENT-SOURCE-REPRODUCTION.md 的最新段落为准。';
start('cover','项目定位','','','项目理解 / 课程反馈',task+'拟选方向为教育智能体应用。当前为参赛原型。无学校与个人署名；以团队最终匿名口径为准。\n讲述：学生和教师面对源码，最需要的是能回到原文、解释过程并保留人工判断。知因 CodeLab 把这件事放进同一个工作流。',[
 ['源码引用','回到具体文件与行范围，核对结论的出处。'],['调查路径','保留读取、搜索和反证复核过程。'],['核查反馈','教师审阅课程反馈，并显式确认后发布。']]);
// Approved A composition: wide white title field and ice-blue evidence bracket.
current.nodes.unshift({type:'rect',x:1310,y:0,w:610,h:984,color:'ice'});
text('让理解，回到依据',164,247,920,25,'deep',false,{tracking:4});rule(112,268,34,'blue',2);
text('让代码结论，',109,315,1175,140,'ink',true,{enter:0,tracking:-5});
text('有据可循。',109,493,1170,161,'blue',true,{enter:180,tracking:-5});
text('面向项目理解与课程反馈的 AI 智能体',112,734,1150,31,'ink',false,{enter:520});
text('从一个问题出发，把依据带回每一个结论。',112,796,1100,24,'muted',false,{enter:720});
text('每个结论，都有来处',1344,224,440,22,'deep',false,{enter:550,tracking:2});
bracket(1727,319,101,438,33,'line');bracket(1714,304,101,438,33,'blue',{draw:true});
[['SOURCE','源码引用'],['INVESTIGATE','调查路径'],['REVIEW','核查反馈']].forEach(([en,cn],i)=>{const y=347+i*124;rule(1512,y+48,264,'line');text(en,1344,y,290,15,'muted',false,{font:'Bahnschrift',tracking:2,enter:850+i*230});text(cn,1344,y+29,260,33,'ink',false,{enter:880+i*230});current.nodes.push({type:'hit',x:1335,y:y-10,w:440,h:105,focus:i,label:cn});});
lines(['源码、过程、反馈，','连接成可核查的依据。'],1344,808,450,23,'muted',38);

start('needs','需求与定位','学生需要读懂项目，','教师需要核查依据。','01 / 用户需求与相邻方案',task+'需求来自产品场景假设与开发观察，未开展独立师生访谈。方案比较只描述工作流切入点，不是商业产品基准测试。\n讲述：通用模型和 IDE 助手适合问答与编辑；CodeLab 聚焦上传项目后的共享核查，以及课程反馈的版本化发布。',[
 ['读懂项目','项目结构与阅读路线，关联具体的文件和行。'],['核查反馈','教学条目连接原始结果、证据与教师判断。'],['修改复提','保留旧报告，区分修复、回归和条件变化。']]);
[['01','读懂项目','陌生源码里，先找到阅读入口。'],['02','核查反馈','每条建议，都能回到原始依据。'],['03','修改复提','修复与回归，需要分别看见。']].forEach(([n,h,b],i)=>{const y=429+i*153;rule(112,y,720);text(n,112,y+23,65,33,'blue',false,{font:'Bahnschrift',enter:350+i*160});text(h,205,y+18,600,36,'ink',true,{enter:350+i*160});text(b,205,y+76,610,27,'muted',false,{enter:400+i*160});current.nodes.push({type:'hit',x:105,y:y+5,w:735,h:140,focus:i,label:h});});
text('相邻方案各有所长',934,393,850,25,'deep');
table([['类别','已有切入点','CodeLab 的补充'],['通用对话','灵活问答','索引与引用'],['IDE 助手','编辑与修改','师生共享核查'],['自动化测试','固定行为检查','教学解释与判断'],['课程提交系统','收集与组织','证据及复提比较']],934,448,[235,305,334],[64,85,85,85,85],26);
text('需求来源：产品场景假设与开发观察；尚无独立师生访谈结论。',112,921,1680,22,'muted');

start('import','项目导入','上传普通源码，','按问题开始阅读。','02 / 普通 ZIP 与个人模型',task+'容量依据 packages/contracts/src/source.ts。普通 ZIP 100MiB，展开500MiB，20,000项，保留16MiB，单文件512KiB。快速/深入阅读预算100,000/180,000字符。课程ZIP10MiB。密钥加密保存且不回显；服务商费用由用户账户承担。\n讲述：普通源码不需要适配课程模板。系统先建立索引，再选择片段阅读；导入大小和模型阅读量分别受限。',[
 ['导入范围','展开总量500 MiB，最多20,000项；单文件512 KiB，保留源码16 MiB。'],['受控阅读','快速10万字符、深入18万字符；导入不等于全部已读。'],['个人模型','用户配置服务商、模型和密钥；费用由个人供应商账户承担。']]);
rect(112,429,584,450);text('普通源码 ZIP',151,466,490,29,'deep');text('100',144,528,370,145,'blue',false,{font:'Bahnschrift',enter:450});text('MiB',453,617,180,43,'blue',false,{font:'Bahnschrift',enter:650});
text('上传上限',151,725,420,29,'ink',true);lines(['无需适配课程模板','静态分析，不执行任意项目'],151,785,475,25,'muted',40);current.nodes.push({type:'hit',x:112,y:429,w:584,h:450,focus:0,label:'查看导入范围'});
[['01','安全导入','校验路径与大小，跳过依赖、产物及识别到的敏感配置。'],['02','按预算阅读','索引 → 规划 → 读取 / 搜索；保留已读片段与覆盖说明。'],['03','连接个人模型','个人配置模型与密钥，调用费用归属用户的供应商账户。']].forEach(([n,h,b],i)=>{const y=429+i*153;rule(790,y,1018);text(n,790,y+23,85,32,'blue',false,{font:'Bahnschrift',enter:500+i*180});text(h,883,y+18,900,35,'ink',true,{enter:500+i*180});text(b,883,y+80,920,25,'muted',false,{enter:570+i*180});current.nodes.push({type:'hit',x:781,y:y+3,w:1027,h:141,focus:i===0?0:i,label:h});});
text('阅读预算：快速 10 万字符 / 深入 18 万字符     ·     课程 ZIP 单独限制为 10 MiB',112,922,1696,24,'deep');

start('investigate','调查机制','分析过程可回看，','阅读范围说得清。','03 / 源码调查与反证复核',task+'普通源码调查并非任意代码执行。深入模式增加两轮沿线索调查。显示实际阶段和工具动作，不推测模型内部推理百分比。\n讲述：从索引规划到引用检查，每一步都有可查看的材料。对于未读到、依据不足或反证不支持的内容，要明确保留边界。',[
 ['索引与规划','记录保留和跳过的范围，并确定重点目录。'],['读取与搜索','按预算取片段，沿调用或业务线索补读。'],['反证与成稿','检查引用，保留撤回、未确认与覆盖之外的事项。']]);
rule(139,491,1615,'line',2);
[['01','索引','保留 / 跳过范围'],['02','规划','问题与重点目录'],['03','读取 / 搜索','片段及工具动作'],['04','反证复核','补读与判断变化'],['05','引用检查','出处与覆盖说明']].forEach(([n,h,b],i)=>{const x=112+i*349;rect(x,458,73,70,'paper');text(n,x,456,72,51,'blue',false,{font:'Bahnschrift',enter:330+i*180});text(h,x,559,340,35,'ink',true,{enter:440+i*180});text(b,x,623,340,25,'muted',false,{enter:500+i*180});current.nodes.push({type:'hit',x:x-8,y:449,w:335,h:226,focus:i<2?0:i===2?1:2,label:h});});
rect(112,736,1696,173);text('快速概览',148,767,400,30,'deep',true);text('建立结构与初步阅读路线',148,826,630,27,'muted');rule(815,769,1,'line',104);text('深入分析',868,767,400,30,'deep',true);text('增加两轮沿源码线索的调查',868,826,860,27,'muted');
text('展示真实阶段、已完成动作与覆盖范围；源码导入不代表全仓库已读。',112,931,1696,23,'muted');

start('report','引用与复核','结论旁边，','始终保留核查入口。','04 / 报告与人工判断',task+'本页为功能结构示意，不是伪造报告截图，也不引用未获公开授权的博物馆源码。静态线索不是已复现漏洞。\n讲述：报告提供结构、业务链路、问题建议和阅读路线。用户沿引用回到源码，检查是否真的支持结论；教师对课程反馈保留最终发布权。',[
 ['定位原文','从引用打开具体文件与行范围，理解上下文。'],['检查依据','对照源码与反证核对判断，允许修订和撤回。'],['确认反馈','课程反馈由教师修改、确认后发布，模型候选单独保存。']]);
[['01','定位原文','文件路径与行范围，连接每条解释。'],['02','检查依据','补读上下文，保留反证与撤回。'],['03','确认反馈','课程反馈经教师审阅后，再发布。']].forEach(([n,h,b],i)=>{const y=429+i*153;rule(112,y,760);text(n,112,y+23,80,33,'blue',false,{font:'Bahnschrift',enter:350+i*180});text(h,205,y+19,630,36,'ink',true,{enter:350+i*180});text(b,205,y+80,670,26,'muted',false,{enter:410+i*180});current.nodes.push({type:'hit',x:104,y:y+3,w:774,h:141,focus:i,label:h});});
rect(982,418,826,481);text('结构化报告',1024,447,530,30,'deep',true);text('功能结构示意',1565,453,203,19,'muted',false,{align:'right'});
[['项目结构','模块职责与入口'],['业务链路','连接文件与调用关系'],['问题建议','来源、反证与未确认说明'],['阅读路线','下一步核查与修改方向']].forEach(([h,b],i)=>{const y=516+i*83;rule(1024,y,667);text(h,1024,y+19,240,29,'ink',true,{enter:520+i*160});text(b,1272,y+24,419,23,'muted',false,{enter:600+i*160});});bracket(1730,516,39,318,9,'blue',{draw:true});
text('模型提供调查候选；覆盖之外和上下文不足的事项，仍需人工核查。',112,928,1696,24,'deep');

start('course','课程复提','筛选修复了，','保存回归也要看见。','05 / 课程证据闭环',task+'图片来源：output/workspace-verification/2026-09-28T17-36-40-006Z/chapter-7.png。2026-09-28 历史原界面实录；团队构造样本，本次关闭AI。案例来源 docs/verification/2026-09-29/WORKSPACE-REGRESSION-DEMO.md。不是当前新界面截图，不是AI质量评测。\n讲述：固定课程先执行真实检查，再由教师审阅。学生复提修复了筛选，却引入刷新保存回归，系统把两项变化分别保留。',[
 ['第一次提交','筛选行为存在缺陷，保留当次失败证据。'],['修改后复提','筛选修复，但刷新保存出现回归；旧报告保持可读。'],['教师发布','查看证据、修改反馈、逐项确认，再发布给学生。']]);
rect(112,409,826,543);current.nodes.push({type:'image',src:'assets/course-report.png',x:167,y:426,w:710,h:501,alt:'2026-09-28课程历史回放截图，显示筛选修复与保存回归，此次运行关闭AI',enter:430,zoom:true});
text('真实历史回放  ·  原界面  ·  团队样本  ·  本次关闭 AI',143,927,760,19,'muted');
[['版本 01','筛选存在缺陷','保留失败结果与原始证据。'],['版本 02','筛选修复，保存回归','两项变化分别记录，旧报告可回看。'],['教师复核','修改 → 确认 → 发布','学生读取本人已发布的反馈快照。']].forEach(([l,h,b],i)=>{const y=422+i*157;rule(1020,y,788);text(l,1020,y+17,210,21,'blue',false,{enter:420+i*180});text(h,1020,y+53,775,35,'ink',true,{enter:440+i*180});text(b,1020,y+112,775,25,'muted',false,{enter:480+i*180});current.nodes.push({type:'hit',x:1010,y:y+2,w:798,h:150,focus:i,label:l});});
text('5 项核心 / 8 个案例',1020,906,750,29,'deep',true);text('仅针对登记并验证过的 Vue 课程任务包',1020,952,770,20,'muted');

start('architecture','技术架构','源码调查与课程执行，','各有边界、共享证据。','06 / 系统架构与输入输出',task+'LangGraph用于课程Agent；普通源码调查为TypeScript索引、检索、模型适配与校验。Docker/Playwright仅执行登记任务包。没有自训练基础模型。\n讲述：工作台和API处理身份与版本；普通源码走静态调查，课程任务走受控执行与Agent。证据、候选和发布记录分层保存。',[
 ['业务层','Vue工作台处理交互；Fastify与PostgreSQL处理鉴权、版本与存储。'],['源码路径','输入索引与源码片段，输出结构化分析、引用及覆盖记录。'],['课程路径','输入登记任务包与规则，输出运行证据；课程Agent生成独立候选。']]);
rect(112,415,1696,109);text('Vue + TypeScript 工作台',142,444,745,33,'ink',true,{enter:350});text('师生操作 / 个人模型',142,490,750,20,'muted');text('→',858,443,80,40,'blue');text('Fastify + PostgreSQL',986,444,763,33,'ink',true,{enter:490});text('请求、身份、版本化对象与权限控制',986,490,763,20,'muted');
[['普通源码路径','索引 / 片段 / 阅读预算','TypeScript 调查 + 模型适配','解释、源码引用、覆盖记录'],['登记课程路径','任务包 / 规则 / 封存证据','Docker + Playwright → 课程 Agent','案例结果、截图日志、独立候选']].forEach((a,i)=>{const x=112+i*897;rule(x,573,799,'blue',3);text(a[0],x,595,780,31,'deep',true,{enter:600+i*160});text('输入  '+a[1],x,658,790,25,'muted',false,{enter:660+i*160});text(a[2],x,711,798,31,'ink',true,{enter:750+i*160});text('输出  '+a[3],x,771,798,25,'muted',false,{enter:850+i*160});current.nodes.push({type:'hit',x:x-8,y:578,w:815,h:258,focus:i+1,label:a[0]});});
rect(112,844,1696,86);text('证据与回收',142,868,270,29,'deep',true);text('哈希 / 版本 / 权限  ·  所有权与租约  ·  独立回收器  ·  LangGraph 持久检查点',430,872,1320,25,'ink');
text('接入 DeepSeek / OpenAI / 通义千问等现有模型推理；未自训练基础模型。',112,945,1696,22,'muted');

start('data','数据与权限','原始证据、模型候选，','与教师发布分层保存。','07 / 数据字段与权限边界',task+'未采用开放训练数据集，未用用户源码进行本地模型训练。供应商处理条件按用户所选服务与账户约定。密钥不进入公开材料。\n讲述：数据设计围绕可追溯性展开。原始运行事实不能被模型覆盖，候选不能自动变成发布报告，学生读取的是获授权的发布快照。',[
 ['原始材料','路径、行、哈希与规则版本把证据绑定到具体输入。'],['模型候选','保留模型配置、工具轨迹、状态与已知用量。'],['发布权限','教师确认后形成版本快照；学生读取本人获授权内容。']]);
table([['数据名称','核心字段 / 内容','用途与边界'],['源码项目','路径、内容、行范围、哈希','静态阅读与引用'],['规则与运行证据','规则版本、案例 ID、结果、截图 / 日志','绑定测量条件，保留原始事实'],['AI 分析记录','模型版本、轨迹、引用、状态、已知用量','候选单独保存，未知用量保留未知'],['教师修订与发布','判断、确认哈希、发布版本、证据白名单','教师确认后发布，学生读取本人快照'],['个人模型配置','用户、服务商、模型、加密密钥','按账号隔离；密钥不进入公开材料']],112,414,[338,723,635],[65,78,78,78,78,78],26);
rect(112,899,1696,60);text('用户源码未用于本地模型训练；外部服务商的数据处理条件取决于所选服务和账户约定。',140,912,1636,23,'deep');

start('validation','验证范围','已完成的验证，','有明确的证据范围。','08 / 工程验证 · 截至 2026.09.29',task+'来源：docs/engineering/FRONTEND-REPAIR-ACCEPTANCE.md，docs/verification/2026-09-29/CURRENT-SOURCE-REPRODUCTION.md，docs/verification/2026-09-28/T07-T08-core-workspace.md。215真实PG专项五文件；33浏览器分组结果含模型合成替身，并非一次命令33项。11团队ZIP/2家族/88案例含预期失败和未执行。新源码36c71293同机421文件274所选测试及Chrome10项。普通测试716通过32跳过与这些专项有重复，不相加。\n讲述：这些数字回答工程链路能否按预期运行，不能推导模型准确率或教学收益。独立教师评测和异机验收仍待完成。',[
 ['数据库专项','真实隔离 PostgreSQL，五个文件215项通过；与普通测试存在重复。'],['浏览器专项','33项为分组执行累计，模型含合成替身，不是模型质量结论。'],['课程样本','11份开发ZIP、2个实现家族；88案例结果包含预期失败和未执行。']]);
const cols=[112,697,1282];
[['215','项 / 数据库专项','隔离 PostgreSQL · 五个文件','覆盖报告、worker、生命周期等'],['33','项 / 浏览器专项','新入口及 ZIP → 报告链路','分组结果；模型包含合成替身'],['11','份 / 团队课程样本','2 个实现家族 · 88 个案例','含预期失败与未执行']].forEach(([n,u,a,b],i)=>{const x=cols[i];rule(x,431,526,'line',1);text(n,x-5,445,520,129,'blue',false,{font:'Bahnschrift',enter:420+i*170});text(u,x,611,535,29,'ink',true,{enter:540+i*170});text(a,x,683,535,25,'muted',false,{enter:630+i*170});text(b,x,730,535,24,'muted',false,{enter:690+i*170});current.nodes.push({type:'hit',x:x-8,y:431,w:548,h:341,focus:i,label:u});});
rect(112,818,1696,93);text('同机新目录复现',143,845,430,30,'deep',true);text('421 文件核对  /  274 项所选测试  /  10 项 Chrome 验证',587,849,1176,27,'ink');
text('各集合不相加、不折算准确率；独立教师评测、成员异机复现与生产环境验收仍待完成。',112,938,1696,22,'muted');

start('value','价值与交付','','','09 / 作品价值与后续验证',task+'官方内容要求来源 docs/OFFICIAL_COMPETITION_REQUIREMENTS.md 第6—7页记录。预期节时、修订负担和学习效果尚无独立评测结论。交付材料须由团队核实报名、匿名、素材授权和最终源码版本；当前仍有3项依赖许可全文缺口。\n讲述：我们的贡献是把解释过程变得可追溯，把教师判断留下来。下一阶段以形成可发布反馈为终点，开展独立评阅、异机复现和课程试点，测量实际收益。',[
 ['可追溯解释','结论连接文件、行与调查过程，便于回看和核查。'],['人工发布权','模型候选与教师判断分离，课程反馈经确认后发布。'],['可比较复提','保留旧报告，在相同测量条件下区分修复和回归。']]);
current.nodes.unshift({type:'rect',x:1310,y:0,w:610,h:984,color:'ice'});
text('让每一次反馈，',108,222,1180,99,'ink',true,{enter:0,tracking:-3});text('回到可核查的依据。',108,364,1180,99,'blue',true,{enter:180,tracking:-3});
text('知因 CodeLab',112,555,1060,40,'ink',true,{enter:420});text('面向项目实训的 AI 源码分析与证据反馈平台',112,628,1140,29,'muted',false,{enter:600});
rule(112,720,1070);text('交付材料',112,750,250,26,'deep',true);text('作品介绍 / 任务书 / 源码与复现指南 / 演示材料',112,800,1120,27,'ink');text('下一步验证',112,865,250,26,'deep',true);text('独立评阅、成员异机复现与课程试点；实际收益待测量。',112,915,1150,24,'muted');
text('本项目的实现重点',1344,253,440,23,'deep');bracket(1742,338,70,447,22,'blue',{draw:true});
[['01','可追溯的解释','源码与调查过程'],['02','人工发布权','候选与判断分离'],['03','可比较的复提','修复与回归并存']].forEach(([n,h,b],i)=>{const y=343+i*148;text(n,1344,y,370,18,'blue',false,{font:'Bahnschrift',enter:630+i*200});text(h,1344,y+31,397,32,'ink',true,{enter:700+i*200});text(b,1344,y+89,397,24,'muted',false,{enter:770+i*200});current.nodes.push({type:'hit',x:1334,y:y-6,w:400,h:140,focus:i,label:h});});

export const metadata={title:'知因 CodeLab｜让代码结论，有据可循',edition:'A 精修 · 完整演示稿',date:'2026-09-30',evidenceDate:'2026-09-29',canvas:[1920,1080],font:['Microsoft YaHei','Bahnschrift'],duration:2600};
