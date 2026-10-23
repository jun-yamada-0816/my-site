// All remote requests are intercepted. No production reads/writes or credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
let browser, server, base, cdn;
const user = { id:'11111111-1111-4111-8111-111111111111', aud:'authenticated', role:'authenticated', email:'admin@example.test' };
const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({sub:user.id, role:user.role, exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'), 'test'].join('.');
const strategy = purpose => ({purpose, goal:'相談につなぐ', keep:'音楽を続ける', rivals:[{name:'参考',url:'',views:'5000',subs:'100'}], mix:70, minutes:30});
const date = new Date().toLocaleDateString('sv-SE');
function fixture() {
  return {
    sv_config:[],
    sv_videos:[1,2].map(i => ({id:'video-'+i,slug:'v'+i,title:'動画'+i,produced_on:'2026-09-01',duration_sec:17,format:'映像＋テロップ（窓と灯り）',theme:'孤独',hook_type:'場面描写'})),
    sv_posts:[1,2].map(i => ({id:'post-'+i,video_id:'video-'+i,platform:'youtube',posted_at:'2026-09-01T10:00:00Z',platform_video_id:'testvideo0'+i})),
    sv_metrics:[{post_id:'post-1',measured_on:date,views:100,likes:5,comments:1,subs_gained:0,avg_watch_sec:10,stayed_pct:40}],
    sv_site_visits:[],sv_channel_daily:[{measured_on:date,subscribers:20}],sv_metrics_log:[],
  };
}
before(async () => {
  const cache = path.join(os.tmpdir(),'my-site-check','supabase-2.49.10.js');
  try { cdn = await fs.readFile(cache); } catch {
    const response = await fetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/dist/umd/supabase.min.js');
    assert(response.ok); cdn = Buffer.from(await response.arrayBuffer());
  }
  server = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(await fs.readFile(path.join(__dirname,'../shorts.html')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base = 'http://127.0.0.1:'+server.address().port;
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium'});
});
after(async()=>{ await browser?.close(); await new Promise(resolve=>server?.close(resolve)); });
async function open(db, storage={}) {
  const context = await browser.newContext();
  const flags = {failMetrics:false, failWrites:false, nullVerification:false, nullSubs:false, pauseWrite:null, pageSize:1000};
  const writes = [], errors = [], reads=[];
  await context.addInitScript(({token,user,storage})=>{
    if (!sessionStorage.getItem('test-seeded')) {
      localStorage.setItem('sb-qnmzjwgacnfxwlbgwxcr-auth-token',JSON.stringify({access_token:token,refresh_token:'test',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,user}));
      for(const [key,value] of Object.entries(storage)) localStorage.setItem(key,value);
      sessionStorage.setItem('test-seeded','1');
    }
  },{token,user,storage});
  await context.route('**/*',async route=>{
    const req=route.request(), url=new URL(req.url());
    if(url.origin===base) return route.continue();
    if(url.hostname==='cdn.jsdelivr.net') return route.fulfill({body:cdn,contentType:'application/javascript',headers:{'access-control-allow-origin':'*'}});
    if(!url.hostname.endsWith('.supabase.co')) return route.abort();
    const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(body)});
    if(url.pathname==='/auth/v1/user') return send(user);
    const table=url.pathname.split('/').at(-1);
    assert(table in db, 'unexpected endpoint '+url.pathname);
    let rows=db[table];
    const filters=[...url.searchParams].filter(([,v])=>v.startsWith('eq.'));
    const matches=row=>filters.every(([key,value])=>String(row[key])===value.slice(3));
    if(req.method()==='GET') {
      reads.push({table,offset:url.searchParams.get('offset')});
      if(flags.missingStayed && table==='sv_metrics' && url.searchParams.get('select')==='stayed_pct') return send({message:'column stayed_pct does not exist'},400);
      if(flags.failMetrics && table==='sv_metrics') return send({message:'network temporarily unavailable'},503);
      rows=rows.filter(matches).map(row=>({...row}));
      const order=url.searchParams.get('order');
      if(order) rows.sort((a,b)=>{for(const spec of order.split(',')){const [key,dir]=spec.split('.');const n=String(a[key]).localeCompare(String(b[key]));if(n)return dir==='desc'?-n:n;}return 0;});
      const start=Number(url.searchParams.get('offset')||0);
      rows=rows.slice(start,start+Math.min(flags.pageSize,Number(url.searchParams.get('limit')||1000)));
      if(flags.nullVerification && table==='sv_metrics' && filters.some(([k])=>k==='post_id')) rows=rows.map(row=>({...row,subs_gained:null}));
      if(flags.nullSubs && table==='sv_channel_daily' && filters.length) rows=[];
      // supabase-js maybeSingle requests JSON then converts 0/1 rows itself.
      return send(rows);
    }
    const body=req.postDataJSON();
    writes.push({table,method:req.method(),body,prefer:req.headers().prefer});
    if(flags.failWrites) return send({message:'offline'},503);
    if(flags.pauseWrite && table==='sv_metrics') await flags.pauseWrite;
    if(req.method()==='PATCH') {
      const changed=rows.filter(matches); changed.forEach(row=>Object.assign(row,body));return send(changed);
    }
    assert.equal(req.method(),'POST');
    const incoming=Array.isArray(body)?body:[body];
    const conflict=url.searchParams.get('on_conflict')?.split(',');
    for(const row of incoming){
      if(table==='sv_config' && rows.some(x=>x.key===row.key)) return send({message:'duplicate key'},409);
      const existing=conflict && rows.find(x=>conflict.every(k=>x[k]===row[k]));
      if(existing) Object.assign(existing,row); else rows.push({...row});
    }
    return send(incoming,201);
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/shorts.html');
  await page.waitForFunction(()=>state.ready);
  await page.addStyleTag({content:'.hidden{display:none !important}'});
  async function tab(name){await page.evaluate(name=>showTab(name),name);}
  return {page,context,flags,writes,reads,errors,tab};
}
const fillMetric=(page,post,key,value)=>page.locator(`.entry-in[data-post="${post}"][data-metric="${key}"]`).fill(value);
async function saveEntries(page){await page.locator('#entry-save').click();await page.waitForFunction(()=>!document.querySelector('#entry-save').disabled);}

test('legacy strategy survives reload, cloud save restores it in a new browser',async()=>{
  const db=fixture(), old=strategy('更新した目的');
  const a=await open(db,{'sv-strategy-v1':JSON.stringify(old)});
  try {
    await a.tab('base');assert.equal(await a.page.locator('#base-purpose').inputValue(),old.purpose);
    await a.page.locator('#base-purpose').fill('編集途中も残す');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);
    assert.equal(await a.page.locator('#base-purpose').inputValue(),'編集途中も残す');
    await a.tab('base');await a.page.locator('#base-save').click();
    await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/保存と読み直し/);
    const b=await open(db);
    try{assert.equal(await b.page.locator('#base-purpose').inputValue(),'編集途中も残す');assert.deepEqual(b.errors,[]);}finally{await b.context.close();}
    assert.deepEqual(a.errors,[]);
  } finally {await a.context.close();}
});

test('strategy save failure and concurrent cloud change never overwrite the draft or cloud',async()=>{
  const db=fixture();db.sv_config.push({key:'shorts_strategy_v1',value:JSON.stringify(strategy('クラウド'))});
  const a=await open(db);
  try {
    await a.tab('base');await a.page.locator('#base-purpose').fill('手元の変更');
    db.sv_config[0].value=JSON.stringify(strategy('別端末の変更'));
    await a.page.locator('#base-save').click();await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/別の画面/);
    assert.equal(JSON.parse(db.sv_config[0].value).purpose,'別端末の変更');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);
    assert.equal(await a.page.locator('#base-purpose').inputValue(),'手元の変更');
    a.flags.failWrites=true;await a.tab('base');await a.page.locator('#base-save').click();await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/保存できません/);
  }finally{await a.context.close();}
});

