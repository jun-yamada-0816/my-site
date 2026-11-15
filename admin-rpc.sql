-- ============================================================
-- 管理用の関数を「管理者本人だけ」に絞り、APIキーを画面から読めなくする（2026-11-15）
-- ============================================================
-- admin-only.sql で、表は「管理者の一覧に入っていないログインは何もできない」ようにしました。
-- けれども、表を直接さわる関数（security definer）はその制限の外にあります。
--   ・YouTube の取り込み（sync_youtube など）、控えからの書き戻し（restore_metrics_from_log）、
--     ITニュースの収集（refresh_it_news など）は、ログインさえしていれば管理者でなくても呼べました。
--   ・取り込みの部品（sv_youtube_write など）は、画面から呼ぶものではないのに呼べる状態でした
--     （Supabase は、作った関数をログイン済みの人にも実行できるようにするため）。
--   ・YouTube の APIキー（sv_config）は、管理者の画面にそのまま読み出していました。
--     画面に出ている間は、ページに悪いスクリプトが紛れ込むと持ち出せます。
--   ・ITニュースの収集元には http:// や、数字だけの宛先（Supabase の内側の機械など）も登録できました。
--
-- このファイルは、関数の中身を書き直さずに、次の5つをします。
--   1. 「管理者か」を確かめる関所 require_site_admin() を作る
--   2. 画面から呼ぶ関数の先頭に、その関所を足す（中身はそのまま包むだけ）
--   3. 画面から呼ばない部品は、ログインしていても呼べないようにする
--   4. APIキーの行を画面から読めなくし、登録・削除・「入っているか」だけを関数で受ける
--   5. 収集元の URL を https の、名前で引けるサイトだけにする
--
-- 前提：admin-only.sql を実行済みであること（is_site_admin を使います）。
-- まだ作っていない表や関数は飛ばします。何度実行しても安全です。
-- sync-youtube.sql・保存を守る.sql・it-news.sql を実行し直したら、関所が外れるので、
-- そのあとにもう一度このファイルを実行してください（最後の一覧の guarded が false なら外れています）。
-- 元に戻すときは、ファイル末尾の「元に戻す」を参照。
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.is_site_admin()') is null then
    raise exception '先に admin-only.sql を実行してください（is_site_admin がありません）';
  end if;
end
$$;

-- ------------------------------------------------------------
-- 1. 関所。通すのは次の3つだけ。それ以外はすべて断る（default deny）。
--      ・管理者の一覧（site_admins）に入っている人のログイン
--      ・サーバー側の鍵（service_role）での呼び出し
--      ・SQL Editor や pg_cron からの呼び出し（サイトの API を通っていないもの）
--    API を通った呼び出しは、DB から見ると必ず authenticator という名前でつながってきます。
--    「ログインの情報が付いていない」だけでは通さず、つなぎ方も合わせて確かめます。
-- ------------------------------------------------------------
create or replace function public.require_site_admin()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := auth.role();
begin
  if v_role = 'service_role' then
    return;
  end if;
  if v_role is null and session_user <> 'authenticator' then
    return;
  end if;
  if coalesce(public.is_site_admin(), false) then
    return;
  end if;
  raise exception '管理者だけが実行できます' using errcode = '42501';
end
$$;
-- 関所そのものは、関数の中からだけ呼ぶ。画面から直接は呼べない。
revoke all on function public.require_site_admin() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. 画面から呼ぶ関数の先頭に関所を足す。
--    もとの中身（declare … begin … end;）を、関所を先に通る外側の begin … end で包みます。
--    返す列・設定（search_path や時間切れ）・実行できる人は、もとのまま残ります。
-- ------------------------------------------------------------
do $$
declare
  f     text;
  r     record;
  v_def text;
  v_new text;
begin
  -- 包んだ結果の文法を、作るその場で確かめさせる（確かめない設定になっていると、壊れた関数ができうる）
  perform set_config('check_function_bodies', 'on', true);
  foreach f in array array[
    'sync_youtube', 'sync_youtube_api', 'sync_youtube_scrape',   -- YouTube の取り込み
    'restore_metrics_from_log',                                  -- 控えからの書き戻し
    'refresh_it_news', 'it_news_queue_all'                       -- ITニュースの収集
  ]
  loop
    for r in
      select p.oid, p.prosrc, l.lanname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language  l on l.oid = p.prolang
      where n.nspname = 'public' and p.proname = f and p.prokind = 'f'
    loop
      if position('require_site_admin' in r.prosrc) > 0 then
        continue;   -- すでに関所がある（2回目以降の実行）
      end if;
      if r.lanname <> 'plpgsql' then
        raise exception '% は plpgsql の関数ではないため、関所を足せません', f;
      end if;
      v_def := pg_get_functiondef(r.oid);
      if position(r.prosrc in v_def) = 0 then
        raise exception '% の定義を読み取れませんでした', f;
      end if;
      v_new := E'\nbegin\n'
            || E'  perform public.require_site_admin();  -- admin-rpc.sql が足した関所\n'
            || r.prosrc;
      -- もとの中身は一字も変えない。最後が「end;」ならそのまま外側を閉じ、
      -- 「end」（セミコロンなし）で終わっていて文法エラーになるときだけ、セミコロンを補う。
      begin
        execute replace(v_def, r.prosrc, v_new || E'\nend;\n');
      exception when syntax_error then
        execute replace(v_def, r.prosrc, v_new || E'\n;\nend;\n');
      end;
    end loop;
  end loop;
end
$$;

