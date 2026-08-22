-- ============================================================
--  星と海 ｜ IT ニュース収集
--  Supabase の SQL Editor に貼り付けて実行してください。
--
--  APIキーも開発者登録も不要です。各サイトが公開している
--  RSS / Atom / RDF フィードを Supabase 自身が読みに行きます。
--  YouTube 分析の sync_youtube と同じ仕組み（http 拡張）です。
--
--  ※ SQL Editor が長い関数定義を途中で切って
--    「syntax error at end of input」を出すことがあります。
--    そのときは ── の区切りごとに 1 つずつ実行してください。
-- ============================================================


-- ------------------------------------------------------------
-- 1. 準備
-- ------------------------------------------------------------
create extension if not exists http with schema extensions;

-- 収集元（フィード）の一覧
create table if not exists it_news_sources (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  url             text not null unique,
  genre           text not null default 'other',   -- ai / kokunai / dev / kaigai / other
  enabled         boolean not null default true,
  sort_order      int not null default 100,
  queued_at       timestamptz,                     -- 更新の順番待ち
  last_fetched_at timestamptz,
  last_status     text,
  last_added      int,
  created_at      timestamptz not null default now()
);

-- 集めた記事
create table if not exists it_news_items (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid references it_news_sources(id) on delete set null,
  source_name  text,
  genre        text,
  title        text not null,
  url          text not null unique,
  summary      text,
  published_at timestamptz,
  fetched_at   timestamptz not null default now(),
  starred      boolean not null default false,
  read_at      timestamptz
);

create index if not exists it_news_items_pub_idx    on it_news_items(published_at desc nulls last);
create index if not exists it_news_items_genre_idx  on it_news_items(genre);
create index if not exists it_news_items_star_idx   on it_news_items(starred) where starred;

-- 管理者（ログイン済み）だけが読み書きできます
alter table it_news_sources enable row level security;
alter table it_news_items   enable row level security;

drop policy if exists "admin_all" on it_news_sources;
create policy "admin_all" on it_news_sources for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "admin_all" on it_news_items;
create policy "admin_all" on it_news_items for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');


-- ------------------------------------------------------------
-- 2. 小さな道具
--    ①XMLとして読めるように整える ②日付を読む ③HTMLタグを外す
-- ------------------------------------------------------------

-- ① 受け取った本文を XML に変換する。
--    XML宣言のエンコーディング指定や、XMLでは未定義の実体参照（&nbsp; など）が
--    混ざっていると読めないので、先に取り除いてから変換します。
--    どうしても読めなければ null を返し、呼び出し側でエラーとして記録します。
create or replace function it_news_to_xml(p_body text)
returns xml
language plpgsql
immutable
as $fn$
declare t text;
begin
  if p_body is null then return null; end if;

  t := ltrim(p_body, chr(65279) || E' \t\r\n');          -- BOM と先頭の空白
  t := regexp_replace(t, '^<\?xml[^>]*\?>', '');          -- XML宣言
  t := regexp_replace(t, '<!DOCTYPE[^>]*>', '', 'g');     -- DOCTYPE
  t := btrim(t);

  -- よく出てくる名前つき実体参照を、数値参照に置き換える
  t := replace(t, '&nbsp;',   '&#160;');
  t := replace(t, '&mdash;',  '&#8212;');
  t := replace(t, '&ndash;',  '&#8211;');
  t := replace(t, '&hellip;', '&#8230;');
  t := replace(t, '&lsquo;',  '&#8216;');
  t := replace(t, '&rsquo;',  '&#8217;');
  t := replace(t, '&ldquo;',  '&#8220;');
  t := replace(t, '&rdquo;',  '&#8221;');
  t := replace(t, '&bull;',   '&#8226;');
  t := replace(t, '&middot;', '&#183;');
  t := replace(t, '&copy;',   '&#169;');
  t := replace(t, '&reg;',    '&#174;');
  t := replace(t, '&trade;',  '&#8482;');
  t := replace(t, '&deg;',    '&#176;');
  t := replace(t, '&laquo;',  '&#171;');
  t := replace(t, '&raquo;',  '&#187;');

  -- 残った未定義の実体参照は、ただの「&」として扱う
  t := regexp_replace(t, '&(?!amp;|lt;|gt;|quot;|apos;|#)([a-zA-Z][a-zA-Z0-9]*;)', '&amp;\1', 'g');

  return t::xml;