test('filtered rows and selected dates retain drafts across reload',async()=>{
  const a=await open(fixture());
  try {
    await a.tab('entry');await fillMetric(a.page,'post-1','likes','12');
    await a.page.locator('#entry-unfilled').check();
    await fillMetric(a.page,'post-2','views','234');
    await a.page.locator('#entry-date').fill('2026-09-20');await a.page.locator('#entry-date').dispatchEvent('change');
    await fillMetric(a.page,'post-2','views','99');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);
    assert.equal(await a.page.locator('#entry-date').inputValue(),'2026-09-20');
    assert.equal(await a.page.locator('.entry-in[data-post="post-2"][data-metric="views"]').inputValue(),'99');
    const draft=await a.page.evaluate(date=>JSON.parse(localStorage.getItem('sv-entry-draft-'+date)),date);
    assert.equal(draft['post-1'].likes,'12');assert.equal(draft['post-2'].views,'234');
  }finally{await a.context.close();}
});

test('sparse saves preserve unrelated fresh server values and absent fields',async()=>{
  const db=fixture(),a=await open(db);
  try {
    await a.tab('entry');await fillMetric(a.page,'post-1','likes','9');await fillMetric(a.page,'post-2','views','222');
    db.sv_metrics[0].views=888;db.sv_metrics[0].comments=77;
    await saveEntries(a.page);
    assert.match(await a.page.locator('#entry-msg').textContent(),/保存と読み直し/);
    assert.equal(db.sv_metrics[0].views,888);assert.equal(db.sv_metrics[0].comments,77);assert.equal(db.sv_metrics[0].likes,9);
    const writes=a.writes.filter(x=>x.table==='sv_metrics');assert.equal(writes.length,2);
    assert.deepEqual(Object.keys(writes[0].body[0]).sort(),['likes','measured_on','post_id']);
    assert.match(writes[0].prefer,/missing=default/);
  }finally{await a.context.close();}
});

test('failed writes and null verification retain zero-valued drafts',async()=>{
  const a=await open(fixture());
  try {
    await a.tab('entry');await fillMetric(a.page,'post-1','subs_gained','0');a.flags.failWrites=true;
    await saveEntries(a.page);assert.match(await a.page.locator('#entry-msg').textContent(),/完了できません/);
    a.flags.failWrites=false;a.flags.nullVerification=true;await saveEntries(a.page);
    assert.match(await a.page.locator('#entry-msg').textContent(),/保存を確認できません/);
    assert.equal(await a.page.evaluate(date=>readDraft(date)['post-1'].subs_gained,date),'0');
    a.flags.nullVerification=false;await saveEntries(a.page);
    assert.deepEqual(await a.page.evaluate(date=>readDraft(date),date),{});
  }finally{await a.context.close();}
});

test('subscriber verification and edits while saving retain pending data',async()=>{
  const a=await open(fixture());
  try {
    await a.tab('entry');await a.page.locator('#entry-subs-total').fill('25');a.flags.nullSubs=true;
    await saveEntries(a.page);assert.match(await a.page.locator('#entry-msg').textContent(),/登録者総数の保存を確認できません/);
    assert.equal(await a.page.evaluate(date=>readDraft(date).subs,date),'25');
    a.flags.nullSubs=false;
    let release;a.flags.pauseWrite=new Promise(resolve=>release=resolve);
    await fillMetric(a.page,'post-1','likes','8');await a.page.locator('#entry-save').click();
    await a.page.waitForTimeout(100);await fillMetric(a.page,'post-1','likes','9');release();
    await a.page.waitForFunction(()=>!document.querySelector('#entry-save').disabled);
    assert.equal(await a.page.evaluate(date=>readDraft(date)['post-1'].likes,date),'9');
    assert.equal(await a.page.locator('.entry-in[data-post="post-1"][data-metric="likes"]').inputValue(),'9');
  }finally{await a.context.close();}
});

