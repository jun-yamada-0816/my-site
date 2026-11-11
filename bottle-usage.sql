-- ============================================================
-- 星の小瓶・コンテンツごとの利用回数・日記ごとの閲覧数（2026-11-11）
--
-- Supabase の SQL Editor で、このファイルをまるごと1回実行してください。
-- 何度実行しても壊れません（作り直すのは関数だけで、記録は消しません）。
-- 前提：admin-only.sql（is_site_admin）と participation.sql を実行済みであること。
--
-- 実行するまでのサイトの動き（エラーにはなりません）：
--   ・星の小瓶：管理人がはじめに置いた小瓶だけが拾えます。流そうとすると「いまは流せません」と出ます
--   ・利用状況のページ（usage.html）：「このSQLを実行してください」と出ます
--   ・掲示板の「開いた」「書きはじめた」は、これまでどおり participation.sql の関数で数え続けます
--
-- 残すもの：
--   ・利用回数 … どの場所が、いつ見られた・使われたか（種類と時刻だけ。同じ端末は1日1回）
--   ・日記の閲覧 … どの日記が、いつ開かれたか
--   ・小瓶 … 宛先とことば（どちらも決まった候補から選ぶだけ）、流した時刻、拾われた回数
-- 名前・文章・IPアドレス・端末の情報は保存しません。
-- どの表も、訪問者から直接は読み書きできません（下の関数を通したときだけ）。
-- 数を見られるのは、管理者としてログインしたときだけです（利用状況のページ・日記の画面）。
-- 利用回数と小瓶は、400日を過ぎたものから消します。
-- ============================================================

begin;

-- 0. 先に実行しておくSQLが済んでいるか -----------------------------
do $$
begin
  if to_regprocedure('public.is_site_admin()') is null then
    raise exception '先に admin-only.sql を実行してください（is_site_admin がありません）';
  end if;
  if to_regclass('public.site_signals') is null or to_regclass('public.star_lights') is null
     or to_regclass('public.diary_metoo') is null or to_regclass('public.bulletin_reports') is null then
    raise exception '先に participation.sql を実行してください（星の灯りなどの表がありません）';
  end if;
end
$$;

-- 1. 利用回数：数える種類を増やす -----------------------------------
-- 表は participation.sql の site_signals をそのまま使う（1行＝「この種類が、この時刻に1回」）。
-- 種類を増やすときは、この制約と、下の note_usage の2か所を直すこと。
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.site_signals'::regclass and contype = 'c' loop
    execute format('alter table public.site_signals drop constraint %I', c.conname);
  end loop;
end
$$;
alter table public.site_signals add constraint site_signals_kind_check check (kind in (
  'visit',
  'bottle_seen', 'bottle_pick', 'bottle_throw', 'bottle_thanks',
  'lights_seen',
  'news_seen', 'news_tap',
  'profile_seen',
  'blog_seen', 'diary_open',
  'bbs_seen', 'bbs_typing',
  'mikuji_seen', 'mikuji_draw',
  'welcome_seen', 'welcome_tap',
  'promise_seen',
  'mood_seen', 'mood_used',
  'coping_seen', 'affirm_next',
  'services_seen', 'services_tap',
  'links_seen', 'links_tap',
  'support_seen', 'help_tap',
  'sos_open'));
-- 古い記録を消すとき（400日）に、表をぜんぶ読まずに済むように
create index if not exists site_signals_created_at_idx on public.site_signals (created_at);

