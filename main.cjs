const {app,BrowserWindow,ipcMain,dialog,session}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./lib/finance.cjs');
const Campus=require('./lib/campus.cjs');
let main,school,book,queue=Promise.resolve(),syncing=false,cancelSync=false;
const dataOverride=process.argv.find(x=>x.startsWith('--data-dir='));if(dataOverride)app.setPath('userData',path.resolve(dataOverride.slice(11)));
const file=()=>path.join(app.getPath('userData'),'ledger.json');
const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&['campuscard.sustech.edu.cn','cas.sustech.edu.cn'].includes(u.hostname);}catch{return false;}};
const schoolPage=url=>{try{return new URL(url).origin==='https://campuscard.sustech.edu.cn';}catch{return false;}};
async function persist(next){F.validate(next);await fs.mkdir(path.dirname(file()),{recursive:true});await fs.writeFile(file()+'.tmp',JSON.stringify(next,null,2),{mode:0o600});await fs.rename(file()+'.tmp',file());book=next;return book;}
async function openSchool(){if(school&&!school.isDestroyed()){school.show();return true;}const ses=session.fromPartition('school-memory');ses.setPermissionRequestHandler((w,p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);school=new BrowserWindow({title:'南科大官方校园卡 · 登录并打开消费明细',width:1100,height:820,webPreferences:{partition:'school-memory',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});school.webContents.setWindowOpenHandler(({url})=>{if(allowed(url))void school.loadURL(url).catch(()=>{});return {action:'deny'};});school.webContents.on('will-navigate',(e,url)=>{if(!allowed(url))e.preventDefault();});school.webContents.on('will-redirect',(e,url)=>{if(!allowed(url))e.preventDefault();});school.on('closed',()=>{school=null;});await school.loadURL('https://campuscard.sustech.edu.cn/epay/');return true;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function progress(message){main.webContents.send('sync-progress',message);}
async function sync(){
 if(syncing)throw Error('正在同步，请稍候');
 if(!school||school.isDestroyed())throw Error('请先打开学校网站并登录。');
 syncing=true;cancelSync=false;
 try{
 progress('正在验证校园卡登录状态…');
 await school.loadURL('https://campuscard.sustech.edu.cn/epay/');
 let account=null;
 for(let n=0;n<30;n++){
  if(!school||school.isDestroyed()||cancelSync)throw Error('同步已取消，账本未改变');
  const frames=school.webContents.mainFrame.framesInSubtree.filter(f=>schoolPage(f.url));
  for(const f of frames){try{const info=await f.executeJavaScript(Campus.readIdentity);if(info)account=info;}catch{}}
  if(account)break;
  if(school.webContents.getURL().startsWith('https://cas.sustech.edu.cn/'))throw Error('登录已过期，请在学校窗口手动登录后重试');
  await delay(500);
 }
 if(!account)throw Error('无法确认校园卡账户，请完成登录后重试');
 const accountHash=crypto.createHash('sha256').update(account).digest('hex');
 if(book.accountHash&&book.accountHash!==accountHash)throw Error('当前登录账户与本账本不同，已停止同步以避免混入他人账单');
 await school.loadURL('https://campuscard.sustech.edu.cn/epay/consume/query?pageNo=1&tabNo=1');
 const seenPages=new Set(),all=[];let expected=1,total=0,ignored=0;
 while(true){
  let data;
  for(let i=0;i<40;i++){
   if(!school||school.isDestroyed()||cancelSync)throw Error('同步已取消，账本未改变');
   if(!schoolPage(school.webContents.getURL()))throw Error('登录失效，同步未写入账本');
   data=await school.webContents.executeJavaScriptInIsolatedWorld(999,[{code:Campus.readPage}]);
   if(data.login)throw Error('登录已过期，请重新登录');
   if(data.current===expected)break;
   await delay(500);
  }
  if(!data||data.current!==expected)throw Error('账单页加载超时或结构变化，未写入不完整数据');
  if(data.total<1||data.total>200)throw Error('账单页数异常或超过 200 页，请联系适配后再同步');
  if(total&&data.total!==total)throw Error('同步期间账单页数变化，请重新同步');total=data.total;
  if(seenPages.has(data.current))throw Error('检测到重复分页，同步已停止');seenPages.add(data.current);
  const parsed=Campus.parseSchoolTables(data.tables);if(!parsed.recognized)throw Error('消费表格结构与已适配版本不同，未写入数据');
  if(parsed.warnings.length)throw Error('部分消费无法解析：'+parsed.warnings.join('；')+'。账本未改变');
  all.push(...parsed.entries);ignored+=parsed.ignored;
  progress(`已读取第 ${expected} / ${total} 页，共 ${all.length} 条消费或退款`);
  if(expected===total)break;
  const clicked=await school.webContents.executeJavaScript(Campus.nextPage);if(!clicked)throw Error('未找到下一页，同步未写入账本');expected++;await delay(600);
 }
 const result=F.merge(book,all);await persist({...result.book,accountHash,lastSync:new Date().toISOString()});
 school.hide();progress(`同步完成：新增 ${result.added} 笔，跳过 ${result.duplicates} 笔重复账单`);
 return {added:result.added,duplicates:result.duplicates,pages:total,ignored,count:all.length,unclassified:all.filter(e=>!e.meal).length};
 }finally{syncing=false;}
}
function handle(name,fn,mutate=false){ipcMain.handle('wallet:'+name,async(e,arg)=>{if(e.sender!==main.webContents||e.senderFrame!==main.webContents.mainFrame)throw Error('请求来源无效');const task=async()=>{try{return {ok:true,value:await fn(arg)};}catch(err){return {ok:false,error:err.message};}};if(!mutate)return task();const result=queue.then(task,task);queue=result.then(()=>{});return result;});}
app.whenReady().then(async()=>{try{book=F.validate(JSON.parse(await fs.readFile(file(),'utf8')));}catch(e){if(e.code==='ENOENT')book=F.empty();else{dialog.showErrorBox('账本读取失败','原数据已保留，请恢复有效备份后重试。');app.quit();return;}}
main=new BrowserWindow({title:'南科饭钱',width:1180,height:850,minWidth:860,minHeight:660,backgroundColor:'#f2f5fb',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});main.webContents.setWindowOpenHandler(()=>({action:'deny'}));main.webContents.on('will-navigate',e=>e.preventDefault());
handle('load',()=>({book,stats:F.calculate(book),today:F.today()}));
handle('settings',s=>persist({...book,settings:s}),true);
handle('add',e=>persist({...book,entries:[...book.entries,{id:crypto.randomUUID(),date:e.date,place:e.place.trim().slice(0,100),cents:F.cents(e.amount),meal:true,source:'manual',note:''}]}),true);
handle('toggle',id=>persist({...book,entries:book.entries.map(e=>e.id===id?{...e,meal:!e.meal}:e)}),true);
handle('remove',id=>persist({...book,entries:book.entries.filter(e=>e.id!==id)}),true);
handle('school',openSchool);handle('scan',sync,true);handle('cancelSync',()=>{cancelSync=true;return true;});
handle('backup',async()=>{const r=await dialog.showSaveDialog(main,{defaultPath:'南科饭钱-备份.json',filters:[{name:'账本备份',extensions:['json']}]});if(r.canceled)return false;await fs.writeFile(r.filePath,JSON.stringify(book,null,2),{mode:0o600});return true;});
handle('restore',async()=>{const r=await dialog.showOpenDialog(main,{properties:['openFile'],filters:[{name:'账本备份',extensions:['json']}]});if(r.canceled)return false;const st=await fs.stat(r.filePaths[0]);if(st.size>10*1024*1024)throw Error('备份文件过大');const b=F.validate(JSON.parse(await fs.readFile(r.filePaths[0],'utf8')));const c=await dialog.showMessageBox(main,{type:'question',buttons:['取消','替换账本'],defaultId:0,cancelId:0,message:`用备份中的 ${b.entries.length} 笔记录替换当前账本？`});if(c.response!==1)return false;await persist(b);return true;},true);
await main.loadFile(path.join(__dirname,'ui/index.html'));});
app.on('window-all-closed',()=>app.quit());