test('pagination loads all records and read failures preserve the last valid state',async()=>{
  const db=fixture();db.sv_metrics.push({post_id:'post-1',measured_on:'2026-09-10',avg_watch_sec:13,stayed_pct:55});
  const a=await open(db);
  try {
    a.flags.pageSize=1;assert.equal(await a.page.evaluate(()=>loadAll()),true);
    assert.equal(await a.page.evaluate(()=>state.metrics.length),2);
    assert.equal(await a.page.evaluate(()=>state.latest['post-1'].views),100);
    assert(a.reads.some(r=>r.table==='sv_metrics' && r.offset==='1'));
    a.flags.failMetrics=true;assert.equal(await a.page.evaluate(()=>loadAll()),false);
    assert.equal(await a.page.evaluate(()=>state.metrics.length),2);
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    assert.match(await a.page.locator('#prompt-msg').textContent(),/読み込めない/);
    assert.equal(await a.page.locator('#prompt-copy').isDisabled(),true);
  }finally{await a.context.close();}
});

test('prompt refresh uses new records and strategy; reports dates and does not repeat frozen metrics',async()=>{
  const db=fixture(),a=await open(db);
  try {
    await a.tab('base');await a.page.locator('#base-purpose').fill('静かな相談につなぐ');
    db.sv_metrics[0].views=4321;db.sv_metrics[0].avg_watch_sec=0;
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const prompt=await a.page.locator('#prompt-out').inputValue();
    assert.match(prompt,/静かな相談につなぐ/);assert.match(prompt,/4,321/);assert.match(prompt,/計測日/);
    assert.match(prompt,/完走した人数の割合ではなく/);assert.doesNotMatch(prompt,/21本が1,100回|チャンネル登録者は20人/);
    assert.equal(await a.page.evaluate(()=>allStats().list[0].retention),0);
    assert.equal(await a.page.evaluate(()=>hasMatureMeasurement({postedAt:'2026-09-01T10:00:00Z',metricDates:{views:'2026-09-02'}})),false);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('strategy edits made during a cloud save stay pending after reload',async()=>{
  const db=fixture(),a=await open(db);
  try {
    await a.tab('base');await a.page.locator('#base-purpose').fill('保存対象');
    // Defer the actual write, then make another edit while the request is in flight.
    let release, started;
    const pending=new Promise(resolve=>release=resolve),writing=new Promise(resolve=>started=resolve);
    await a.context.route('**/rest/v1/sv_config**',async route=>{
      if(route.request().method()==='POST'){started();await pending;}
      await route.fallback();
    });
    await a.page.locator('#base-save').click();await writing;
    await a.page.locator('#base-purpose').fill('保存中の追加変更');release();
    await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/その後に入力/);
    assert.equal(JSON.parse(db.sv_config[0].value).purpose,'保存対象');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);
    assert.equal(await a.page.locator('#base-purpose').inputValue(),'保存中の追加変更');
  }finally{await a.context.close();}
});

test('unavailable local storage shows a warning and keeps edits in memory during refresh',async()=>{
  const a=await open(fixture());
  try {
    await a.page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};});
    await a.tab('base');await a.page.locator('#base-purpose').fill('控えを書けなくても保持');
    assert.match(await a.page.locator('#base-msg').textContent(),/控えを残せません/);
    await a.tab('entry');await fillMetric(a.page,'post-1','likes','44');
    assert.match(await a.page.locator('#entry-msg').textContent(),/控えを残せません/);
    await a.page.evaluate(()=>loadAll());
    assert.match(await a.page.locator('#entry-msg').textContent(),/控えを残せません/);
    assert.equal(await a.page.locator('#base-purpose').inputValue(),'控えを書けなくても保持');
    assert.equal(await a.page.locator('.entry-in[data-post="post-1"][data-metric="likes"]').inputValue(),'44');
  }finally{await a.context.close();}
});

function experimentFixture(){
  return {...fixture(),sv_videos:[],sv_posts:[],sv_metrics:[]};
}
function addExperiment(db, format, daysAgo, values={}, measuredDays=4){
  const n=db.sv_videos.length+1, id='experiment-'+n, pid='experiment-post-'+n;
  const posted=new Date(Date.now()-daysAgo*864e5);
  const measured=new Date(+posted+measuredDays*864e5).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
  db.sv_videos.push({id,slug:'v'+n,title:'別の企画'+n,format,duration_sec:20,theme:'日常',hook_type:'共感',cta_type:'なし',audio_type:'BGMのみ'});
  db.sv_posts.push({id:pid,video_id:id,platform:'youtube',posted_at:posted.toISOString()});
  db.sv_metrics.push({post_id:pid,measured_on:measured,views:500,avg_watch_sec:8,stayed_pct:40,subs_gained:0,...values});
  return {id,pid};
}
function baselineFixture(){
  const db=experimentFixture();
  [24,23,22].forEach(age=>addExperiment(db,'映像＋テロップ（窓と灯り）',age));
  return db;
}
const goodExperiment={views:900,avg_watch_sec:12,stayed_pct:60,subs_gained:2};