-- 2. 日記ごとの閲覧：どの日記が、いつ開かれたかだけ -------------------
create table if not exists public.diary_views (
  id bigint generated always as identity primary key,
  post_id uuid not null references public.blog_posts (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists diary_views_post_idx on public.diary_views (post_id, created_at);
create index if not exists diary_views_created_at_idx on public.diary_views (created_at);

-- 3. 星の小瓶 --------------------------------------------------------
-- 宛先とことばは、決まった候補の「記号」で持つ（自由な文章は入らない）。
-- 文面はサイトの側（index.html の BOTTLE_TO・BOTTLE_WORDS）にある。候補を増やすときは、
-- この2つの制約と、下の throw_bottle・pick_bottle、サイトの側の4か所をそろえること。
-- owner_key は流した端末だけが持つ合言葉。これを知っている端末だけが、拾われた回数を見られる。
create table if not exists public.sea_bottles (
  id uuid primary key default gen_random_uuid(),
  owner_key uuid not null unique default gen_random_uuid(),
  to_kind text not null check (to_kind in ('sleepless', 'lonely', 'tired', 'wordless', 'anxious', 'anyone')),
  word text not null check (word in ('here', 'same_night', 'enough', 'slowly', 'me_too',
                                     'not_alone', 'rest', 'no_words', 'thanks', 'see_you')),
  from_admin boolean not null default false,
  picks integer not null default 0 check (picks >= 0),
  thanks integer not null default 0 check (thanks >= 0),
  created_at timestamptz not null default now()
);
create index if not exists sea_bottles_created_at_idx on public.sea_bottles (created_at);

-- 「拾う」「ありがとう」が10分のあいだに何回あったか（数を水増しされないための上限に使う）
create table if not exists public.sea_bottle_rate (
  bucket timestamptz primary key,
  picks integer not null default 0,
  thanks integer not null default 0
);

do $$
declare
  t text;
begin
  foreach t in array array['diary_views', 'sea_bottles', 'sea_bottle_rate'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end
$$;

-- 4. 訪問者が呼べる関数 ---------------------------------------------
-- どれも上限つき。上限は1人ずつではなく全体の数（IPは扱わない）。
-- 数えるのと足すのは、サーバーが何台あっても1つずつ順番に（pg_advisory_xact_lock）。

-- 「この場所が見られた・使われた」をひとつ数える（同じ端末は1日1回。サイトの側で絞ってから送る）
create or replace function public.note_usage(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in (
    'visit',
    'bottle_seen', 'bottle_pick', 'bottle_throw', 'bottle_thanks',
    'lights_seen',
    'news_seen', 'news_tap',
    'profile_seen',
    'blog_seen', 'diary_open',
    'bbs_seen', 'bbs_typing',
    'mikuji_seen', 'mikuji_draw',
    'welcome_seen', 'welcome_tap',
    'promise_seen',
    'mood_seen', 'mood_used',
    'coping_seen', 'affirm_next',
    'services_seen', 'services_tap',
    'links_seen', 'links_tap',
    'support_seen', 'help_tap',
    'sos_open') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 14);   -- note_site_signal と同じ鍵（同じ表に足すため）
  if (select count(*) from public.site_signals
      where kind = p_kind and created_at > now() - interval '10 minutes') >= 300 then
    return false;
  end if;
  insert into public.site_signals (kind) values (p_kind);
  delete from public.site_signals where created_at < now() - interval '400 days';
  return true;
end;
$$;

-- 日記がひとつ開かれた、を数える。プロフィール（固定IDの行）と、無い日記は数えない。
create or replace function public.note_diary_view(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_post_id is null
     or p_post_id = '00000000-0000-4000-8000-000000000095'::uuid
     or not exists (select 1 from public.blog_posts where id = p_post_id) then
    raise exception 'unknown diary' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 21);
  if (select count(*) from public.diary_views where created_at > now() - interval '10 minutes') >= 300 then
    return false;
  end if;
  insert into public.diary_views (post_id) values (p_post_id);
  return true;
end;
$$;

-- いま海にある小瓶の数
create or replace function public.sea_bottle_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.sea_bottles;
$$;

-- 小瓶をひとつ流す。返すのは、拾うときの id と、流した端末だけが持つ合言葉（key）。
-- 管理者としてログインしているときに流した小瓶には「管理人が流した」の印がつく。
-- 混み合っているときは流さずに ok=false。
create or replace function public.throw_bottle(p_to text, p_word text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.sea_bottles;
begin
  if p_to is null or p_to not in ('sleepless', 'lonely', 'tired', 'wordless', 'anxious', 'anyone') then
    raise exception 'invalid recipient' using errcode = '22023';
  end if;
  if p_word is null or p_word not in ('here', 'same_night', 'enough', 'slowly', 'me_too',
                                      'not_alone', 'rest', 'no_words', 'thanks', 'see_you') then
    raise exception 'invalid word' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 22);
  if (select count(*) from public.sea_bottles where created_at > now() - interval '10 minutes') >= 30
     or (select count(*) from public.sea_bottles where created_at > now() - interval '24 hours') >= 300 then
    return jsonb_build_object('ok', false);
  end if;
  insert into public.sea_bottles (to_kind, word, from_admin)
    values (p_to, p_word, coalesce(public.is_site_admin(), false))
    returning * into b;
  delete from public.sea_bottles where created_at < now() - interval '400 days';
  return jsonb_build_object('ok', true, 'id', b.id, 'key', b.owner_key);
end;
$$;

-- 小瓶をひとつ拾う。p_skip（もう拾ったもの・自分が流したもの）は避ける。
-- p_to（今夜の星の灯りと同じ宛先）があれば先に、あとは、まだあまり拾われていないものから。
-- 流した時刻は「時」までに丸めて返す。拾える小瓶がなければ null。
create or replace function public.pick_bottle(p_to text default null, p_skip uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.sea_bottles;
  slot timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600);
  used integer;
begin
  if p_to is not null and p_to not in ('sleepless', 'lonely', 'tired', 'wordless', 'anxious', 'anyone') then
    raise exception 'invalid recipient' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_skip, '{}')) > 200 then
    raise exception 'too many ids' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 22);
  select * into b from public.sea_bottles
    where id <> all (coalesce(p_skip, '{}'))
    order by (to_kind is not distinct from p_to) desc, picks, random()
    limit 1;
  if not found then
    return null;
  end if;
  -- 拾われた回数は、10分に300回までしか増やさない（超えたぶんは、小瓶は渡すが数えない）
  insert into public.sea_bottle_rate as r (bucket, picks) values (slot, 1)
    on conflict (bucket) do update set picks = r.picks + 1
    returning r.picks into used;
  delete from public.sea_bottle_rate where bucket < now() - interval '1 day';
  if used <= 300 then
    update public.sea_bottles set picks = picks + 1 where id = b.id;
  end if;
  return jsonb_build_object('id', b.id, 'to', b.to_kind, 'word', b.word,
                            'from_admin', b.from_admin, 'at', date_trunc('hour', b.created_at));