exception when others then
  return null;
end;
$fn$;

-- ② 日付の文字列を読む。
--    RFC822（Fri, 22 Aug 2026 14:05:31 +0900）と
--    ISO8601（2026-08-22T14:05:31+09:00）のどちらも来ます。
create or replace function it_news_ts(p text)
returns timestamptz
language plpgsql
immutable
as $fn$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return btrim(p)::timestamptz;
exception when others then
  begin
    -- 先頭の曜日（Fri, ）を落としてもう一度
    return btrim(regexp_replace(p, '^[A-Za-z]{3,9},?\s*', ''))::timestamptz;
  exception when others then
    return null;
  end;
end;
$fn$;

-- ③ 要約に混ざる HTML タグと実体参照を外して、読める文にする
create or replace function it_news_plain(p text)
returns text
language sql
immutable
as $fn$
  select nullif(btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(coalesce(p, ''), '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
    '\s+', ' ', 'g')), '')
$fn$;

-- ④ 記事のURLをそろえる。
--    同じ記事でも ?utm_source= の中身が変わることがあり、
--    そのままだと同じ記事が二重に入ってしまうため、計測用のパラメータを外します。
create or replace function it_news_url(p text)
returns text
language sql
immutable
as $fn$
  select nullif(
    regexp_replace(                                   -- ④ 余った ? や & を落とす
      regexp_replace(                                 -- ③ 先頭に来た & を ? に戻す
        regexp_replace(                               -- ② && をひとつにまとめる
          regexp_replace(                             -- ① 計測用のパラメータを外す
            btrim(coalesce(p, '')),
            '[?&](utm_[^&#=]*|ref|ref_src|fbclid|gclid|feature|spm)=[^&#]*', '&', 'g'),
          '&+', '&', 'g'),
        '^([^?]*)&', '\1?'),
      '[?&]+(#|$)', '\1'), '')
$fn$;


