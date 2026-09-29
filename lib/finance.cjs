const crypto = require('node:crypto');
const DAY=86400000;
function day(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('日期格式须为 YYYY-MM-DD');const d=new Date(s+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw Error('日期无效');return +d;}
function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function cents(s){const v=String(s).replace(/[¥￥元,\s]/g,'');if(!/^-?\d{1,8}(\.\d{1,2})?$/.test(v))throw Error('金额无效');return Math.round(Number(v)*100);}
function empty(){return {version:1,entries:[],settings:{funds:0,budget:0,anchor:today(),end:today(),sampleStart:today()},seen:[]};}
function validate(b){if(!b||b.version!==1||!Array.isArray(b.entries)||!Array.isArray(b.seen)||!b.settings)throw Error('账本格式错误');for(const k of ['anchor','end','sampleStart'])day(b.settings[k]);for(const k of ['funds','budget'])if(!Number.isSafeInteger(b.settings[k])||b.settings[k]<0)throw Error('预算金额无效');if(b.settings.end<b.settings.anchor||b.settings.sampleStart>today()||b.settings.anchor>today())throw Error('请检查预算日期');const ids=new Set();for(const e of b.entries){day(e.date);if(e.date>today()||typeof e.id!=='string'||ids.has(e.id)||typeof e.place!=='string'||!e.place.trim()||!Number.isSafeInteger(e.cents)||e.cents===0||typeof e.meal!=='boolean'||!['manual','campus'].includes(e.source))throw Error('账单格式错误');ids.add(e.id);}if(b.seen.some(x=>typeof x!=='string'))throw Error('去重记录格式错误');return b;}
function calculate(b,now=today()){
 const s=b.settings,meals=b.entries.filter(e=>e.meal&&e.date<=now),sample=meals.filter(e=>e.date>=s.sampleStart),sampleDays=Math.max(1,(day(now)-day(s.sampleStart))/DAY+1),sampleCost=sample.reduce((a,e)=>a+e.cents,0),rate=Math.max(0,sampleCost/sampleDays);
 const spent=meals.filter(e=>e.date>=s.anchor).reduce((a,e)=>a+e.cents,0),balance=s.funds-spent,remainingDays=Math.max(0,(day(s.end)-day(now))/DAY+1),leftBudget=s.budget-spent;
 const sustain=balance<=0?0:rate>0?Math.floor(balance/rate):null;
 const daily=remainingDays?Math.max(0,Math.min(balance,leftBudget))/remainingDays:null;
 const gap=remainingDays?Math.round(Math.min(balance,leftBudget)-rate*remainingDays):null;
 const places=new Map();for(const e of meals){const p=places.get(e.place)||{name:e.place,count:0,cents:0};p.cents+=e.cents;if(e.cents>0)p.count++;places.set(e.place,p);}
 const days=Array.from({length:14},(_,i)=>{const date=new Date(day(now)-(13-i)*DAY).toISOString().slice(0,10);return {date,cents:meals.filter(e=>e.date===date).reduce((a,e)=>a+e.cents,0)};});
 return {sampleDays,rate,balance,leftBudget,spent,sustain,daily,gap,remainingDays,days,places:[...places.values()].sort((a,b)=>b.count-a.count),todayCost:meals.filter(e=>e.date===now).reduce((a,e)=>a+e.cents,0),total:meals.reduce((a,e)=>a+e.cents,0),count:meals.length};
}
const norm=s=>String(s||'').replace(/[\s：:()（）]/g,'');
const aliases={date:['交易时间','消费时间','交易日期','消费日期','日期'],time:['时间'],place:['商户名称','商户','商户名','消费地点','交易地点','地点','终端名称'],amount:['交易金额','消费金额','金额','支出金额'],kind:['交易类型','交易名称','业务类型','类型','交易摘要'],id:['交易流水号','流水号','交易编号','订单号','流水编号'],balance:['余额','卡余额','账户余额']};
function parseTables(tables){const entries=[],warnings=[];let recognized=0,ignored=0;const occurrence=new Map();for(const t of tables){if(!Array.isArray(t.headers)||!Array.isArray(t.rows))continue;const index={};for(const [key,names] of Object.entries(aliases))index[key]=t.headers.findIndex(h=>names.includes(norm(h)));if(['date','place','amount','kind'].some(k=>index[k]<0))continue;recognized++;
 for(const row of t.rows){try{const read=k=>String(row[index[k]]??'').trim(),kind=read('kind');if(!/消费|扣款|退款|退费|冲正/.test(kind)||/充值|转账|补助|圈存|撤销充值/.test(kind)){ignored++;continue;}
 const rawDate=read('date').replace(/[年月/.]/g,'-').replace(/日/g,'');const m=rawDate.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);if(!m)throw Error('无法识别交易日期');const date=`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;day(date);if(date>today())throw Error('交易日期晚于今天');const place=read('place');if(!place)throw Error('商户为空');let value=Math.abs(cents(read('amount')));if(value===0){ignored++;continue;}if(/退款|退费|冲正/.test(kind))value=-value;
 const timestamp=(rawDate.match(/\d{1,2}:\d{2}(?::\d{2})?/)||[])[0]||read('time');const sourceId=read('id');const rawKey=sourceId?`id:${sourceId}`:JSON.stringify([date,timestamp,place,value,kind,read('balance')]);const count=occurrence.get(rawKey)||0;occurrence.set(rawKey,count+1);const key=crypto.createHash('sha256').update(rawKey+(sourceId?'':`:${count}`)).digest('hex');
 entries.push({id:'campus:'+key,key,date,place,cents:value,meal:/食堂|餐厅|餐饮|饭|面馆|咖啡|奶茶|早餐|午餐|晚餐/.test(place),source:'campus',sourceId:sourceId||null,note:kind+(timestamp?' · '+timestamp:''),needsReview:!sourceId});
 }catch(e){warnings.push(e.message);}}
 }return {entries,recognized,ignored,warnings:[...new Set(warnings)]};}
function merge(b,rows){let added=0,duplicates=0;const seen=new Set(b.seen);const entries=[...b.entries];for(const e of rows){if(seen.has(e.key)||entries.some(x=>x.id===e.id)){duplicates++;continue;}entries.push(e);seen.add(e.key);added++;}return {book:validate({...b,entries,seen:[...seen]}),added,duplicates};}
module.exports={day,today,cents,empty,validate,calculate,parseTables,merge};