test('new prompt changes the visual style each time, keeps the proven first line, deliverables and tracking, and makes no writes',async()=>{
  const db=baselineFixture(),a=await open(db);
  try {
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const first=await a.page.locator('#prompt-out').inputValue();
    assert.match(first,/今回：毎回ちがう画風で作る（画風：墨と和紙）/);
    assert.match(first,/形式: 画風1｜墨と和紙/);
    assert.match(first,/水墨画/);assert.match(first,/サムネイル1枚で別のチャンネルに見える/);
    // The first line is the priority: a relatable action with a hook, not a description of scenery.
    assert.match(first,/## いちばん大事なこと：最初の一言（0〜3秒）/);
    assert.match(first,/今回のテーマ：うつ/);assert.match(first,/今回の一言の型：物が語る状態/);
    assert.match(first,/テーマ: うつ ／ 冒頭の掴み: 物が語る状態/);
    assert.match(first,/景色や物のきれいさの描写だけ/);assert.match(first,/5点で採点/);
    assert.match(first,/毎晩1本、置いてます。/);
    assert.match(first,/窓と灯り：3本・再生の中央値500回/);
    // The prompt must stay within what Claude/Codex can render with code alone.
    assert.match(first,/Python（numpy・Pillow）で1フレームずつ画を描き、ffmpeg で mp4/);
    assert.match(first,/動画生成AI・画像生成AI・実写の素材は使いません/);
    assert.match(first,/音も numpy で合成/);assert.match(first,/フレームはPNGに保存せず/);
    assert.match(first,/自己点検 8\/8 通過/);assert.match(first,/冒頭0.2秒の平均の音量/);
    assert.match(first,/人物・顔・手は描きません/);assert.match(first,/日本語フォントがない場合だけ/);
    assert.doesNotMatch(first,/実写映像に限りなく近い|実写動画素材と編集環境|動画生成または実写素材の編集で実現|コード描画への無断の代替|図形・SVG・Canvasによる風景|Seedance等の動画生成を利用できる場合/);
    assert.match(first,/音入りのmp4を1本/);assert.match(first,/固定コメントは別に出しません/);
    assert.ok(first.includes("https://hoshinoumi.org/?utm_source=youtube&utm_medium=short&utm_content=v004"));
    assert.doesNotMatch(first,/全体17秒|場所はひとつ。暗い自分の部屋|形式: 映像＋テロップ（窓と灯り）|画の答えは、自分のスタンド|少なくとも4項目/);
    await a.page.locator('#prompt-build2').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build2').disabled);
    const second=await a.page.locator('#prompt-out').inputValue();
    assert.notEqual(second,first);
    assert.match(second,/形式: 画風1｜ネオン管の夜/);assert.doesNotMatch(second,/水墨画/);
    assert.match(second,/今回のテーマ：孤独/);assert.match(second,/今回の一言の型：時刻と、できていないこと/);
    assert.match(second,/- 画風1｜墨と和紙／テーマ：うつ／一言の型：物が語る状態/); // The prior plan appears only as avoidance history.
    assert.match(await a.page.locator('#test-design').textContent(),/画風1｜ネオン管の夜/);
    assert.equal(await a.page.evaluate(()=>experimentPlan().groups.length),0);
    assert.equal(await a.page.locator('#prompt-slug').textContent(),'v004');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);await a.tab('advice');
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    assert.match(await a.page.locator('#prompt-out').inputValue(),/形式: 画風1｜色鉛筆の絵日記/);
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('recorded videos rotate all 21 visual styles before repeating one, and the format table separates them',async()=>{
  const db=baselineFixture(),a=await open(db);
  try {
    const names=await a.page.evaluate(()=>EXPERIMENT_RECIPES.map(r=>r.name));
    assert.equal(names.length,21);
    for(let n=0;n<21;n++){
      const plan=await a.page.evaluate(()=>experimentPlan());
      assert.equal(plan.mode,'explore');assert.equal(plan.format,'画風1｜'+names[n]);
      addExperiment(db,plan.format,45-n,{views:100});
      assert.equal(await a.page.evaluate(()=>loadAll()),true);
    }
    const next=await a.page.evaluate(()=>experimentPlan());
    assert.equal(next.format,'画風2｜墨と和紙');
    assert.match(next.brief,/2回目/);
    // New styles are neither the old text-only videos nor the 10/18〜10/23 exploration.
    const fc=await a.page.evaluate(()=>{const fc=formatCompare();return {txt:fc.txt,exp:fc.exp,sty:fc.sty?.n};});
    assert.equal(fc.txt,null);assert.equal(fc.exp,null);assert.equal(fc.sty,21);
  }finally{await a.context.close();}
});

test('repeated evidence promotes a candidate, with exploration after two consecutive videos',async()=>{
  const db=baselineFixture();
  addExperiment(db,'探索1｜昼の切り絵',15,goodExperiment);
  addExperiment(db,'探索1｜昼の切り絵',14,goodExperiment);
  const a=await open(db);
  try {
    let plan=await a.page.evaluate(()=>experimentPlan());
    assert(plan.groups[0].promising);assert.equal(plan.mode,'explore');
    addExperiment(db,'探索1｜動くことば',12,{views:200});await a.page.evaluate(()=>loadAll());
    plan=await a.page.evaluate(()=>experimentPlan());
    assert.equal(plan.mode,'explore'); // Strong metrics never switch the default mode.
    await a.tab('advice');await a.page.locator('#prompt-mode').selectOption('refine');
    plan=await a.page.evaluate(()=>experimentPlan());
    assert.equal(plan.mode,'refine');assert.equal(plan.format,'探索1｜昼の切り絵');
    const prompt=await a.page.evaluate(()=>buildPrompt().text);
    assert.match(prompt,/今回だけ変えるもの：締めの誘導/);
    assert.match(prompt,/形式: 探索1｜昼の切り絵/);assert.match(prompt,/参考:v/);
    assert.match(await a.page.locator('#test-design').textContent(),/手応えのある型を再検証/);
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    assert.match(await a.page.locator('#prompt-out').inputValue(),/今回：手応えのある型を再検証/);
    await a.page.locator('#prompt-build2').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build2').disabled);
    assert.equal(await a.page.locator('#prompt-mode').inputValue(),'explore');
    assert.match(await a.page.locator('#prompt-out').inputValue(),/今回：毎回ちがう画風で作る/);
    // Once the recent results weaken, old hits do not keep the format selected.
    addExperiment(db,'探索1｜昼の切り絵',10,{views:80});
    addExperiment(db,'探索1｜昼の切り絵',9,{views:90});await a.page.evaluate(()=>loadAll());
    plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.mode,'explore');assert(!plan.groups.find(g=>g.format==='探索1｜昼の切り絵').promising);
  }finally{await a.context.close();}
});

test('one hit, missing auxiliary metrics, and unmatched ages cannot promote a format',async()=>{
  const db=baselineFixture();
  addExperiment(db,'探索1｜昼の切り絵',15,{...goodExperiment,views:9000});
  addExperiment(db,'探索1｜昼の切り絵',14,{views:80});
  addExperiment(db,'探索1｜動くことば',12,{views:5000,avg_watch_sec:null,stayed_pct:null,subs_gained:null});
  addExperiment(db,'探索1｜動くことば',11,{views:6000,avg_watch_sec:null,stayed_pct:null,subs_gained:null});
  addExperiment(db,'探索1｜身近な物のコマ撮り',10,goodExperiment,1);
  addExperiment(db,'探索1｜身近な物のコマ撮り',9,goodExperiment,8);
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.mode,'explore');assert(plan.groups.every(g=>!g.promising));
    assert.equal(plan.groups.find(g=>g.format.endsWith('身近な物のコマ撮り')).summary.n,0);
    assert.equal(plan.groups.find(g=>g.format.endsWith('動くことば')).summary.stayedN,0);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('comparison uses a single age-matched row, preserves zero and excludes old/future data',async()=>{
  const db=baselineFixture();
  const {pid}=addExperiment(db,'探索1｜昼の切り絵',15,{views:0,stayed_pct:0,avg_watch_sec:0,subs_gained:0});
  db.sv_metrics.push({post_id:pid,measured_on:date,views:99999,stayed_pct:99,avg_watch_sec:99,subs_gained:999});
  addExperiment(db,'探索1｜動くことば',120,goodExperiment);
  addExperiment(db,'探索1｜動くことば',119,goodExperiment);
  addExperiment(db,'探索1｜身近な物のコマ撮り',-10,goodExperiment);
  const a=await open(db);
  try {
    const observation=await a.page.evaluate(pid=>experimentObservation(allStats().list.find(s=>s.post?.id===pid)),pid);
    assert.equal(observation.views,0);assert.equal(observation.stayed,0);assert.equal(observation.retention,0);
    const plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.groups.find(g=>g.format.endsWith('動くことば')).summary.n,0);
    assert(!plan.groups.some(g=>g.format.endsWith('身近な物のコマ撮り')));
    assert.equal(plan.mode,'explore');
  }finally{await a.context.close();}
});

test('awaiting measurements does not repeatedly reuse old successful videos',async()=>{
  const db=baselineFixture();
  addExperiment(db,'探索1｜昼の切り絵',15,goodExperiment);
  addExperiment(db,'探索1｜昼の切り絵',14,goodExperiment);
  addExperiment(db,'探索1｜昼の切り絵',2,goodExperiment,0);
  addExperiment(db,'探索1｜昼の切り絵',1,goodExperiment,0);
  addExperiment(db,'探索1｜動くことば',0.5,{views:10},0);
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.mode,'explore');
    assert.equal(plan.groups.find(g=>g.format.endsWith('昼の切り絵')).summary.n,1);
  }finally{await a.context.close();}
});