-- ------------------------------------------------------------
-- 3. フィードを1つ読み込む
--    RSS2.0 / Atom / RDF(RSS1.0) のどれでも、同じ書き方で拾えるように
--    名前空間を見ずに local-name() で項目名だけを見ています。
-- ------------------------------------------------------------
create or replace function it_news_fetch_source(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  s        record;
  v_status int;
  v_body   text;
  doc      xml;
  n        int := 0;
begin
  select * into s from it_news_sources where id = p_id;
  if not found then return 0; end if;

  -- 時間のかかるサイトで止まらないように、12秒で打ち切る
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '12000');
  exception when others then null;
  end;

  begin
    select status, content into v_status, v_body
    from extensions.http((
      'GET',
      s.url,
      array[
        extensions.http_header('User-Agent', 'Mozilla/5.0 (compatible; HoshiToUmi/1.0; +https://hoshitoumi.vercel.app)'),
        extensions.http_header('Accept', 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*')
      ],
      null, null)::extensions.http_request);
  exception when others then
    update it_news_sources
       set last_fetched_at = now(), queued_at = null, last_added = 0,
           last_status = '取得できませんでした：' || left(sqlerrm, 120)
     where id = p_id;
    return 0;
  end;

  if v_status <> 200 then
    update it_news_sources
       set last_fetched_at = now(), queued_at = null, last_added = 0,
           last_status = 'HTTP ' || v_status || ' が返りました'
     where id = p_id;
    return 0;
  end if;

  doc := it_news_to_xml(v_body);
  if doc is null then
    update it_news_sources
       set last_fetched_at = now(), queued_at = null, last_added = 0,
           last_status = 'XML として読めませんでした'
     where id = p_id;
    return 0;
  end if;

  with parsed as (
    select *
    from xmltable(
      '//*[local-name()="item" or local-name()="entry"]'
      passing doc
      columns
        ord    for ordinality,
        title  text path 'string((*[local-name()="title"])[1])',
        link   text path 'string((*[local-name()="link"])[1])',
        href   text path 'string((*[local-name()="link"][not(@rel) or @rel="alternate"])[1]/@href)',
        pub    text path 'string((*[local-name()="pubDate"]|*[local-name()="date"]|*[local-name()="published"]|*[local-name()="updated"])[1])',
        summ   text path 'string((*[local-name()="description"]|*[local-name()="summary"]|*[local-name()="content"])[1])'
    )
    where ord <= 40                                   -- 新しいほうから40件まで
  ),
  cleaned as (
    select distinct on (u)
           left(it_news_plain(title), 300)  as t,
           u,
           left(it_news_plain(summ), 400)   as d,
           it_news_ts(pub)                  as p
    from (
      select title, summ, pub,
             it_news_url(coalesce(nullif(btrim(link), ''), href)) as u
      from parsed
    ) x
    where u ~ '^https?://' and btrim(coalesce(title, '')) <> ''
  ),
  ins as (
    insert into it_news_items (source_id, source_name, genre, title, url, summary, published_at)
    select p_id, s.name, s.genre, t, u, d, p from cleaned
    on conflict (url) do nothing
    returning 1
  )
  select count(*) into n from ins;

  update it_news_sources
     set last_fetched_at = now(), queued_at = null, last_added = n,
         last_status = case when n > 0 then n || '件 追加' else '新着なし' end
   where id = p_id;

  return n;
end;
$fn$;


-- ------------------------------------------------------------
-- 4. 更新ボタンから呼ぶもの
--    1回で全部を取りに行くと時間切れになるので、
--    「順番待ちに入れて、数件ずつ取りに行く」形にしています。
--    画面は remaining が 0 になるまで refresh_it_news を呼び直します。
-- ------------------------------------------------------------

-- 有効なフィードをすべて順番待ちに入れる（更新ボタンを押した最初の1回）
create or replace function it_news_queue_all()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare n int;
begin
  update it_news_sources set queued_at = now() where enabled;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- 順番待ちから p_limit 件だけ取りに行く
create or replace function refresh_it_news(p_limit int default 4)
returns table(done int, added int, remaining int)
language plpgsql
security definer
set search_path = public, extensions
set statement_timeout = '110s'
as $fn$
declare
  r record;
  d int := 0;
  a int := 0;
begin
  -- 順番待ちが空なら（自動更新など）、まず全部を並べる
  if not exists (select 1 from it_news_sources where enabled and queued_at is not null) then
    perform it_news_queue_all();
  end if;

  for r in
    select id from it_news_sources
     where enabled and queued_at is not null
     order by sort_order, name
     limit greatest(1, least(coalesce(p_limit, 4), 30))
  loop
    a := a + it_news_fetch_source(r.id);
    d := d + 1;
  end loop;

  return query
    select d, a, (select count(*)::int from it_news_sources where enabled and queued_at is not null);
end;
$fn$;

-- 画面から呼べるのはログイン済みの本人だけにする
revoke execute on function it_news_fetch_source(uuid) from public, anon;
revoke execute on function it_news_queue_all()         from public, anon;
revoke execute on function refresh_it_news(int)        from public, anon;
grant  execute on function it_news_queue_all()         to authenticated;
grant  execute on function refresh_it_news(int)        to authenticated;


-- ------------------------------------------------------------
-- 5. 毎日ひとりでに集める
--    日本時間の 朝7時・昼12時・夜9時。
--    ついでに、古い記事（★をつけていないもの）を片づけます。
-- ------------------------------------------------------------
create or replace function it_news_cron()
returns void
language plpgsql
security definer
set search_path = public, extensions
set statement_timeout = '0'
as $fn$
declare r record;
begin
  for r in select id from it_news_sources where enabled order by sort_order, name loop
    perform it_news_fetch_source(r.id);
  end loop;

  delete from it_news_items
   where not starred
     and coalesce(published_at, fetched_at) < now() - interval '60 days';
end;
$fn$;

revoke execute on function it_news_cron() from public, anon;

create extension if not exists pg_cron;

select cron.unschedule('refresh-it-news') where exists (
  select 1 from cron.job where jobname = 'refresh-it-news');

select cron.schedule('refresh-it-news', '0 22,3,12 * * *', $$select public.it_news_cron()$$);
-- （cron はUTC。22時UTC=日本の朝7時、3時UTC=昼12時、12時UTC=夜9時）


-- ------------------------------------------------------------
-- 6. 収集元をひととおり登録する
--    画面の「収集元」から、あとから追加・削除・停止できます。
--    （もう一度この SQL を流しても、停止したものは停止のままです）
-- ------------------------------------------------------------
insert into it_news_sources (name, url, genre, sort_order) values
  -- ── AI・生成AI ──
  ('ITmedia AI+',            'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml',                                       'ai',      10),
  ('OpenAI News',            'https://openai.com/news/rss.xml',                                                    'ai',      11),
  ('Google AI Blog',         'https://blog.google/technology/ai/rss/',                                             'ai',      12),
  ('Hugging Face Blog',      'https://huggingface.co/blog/feed.xml',                                               'ai',      13),
  ('Zenn（AI）',              'https://zenn.dev/topics/ai/feed',                                                    'ai',      14),
  ('ニュース検索：生成AI',      'https://news.google.com/rss/search?q=%E7%94%9F%E6%88%90AI+when:2d&hl=ja&gl=JP&ceid=JP:ja', 'ai', 15),
  ('ニュース検索：Anthropic',  'https://news.google.com/rss/search?q=Anthropic+OR+Claude+AI+when:3d&hl=ja&gl=JP&ceid=JP:ja','ai', 16),

  -- ── 国内IT総合 ──
  ('はてブ テクノロジー',      'https://b.hatena.ne.jp/hotentry/it.rss',                                            'kokunai', 20),
  ('ITmedia NEWS',           'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml',                                  'kokunai', 21),
  ('Publickey',              'https://www.publickey1.jp/atom.xml',                                                 'kokunai', 22),
  ('GIGAZINE',               'https://gigazine.net/news/rss_2.0/',                                                 'kokunai', 23),
  ('INTERNET Watch',         'https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf',                          'kokunai', 24),
  ('ASCII.jp',               'https://ascii.jp/rss.xml',                                                           'kokunai', 25),

  -- ── 開発者向け技術記事 ──
  ('Zenn',                   'https://zenn.dev/feed',                                                              'dev',     30),
  ('Qiita 人気',              'https://qiita.com/popular-items/feed',                                              'dev',     31),
  ('gihyo.jp',               'https://gihyo.jp/feed/atom',                                                         'dev',     32),
  ('CodeZine',               'https://codezine.jp/rss/new/20/index.xml',                                           'dev',     33),
  ('InfoQ Japan',            'https://feed.infoq.com/jp/',                                                         'dev',     34),

  -- ── 海外テック ──
  ('Hacker News',            'https://hnrss.org/frontpage',                                                        'kaigai',  40),
  ('TechCrunch',             'https://techcrunch.com/feed/',                                                       'kaigai',  41),
  ('The Verge',              'https://www.theverge.com/rss/index.xml',                                             'kaigai',  42),
  ('Ars Technica',           'https://feeds.arstechnica.com/arstechnica/index',                                    'kaigai',  43),
  ('GitHub Blog',            'https://github.blog/feed/',                                                          'kaigai',  44)
on conflict (url) do update
  set name = excluded.name, genre = excluded.genre, sort_order = excluded.sort_order;


-- ------------------------------------------------------------
-- 7. さっそく1回集める
--    件数が多いので、下の行を remaining が 0 になるまで押してください。
--    （画面の「更新」ボタンは、これを自動でくり返します）
-- ------------------------------------------------------------
select * from refresh_it_news(30);
