\set ON_ERROR_STOP on
-- Runs after admin-rpc.sql (applied twice), connected as postgres like the SQL Editor and pg_cron.

-- Each entry point is wrapped exactly once and keeps its settings.
do $$
declare r record;
begin
  for r in select proname, prosrc, proconfig from pg_proc
           where pronamespace = 'public'::regnamespace
             and proname in ('sync_youtube', 'sync_youtube_scrape', 'restore_metrics_from_log',
                             'refresh_it_news', 'it_news_queue_all')
  loop
    assert (length(r.prosrc) - length(replace(r.prosrc, 'require_site_admin', '')))
           / length('require_site_admin') = 1, r.proname || ' should be guarded exactly once';
  end loop;
  assert (select proconfig::text from pg_proc where proname = 'refresh_it_news') like '%statement_timeout=110s%',
    'function settings must survive';
  assert (select position('require_site_admin' in prosrc) = 0 from pg_proc where proname = 'sv_youtube_write'),
    'helpers are closed by privilege, not wrapped';
end $$;

-- SQL Editor / pg_cron (no API request): everything still runs.
do $$
declare n int;
begin
  assert (select source from public.sync_youtube()) = 'api', 'sync should use the stored key';
  perform public.it_news_cron();
  perform public.restore_metrics_from_log();
  select done into n from public.refresh_it_news(30);
  assert n = 2, 'only the two https feeds are fetched, got ' || n;
end $$;

-- Feeds that are not https, or point at a bare address, were paused (not deleted) and cannot be re-enabled.
do $$
begin
  assert (select count(*) from public.it_news_sources) = 4, 'no feed is deleted';
  assert (select count(*) from public.it_news_sources where enabled) = 2;
  assert not (select enabled from public.it_news_sources where name = '暗号化なし');
  assert not (select enabled from public.it_news_sources where name = '内側の宛先');
  begin
    update public.it_news_sources set enabled = true where name = '内側の宛先';
    raise exception 're-enabling a bare address should fail';
  exception when check_violation then null;
  end;
  -- Pausing and renaming an existing bad row stays possible.
  update public.it_news_sources set name = '内側の宛先（休み）' where name = '内側の宛先';
end $$;

-- URL rule, case by case.
do $$
declare
  ok  text[] := array['https://zenn.dev/feed', 'https://news.google.com/rss/search?q=a+b&ceid=JP:ja',
                      'https://FEEDS.arstechnica.com/arstechnica/index', 'https://b.hatena.ne.jp',
                      'https://xn--eckwd4c7c.jp/feed'];
  bad text[] := array['http://zenn.dev/feed', 'https://127.0.0.1/', 'https://10.0.0.5/rss', 'https://localhost/rss',
                      'https://db.internal/rss', 'https://[::1]/rss', 'https://user:pass@zenn.dev/feed',
                      'https://zenn.dev:8443/feed', 'https://zenn.dev/a b', 'ftp://zenn.dev/feed',
                      'javascript:alert(1)', 'https://2130706433/', 'https://printer.local/feed', '', null,
                      'https://evil.example@zenn.dev/', 'file:///etc/passwd', 'https://zenn.dev' || repeat('/a', 300)];
  u text;
begin
  foreach u in array ok  loop assert public.it_news_is_feed_url(u), 'should accept ' || u; end loop;
  foreach u in array bad loop assert not public.it_news_is_feed_url(u), 'should refuse ' || coalesce(u, '(null)'); end loop;
end $$;

create function pg_temp.as_client(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), false);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), false);
end $$;

-- A signed-in account that is not the admin: every management function refuses.
select pg_temp.as_client('authenticated', '22222222-2222-4222-8222-222222222222');
set role authenticated;
do $$
declare f text; before int;
begin
  foreach f in array array[
    'select * from public.sync_youtube()', 'select * from public.restore_metrics_from_log()',
    'select * from public.refresh_it_news(3)', 'select public.it_news_queue_all()',
    'select * from public.sync_youtube_scrape()', 'select public.sv_youtube_write(''x'')',
    'select public.it_news_fetch_source(gen_random_uuid())', 'select public.it_news_cron()',
    'select public.youtube_api_key_status()', 'select public.set_youtube_api_key(repeat(''a'', 39))',
    'select public.clear_youtube_api_key()', 'select public.require_site_admin()']
  loop
    begin
      execute f;
      raise exception 'a non-admin login should not run: %', f;
    exception when insufficient_privilege then null;
    end;
  end loop;
  assert (select count(*) from public.sv_config where key = 'youtube_api_key') = 0, 'key row must be hidden';
