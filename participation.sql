-- ============================================================
-- 星の灯り・日記の「私も」・掲示板の「知らせる」・掲示板の小さな数え上げ（2026-11-09）
--
-- Supabase の SQL Editor で、このファイルをまるごと1回実行してください。
-- 何度実行しても壊れません（作り直すのは関数と通知だけで、記録は消しません）。
-- 前提：admin-only.sql（is_site_admin）と bbs-moderation.sql を実行済みであること。
--
-- 実行するまでのサイトの動き（エラーにはなりません）：
--   ・星の灯り：選んだ灯りはその端末の中にだけ残り、ほかの人の灯りの数は出ません
--   ・「私も」「知らせる」：押すと「いまは届けられません」と出ます
--
-- 残すのは「種類」と「時刻」だけです。名前・文章・IPアドレス・端末の情報は保存しません。
-- どの表も、訪問者から直接は読み書きできません（下の関数を通したときだけ1行足せます）。
-- 数を見られるのは、管理者としてログインしたときだけです（YouTube分析ページ・日記の画面）。
-- 記録は400日を過ぎたものから消します（星の灯り・掲示板の数え上げ）。
-- ============================================================

begin;

-- 1. 表 ----------------------------------------------------------

-- 星の灯り：選ばれた気持ちの種類と時刻だけ
create table if not exists public.star_lights (
  id bigint generated always as identity primary key,
  mood text not null check (mood in ('tired', 'lonely', 'sleepless', 'wordless', 'calm')),
  created_at timestamptz not null default now()
);
create index if not exists star_lights_created_at_idx on public.star_lights (created_at);