test('unpublished plans reserve their concept without being counted as performance and custom names are escaped',async()=>{
  const db=baselineFixture();
  const unposted=addExperiment(db,'画風1｜墨と和紙',10,goodExperiment);
  db.sv_posts=db.sv_posts.filter(p=>p.id!==unposted.pid);
  const custom='探索1｜<img src=x onerror=alert(1)>';
  addExperiment(db,custom,9,{views:50});
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan());
    assert.equal(plan.format,'画風1｜ネオン管の夜');
    assert(!plan.groups.some(g=>g.format==='画風1｜墨と和紙'));
    assert.match(await a.page.locator('#test-matrix').textContent(),/探索1｜<img/);
    assert.equal(await a.page.locator('#test-matrix img').count(),0);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});


test('generation rotates 21 distinct visual styles, themes and first-line types without changing published results or saved inputs',async()=>{
  const db=baselineFixture(), before=structuredClone(db), old=strategy('大切な目的');
  old.keep='毎回、夜の窓辺をコードで描く';
  const a=await open(db,{'sv-strategy-v1':JSON.stringify(old),['sv-entry-draft-'+date]:JSON.stringify({'experiment-post-1':{views:'777'}})});
  try {
    const results=[];
    // Exercise the same handler as both UI buttons, with no new video registration.
    for(let n=0;n<25;n++){
      const result=await a.page.evaluate(async()=>{
        const plan=experimentPlan();await showPrompt();
        return {brief:plan.brief,format:plan.format,hook:plan.hook.name,theme:plan.theme,copy:document.querySelector('#prompt-out').value};
      });
      results.push(result);
      assert.match(result.copy,/画風は毎回まったく別のものにし、題材と最初の一言は伸びた回の作り方にそろえます/);
    }
    assert.equal(new Set(results.slice(0,21).map(r=>r.brief)).size,21);
    assert.equal(new Set(results.map(r=>r.format)).size,25);
    assert.equal(results[21].format,'画風2｜墨と和紙');assert.match(results[21].brief,/2回目/);
    for(let n=1;n<25;n++){
      assert.notEqual(results[n].hook,results[n-1].hook);assert.notEqual(results[n].theme,results[n-1].theme);
    }
    const history=await a.page.evaluate(()=>readPromptHistory());
    assert.equal(history.recent.length,24);
    assert.equal(await a.page.locator('#base-keep').inputValue(),old.keep);
    assert.deepEqual(db,before);assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
    assert.equal(await a.page.evaluate(date=>JSON.parse(localStorage.getItem('sv-entry-draft-'+date))['experiment-post-1'].views,date),'777');
  }finally{await a.context.close();}
});

