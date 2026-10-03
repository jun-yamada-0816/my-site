\set ON_ERROR_STOP on
-- Minimal stand-ins for the Supabase pieces admin-only.sql relies on.
-- Policies mirror docs/supabase-setup.md and the shorts-analytics SQL (auth.role() = 'authenticated').
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now(),
  last_sign_in_at timestamptz);
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'admin@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'stranger@example.test');

create table public.blog_posts (
  id uuid default gen_random_uuid() primary key, title text not null, content text not null,
  created_at timestamptz default now()
);
alter table public.blog_posts enable row level security;
create policy "select_all"   on public.blog_posts for select using (true);
create policy "admin_insert" on public.blog_posts for insert with check (auth.role() = 'authenticated');
create policy "admin_update" on public.blog_posts for update using (auth.role() = 'authenticated');
create policy "admin_delete" on public.blog_posts for delete using (auth.role() = 'authenticated');
insert into public.blog_posts (title, content) values ('日記1', '本文1'), ('日記2', '本文2');

create table public.sv_config (key text primary key, value text, updated_at timestamptz default now());
alter table public.sv_config enable row level security;
create policy "owner_all" on public.sv_config for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
insert into public.sv_config values ('youtube_api_key', 'test-not-a-real-key');

create table public.sv_site_visits (
  id bigserial primary key, visited_at timestamptz default now(),
  source text, video_slug text, path text, referrer text
);
alter table public.sv_site_visits enable row level security;
create policy "public_insert" on public.sv_site_visits for insert with check (true);
create policy "owner_select" on public.sv_site_visits for select using (auth.role() = 'authenticated');

create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create policy "public_read"  on storage.objects for select using (bucket_id = 'music');
create policy "admin_upload" on storage.objects for insert
  with check (bucket_id = 'music' and auth.role() = 'authenticated');

-- Supabase grants table privileges broadly and relies on RLS.
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on storage.objects to anon, authenticated;