-- 日記への「私も」：どの日記に、いつ届いたかだけ
create table if not exists public.diary_metoo (
  id bigint generated always as identity primary key,
  post_id uuid not null references public.blog_posts (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists diary_metoo_post_idx on public.diary_metoo (post_id, created_at);

-- 掲示板の「知らせる」：どの書き込みに、どの理由で、いつ届いたかだけ
create table if not exists public.bulletin_reports (
  id bigint generated always as identity primary key,
  message_id uuid not null references public.bulletin_messages (id) on delete cascade,
  reason text not null check (reason in ('attack', 'personal', 'spam', 'worry')),
  created_at timestamptz not null default now()
);
create index if not exists bulletin_reports_created_at_idx on public.bulletin_reports (created_at);

-- 掲示板を開いた・書きはじめた（同じ端末は1日1回。サイトの側で絞ってから送る）
create table if not exists public.site_signals (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('bbs_seen', 'bbs_typing')),
  created_at timestamptz not null default now()
);
create index if not exists site_signals_kind_created_at_idx on public.site_signals (kind, created_at);

do $$
declare
  t text;
begin
  foreach t in array array['star_lights', 'diary_metoo', 'bulletin_reports', 'site_signals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end
$$;

-- 2. 訪問者が呼べる関数 -------------------------------------------
-- どれも上限つき。上限は1人ずつではなく全体の数（IPは扱わない）。
-- 数えるのと足すのは、サーバーが何台あっても1つずつ順番に（pg_advisory_xact_lock）。

-- この24時間に灯った灯りの数（全体と、気持ちごと）
create or replace function public.star_lights_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'total', coalesce(sum(n), 0)::int,
    'by_mood', coalesce(jsonb_object_agg(mood, n), '{}'::jsonb))
  from (
    select mood, count(*)::int as n
    from public.star_lights
    where created_at > now() - interval '24 hours'
    group by mood
  ) as recent;
$$;

-- 灯りをひとつ足して、足したあとの数を返す。混み合っているときは足さずに ok=false。
create or replace function public.light_star(p_mood text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_mood is null or p_mood not in ('tired', 'lonely', 'sleepless', 'wordless', 'calm') then
    raise exception 'invalid mood' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 11);
  if (select count(*) from public.star_lights where created_at > now() - interval '10 minutes') >= 300 then
    return public.star_lights_summary() || jsonb_build_object('ok', false);
  end if;
  insert into public.star_lights (mood) values (p_mood);
  delete from public.star_lights where created_at < now() - interval '400 days';
  return public.star_lights_summary() || jsonb_build_object('ok', true);
end;
$$;

-- 日記に「私も」をひとつ届ける。プロフィール（固定IDの行）と、無い日記には届けない。
create or replace function public.send_metoo(p_post_id uuid)
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
  perform pg_advisory_xact_lock(71862026, 12);
  if (select count(*) from public.diary_metoo where created_at > now() - interval '10 minutes') >= 200 then
    return false;
  end if;
  insert into public.diary_metoo (post_id) values (p_post_id);
  return true;
end;
$$;

-- 掲示板の書き込みについて、管理人に知らせる（理由は4つから選ぶだけ。文章は受け取らない）
create or replace function public.report_bulletin(p_message_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or p_reason not in ('attack', 'personal', 'spam', 'worry') then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  if p_message_id is null
     or not exists (select 1 from public.bulletin_messages where id = p_message_id) then
    raise exception 'unknown message' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 13);
  if (select count(*) from public.bulletin_reports where created_at > now() - interval '1 hour') >= 30 then
    return false;
  end if;
  insert into public.bulletin_reports (message_id, reason) values (p_message_id, p_reason);
  return true;
end;
$$;

-- 掲示板を開いた・書きはじめた、をひとつ数える
create or replace function public.note_site_signal(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('bbs_seen', 'bbs_typing') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(71862026, 14);
  if (select count(*) from public.site_signals
      where kind = p_kind and created_at > now() - interval '10 minutes') >= 300 then
    return false;
  end if;
  insert into public.site_signals (kind) values (p_kind);
  delete from public.site_signals where created_at < now() - interval '400 days';
  return true;
end;
$$;

-- 3. 管理者だけが呼べる関数 ---------------------------------------

-- 直近 p_days 日の、小さな参加の数（YouTube分析ページのダッシュボードに出す）
create or replace function public.participation_summary(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  since timestamptz;
begin
  if not coalesce(public.is_site_admin(), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'invalid days' using errcode = '22023';
  end if;
  since := now() - make_interval(days => p_days);
  return jsonb_build_object(
    'days', p_days,
    'lights', (select coalesce(jsonb_object_agg(mood, n), '{}'::jsonb) from (
        select mood, count(*)::int as n from public.star_lights
        where created_at >= since group by mood) as l),
    'metoo', (select count(*)::int from public.diary_metoo where created_at >= since),
    'metoo_posts', (select coalesce(jsonb_agg(jsonb_build_object('post_id', post_id, 'title', title, 'n', n)
                                              order by n desc, title), '[]'::jsonb) from (
        select m.post_id, b.title, count(*)::int as n
        from public.diary_metoo m join public.blog_posts b on b.id = m.post_id
        where m.created_at >= since
        group by m.post_id, b.title
        order by n desc, b.title
        limit 5) as p),
    'reports', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from (
        select reason, count(*)::int as n from public.bulletin_reports
        where created_at >= since group by reason) as r),
    'bbs_seen', (select count(*)::int from public.site_signals where kind = 'bbs_seen' and created_at >= since),
    'bbs_typing', (select count(*)::int from public.site_signals where kind = 'bbs_typing' and created_at >= since),
    'bbs_posts', (select count(*)::int from public.bulletin_messages where created_at >= since and parent_id is null),
    'bbs_replies', (select count(*)::int from public.bulletin_messages where created_at >= since and parent_id is not null));
end;
$$;

-- ひとつの日記に届いた「私も」の数（日記の画面で、管理者にだけ出す）
create or replace function public.diary_metoo_count(p_post_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_site_admin(), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return (select count(*)::int from public.diary_metoo where post_id = p_post_id);
end;
$$;

-- 4. 呼べる人を決める ---------------------------------------------
revoke all on function public.star_lights_summary() from public;
revoke all on function public.light_star(text) from public;
revoke all on function public.send_metoo(uuid) from public;
revoke all on function public.report_bulletin(uuid, text) from public;
revoke all on function public.note_site_signal(text) from public;
revoke all on function public.participation_summary(integer) from public, anon;
revoke all on function public.diary_metoo_count(uuid) from public, anon;
grant execute on function public.star_lights_summary() to anon, authenticated;
grant execute on function public.light_star(text) to anon, authenticated;
grant execute on function public.send_metoo(uuid) to anon, authenticated;
grant execute on function public.report_bulletin(uuid, text) to anon, authenticated;
grant execute on function public.note_site_signal(text) to anon, authenticated;
grant execute on function public.participation_summary(integer) to authenticated;
grant execute on function public.diary_metoo_count(uuid) to authenticated;

-- 5. 「知らせる」が届いたら、管理人にメールする -------------------
-- 掲示板の新しい書き込みの通知（bbs-moderation.sql）と同じ送り方・同じ宛先。
-- 本文・名前・どの書き込みかは載せず、理由だけを載せる。
-- Resend のキー（Vault の resend_api_key）が無いときは何もしない。
create or replace function public.notify_bulletin_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  api_key text;
  label text;
begin
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if api_key is null then return new; end if;
  label := case new.reason
    when 'attack' then '傷つける言葉がある'
    when 'personal' then '個人が分かる情報がある'
    when 'spam' then '宣伝・関係のない内容'
    else '書いた人のことが心配' end;
  perform net.http_post(
    url => 'https://api.resend.com/emails',
    headers => jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || api_key),
    body => jsonb_build_object(
      'from', 'Hoshi no Umi <onboarding@resend.dev>',
      'to', jsonb_build_array('jun_yamada_0816@yahoo.co.jp'),
      'subject', '【星の海】掲示板の書き込みについて、知らせが届きました',
      'html', '<p>掲示板の書き込みについて、訪問者から知らせが届きました。</p><p>理由：' || label
        || '</p><p>通知には、本文やお名前は載せていません。</p><p><a href="https://hoshinoumi.org/#bulletin">掲示板をひらく</a></p>'
    )
  );
  return new;
exception when others then
  -- メールが送れなくても、知らせそのものは残す
  return new;
end;
$fn$;
revoke all on function public.notify_bulletin_report() from public, anon, authenticated;
drop trigger if exists on_bulletin_report_created on public.bulletin_reports;
create trigger on_bulletin_report_created after insert on public.bulletin_reports
  for each row execute function public.notify_bulletin_report();

notify pgrst, 'reload schema';
commit;
