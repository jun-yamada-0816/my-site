\set ON_ERROR_STOP on
-- Extra stand-ins for bottle-usage.sql, on top of participation-db-setup.sql.
-- The footprint counter on the top page (docs/supabase-setup.md).
create table public.site_visits (id integer primary key, count bigint not null default 0);
alter table public.site_visits enable row level security;
-- A second diary, to rank diaries by views.
insert into public.blog_posts (id, title, content) values
  ('10000000-0000-4000-8000-000000000002', '朝のひとりごと', 'PRIVATE DIARY 2');