-- ------------------------------------------------------------
-- 3. 実行できる人を決め直す。
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  -- 画面から呼ばない部品。SQL Editor・pg_cron・ほかの関数の中からは、これまでどおり動く。
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (array[
      'sync_youtube_api', 'sync_youtube_scrape',
      'sv_youtube_write', 'sv_youtube_from_videos_json', 'sv_youtube_from_html', 'sv_youtube_fill_detail',
      'it_news_fetch_source', 'it_news_cron'
    ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;

  -- 画面のボタンから呼ぶもの。ログインは要るが、関所があるので管理者しか通れない。
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (array[
      'sync_youtube', 'restore_metrics_from_log', 'refresh_it_news', 'it_news_queue_all'
    ])
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end
$$;

-- ------------------------------------------------------------
-- 4. YouTube の APIキー。
--    sv_config の youtube_api_key の行は、API からは誰にも（管理者にも）読み書きさせない。
--    取り込みの関数は表の持ち主として動くので、これまでどおり読める。
--    画面は「入っているか・末尾4文字」「登録」「削除」の3つの関数だけを使う。
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.sv_config') is null then
    return;
  end if;
  drop policy if exists secret_rows_hidden on public.sv_config;
  create policy secret_rows_hidden on public.sv_config as restrictive for all to anon, authenticated
    using (key <> 'youtube_api_key') with check (key <> 'youtube_api_key');
end
$$;

create or replace function public.youtube_api_key_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  perform public.require_site_admin();
  select nullif(btrim(coalesce(value, '')), '') into v
  from public.sv_config where key = 'youtube_api_key';
  -- キーそのものは返さない。入れ間違いに気づけるよう、末尾4文字だけ。
  return jsonb_build_object('registered', v is not null,
                            'tail', case when v is null then null else right(v, 4) end);
end
$$;

create or replace function public.set_youtube_api_key(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_key, ''));
begin
  perform public.require_site_admin();
  if v !~ '^[A-Za-z0-9_-]{20,200}$' then
    raise exception 'APIキーの形ではありません（英数字と - _ だけ、20〜200文字）' using errcode = '22023';
  end if;
  insert into public.sv_config (key, value, updated_at) values ('youtube_api_key', v, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
end
$$;

create or replace function public.clear_youtube_api_key()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_site_admin();
  delete from public.sv_config where key = 'youtube_api_key';
end
$$;

revoke all on function public.youtube_api_key_status()  from public, anon;
revoke all on function public.set_youtube_api_key(text) from public, anon;
revoke all on function public.clear_youtube_api_key()   from public, anon;
grant execute on function public.youtube_api_key_status()  to authenticated;
grant execute on function public.set_youtube_api_key(text) to authenticated;
grant execute on function public.clear_youtube_api_key()   to authenticated;

-- ------------------------------------------------------------
-- 5. ITニュースの収集元。フィードを読みに行くのは Supabase の中からなので、
--    宛先は「https の、名前で引けるサイト」だけにする。
--    http://（暗号化なし）、数字だけの宛先、localhost、ポート番号つき、ID・パスワードつきは不可。
--    決まりに合わない行は「使う」にできないので、読みに行かれることもない。
--    ※ 読みに行った先が別の宛先へ転送（リダイレクト）した場合までは、ここでは止められません。
-- ------------------------------------------------------------
create or replace function public.it_news_is_feed_url(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and char_length(p) <= 500
     and p ~* '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]([/?#]\S*)?$'
     and p !~* '^https://[^/?#]*\.(local|localhost|internal|lan|home|corp|test|invalid|example)([/?#]|$)';
$$;

create or replace function public.it_news_sources_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if char_length(new.name) > 80 then
    raise exception '収集元の名前は80文字までです' using errcode = '23514';
  end if;
  -- すでにある行を「休む」にする・順番待ちに入れるだけの更新は通す。
  -- 新しく足す・URL を変える・「使う」に戻すときに確かめる。
  if tg_op = 'UPDATE' then
    if new.url is not distinct from old.url and not (new.enabled and not old.enabled) then
      return new;
    end if;
  end if;
  if not public.it_news_is_feed_url(new.url) then
    raise exception '収集元の URL は https:// で始まる、名前で引けるサイトのものにしてください'
      using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function public.it_news_sources_check() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.it_news_sources') is null then
    return;
  end if;
  drop trigger if exists it_news_sources_check on public.it_news_sources;
  -- いま登録されているもののうち、決まりに合わない行は消さずに「休む」にする
  update public.it_news_sources
     set enabled = false, queued_at = null,
         last_status = 'https の宛先ではないため休ませました（admin-rpc.sql）'
   where enabled and not public.it_news_is_feed_url(url);
  create trigger it_news_sources_check
    before insert or update of url, name, enabled on public.it_news_sources
    for each row execute function public.it_news_sources_check();
end
$$;

notify pgrst, 'reload schema';
commit;

-- ------------------------------------------------------------
-- 6. 確認：表を直接さわれる関数（security definer）の一覧。
--    ・上の2の関数は guarded が true になっていること
--    ・visitor_can（ログインしていない人が呼べる）が true なのは、訪問者のための関数だけであること
--      （星の灯り・星の小瓶・足あと・利用回数など。取り込みや管理の関数が true なら知らせてください）
-- ------------------------------------------------------------
select p.proname as function_name,
       position('require_site_admin' in p.prosrc) > 0 as guarded,
       has_function_privilege('anon', p.oid, 'execute') as visitor_can,
       has_function_privilege('authenticated', p.oid, 'execute') as login_can
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by 1;

-- ------------------------------------------------------------
-- 元に戻す（必要なときだけ、1行ずつ実行）
--   関所を外す:           もとの SQL（sync-youtube.sql・保存を守る.sql・it-news.sql）を実行し直す
--   APIキーの行を戻す:    drop policy secret_rows_hidden on public.sv_config;
--   収集元の決まりを外す: drop trigger it_news_sources_check on public.it_news_sources;
-- ------------------------------------------------------------
