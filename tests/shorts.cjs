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
