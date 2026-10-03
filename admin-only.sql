-- ============================================================
-- 書き込み・管理の権限を「管理者本人だけ」に絞る（2026-10-03）
-- ============================================================
-- これまでの権限は auth.role() = 'authenticated'、つまり
-- 「Supabase にログインできる人なら誰でも管理者」という前提でした。
-- ところが本番は新規登録（Sign up）が開いたままで、メールアドレスがあれば
-- 誰でもアカウントを作れます。作った人は日記の書き換え・掲示板の削除・
-- 音楽のアップロード、分析データや YouTube の API キーの読み取りまでできてしまいます。
--
-- このファイルは、既存の権限（permissive policy）には触らず、
-- 「ログインしている人は、管理者の一覧に入っていなければ何もできない」という
-- 制限（restrictive policy）を重ねます。ログインしていない訪問者
-- （日記を読む・掲示板を読む・訪問を記録する）には影響しません。
--
-- 実行のしかた
--   1. 先に Supabase の Authentication → Sign In / Providers で
--      「Allow new users to sign up」をオフにする（これがいちばん大事）
--   2. Authentication → Users で、自分の User UID をコピーする
--      （Vercel の BBS_ADMIN_USER_ID と同じ値。メールアドレスではありません）
--   3. 下の YOUR_ADMIN_USER_ID_HERE をその UID に置き換えて、全体を SQL Editor で実行する
--   4. 最後に出る一覧に、自分以外のアカウントがないか確かめる
--
-- 何度実行しても安全です。2回目からは UID を置き換えなくても通ります。
-- 元に戻すとき（自分も書き込めなくなった場合など）は、ファイル末尾の「元に戻す」を参照。
-- ============================================================

begin;

-- 1. 管理者の一覧。誰からも読めない表にして、下の関数からだけ参照する。
create table if not exists public.site_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.site_admins enable row level security;
revoke all on public.site_admins from public, anon, authenticated;

do $$
declare
  admin_id text := 'YOUR_ADMIN_USER_ID_HERE';
begin
  if admin_id = 'YOUR_ADMIN_USER_ID_HERE' then
    if exists (select 1 from public.site_admins) then
      return;  -- 2回目以降の実行。登録済みの管理者をそのまま使う
    end if;
    raise exception 'YOUR_ADMIN_USER_ID_HERE を管理者の User UID に置き換えてから実行してください';
  end if;
  if admin_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'User UID の形ではありません（メールアドレスではなく UID を入れてください）';
  end if;
  if not exists (select 1 from auth.users where id = admin_id::uuid) then
    raise exception 'その User UID のアカウントが Authentication → Users に見つかりません';
  end if;
  insert into public.site_admins (user_id) values (admin_id::uuid) on conflict do nothing;
end
$$;

-- 2. 「いまログインしている人は管理者か」。site_admins を読むために security definer。
create or replace function public.is_site_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.site_admins where user_id = auth.uid());
$$;
revoke all on function public.is_site_admin() from public, anon;
grant execute on function public.is_site_admin() to authenticated;

-- 3. サイトと分析ページの表に、管理者以外のログインを締め出す制限を重ねる。
--    まだ作っていない表は飛ばす。RLS が無効の表は制限が効かないので警告を出す
--    （勝手に有効にすると訪問者が読めなくなる表があり得るため、ここでは変えない）。
do $$
declare
  t text;
begin
  foreach t in array array[
    -- サイト本体
    'blog_posts', 'bulletin_messages', 'music_tracks', 'site_visits',
    -- ITニュース
    'it_news_sources', 'it_news_items',
    -- YouTube分析
    'sv_videos', 'sv_posts', 'sv_metrics', 'sv_site_visits',
    'sv_channel_daily', 'sv_channels', 'sv_config', 'sv_metrics_log'
  ]
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass('public.' || t)) then
      raise warning '% は RLS が無効です。制限を足しても効きません', t;
    end if;
    execute format('drop policy if exists site_admin_only on public.%I', t);
    execute format(
      'create policy site_admin_only on public.%I as restrictive for all to authenticated '
      'using ((select public.is_site_admin())) with check ((select public.is_site_admin()))', t);
  end loop;
end
$$;

-- 音楽ファイルの置き場（Storage）も同じ。公開バケットの再生（URLで読む）には影響しない。
drop policy if exists site_admin_only on storage.objects;
create policy site_admin_only on storage.objects as restrictive for all to authenticated
  using ((select public.is_site_admin())) with check ((select public.is_site_admin()));

-- 4. 訪問の記録（誰でも書き込める表）に上限を付ける。
--    index.html の記録スクリプトも同じ長さに切ってから送っている。
--    記録時刻は既定値（いま）のままのものだけ受け付ける。
do $$
begin
  if to_regclass('public.sv_site_visits') is not null then
    drop policy if exists visit_insert_limits on public.sv_site_visits;
    create policy visit_insert_limits on public.sv_site_visits as restrictive for insert to anon
      with check (
        char_length(coalesce(source, ''))     <= 40  and
        char_length(coalesce(video_slug, '')) <= 80  and
        char_length(coalesce(path, ''))       <= 300 and
        char_length(coalesce(referrer, ''))   <= 1000 and
        visited_at between now() - interval '1 hour' and now() + interval '1 hour'
      );
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;

-- 5. 確認：登録されているアカウント。is_site_admin が false の行は、自分で作った覚えがなければ
--    Authentication → Users から削除し、YouTube の API キー（sv_config）を作り直してください。
select u.id, u.email, u.created_at, u.last_sign_in_at,
       (a.user_id is not null) as is_site_admin
from auth.users u
left join public.site_admins a on a.user_id = u.id
order by u.created_at;

-- ------------------------------------------------------------
-- 元に戻す（必要なときだけ、1行ずつ実行）
--   管理者を足す:   insert into public.site_admins (user_id) values ('<User UID>');
--   制限を外す:     drop policy site_admin_only on public.<表の名前>;
--                   drop policy site_admin_only on storage.objects;
-- ------------------------------------------------------------