end;
$$;

-- 拾った小瓶に「ありがとう」をひとつ返す。無い小瓶・混み合っているときは false。
create or replace function public.thank_bottle(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  slot timestamptz := to_timestamp(floor(extract(epoch from now()) / 600) * 600);
  used integer;
begin
  if p_id is null then
    raise exception 'invalid id' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 22);
  if not exists (select 1 from public.sea_bottles where id = p_id) then
    return false;
  end if;
  insert into public.sea_bottle_rate as r (bucket, thanks) values (slot, 1)
    on conflict (bucket) do update set thanks = r.thanks + 1
    returning r.thanks into used;
  if used > 300 then
    return false;
  end if;
  update public.sea_bottles set thanks = thanks + 1 where id = p_id;
  return true;
end;
$$;

-- 自分が流した小瓶が、何回拾われて、ありがとうがいくつ届いたか。
-- 合言葉（key）を知っている端末にだけ返す。もう海に無い小瓶は、答えに入らない。
create or replace function public.bottle_status(p_keys uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_keys is null or cardinality(p_keys) > 20 then
    raise exception 'invalid keys' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('key', owner_key, 'picks', picks, 'thanks', thanks))
    from public.sea_bottles where owner_key = any (p_keys)), '[]'::jsonb);
end;
$$;

-- 5. 管理者だけが呼べる関数 -----------------------------------------

-- 利用状況のページ（usage.html）に出す数をまとめて返す。
-- 期間は日本時間の日付で区切る：today＝きょう、d7＝きょうを含む7日、d30＝きょうを含む30日、all＝残っているぶん全部。
create or replace function public.site_usage_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  jst_today date := (now() at time zone 'Asia/Tokyo')::date;
  d0 timestamptz := jst_today::timestamp at time zone 'Asia/Tokyo';
  d7 timestamptz := d0 - interval '6 days';
  d30 timestamptz := d0 - interval '29 days';
