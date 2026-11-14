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
// Most tests check the code-only prompt, so they pin the opening setting to "code".
// The GIF-opening tests pass their own value, or null to leave the setting unsaved (the default is "auto").
async function open(db, storage={}) {
  storage = {'sv-opening-v2':'code', ...storage};
  const context = await browser.newContext();
  const flags = {failMetrics:false, failWrites:false, nullVerification:false, nullSubs:false, pauseWrite:null, pageSize:1000, participation:null};
  const writes = [], errors = [], reads=[];
  await context.addInitScript(({token,user,storage})=>{
    if (!sessionStorage.getItem('test-seeded')) {
      localStorage.setItem('sb-qnmzjwgacnfxwlbgwxcr-auth-token',JSON.stringify({access_token:token,refresh_token:'test',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,user}));
      for(const [key,value] of Object.entries(storage)) if(value!=null) localStorage.setItem(key,value);
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
    // The site's participation.sql: answers only when a test provides a summary, otherwise "not installed".
    if(url.pathname.endsWith('/rpc/participation_summary')) return flags.participation ? send(flags.participation) : send({code:'PGRST202',message:'Could not find the function'},404);
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

test('new prompt picks a new pattern and visual style each time, keeps deliverables and tracking, and makes no writes',async()=>{
  const db=baselineFixture(),a=await open(db);
  try {
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const first=await a.page.locator('#prompt-out').inputValue();
    const one=await a.page.evaluate(()=>readPromptHistory().recent.at(-1));
    assert.match(one.code,/^T\d{3}-A\d-N\d-S1$/); // code-drawn videos never show people
    assert.ok(first.includes(`## 今回の型（型番 ${one.code}）`));
    assert.match(first,/## 今回の画風：墨と和紙（毎回ちがう型で作る）/);
    assert.match(first,/形式: 画風1｜墨と和紙/);
    assert.match(first,/水墨画/);assert.match(first,/サムネイル1枚で別のチャンネルに見える/);
    // Why the pattern changes every time: the measured repetition, stated with its date.
    assert.match(first,/2026-11-12の確認（チャンネルの全171本の題名と再生数）/);assert.match(first,/うつ15本・不眠13本・孤独15本/);
    assert.match(first,/型は検証のためのものです。指定された型を、別のものに取り替えないでください/);
    for(const label of ['テーマ：','題材：','切り口：','最初の一言の型：','展開の型：','締めの型：','画風：墨と和紙','写るもの：物と光だけ']) assert.ok(first.includes('- '+label),label);
    // The first line is still the priority: a relatable action with a hook, not a description of scenery.
    assert.match(first,/## いちばん大事なこと：最初の一言（0〜3秒）/);
    assert.ok(first.includes(`今回のテーマ：${one.theme}。`));assert.ok(first.includes(`今回の一言の型：${one.hook}。`));
    assert.match(first,/景色や物のきれいさの描写だけ/);assert.match(first,/5点で採点/);
    assert.match(first,/ここ1か月でくり返した物（カーテン・枕・時計/);
    assert.match(first,/## 構成（今回の展開と締め）/);assert.ok(first.includes(`締めの型「${one.ending}」`));
    assert.match(first,/窓と灯り：3本・再生の中央値500回/);
    assert.match(first,/過去の題名（新しい順・3本）/);
    // The record line carries the whole pattern, ready to paste into the video form.
    assert.ok(first.includes(`識別子: v004 ／ 型番: ${one.code} ／ テーマ: ${one.theme} ／ 冒頭の掴み: ${one.hook} ／ 音: ___ ／ 形式: 画風1｜墨と和紙 ／ 尺: ___（実測秒）／ 締め: ${one.ending} ／`));
    assert.match(first,/今回変えたもの: 型の探索 ／ 制作手法: その他 ／ メモ: 毎回ちがう型で作る・題材「/);
    // The prompt must stay within what Claude/Codex can render with code alone.
    assert.match(first,/Python（numpy・Pillow）で1フレームずつ画を描き、ffmpeg で mp4/);
    assert.match(first,/動画生成AI・画像生成AI・実写の素材は使いません/);
    assert.match(first,/音も numpy で合成/);assert.match(first,/フレームはPNGに保存せず/);
    assert.match(first,/自己点検 8\/8 通過/);assert.match(first,/冒頭0.2秒の平均の音量/);
    assert.match(first,/人物・顔・手は描きません/);assert.match(first,/日本語フォントがない場合だけ/);
    assert.doesNotMatch(first,/実写映像に限りなく近い|実写動画素材と編集環境|動画生成または実写素材の編集で実現|コード描画への無断の代替|図形・SVG・Canvasによる風景|Seedance等の動画生成を利用できる場合/);
    assert.doesNotMatch(first,/ChatGPTに頼む素材|素材の使い方|```/);
    assert.match(first,/音入りのmp4を1本/);assert.match(first,/固定コメントは別に出しません/);
    assert.ok(first.includes("https://hoshinoumi.org/?utm_source=youtube&utm_medium=short&utm_content=v004"));
    assert.doesNotMatch(first,/全体17秒|場所はひとつ。暗い自分の部屋|形式: 映像＋テロップ（窓と灯り）|画の答えは、自分のスタンド|少なくとも4項目/);
    await a.page.locator('#prompt-build2').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build2').disabled);
    const second=await a.page.locator('#prompt-out').inputValue();
    const two=await a.page.evaluate(()=>readPromptHistory().recent.at(-1));
    assert.notEqual(second,first);
    assert.match(second,/形式: 画風1｜ネオン管の夜/);assert.doesNotMatch(second,/水墨画/);
    assert.notEqual(two.code.slice(0,4),one.code.slice(0,4));assert.notEqual(two.theme,one.theme);assert.notEqual(two.hook,one.hook);assert.notEqual(two.ending,one.ending);
    assert.ok(second.includes(`- 画風1｜墨と和紙／型番：${one.code}／テーマ：${one.theme}／一言の型：${one.hook}`)); // The prior plan appears only as avoidance history.
    assert.match(await a.page.locator('#test-design').textContent(),/画風1｜ネオン管の夜/);
    assert.ok((await a.page.locator('#test-design').textContent()).includes('型番 '+two.code));
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
    assert.match(await a.page.locator('#prompt-out').inputValue(),/（手応えのある型を再検証）/);
    await a.page.locator('#prompt-build2').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build2').disabled);
    assert.equal(await a.page.locator('#prompt-mode').inputValue(),'explore');
    assert.match(await a.page.locator('#prompt-out').inputValue(),/（毎回ちがう型で作る）/);
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


test('generation rotates 21 distinct visual styles and never repeats a theme, first-line type or topic in a row, without changing published results or saved inputs',async()=>{
  const db=baselineFixture(), before=structuredClone(db), old=strategy('大切な目的');
  old.keep='毎回、夜の窓辺をコードで描く';
  const a=await open(db,{'sv-strategy-v1':JSON.stringify(old),['sv-entry-draft-'+date]:JSON.stringify({'experiment-post-1':{views:'777'}})});
  try {
    const results=[];
    // Exercise the same handler as both UI buttons, with no new video registration.
    for(let n=0;n<25;n++){
      const result=await a.page.evaluate(async()=>{
        const plan=experimentPlan();await showPrompt();
        return {brief:plan.brief,format:plan.format,hook:plan.hook.name,theme:plan.theme,code:plan.pattern.code,ending:plan.pattern.ending.name,copy:document.querySelector('#prompt-out').value};
      });
      results.push(result);
      assert.match(result.copy,/毎回ちがう組み合わせ（型）にします/);
      assert.ok(result.copy.includes('型番: '+result.code+' ／'));
    }
    assert.equal(new Set(results.slice(0,21).map(r=>r.brief)).size,21);
    assert.equal(new Set(results.map(r=>r.format)).size,25);
    assert.equal(results[21].format,'画風2｜墨と和紙');assert.match(results[21].brief,/2回目/);
    assert.equal(new Set(results.map(r=>r.code.slice(0,4))).size,25,'every topic is new');
    assert.equal(new Set(results.slice(0,20).map(r=>r.theme)).size,20,'all 20 themes are used before one repeats');
    for(let n=1;n<25;n++){
      assert.notEqual(results[n].hook,results[n-1].hook);assert.notEqual(results[n].theme,results[n-1].theme);assert.notEqual(results[n].ending,results[n-1].ending);
      if(n>1) assert.notEqual(results[n].theme,results[n-2].theme);
    }
    const history=await a.page.evaluate(()=>readPromptHistory());
    assert.equal(history.recent.length,25);
    assert.equal(await a.page.locator('#base-keep').inputValue(),old.keep);
    assert.deepEqual(db,before);assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
    assert.equal(await a.page.evaluate(date=>JSON.parse(localStorage.getItem('sv-entry-draft-'+date))['experiment-post-1'].views,date),'777');
  }finally{await a.context.close();}
});

test('the pattern catalog is safe and well formed, and 160 generations use every topic once with balanced, unpaired levels',async()=>{
  const a=await open(baselineFixture(),{'sv-opening-v2':null});
  try {
    const c=await a.page.evaluate(()=>({themes:TOPIC_THEMES,topics:TOPICS,angles:ANGLES,narr:NARRATIVES,endings:ENDINGS,subjects:SUBJECTS,hooks:HOOK_TYPES,count:PATTERN_COUNT}));
    assert.equal(c.themes.length,20);assert.equal(c.topics.length,160);
    assert.equal(new Set(c.topics.map(t=>t.id)).size,160);assert.equal(new Set(c.topics.map(t=>t.seed)).size,160);
    assert.equal(c.topics[0].id,11);assert.equal(c.topics.at(-1).id,208); // ids are recorded: theme number ×10 + topic number
    assert.equal(c.hooks.length,12);assert.equal(c.angles.length,8);assert.equal(c.narr.length,8);assert.equal(c.endings.length,6);assert.equal(c.subjects.length,4);
    assert.ok(c.count>=1000);
    for(const key of ['angles','narr','endings','subjects','hooks']){
      assert.equal(new Set(c[key].map(x=>x.name)).size,c[key].length,key);
      for(const x of c[key]) assert.ok(x.name&&x.how,key+' '+x.name);
    }
    // Topics are lived situations; nothing that could hurt someone watching on their worst night.
    for(const t of c.topics){
      assert.ok(t.theme&&t.tag&&t.area&&t.seed.length>=8&&t.seed.length<=40,t.seed);
      assert.doesNotMatch(t.seed,/薬|酒|刃物|ロープ|血|死|自傷|切る跡|飛び|屋上|ベランダ|線路|踏切|ホーム|吐|痩せ|体重/,t.seed);
    }
    for(const s of c.subjects) assert.match(s.ask,/顔|写さないでください/,s.name);
    assert.deepEqual(await a.page.evaluate(()=>[decodePattern('T011-A3-N2-S1')?.topic.seed,decodePattern('【型:T208-A8-N8-S4】メモ')?.code,decodePattern('T999-A1-N1-S1'),decodePattern('T011-A9-N1-S1'),decodePattern('メモだけ')]),
      [c.topics[0].seed,'T208-A8-N8-S4',null,null,null]);
    assert.deepEqual(await a.page.evaluate(()=>[withPattern('古いメモ','T011-A3-N2-S1'),withPattern('【型:T011-A1-N1-S1】 書き直し','T012-A3-N2-S1'),withPattern('そのまま','こわれた型番')]),
      ['【型:T011-A3-N2-S1】 古いメモ','【型:T012-A3-N2-S1】 書き直し','そのまま']);
    const rows=await a.page.evaluate(()=>{
      const out=[];
      for(let n=0;n<160;n++){const plan=experimentPlan('explore','photo');rememberPrompt(plan);
        const p=plan.pattern;out.push({topic:p.topic.id,theme:p.topic.theme,angle:p.angle.id,narr:p.narr.id,subj:p.subj.id,hook:p.hook.name,ending:p.ending.name,format:plan.format});}
      return out;
    });
    const tally=key=>{const m=new Map();rows.forEach(r=>m.set(r[key],(m.get(r[key])||0)+1));return [...m.values()];};
    assert.equal(new Set(rows.map(r=>r.topic)).size,160,'every topic is used once before any repeats');
    assert.deepEqual(tally('theme'),Array(20).fill(8));
    assert.deepEqual(tally('angle'),Array(8).fill(20));assert.deepEqual(tally('narr'),Array(8).fill(20));{const t=tally('subj');assert.equal(t.length,4);assert.ok(Math.max(...t)-Math.min(...t)<=1,'subj '+t);}
    // A first line about the body is never paired with a picture that shows no body (2026-11-14: v211).
    assert.equal(rows.filter(r=>r.hook==='からだの感覚').length>=13,true);assert.equal(rows.some(r=>r.hook==='からだの感覚'&&r.subj===1),false);
    assert.equal(await a.page.evaluate(()=>HOOK_TYPES.filter(h=>h.body).map(h=>h.name).join()),'からだの感覚');
    assert.equal(await a.page.evaluate(()=>choosePattern({recent:[]},{photo:false}).subj.id),1); // drawn rounds never show people, whatever the first line
    for(const key of ['hook','ending']){const t=tally(key);assert.ok(Math.max(...t)-Math.min(...t)<=1,key+' '+t);}
    assert.equal(tally('hook').length,12);assert.equal(tally('ending').length,6);
    for(let n=2;n<160;n++) assert.ok(rows[n].theme!==rows[n-1].theme&&rows[n].theme!==rows[n-2].theme,'theme repeats at '+n);
    // Levels must not travel in fixed pairs, or their effects could never be told apart.
    const pairs=(x,y)=>new Set(rows.map(r=>r[x]+'|'+r[y])).size;
    assert.ok(pairs('angle','narr')>=40,'angle×narr '+pairs('angle','narr'));
    assert.ok(pairs('angle','subj')>=28,'angle×subj '+pairs('angle','subj'));
    assert.ok(pairs('hook','ending')>=50,'hook×ending '+pairs('hook','ending'));
    assert.equal(new Set(rows.slice(0,15).map(r=>r.format)).size,15);assert.match(rows[0].format,/^写真1｜/);assert.match(rows[15].format,/^写真2｜/);
    // The 161st video starts the second lap of topics instead of failing.
    const again=await a.page.evaluate(()=>experimentPlan('explore','photo').pattern);
    assert.equal(again.tried,160);assert.equal(again.topicsUsed,160);assert.ok(again.topic.id>=11);
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
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
      Storage.prototype.setItem=function(key,value){if(key==='sv-prompt-style-v4')throw new Error('quota');return original.call(this,key,value);};
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
    assert.deepEqual(options,[...(await a.page.evaluate(()=>PHOTO_RECIPES.map(r=>'写真1｜'+r.name))),...recipes.map(r=>'画風1｜'+r.name)]);
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
    assert.match(prompt,/（毎回ちがう型で作る）/);
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
    await a.page.waitForFunction(()=>state.videos.some(v=>v.id==='experiment-1'&&/^【制作手法:Seedance】/.test(v.note||''))); // the modal closes before the saved row is read back
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

test('themes are spread across the catalog instead of following past winners, and real high and low titles are quoted',async()=>{
  const db=experimentFixture();
  const add=(title,theme,views,daysAgo,extra={})=>{const {id}=addExperiment(db,'映像＋テロップ（窓と灯り）',daysAgo,{views});setVideo(db,id,{title,theme,...extra});};
  add('淹れたお茶が、また冷めている。 #ショート #うつ','うつ',1054,30);
  add('流しに、三日ぶんのお皿がある。 #ショート #うつ','うつ',915,28);
  add('3時12分、また目が覚めた。 #ショート #不眠','不眠',1030,26);
  add('眠れない夜は、窓の前にいる。 #ショート #不眠','不眠',1053,24);
  add('風に飛ばされた落ち葉が、知らない本屋の軒先で止まった。 #ショート','日常',110,22);
  add('最後の綿毛がひとつ、知らない野原に降りた。 #ショート','日常',251,20);
  add('今日、声を出したのは一回だけ。 #ショート #孤独','孤独',1001,18,{hook_type:'数字で言い切る'});
  add('星と海 #ショート #精神障害','',2159,90); // the early untitled videos are not listed as titles
  const a=await open(db);
  try {
    const plan=await a.page.evaluate(()=>experimentPlan());
    // The ranking is shown for reference only (孤独 has a single video, so it is not ranked).
    assert.deepEqual(plan.themes.map(t=>t.theme),['不眠','うつ','日常']);
    // Old videos carry no pattern code, so they do not push the choice toward or away from any theme.
    assert.equal(plan.pattern.tried,0);assert.equal(plan.pattern.topicsUsed,0);
    const prompt=await a.page.evaluate(()=>buildPrompt().text);
    assert.ok(prompt.includes(`今回のテーマ：${plan.theme}。テーマは20個を順にまわし、直前の2本と同じテーマは続けません`));
    assert.match(prompt,/参考（直近120日のテーマ別の再生の中央値。次のテーマは、これでは決めません）：不眠 1,042回（2本）／うつ 985回（2本）／日常 181回（2本）/);
    assert.match(prompt,/再生が多かった題名（投稿から2日以降の記録）：\n  「星と海」2,159回\n  「淹れたお茶が、また冷めている。」1,054回/);
    assert.match(prompt,/再生が少なかった題名：\n  「風に飛ばされた落ち葉が、知らない本屋の軒先で止まった。」110回/);
    assert.doesNotMatch(prompt.slice(prompt.indexOf('再生が多かった題名'),prompt.indexOf('## 今回の画風')),/#ショート/); // hashtags are stripped from the examples
    // Every earlier title is handed over so the same action, object or phrasing is not repeated.
    assert.match(prompt,/過去の題名（新しい順・7本）。1枚目の一言と題名は、このどれとも同じ行動・同じ物・同じ言い回しにしないでください：\n  今日、声を出したのは一回だけ。／最後の綿毛がひとつ、知らない野原に降りた。／/);
    assert.doesNotMatch(prompt.slice(prompt.indexOf('過去の題名（新しい順'),prompt.indexOf('## 最優先KPI')),/#ショート|星と海／|／星と海/);
    assert.ok(prompt.includes(`テーマ: ${plan.theme} ／ 冒頭の掴み: ${plan.hook.name} ／`));
    assert.ok(prompt.includes(`#${plan.pattern.topic.tag} を入れる`));
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const next=await a.page.evaluate(()=>experimentPlan());
    assert.notEqual(next.theme,plan.theme);assert.notEqual(next.hook.name,plan.hook.name);assert.equal(next.pattern.tried,1);
    assert.ok((await a.page.locator('#test-design').textContent()).includes(`テーマ：${plan.theme} ／ 題材：${plan.pattern.topic.seed}`)); // the plan that was just generated
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

/* 実写の素材（ChatGPT の実写の画像とGIF）で作る回（2026-11-12〜）。 */
const gifNote = '【制作手法:ChatGPT GIF】\n冒頭:ChatGPTのGIF';
const photoNote = '【制作手法:ChatGPT 実写】\n素材:GIF2・写真2';
function tagMethod(db, id, note){ db.sv_videos.find(v=>v.id===id).note=note; }

test('by default the next video is built from photoreal ChatGPT material: two steps, a paste-ready request for real motion, footage-like handling and nine checks',async()=>{
  const db=baselineFixture(),a=await open(db,{'sv-opening-v2':null,'sv-opening-v1':'code'}); // the old v1 choice is not carried over
  try {
    await a.tab('advice');
    assert.equal(await a.page.locator('#prompt-opening').inputValue(),'photo');
    await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const p=await a.page.locator('#prompt-out').inputValue();
    const one=await a.page.evaluate(()=>readPromptHistory().recent.at(-1));
    // The shooting style replaces the drawn style; the pattern, the first line and tracking stay.
    assert.match(p,/形式: 写真1｜窓辺の自然光/);assert.match(p,/## 今回の撮り方：窓辺の自然光（毎回ちがう型で作る）/);
    assert.match(one.code,/^T\d{3}-A\d-N\d-S[1-4]$/);assert.ok(p.includes(`## 今回の型（型番 ${one.code}）`));
    assert.match(p,/## いちばん大事なこと：最初の一言（0〜3秒）/);
    assert.ok(p.includes('https://hoshinoumi.org/?utm_source=youtube&utm_medium=short&utm_content=v004'));
    // Two steps: decide the first line, write the ChatGPT request and stop; then build the mp4 from the material.
    assert.match(p,/## 今回の進め方（2回に分けます）/);assert.match(p,/ChatGPT（Images 2.6）/);assert.match(p,/実写に見える映像で作ります/);
    assert.match(p,/ChatGPTに渡す指示文を書いて止まってください。mp4・題名・説明文は、まだ作りません/);
    assert.match(p,/素材が1つもないときは作り始めず/);assert.match(p,/素材を受け取るところ以外は途中で聞き返さず/);
    assert.ok(p.indexOf('## いちばん大事なこと')<p.indexOf('## ChatGPTに頼む素材（1回目'),'the first line is decided before the material is requested');
    // Why the earlier GIFs barely moved, and the two things that are now always requested.
    assert.match(p,/これまでのGIFは「絵が少し動くだけ」になっていました（2026-11-12）/);
    assert.match(p,/①実写の写真に見えること ②1コマ目から最後のコマまで続く、はっきりした動きが1つあること/);
    // The request is one fenced block: four pieces of material, photoreal, one clear motion, layout and safety rules.
    assert.equal(p.split('```').length,3);
    const block=p.slice(p.indexOf('```')+3,p.lastIndexOf('```'));
    assert.match(block,/^\n縦長のショート動画に使う素材を4つ、順番に作ってください。素材1と素材4はアニメーションGIF、素材2と素材3は写真（静止画）です。/);
    for(const rule of [/実写の写真に見える画にしてください。イラスト・アニメ・絵画・3DCGの見た目にはしないでください/,/撮り方：昼の窓から入るやわらかい自然光/,/色：白い光と/,/写るもの：/,
      /生活感を出してください/,/HDR風/,/縦長（9:16）/,/上から40〜57%/,/文字・数字・ロゴ・透かし・読める看板・読める画面は入れないでください/,/人の顔は写さないでください/,/点滅/,
      /薬・お酒・刃物・ロープ・血や傷、高い所（屋上・ベランダの手すり・橋の上）・駅のホーム・線路・踏切/,
      /■ 素材1：アニメーションGIF（動画の最初の3〜4秒）/,/動き：【はっきり分かる動きを1つ/,/実際に撮った動画から、コマを順に切り出したように/,/16コマ前後/,/カメラは三脚に固定/,
      /1コマ目から動きが始まり、コマごとに少しずつ進み、最後のコマで動きが終わる/,/同じ画のコマを続けないでください/,/■ 素材2・素材3：写真（静止画）/,/■ 素材4：アニメーションGIF（動画の最後の3〜4秒）/,/「続き」と送ったら/]) assert.match(block,rule);
    assert.doesNotMatch(block,/動くのは、ゆっくり変わるもの1つか2つだけ|カメラは動かさず固定。動くのは/); // the wording that produced barely moving pictures
    const subject=await a.page.evaluate(code=>decodePattern(code).subj,one.code);
    assert.ok(block.includes('写るもの：'+subject.ask));
    // The four pieces come back as one zip named after this video; ChatGPT must not redraw, shrink or fake them, and may hand them over one by one if it cannot zip.
    for(const rule of [/■ 渡し方（4つを1つのzipにまとめてください）/,/zipの名前は v004_sozai\.zip にしてください/,/素材1＝sozai1\.gif、素材2＝sozai2\.png、素材3＝sozai3\.png、素材4＝sozai4\.gif/,
      /作り直し・縮小・減色・コマの間引き・形式の変換はしないでください。GIFを静止画に変えないでください/,/中身を1行ずつ書いてください（ファイル名・縦横の大きさ・GIFはコマ数）/,
      /別の画をコードで描いて代わりに入れたりせず、「zipにできませんでした」と書いて、4つを1つずつダウンロードできる形で/,/4つがそろったところでzipにまとめてください。\n$/]) assert.match(block,rule);
    assert.ok(block.indexOf('■ 素材4')<block.indexOf('■ 渡し方'));
    assert.match(p,/1つのzip（v004_sozai\.zip）にまとめて、この会話に添付します（zipにできなかったときは、1つずつ添付します）/);
    assert.match(p,/「■ 渡し方」は、書き換えずにそのまま入れてください/);assert.match(p,/④「素材のzip（v004_sozai\.zip）ができたら、この会話に添付してください。zipにならなかったときは、4つを1つずつ添付してください。」/);
    // Unpacking is limited to image files and to the work folder; loose attachments still work.
    assert.match(p,/1\. 素材を取り出して確かめます。zipが添付されていたら、新しい作業フォルダに展開します。取り出すのは画像（\.gif \.png \.jpg \.jpeg \.webp）だけ/);
    assert.match(p,/フォルダの部分を外してファイル名だけにします/);assert.match(p,/zipの中のほかのファイルは開かず、実行もしません/);
    assert.match(p,/素材1〜4は sozai1〜sozai4 の名前で決めます。名前がちがうときや、zipではなく1つずつ添付されたときは、内容から判断します/);
    // What the first four photoreal videos showed (2026-11-14), stated as a hypothesis, and the first line matched to who is in the picture.
    assert.match(p,/2026-11-14の確認（19時。チャンネルページの再生数と動画のコマ画像）：実写の素材で作った回は、まだ4本です/);
    assert.match(p,/投稿から2日たっておらず、テーマもちがうので、まだ仮説です/);assert.match(p,/一言の型「からだの感覚」と、人が写らない「物と光だけ」が組み合わさっていたためで、この組み合わせは今後は選びません/);
    if(subject.body){
      assert.ok(p.includes(`今回は「${subject.name}」が写ります。1枚目の一言の行動を、その最中の${subject.body}で見せます。0.0秒のフレームに${subject.body}が写っていて`));
      assert.ok(block.includes(`- 1コマ目から、${subject.body}が画面に入っているようにしてください（あとから画面に入ってくる動きにはしないでください）。`));
      assert.doesNotMatch(p,/今回は人が写りません/);
    }else{
      assert.match(p,/今回は人が写りません。1枚目の一言は、画に写る物の状態か、物に残った行動の跡で言い切ります/);
      assert.doesNotMatch(block,/1コマ目から、.+が画面に入っているようにしてください/);assert.doesNotMatch(p,/が写ります。1枚目の一言の行動を/);
    }
    // Turning flipbook frames and stills into footage: dissolve, steady only what should not move, never leave a photo frozen.
    assert.match(p,/## 素材の使い方（2回目）/);assert.match(p,/ImageSequence/);assert.match(p,/\(1−a\)×いまのコマ＋a×次のコマ/);
    assert.match(p,/全コマの画素ごとの中央値を「動かない背景」とし/);assert.match(p,/平均でならすのは動いていない所だけ/);
    assert.match(p,/止めたまま置きません（スライドショーに見えます）/);assert.match(p,/手持ちのカメラのようなごく小さな揺れ/);
    assert.match(p,/物・家具・人のような形のあるものは描き足しません/);assert.match(p,/4つの素材の色をそろえます/);
    assert.match(p,/最初のコマへ戻すループにはしません/);assert.match(p,/黒や白をはさみません/);
    assert.match(p,/場面にあるはずの環境音/);
    assert.match(p,/添付の素材のほかの動画生成AI・画像生成AI/);assert.match(p,/顔は写しません。コードで人・手・顔を描き足しません/);
    assert.doesNotMatch(p,/動画生成AI・画像生成AI・実写の素材は使いません。作り方は下の「作れる範囲」と「作り方」の章のとおりです|人物・顔・手は描きません|写真のような写実や実写の再現は狙いません/);
    assert.match(p,/自己点検 9\/9 通過/);assert.doesNotMatch(p,/自己点検 8\/8/);assert.match(p,/9\. 全編が添付の素材からできているか/);
    assert.match(p,/制作手法: ChatGPT 実写 ／ メモ: /);assert.match(p,/・素材:GIF___・写真___/);assert.match(p,/「映像の制作手法」は「ChatGPTの実写の画像とGIF」になります/);
    assert.match(p,/実写の回とコードだけの回の比較（投稿72〜120時間後の動画別中央値）/);
    // The page shows the extra steps and how this video is made.
    assert.equal(await a.page.locator('#prompt-gif-steps').isVisible(),true);
    assert.equal(await a.page.locator('#prompt-zip-name').textContent(),'v004_sozai.zip');
    assert.match(await a.page.locator('#prompt-gif-steps').textContent(),/zip を解凍せずに、Claude の同じ会話に添付して送る/);
    assert.equal(await a.page.evaluate(()=>materialZipName('v9/../<img src=x>')),'v9imgsrcx_sozai.zip');
    // Every choice of who is in the picture gets its own first-line rule; only the object-only rounds are told to speak about the object.
    const bySubject=await a.page.evaluate(()=>SUBJECTS.map(subj=>{const plan=experimentPlan('explore','photo');plan.pattern={...plan.pattern,subj};return {id:subj.id,body:subj.body||null,text:buildPrompt(plan).text};}));
    assert.deepEqual(bySubject.map(x=>!!x.body),[false,true,true,true]);
    for(const x of bySubject){
      assert.equal(/今回は人が写りません/.test(x.text),!x.body,'S'+x.id);
      assert.equal(/1コマ目から、(手|後ろ姿（頭や肩）|足)が画面に入っているようにしてください/.test(x.text),!!x.body,'S'+x.id);
      assert.equal(x.text.split('```').length,3,'S'+x.id);
    }
    assert.match(await a.page.locator('#prompt-msg').textContent(),/作り方：ChatGPTの実写の画像とGIF/);
    assert.match(await a.page.locator('#test-design').textContent(),/ChatGPTの実写の画像とGIFで作る/);
    // Choosing "code" goes back to the code-only prompt with the drawn styles, and is remembered.
    await a.page.locator('#prompt-opening').selectOption('code');
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const code=await a.page.locator('#prompt-out').inputValue();
    assert.match(code,/自己点検 8\/8 通過/);assert.doesNotMatch(code,/## ChatGPTに頼む素材|## 素材の使い方|```/);
    assert.doesNotMatch(code,/sozai|_sozai\.zip|今回は人が写りません|が写ります。1枚目の一言の行動を/);
    assert.match(code,/形式: 画風1｜墨と和紙/);assert.match(code,/写るもの：物と光だけ/);assert.match(code,/制作手法: その他 ／/);
    assert.match(code,/「映像の制作手法」は「コードだけ（GIF・Seedanceなし）」になります/);
    assert.equal(await a.page.locator('#prompt-gif-steps').isVisible(),false);
    assert.equal(await a.page.evaluate(()=>localStorage.getItem('sv-opening-v2')),'code');
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);
    assert.equal(await a.page.locator('#prompt-opening').inputValue(),'code');
    // A broken saved value falls back to the default instead of reaching the prompt.
    await a.page.evaluate(()=>localStorage.setItem('sv-opening-v2','<img src=x>'));
    await a.page.reload();await a.page.waitForFunction(()=>state.ready);await a.tab('advice');
    assert.equal(await a.page.locator('#prompt-opening').inputValue(),'photo');
    assert.equal(await a.page.evaluate(()=>experimentPlan('explore','<img src=x>').opening.mode),'photo');
    // Tailwind is not loaded in tests; in production its preflight makes every box border-box.
    await a.page.addStyleTag({content:'*,::before,::after{box-sizing:border-box}'});
    await a.page.locator('#prompt-build').click();await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    for(const width of [375,1024]){
      await a.page.setViewportSize({width,height:900});
      for(const name of ['advice','home','grow']){
        await a.tab(name);
        assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,name+' '+width);
      }
    }
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('every shooting style is photographic and safe, rotates before repeating, and a retest follows the kind of its reference',async()=>{
  const db=baselineFixture();
  const a=await open(db,{'sv-opening-v2':null});
  try {
    const recipes=await a.page.evaluate(()=>PHOTO_RECIPES);
    assert.equal(recipes.length,15);
    for(const key of ['name','look','camera']) assert.equal(new Set(recipes.map(r=>r[key])).size,15,key);
    const drawn=await a.page.evaluate(()=>EXPERIMENT_RECIPES.map(r=>r.name));
    for(const r of recipes){
      for(const key of ['name','seconds','mood','look','palette','text','camera','sound']) assert.ok(r[key],r.name+' '+key);
      assert.ok(!drawn.includes(r.name),r.name); // names are how a format finds its recipe
      const text=[r.name,r.mood,r.look,r.palette,r.text,r.camera,r.sound].join('／');
      assert.doesNotMatch(text,/顔が|顔を写|人影|駅|線路|踏切|屋上|ベランダ|橋の上|薬|酒|刃物|ロープ|血|点滅|赤い光|ロゴ|イラスト|アニメ/,r.name);
      const [,lo,hi]=r.seconds.match(/^(\d+)〜(\d+)秒$/).map(Number);
      assert(lo>=15&&hi<=22,r.name+' '+r.seconds);
      assert.match(await a.page.evaluate(r=>recipeBrief(r,2,true),r),/^撮り方：.*この撮り方は2回目です/);
    }
    for(let n=0;n<15;n++){
      const plan=await a.page.evaluate(()=>experimentPlan());
      assert.equal(plan.mode,'explore');assert.equal(plan.opening.mode,'photo');assert.equal(plan.format,'写真1｜'+recipes[n].name);
      tagMethod(db,addExperiment(db,plan.format,45-n,{views:100}).id,photoNote);
      assert.equal(await a.page.evaluate(()=>loadAll()),true);
    }
    assert.equal((await a.page.evaluate(()=>experimentPlan())).format,'写真2｜窓辺の自然光');
    // The photoreal rounds get their own column, apart from the drawn styles and the 10/18〜10/23 exploration.
    const fc=await a.page.evaluate(()=>{const fc=formatCompare();return {pho:fc.pho?.n,sty:fc.sty,exp:fc.exp};});
    assert.equal(fc.pho,15);assert.equal(fc.sty,null);assert.equal(fc.exp,null);
    // A promising photoreal format is retested with photoreal material even when "code" is selected, and the other way round.
    for(const age of [8,7]) tagMethod(db,addExperiment(db,'写真2｜物の接写',age,goodExperiment).id,photoNote);
    addExperiment(db,'画風1｜墨と和紙',6,{views:200}); // a different format in between, so the retest is allowed
    await a.page.evaluate(()=>loadAll());
    await a.tab('advice');await a.page.locator('#prompt-opening').selectOption('code');
    let refine=await a.page.evaluate(()=>{const p=experimentPlan('refine');return {mode:p.mode,format:p.format,opening:p.opening,photo:p.photo};});
    assert.equal(refine.mode,'refine');assert.equal(refine.format,'写真2｜物の接写');assert.equal(refine.opening.mode,'photo');assert.match(refine.opening.reason,/参考にする回/);
    const prompt=await a.page.evaluate(()=>buildPrompt(experimentPlan('refine')).text);
    assert.match(prompt,/## 今回の撮り方：物の接写（手応えのある型を再検証）/);assert.match(prompt,/## ChatGPTに頼む素材/);assert.match(prompt,/今回だけ変えるもの：/);
    assert.equal(await a.page.evaluate(()=>experimentPlan('explore').opening.mode),'code'); // the explicit choice still decides ordinary videos
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('the photoreal comparison uses age-matched medians per method, waits for three each, and the method tags round-trip',async()=>{
  const db=experimentFixture();
  for(const age of [10,8]) tagMethod(db,addExperiment(db,'写真1｜窓辺の自然光',age,{stayed_pct:70,avg_watch_sec:10}).id,photoNote);
  const pending=addExperiment(db,'写真1｜物の接写',1,{stayed_pct:99},0);tagMethod(db,pending.id,photoNote); // too new to compare
  addExperiment(db,'画風3｜色鉛筆の絵日記',20,{stayed_pct:50}); // method not recorded: counted as code-only
  for(const age of [18,16]) tagMethod(db,addExperiment(db,'画風4｜ネオン管の夜',age,{stayed_pct:50}).id,'【制作手法:その他】');
  tagMethod(db,addExperiment(db,'画風5｜墨と和紙',11,{stayed_pct:30}).id,gifNote); // the illustrated-GIF openings are shown apart
  const seedance=addExperiment(db,'実写テスト',6,{stayed_pct:1});tagMethod(db,seedance.id,'【制作手法:Seedance】');
  addExperiment(db,'画風1｜墨と和紙',40,{stayed_pct:5}); // before the baseline period
  const a=await open(db,{'sv-opening-v2':'photo'});
  try {
    const period=()=>{PHOTO_EXPERIMENT.start=window.testStart;PHOTO_EXPERIMENT.baseline=window.testBaseline;GIF_EXPERIMENT.start=window.testBaseline;};
    await a.page.evaluate(([start,baseline])=>{window.testStart=start;window.testBaseline=baseline;},[dayAgoJst(12),dayAgoJst(25)]);
    await a.page.evaluate(period);
    let c=await a.page.evaluate(()=>{const c=openingComparison();return {photo:c.photo,code:c.code,gif:c.gif,text:openingDiagnosis(c)};});
    assert.equal(c.photo.summary.n,2);assert.equal(c.photo.pending,1);assert.equal(c.code.summary.n,3);assert.equal(c.code.summary.stayed,50);assert.equal(c.gif.summary.n,1);
    assert.match(c.text,/判断保留：.*実写の回2本・コードだけの回3本/);
    tagMethod(db,addExperiment(db,'写真1｜夕方の西日',6,{stayed_pct:70,avg_watch_sec:10}).id,photoNote);
    await a.page.evaluate(()=>loadAll());await a.page.evaluate(period);await a.page.evaluate(()=>renderKpis());
    c=await a.page.evaluate(()=>{const c=openingComparison();return {photo:c.photo,code:c.code,text:openingDiagnosis(c)};});
    assert.equal(c.photo.summary.n,3);assert.equal(c.photo.summary.stayed,70);assert.equal(c.code.videos,3);
    assert.match(c.text,/実写の回のほうが、視聴を継続が20.0ポイント高い/);
    const html=await a.page.locator('#gif-comparison').textContent();
    assert.match(html,/\+20.0ポイント/);assert.match(html,/スワイプして次へ：実写の回30.0%／コードだけの回50.0%/);
    assert.match(html,/同条件の計測行なし：実写の回1本／コードだけの回0本/);assert.match(html,/冒頭だけGIFの回/);assert.match(html,/30.0%（1本）/);
    const prompt=await a.page.evaluate(()=>buildPrompt().text);
    assert.match(prompt,/実写の回とコードだけの回の比較（.*実写の回（.*） 視聴を継続 70.0%（3本）/);assert.match(prompt,/20.0ポイント高い/);
    for(const m of db.sv_metrics) if(m.stayed_pct===70) m.stayed_pct=40;
    await a.page.evaluate(()=>loadAll());await a.page.evaluate(period);
    assert.match(await a.page.evaluate(()=>openingDiagnosis(openingComparison())),/10.0ポイント低い/);
    // The method select writes the tag in front of the note and reads it back; older tags keep their meaning.
    const id=db.sv_videos[3].id;
    await a.page.evaluate(id=>openVideo(id),id);
    await a.page.locator('#video-modal summary').click();
    assert.equal(await a.page.locator('#vm-method').inputValue(),'unknown');
    await a.page.locator('#vm-note').fill('メモ');await a.page.locator('#vm-method').selectOption('photo');
    await a.page.locator('#vm-save').click();
    await a.page.waitForFunction(()=>document.querySelector('#video-modal').classList.contains('hidden'));
    assert.equal(db.sv_videos[3].note,'【制作手法:ChatGPT 実写】\nメモ');
    await a.page.waitForFunction(id=>state.videos.some(v=>v.id===id&&/^【制作手法:ChatGPT 実写】/.test(v.note||'')),id); // the modal closes before the saved row is read back
    await a.page.evaluate(id=>openVideo(id),id);
    assert.equal(await a.page.locator('#vm-method').inputValue(),'photo');assert.equal(await a.page.locator('#vm-note').inputValue(),'メモ');
    assert.deepEqual(await a.page.evaluate(()=>['【制作手法:Seedance】x','【制作手法:その他】x','【制作手法:ChatGPT GIF】x','【制作手法:ChatGPT 実写】x','ChatGPT 実写','【制作手法:GIF】x'].map(note=>productionMethod({note}))),
      ['seedance','other','gif','photo','unknown','unknown']);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('pasting the record line fills the video form, keeps the pattern code in the note, and the pattern feeds the comparison by item',async()=>{
  const db=baselineFixture(),a=await open(db,{'sv-opening-v2':null});
  try {
    await a.tab('advice');await a.page.locator('#prompt-build').click();
    await a.page.waitForFunction(()=>!document.querySelector('#prompt-build').disabled);
    const prompt=await a.page.locator('#prompt-out').inputValue();
    const one=await a.page.evaluate(()=>{const h=readPromptHistory().recent.at(-1);return {...h,p:decodePattern(h.code)};});
    const line=prompt.split('\n').find(l=>l.startsWith('識別子: v004 ／'));
    assert.ok(line);
    const filled=line.replace('音: ___','音: BGM＋効果音').replace('尺: ___（実測秒）','尺: 17.4（実測秒）').replace('1枚目「___」','1枚目「<b>テスト</b>」');
    const parsed=await a.page.evaluate(text=>parseRecordLine(text),filled);
    assert.equal(parsed['型番'],one.code);assert.equal(parsed['形式'],'写真1｜窓辺の自然光');assert.equal(parsed['制作手法'],'ChatGPT 実写');assert.match(parsed['メモ'],/^毎回ちがう型で作る・題材「/);
    await a.page.evaluate(()=>openVideo('experiment-1'));
    await a.page.locator('#video-modal summary').click();
    await a.page.locator('#vm-paste').fill(filled);await a.page.locator('#vm-paste-apply').click();
    assert.match(await a.page.locator('#vm-paste-msg').textContent(),/入れました：識別子・テーマ・冒頭の掴み・形式・締め・尺・音・役割・今回変えたもの・制作手法・型番・メモ。題名/);
    assert.equal(await a.page.locator('#vm-slug').inputValue(),'v004');assert.equal(await a.page.locator('#vm-theme').inputValue(),one.theme);
    assert.equal(await a.page.locator('#vm-hook').inputValue(),one.hook);assert.equal(await a.page.locator('#vm-format').inputValue(),'写真1｜窓辺の自然光');
    assert.equal(await a.page.locator('#vm-cta').inputValue(),one.ending);assert.equal(await a.page.locator('#vm-dur').inputValue(),'17');
    assert.equal(await a.page.locator('#vm-audio').inputValue(),'BGM＋効果音');assert.equal(await a.page.locator('#vm-axis').inputValue(),'型の探索');
    assert.equal(await a.page.locator('#vm-method').inputValue(),'photo');
    assert.ok((await a.page.locator('#vm-note').inputValue()).startsWith(`【型:${one.code}】 毎回ちがう型で作る・題材「`));
    assert.equal(await a.page.locator('#video-modal b').count(),0,'pasted text is never treated as HTML');
    assert.deepEqual(a.writes,[]); // nothing is saved until the save button is pressed
    await a.page.locator('#vm-save').click();
    await a.page.waitForFunction(()=>document.querySelector('#video-modal').classList.contains('hidden'));
    const saved=db.sv_videos[0];
    assert.equal(saved.slug,'v004');assert.equal(saved.theme,one.theme);assert.equal(saved.hook_type,one.hook);assert.equal(saved.cta_type,one.ending);
    assert.equal(saved.format,'写真1｜窓辺の自然光');assert.equal(saved.duration_sec,17);assert.equal(saved.test_axis,'型の探索');
    assert.ok(saved.note.startsWith(`【制作手法:ChatGPT 実写】\n【型:${one.code}】 `));
    // The saved pattern is read back for the comparison by item, and reserves its topic for the next plan.
    await a.page.waitForFunction(()=>state.videos.some(v=>v.slug==='v004'));
    const got=await a.page.evaluate(()=>{const s=allStats().list.find(s=>s.v.slug==='v004');return Object.fromEntries(AXES.map(x=>[x.key,x.of(s)]));});
    assert.equal(got.look,'窓辺の自然光');assert.equal(got.area,one.p.topic.area);assert.equal(got.angle,one.p.angle.name);assert.equal(got.narr,one.p.narr.name);assert.equal(got.subj,one.p.subj.name);
    assert.equal(got.theme,one.theme);assert.equal(got.cta,one.ending);
    await a.tab('advice');
    const groups=await a.page.locator('#insight-groups').textContent();
    for(const label of ['場面','切り口','展開の型','写るもの','撮り方・画風']) assert.ok(groups.includes(label),label);
    const next=await a.page.evaluate(()=>experimentPlan().pattern);
    assert.equal(next.tried,1);assert.notEqual(next.topic.id,one.p.topic.id);assert.notEqual(next.topic.theme,one.theme);
    // Blanks, unknown codes and unknown choices are skipped instead of being written; an existing code in the note survives.
    await a.page.evaluate(()=>openVideo('experiment-2')); // the edit section is still open from the first video
    await a.page.locator('#vm-note').fill('【型:T011-A1-N1-S1】 前のメモ');
    await a.page.locator('#vm-paste').fill('識別子: v 9 ／ 型番: T999-A1-N1-S1 ／ テーマ: 不安 ／ 音: 大きな音 ／ 尺: ___（実測秒）／ 制作手法: なぞの手法');
    await a.page.locator('#vm-paste-apply').click();
    assert.match(await a.page.locator('#vm-paste-msg').textContent(),/入れました：テーマ。読み取れなかった項目：識別子・音・制作手法・型番（手で入れてください）/);
    assert.equal(await a.page.locator('#vm-slug').inputValue(),'v2');assert.equal(await a.page.locator('#vm-theme').inputValue(),'不安');
    assert.equal(await a.page.locator('#vm-note').inputValue(),'【型:T011-A1-N1-S1】 前のメモ');assert.equal(await a.page.locator('#vm-method').inputValue(),'unknown');
    await a.page.locator('#vm-paste').fill('関係のない文章');await a.page.locator('#vm-paste-apply').click();
    assert.match(await a.page.locator('#vm-paste-msg').textContent(),/読み取れる項目がありませんでした/);
    assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});

test('the participation card shows the site counts to the admin, guides to the SQL when missing, and ignores bad numbers',async()=>{
  const a=await open(fixture());
  try {
    await a.page.waitForFunction(()=>document.querySelector('#participation').textContent.includes('participation.sql'));
    a.flags.participation={days:14,lights:{lonely:3,calm:1,evil:99},metoo:2,metoo_posts:[{post_id:'x',title:'<b>夜</b>のひとりごと',n:2}],
      reports:{worry:1},bbs_seen:20,bbs_typing:1,bbs_posts:0,bbs_replies:0};
    await a.page.evaluate(()=>loadParticipation());
    const text=(await a.page.locator('#participation').textContent()).replace(/\s+/g,'');
    assert.match(text,/星の灯り4/);assert.match(text,/私も2/);assert.match(text,/掲示板を開いた20/);
    assert.match(text,/さみしい3こ/);assert.doesNotMatch(text,/evil|99/);
    assert.match(text,/書きはじめたのは5%/);assert.match(text,/知らせ：書いた人が心配1/);
    assert.equal(await a.page.locator('#participation b').count(),0,'diary titles are escaped');
    a.flags.participation={lights:{lonely:-1,calm:'5'},metoo:1.5,bbs_seen:'x'};
    await a.page.evaluate(()=>loadParticipation());
    const odd=(await a.page.locator('#participation').textContent()).replace(/\s+/g,'');
    assert.match(odd,/星の灯り0/);assert.match(odd,/私も0/);assert.match(odd,/まだ灯りはありません/);
    a.flags.participation=[1,2];
    await a.page.evaluate(()=>loadParticipation());
    assert.match(await a.page.locator('#participation').textContent(),/participation.sql/);
    assert.deepEqual(a.writes,[]);assert.deepEqual(a.errors,[]);
  }finally{await a.context.close();}
});
