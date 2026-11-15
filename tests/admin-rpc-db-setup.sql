\set ON_ERROR_STOP on
-- Runs after admin-only-db-setup.sql and admin-only.sql (admin = 1111…, stranger = 2222…).
-- Stand-ins for the functions that sync-youtube.sql, 保存を守る.sql and it-news.sql create in production.
-- They keep the shapes that matter to admin-rpc.sql: declare blocks, "returns table" with return query,
-- function-level settings, a body that ends without a semicolon, and Supabase's default grants.

-- PostgREST connects as authenticator and switches to anon / authenticated.
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;

create table public.it_news_sources (
  id uuid primary key default gen_random_uuid(), name text not null, url text not null unique,
  genre text not null default 'other', enabled boolean not null default true,
  sort_order int not null default 100, queued_at timestamptz, last_status text
);
alter table public.it_news_sources enable row level security;
create policy "admin_all" on public.it_news_sources for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy site_admin_only on public.it_news_sources as restrictive for all to authenticated
  using ((select public.is_site_admin())) with check ((select public.is_site_admin()));
insert into public.it_news_sources (name, url) values
  ('安全なフィード', 'https://example-feed.jp/rss.xml'),
  ('検索つき', 'https://news.google.com/rss/search?q=AI+when:2d&hl=ja&gl=JP&ceid=JP:ja'),
  ('暗号化なし', 'http://old.example-feed.jp/rss.xml'),
  ('内側の宛先', 'https://169.254.169.254/latest/meta-data/');
create table public.work_log (id bigserial primary key, what text);

create function public.it_news_fetch_source(p_id uuid) returns int
language plpgsql security definer set search_path = public as $fn$
begin
  insert into work_log (what) values ('fetch');
  return 1;
end;
$fn$;

create function public.it_news_queue_all() returns int
language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  update it_news_sources set queued_at = now() where enabled;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

create function public.refresh_it_news(p_limit int default 4)
returns table(done int, added int, remaining int)
language plpgsql security definer set search_path = public set statement_timeout = '110s' as $fn$
declare
  r record;
  d int := 0;
  a int := 0;
begin
  if not exists (select 1 from it_news_sources where enabled and queued_at is not null) then
    perform it_news_queue_all();
  end if;
  for r in select id from it_news_sources where enabled and queued_at is not null
           order by sort_order, name limit greatest(1, least(coalesce(p_limit, 4), 30))
  loop
    a := a + it_news_fetch_source(r.id);
    update it_news_sources set queued_at = null where id = r.id;
    d := d + 1;
  end loop;
  return query
    select d, a, (select count(*)::int from it_news_sources where enabled and queued_at is not null);
end;
$fn$;

create function public.it_news_cron() returns void
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  for r in select id from it_news_sources where enabled loop
    perform it_news_fetch_source(r.id);
  end loop;
end;
$fn$;

create function public.sv_youtube_write(p_id text) returns int
language plpgsql security definer set search_path = public as $fn$
begin
  insert into work_log (what) values ('write ' || p_id);
  return 1;
end;
$fn$;

create function public.sync_youtube_scrape()
returns table(source text, new_videos int)
language plpgsql security definer set search_path = public as $fn$
begin
  return query select 'scrape'::text, sv_youtube_write('scrape');
end;
$fn$;

-- Body ends with "end" and a trailing comment, and reads the key the way production does.
create function public.sync_youtube()
returns table(source text, new_videos int)
language plpgsql security definer set search_path = public as $fn$
declare
  has_key boolean;
begin
  select nullif(btrim(coalesce(value,'')), '') is not null into has_key
  from sv_config where key = 'youtube_api_key';
  if coalesce(has_key, false) then
    return query select 'api'::text, sv_youtube_write('api');
    return;
  end if;
  return query select * from sync_youtube_scrape();
end  -- 最後にセミコロンがない書き方
$fn$;

create function public.restore_metrics_from_log() returns table(restored int)
language plpgsql security definer set search_path = public as $fn$
begin
  return query select 0;
end;
$fn$;

-- Supabase's default privileges: every new function is executable by the API roles.
grant execute on all functions in schema public to anon, authenticated, service_role;
revoke execute on function public.is_site_admin() from anon;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
revoke all on public.site_admins from anon, authenticated;