end $$;
reset role;
do $$ begin
  assert (select value from public.sv_config where key = 'youtube_api_key') = 'test-not-a-real-key',
    'a refused call must not change the key';
end $$;

-- Visitor: nothing here is callable.
select pg_temp.as_client('anon', null);
set role anon;
do $$
declare f text;
begin
  foreach f in array array[
    'select * from public.sync_youtube()', 'select * from public.refresh_it_news(3)',
    'select public.it_news_queue_all()', 'select public.youtube_api_key_status()',
    'select public.set_youtube_api_key(repeat(''a'', 39))', 'select public.clear_youtube_api_key()',
    'select public.sv_youtube_write(''x'')', 'select public.require_site_admin()']
  loop
    begin
      execute f;
      raise exception 'a visitor should not run: %', f;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- The admin: buttons work; the key can be set, checked and cleared but never read back.
select pg_temp.as_client('authenticated', '11111111-1111-4111-8111-111111111111');
set role authenticated;
do $$
declare j jsonb; n int;
begin
  assert (select source from public.sync_youtube()) = 'api';
  perform public.restore_metrics_from_log();
  n := public.it_news_queue_all();
  assert n = 2, 'queue only enabled feeds';
  assert (select done from public.refresh_it_news(30)) = 2;

  -- Not readable or writable through the table, even for the admin.
  assert (select count(*) from public.sv_config where key = 'youtube_api_key') = 0;
  begin
    insert into public.sv_config (key, value) values ('youtube_api_key', 'direct-write');
    raise exception 'direct write of the key row should fail';
  exception when insufficient_privilege or unique_violation then null;
  end;
  update public.sv_config set value = 'direct-write' where key = 'youtube_api_key';
  -- Other settings rows are unaffected.
  insert into public.sv_config (key, value) values ('strategy', '{"a":1}');
  assert (select value from public.sv_config where key = 'strategy') = '{"a":1}';

  j := public.youtube_api_key_status();
  assert j = '{"registered": true, "tail": "-key"}'::jsonb, 'status shows only the tail, got ' || j;
  begin
    perform public.set_youtube_api_key('short');
    raise exception 'malformed key should be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_youtube_api_key('TESTONLY has spaces and <script>');
    raise exception 'malformed key should be refused';
  exception when invalid_parameter_value then null;
  end;
  perform public.set_youtube_api_key('  TESTONLY_not-a-real-key_0123456789  ');
  assert public.youtube_api_key_status() = '{"registered": true, "tail": "6789"}'::jsonb;
  perform public.clear_youtube_api_key();
  assert public.youtube_api_key_status() = '{"registered": false, "tail": null}'::jsonb;
  assert (select source from public.sync_youtube()) = 'scrape', 'without a key the sync falls back';

  -- Feed rules through the table, as the page writes them.
  insert into public.it_news_sources (name, url) values ('新しいフィード', 'https://gihyo.jp/feed/atom');
  begin
    insert into public.it_news_sources (name, url) values ('だめ', 'http://gihyo.jp/feed/atom');
    raise exception 'http feed should be refused';
  exception when check_violation then null;
  end;
  begin
    update public.it_news_sources set url = 'https://192.168.0.1/feed' where name = '新しいフィード';
    raise exception 'bare address should be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.it_news_sources (name, url) values (repeat('あ', 81), 'https://codezine.jp/rss');
    raise exception 'long name should be refused';
  exception when check_violation then null;
  end;
  update public.it_news_sources set enabled = false where name = '新しいフィード';
  update public.it_news_sources set enabled = true  where name = '新しいフィード';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.sv_config where value = 'direct-write'), 'direct write must not land';
end $$;

-- Server-side key (service_role): allowed.
select pg_temp.as_client('service_role', null);
set role service_role;
do $$ begin perform public.sync_youtube(); end $$;
reset role;