test('failed refresh does not consume an approach and unavailable history storage still advances in memory',async()=>{
  const a=await open(baselineFixture());
  try {
    await a.tab('advice');
    a.flags.failMetrics=true;
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    assert.equal(await a.page.evaluate(()=>readPromptHistory().recent.length),0);
    a.flags.failMetrics=false;
    await a.page.evaluate(()=>{
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='sv-prompt-style-v3')throw new Error('quota');return original.call(this,key,value);};
    });
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    assert.match(await a.page.locator('#prompt-msg').textContent(),/生成履歴を端末に保存できません/);
    const first=await a.page.locator('#prompt-out').inputValue();
    await a.page.locator('#prompt-build2').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build2').disabled);
    const second=await a.page.locator('#prompt-out').inputValue();
    assert.notEqual(second,first);assert.match(second,/形式: 画風1｜ネオン管の夜/);
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('every visual style stays drawable with code: no people, unsafe places or live footage, distinct looks, and render-sized durations',async()=>{
  const a=await open(baselineFixture());
  try {
    const recipes=await a.page.evaluate(()=>EXPERIMENT_RECIPES);
    assert.equal(recipes.length,21);
    for(const key of ['name','look','text']) assert.equal(new Set(recipes.map(r=>r[key])).size,21,key);
    for(const r of recipes){
      for(const key of ['name','seconds','mood','look','palette','text','camera','sound']) assert.ok(r[key],r.name+' '+key);
      const text=[r.name,r.mood,r.look,r.palette,r.text,r.camera,r.sound].join('／');
      assert.doesNotMatch(text,/実写|撮影|人物|人が|顔|手で|手元|手が|駅|線路|踏切|屋上|ベランダ|橋の上|薬|酒|刃物|ロープ|血|点滅|赤い光|ロゴ/,r.name);
      const [,lo,hi]=r.seconds.match(/^(\d+)〜(\d+)秒$/).map(Number);
      assert(lo>=15&&hi<=22,r.name+' '+r.seconds); // 13秒は通らず、長すぎると書き出しが重い
      const brief=await a.page.evaluate(r=>recipeBrief(r,1),r);
      assert.match(brief,/画風：/);assert.match(brief,/文字の見せ方：/);assert.match(brief,/音：/);
    }
    const options=await a.page.locator('#dl-format option').evaluateAll(xs=>xs.map(x=>x.value));
    assert.deepEqual(options,recipes.map(r=>'画風1｜'+r.name));
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('a strong live-action format stays in the comparison but is never chosen for a code-drawn retest',async()=>{
  const db=baselineFixture();
  addExperiment(db,'探索1｜実写・手仕事の接写',15,goodExperiment);
  addExperiment(db,'探索1｜実写・手仕事の接写',14,goodExperiment);
  const a=await open(db);
  try {
    await a.tab('advice');await a.page.locator('#prompt-mode').selectOption('refine');
    const plan=await a.page.evaluate(()=>experimentPlan('refine'));
    const live=plan.groups.find(g=>g.format==='探索1｜実写・手仕事の接写');
    assert(live.promising);assert.equal(live.reproducible,false);
    assert.equal(plan.mode,'explore');assert.match(plan.reason,/再検証候補がない/);
    assert.match(await a.page.locator('#test-matrix').textContent(),/実写の回のため、コードで描く制作では再検証しない/);
    const prompt=await a.page.evaluate(()=>buildPrompt(experimentPlan('refine')).text);
    assert.match(prompt,/今回：毎回ちがう画風で作る/);
    assert.match(prompt,/実写・動画生成向けの案があっても、今回は下の「作れる範囲」の作り方で作ります/);
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

const dayAgoJst = days => new Date(Date.now()-days*864e5).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
function studyFixture(){
  const db=experimentFixture();
  for(const age of [40,32,20]) addExperiment(db,'導入前',age,{stayed_pct:50,avg_watch_sec:16,subs_gained:1,likes:10});
  for(const age of [12,10,7]){
    const {id}=addExperiment(db,'実写テスト',age,{stayed_pct:70,avg_watch_sec:8,subs_gained:2,likes:20});
    db.sv_videos.find(v=>v.id===id).note='【制作手法:Seedance】\n残したい制作メモ';
  }
  return db;
}
const studyStrategy = () => ({...strategy('冒頭と視聴時間を比べる'),videoStudy:{beforeEnd:dayAgoJst(15),beforeStayed:'99',start:dayAgoJst(14)}});

test('stayed input derives swipe complement, preserves zero and only saves the existing metric',async()=>{
  const db=fixture(),a=await open(db);
  try {
    await a.tab('entry');
    for(const [value,expected] of [['0','100.0%'],['100','0.0%'],['61.5','38.5%'],['','—']]){
      await fillMetric(a.page,'post-1','stayed_pct',value);
      assert((await a.page.locator('[data-swipe-post="post-1"]').textContent()).includes(expected));
    }
    await fillMetric(a.page,'post-1','stayed_pct','101');await saveEntries(a.page);
    assert.equal(a.writes.length,0);assert.match(await a.page.locator('#entry-msg').textContent(),/数字または保存先/);
    await fillMetric(a.page,'post-1','stayed_pct','0');await saveEntries(a.page);
    assert.equal(db.sv_metrics[0].stayed_pct,0);
    const saved=a.writes.find(x=>x.table==='sv_metrics').body[0];
    assert.deepEqual(Object.keys(saved).sort(),['measured_on','post_id','stayed_pct']);
    assert.equal(db.sv_metrics[0].views,100);assert.equal(db.sv_metrics[0].likes,5);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('legacy schema without stayed still loads and keeps the other input fields',async()=>{
  const a=await open(fixture());
  try {
    a.flags.missingStayed=true;assert.equal(await a.page.evaluate(()=>loadAll()),true);
    assert.equal(await a.page.locator('[data-metric="stayed_pct"]').count(),0);
    assert.match(await a.page.locator('#setup-warn').textContent(),/youtube-hook.sql/);
    assert.equal(await a.page.evaluate(()=>allStats().list[0].stayed),null);
    await a.tab('entry');await fillMetric(a.page,'post-1','likes','7');await saveEntries(a.page);
    assert.match(await a.page.locator('#entry-msg').textContent(),/保存と読み直し/);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('28-day baseline settings preserve legacy strategy, sync to another browser and reject overlapping dates',async()=>{
  const db=fixture(),old={...strategy('保存済みの目的'),customLegacy:'消さない'},a=await open(db,{'sv-strategy-v1':JSON.stringify(old)});
  try {
    await a.tab('base');
    await a.page.locator('#study-before-end').fill(dayAgoJst(15));
    await a.page.locator('#study-before-stayed').fill('0');
    await a.page.locator('#study-start').fill(dayAgoJst(14));
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);await a.tab('base');
    assert.equal(await a.page.locator('#study-before-stayed').inputValue(),'0');
    await a.page.locator('#base-save').click();await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/保存と読み直し/);
    const saved=JSON.parse(db.sv_config[0].value);
    assert.equal(saved.customLegacy,'消さない');assert.equal(saved.keep,old.keep);assert.equal(saved.videoStudy.beforeStayed,'0');
    const b=await open(db);
    try { assert.equal(await b.page.locator('#study-before-stayed').inputValue(),'0');assert.equal(await b.page.locator('#base-purpose').inputValue(),old.purpose); }
    finally { await b.context.close(); }
    const before=db.sv_config[0].value;
    await a.page.locator('#study-start').fill(dayAgoJst(16));
    await a.page.locator('#base-save').click();await a.page.waitForFunction(()=>!document.querySelector('#base-save').disabled);
    assert.match(await a.page.locator('#base-msg').textContent(),/終了日より後/);assert.equal(db.sv_config[0].value,before);
  }finally{await a.context.close();}
});

test('production method is saved with the original note and never inferred from format or date',async()=>{
  const db=studyFixture(),a=await open(db);
  try {
    await a.page.evaluate(()=>openVideo('experiment-1'));
    await a.page.locator('#video-modal summary').click();
    await a.page.locator('#vm-note').fill('大事なメモ\n2行目');await a.page.locator('#vm-method').selectOption('seedance');
    await a.page.locator('#vm-save').click();await a.page.waitForFunction(()=>!document.querySelector('#vm-save').disabled);
    await a.page.waitForFunction(()=>document.querySelector('#video-modal').classList.contains('hidden'));
    assert.equal(db.sv_videos[0].note,'【制作手法:Seedance】\n大事なメモ\n2行目');
    await a.page.evaluate(()=>openVideo('experiment-1'));
    assert.equal(await a.page.locator('#vm-method').inputValue(),'seedance');
    assert.equal(await a.page.locator('#vm-note').inputValue(),'大事なメモ\n2行目');
    await a.page.locator('#vm-method').selectOption('other');await a.page.locator('#vm-save').click();
    await a.page.waitForFunction(()=>document.querySelector('#video-modal').classList.contains('hidden'));
    assert.equal(db.sv_videos[0].note,'【制作手法:その他】\n大事なメモ\n2行目');
    assert.equal(await a.page.evaluate(()=>productionMethod({format:'Seedance',note:'Seedanceを検討中'})),'unknown');
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('before and after compare age-matched video medians separately from the Studio baseline',async()=>{
  const db=studyFixture();
  addExperiment(db,'手法未記録',8,{stayed_pct:1});
  const pending=addExperiment(db,'Seedance結果待ち',1,{},0);
  db.sv_videos.find(v=>v.id===pending.id).note='【制作手法:Seedance】';
  addExperiment(db,'期間外',70,{stayed_pct:99});addExperiment(db,'未来',-1,{stayed_pct:99});
  db.sv_metrics.push({post_id:'experiment-post-6',measured_on:dayAgoJst(0),views:999999,stayed_pct:1,avg_watch_sec:100});
  const a=await open(db,{'sv-strategy-v1':JSON.stringify(studyStrategy())});
  try {
    const result=await a.page.evaluate(()=>{
      const c=studyComparison();return {before:c.before,after:c.after,excluded:c.excluded,diagnosis:studyDiagnosis(c)};
    });
    assert.equal(result.before.summary.n,3);assert.equal(result.after.summary.n,3);
    assert.equal(result.before.summary.stayed,50);assert.equal(result.after.summary.stayed,70);
    assert.equal(result.after.summary.retention,40);assert.equal(result.after.summary.watch,8);
    assert.equal(result.after.summary.likeRate,4);assert.equal(result.after.summary.subRate,4);
    assert.equal(result.excluded,1);assert.equal(result.after.pending,1);assert.match(result.diagnosis,/パターンB/);
    const html=await a.page.locator('#seedance-comparison').textContent();
    assert.match(html,/99.0%/);assert.match(html,/20.0ポイント/);assert.match(html,/暫定/);
    const prompt=await a.page.evaluate(()=>buildPrompt().text);
    assert.match(prompt,/優先順位：1. 視聴を継続/);assert.match(prompt,/冒頭0〜5秒/);assert.match(prompt,/パターンB/);
    assert.match(prompt,/平均再生率は完走率ではありません/);assert.match(prompt,/Studio参考値/);
    for(const m of db.sv_metrics.filter(m=>['experiment-post-4','experiment-post-5','experiment-post-6'].includes(m.post_id))) m.stayed_pct=40;
    await a.page.evaluate(()=>loadAll());assert.match(await a.page.evaluate(()=>studyDiagnosis(studyComparison())),/パターンA/);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('KPI diagnostics wait for paired samples, keep missing values distinct and allow replay above 100%',async()=>{
  const db=studyFixture();
  db.sv_metrics[3].avg_watch_sec=null;db.sv_metrics[4].stayed_pct=null;
  db.sv_metrics[5].avg_watch_sec=30;db.sv_metrics[5].subs_gained=0;db.sv_metrics[5].likes=0;
  const a=await open(db,{'sv-strategy-v1':JSON.stringify(studyStrategy())});
  try {
    const result=await a.page.evaluate(()=>{const c=studyComparison();return {summary:c.after.summary,diagnosis:studyDiagnosis(c),obs:c.after.rows.find(o=>o.s.v.id==='experiment-6')};});
    assert.equal(result.summary.stayedN,2);assert.equal(result.summary.retentionN,2);
    assert.match(result.diagnosis,/判断保留/);assert.equal(result.obs.retention,150);
    assert.equal(result.obs.subRate,0);assert.equal(result.obs.likeRate,0);
    db.sv_metrics[5].views=0;await a.page.evaluate(()=>loadAll());
    const o=await a.page.evaluate(()=>studyComparison().after.rows.find(o=>o.s.v.id==='experiment-6'));
    assert.equal(o.subRate,null);assert.equal(o.likeRate,null);assert.equal(o.views,0);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('retest prioritizes continued viewing without a view-count gate, but never treats missing hook data as zero',async()=>{
  const db=baselineFixture();
  addExperiment(db,'探索1｜机の上の接写',15,{views:200,stayed_pct:60});
  addExperiment(db,'探索1｜机の上の接写',14,{views:200,stayed_pct:60});
  addExperiment(db,'探索1｜別の画風',12,{views:500,stayed_pct:40});
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.mode,'refine');assert(plan.candidate.summary.views<plan.candidate.baseline.views);
    assert.match(plan.reason,/視聴継続中央値/);assert.equal(await a.page.evaluate(()=>experimentPlan().mode),'explore');
    db.sv_metrics.filter(m=>['experiment-post-4','experiment-post-5'].includes(m.post_id)).forEach(m=>m.stayed_pct=null);
    await a.page.evaluate(()=>loadAll());assert.equal(await a.page.evaluate(()=>experimentPlan('refine').mode),'explore');
  }finally{await a.context.close();}
});

function setVideo(db,id,fields){Object.assign(db.sv_videos.find(v=>v.id===id),fields);}

test('first line follows the strongest recent themes, rotates first-line types and quotes real high and low titles',async()=>{
  const db=experimentFixture();
  const add=(title,theme,views,daysAgo,extra={})=>{const {id}=addExperiment(db,'映像＋テロップ（窓と灯り）',daysAgo,{views});setVideo(db,id,{title,theme,...extra});};
  add('淹れたお茶が、また冷めている。 #ショート #うつ','うつ',1054,30);
  add('流しに、三日ぶんのお皿がある。 #ショート #うつ','うつ',915,28);
  add('3時12分、また目が覚めた。 #ショート #不眠','不眠',1030,26);
  add('眠れない夜は、窓の前にいる。 #ショート #不眠','不眠',1053,24);
  add('風に飛ばされた落ち葉が、知らない本屋の軒先で止まった。 #ショート','日常',110,22);
  add('最後の綿毛がひとつ、知らない野原に降りた。 #ショート','日常',251,20);
  add('今日、声を出したのは一回だけ。 #ショート #孤独','孤独',1001,18,{hook_type:'数字で言い切る'});
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan());
    // 孤独 has a single video, so it is not ranked; the last two posted themes are not repeated.
    assert.deepEqual(plan.themes.map(t=>t.theme),['不眠','うつ','日常']);
    assert.equal(plan.theme,'不眠');assert.equal(plan.hook.name,'物が語る状態');
    const prompt=await a.page.evaluate(()=>buildPrompt().text);
    assert.match(prompt,/今回のテーマ：不眠。直近120日で再生の中央値が高いテーマ：不眠 1,042回（2本）／うつ 985回（2本）／日常 181回（2本）/);
    assert.match(prompt,/再生が多かった題名（投稿から2日以降の記録）：\n  「淹れたお茶が、また冷めている。」1,054回\n  「眠れない夜は、窓の前にいる。」1,053回/);
    assert.match(prompt,/再生が少なかった題名：\n  「風に飛ばされた落ち葉が、知らない本屋の軒先で止まった。」110回/);
    assert.doesNotMatch(prompt.slice(prompt.indexOf('再生が多かった題名'),prompt.indexOf('## 今回：')),/#ショート/); // hashtags are stripped from the examples
    assert.match(prompt,/テーマ: 不眠 ／ 冒頭の掴み: 物が語る状態/);
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const next=await a.page.evaluate(()=>experimentPlan());
    assert.equal(next.theme,'うつ');assert.equal(next.hook.name,'時刻と、できていないこと');
    assert.match(await a.page.locator('#test-design').textContent(),/テーマ：不眠 ／ 最初の一言の型：物が語る状態/); // the plan that was just generated
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('a retest keeps the reference theme and first-line type unless the first line is the variable',async()=>{
  const db=baselineFixture();
  for(const age of [15,14]){const {id}=addExperiment(db,'画風1｜墨と和紙',age,goodExperiment);setVideo(db,id,{theme:'孤独',hook_type:'数字で言い切る'});}
  addExperiment(db,'画風1｜ネオン管の夜',12,{views:200});
  const a=await open(db);
  try {
    let plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.mode,'refine');assert.equal(plan.format,'画風1｜墨と和紙');assert.equal(plan.axis,'締めの誘導');
    assert.equal(plan.theme,'孤独');assert.equal(plan.hook.name,'数字で言い切る');
    const prompt=await a.page.evaluate(()=>buildPrompt(experimentPlan('refine')).text);
    assert.match(prompt,/水墨画/);assert.match(prompt,/参考にする回と同じテーマです/);
    assert.match(prompt,/今回だけ変えるもの：締めの誘導/);assert.doesNotMatch(prompt,/サムネイル1枚で別のチャンネル/);
    const {id}=addExperiment(db,'画風1｜墨と和紙',13,goodExperiment);setVideo(db,id,{theme:'孤独',hook_type:'数字で言い切る'});
    await a.page.evaluate(()=>loadAll());
    plan=await a.page.evaluate(()=>experimentPlan('refine'));
    assert.equal(plan.axis,'冒頭の掴み');assert.equal(plan.theme,'孤独');assert.notEqual(plan.hook.name,'数字で言い切る');
    // A retest does not consume the next style in the rotation.
    await a.page.evaluate(()=>rememberPrompt(experimentPlan('refine')));
    assert.equal(await a.page.evaluate(()=>readPromptHistory().rounds['墨と和紙']),undefined);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});