begin
  if not coalesce(public.is_site_admin(), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'today', to_char(jst_today, 'YYYY-MM-DD'),
    -- 「見た」「使った」を数えはじめた日（最初の訪問の記録の日）
    'since', (select to_char(min(created_at) at time zone 'Asia/Tokyo', 'YYYY-MM-DD')
              from public.site_signals where kind = 'visit'),
    -- トップページの足あとカウンター（サイトをはじめてからの延べ回数）
    'counter_total', (select count from public.site_visits where id = 1),
    -- counts.<まとまり>.<種類> = { today, d7, d30, all }
    'counts', (
      with events as (
        select 'signal' as src, kind as key, created_at from public.site_signals
        union all select 'light', mood, created_at from public.star_lights
        union all select 'metoo', 'all', created_at from public.diary_metoo
        union all select 'view', 'all', created_at from public.diary_views
        union all select 'report', reason, created_at from public.bulletin_reports
        union all select 'bbs', case when parent_id is null then 'post' else 'reply' end, created_at
                  from public.bulletin_messages
        union all select 'bottle_to', to_kind, created_at from public.sea_bottles
        union all select 'bottle_word', word, created_at from public.sea_bottles
      ), windows as (
        select src, key, jsonb_build_object(
          'today', count(*) filter (where created_at >= d0),
          'd7', count(*) filter (where created_at >= d7),
          'd30', count(*) filter (where created_at >= d30),
          'all', count(*)) as w
        from events group by src, key
      )
      select coalesce(jsonb_object_agg(src, per_src), '{}'::jsonb)
      from (select src, jsonb_object_agg(key, w) as per_src from windows group by src) as grouped),
    'bottles', (select jsonb_build_object(
        'in_sea', count(*),
        'from_admin', count(*) filter (where from_admin),
        'picked_once', count(*) filter (where picks > 0),
        'picks', coalesce(sum(picks), 0),
        'thanks', coalesce(sum(thanks), 0)) from public.sea_bottles),
    -- よく開かれた日記（期間ごとに上から10件）
    'top_diaries', (
      select jsonb_object_agg(win.name, coalesce(top.list, '[]'::jsonb))
      from (values ('today', d0), ('d7', d7), ('d30', d30), ('all', '-infinity'::timestamptz)) as win(name, since)
      left join lateral (
        select jsonb_agg(jsonb_build_object('post_id', post_id, 'title', title, 'n', n) order by n desc, title) as list
        from (
          select v.post_id, b.title, count(*) as n
          from public.diary_views v join public.blog_posts b on b.id = v.post_id
          where v.created_at >= win.since
          group by v.post_id, b.title
          order by n desc, b.title
          limit 10) as ranked
      ) as top on true),
    -- 直近14日の、日ごと・種類ごとの数（記録のない日も 0 として並べる）
    'daily', (
      select jsonb_agg(jsonb_build_object(
          'day', to_char(days.day, 'YYYY-MM-DD'),
          'kinds', coalesce((
            select jsonb_object_agg(kind, n) from (
              select kind, count(*) as n from public.site_signals
              where created_at >= days.day::timestamp at time zone 'Asia/Tokyo'
                and created_at < (days.day + 1)::timestamp at time zone 'Asia/Tokyo'
              group by kind) as per_kind), '{}'::jsonb)) order by days.day)
      from (select jst_today - back as day from generate_series(0, 13) as back) as days),
    -- 直近30日の訪問を、日本時間の時刻（0〜23時）ごとに
    'hours', (
      select jsonb_agg(coalesce(per_hour.n, 0) order by hours.h)
      from generate_series(0, 23) as hours(h)
      left join (
        select extract(hour from created_at at time zone 'Asia/Tokyo')::int as h, count(*) as n
        from public.site_signals
        where kind = 'visit' and created_at >= d30
        group by 1) as per_hour on per_hour.h = hours.h));
end;
$$;

-- 日記ごとの、これまでに開かれた回数（日記の一覧と詳細で、管理者にだけ出す）
create or replace function public.diary_view_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_site_admin(), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_object_agg(post_id, n)
    from (select post_id, count(*) as n from public.diary_views group by post_id) as per_post), '{}'::jsonb);
end;
$$;

-- 6. 呼べる人を決める -----------------------------------------------
revoke all on function public.note_usage(text) from public;
revoke all on function public.note_diary_view(uuid) from public;
revoke all on function public.sea_bottle_count() from public;
revoke all on function public.throw_bottle(text, text) from public;
revoke all on function public.pick_bottle(text, uuid[]) from public;
revoke all on function public.thank_bottle(uuid) from public;
revoke all on function public.bottle_status(uuid[]) from public;
revoke all on function public.site_usage_summary() from public, anon;
revoke all on function public.diary_view_counts() from public, anon;
grant execute on function public.note_usage(text) to anon, authenticated;
grant execute on function public.note_diary_view(uuid) to anon, authenticated;
grant execute on function public.sea_bottle_count() to anon, authenticated;
grant execute on function public.throw_bottle(text, text) to anon, authenticated;
grant execute on function public.pick_bottle(text, uuid[]) to anon, authenticated;
grant execute on function public.thank_bottle(uuid) to anon, authenticated;
grant execute on function public.bottle_status(uuid[]) to anon, authenticated;
grant execute on function public.site_usage_summary() to authenticated;
grant execute on function public.diary_view_counts() to authenticated;

notify pgrst, 'reload schema';
commit;
