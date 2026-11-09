\set ON_ERROR_STOP on
-- A minimal stand-in for the Supabase pieces participation.sql relies on.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.role() returns text language sql as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.blog_posts (
  id uuid primary key default gen_random_uuid(), title text not null,
  content text not null, created_at timestamptz default now()
);
alter table public.blog_posts enable row level security;
grant select on public.blog_posts to anon, authenticated;
create policy select_all on public.blog_posts for select using (true);

create table public.bulletin_messages (
  id uuid primary key default gen_random_uuid(), author_name text not null,
  content text not null, created_at timestamptz default now(),
  parent_id uuid references public.bulletin_messages(id) on delete cascade, edited_at timestamptz
);
alter table public.bulletin_messages enable row level security;
grant select on public.bulletin_messages to anon, authenticated;
create policy select_all on public.bulletin_messages for select using (true);

-- Same shape as admin-only.sql.
create table public.site_admins (user_id uuid primary key);
alter table public.site_admins enable row level security;
revoke all on public.site_admins from public, anon, authenticated;
create function public.is_site_admin() returns boolean language sql stable security definer
  set search_path = '' as $$
  select exists (select 1 from public.site_admins where user_id = auth.uid());
$$;
revoke all on function public.is_site_admin() from public, anon;
grant execute on function public.is_site_admin() to authenticated;
insert into public.site_admins values ('20000000-0000-4000-8000-000000000001');

-- Resend through pg_net + Vault, captured instead of sent.
create schema vault;
create table vault.decrypted_secrets(name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('resend_api_key', 'fake-test-key');
create schema net;
create table public.test_emails(body jsonb);
create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as $$
begin insert into public.test_emails values (body); return 1; end;
$$;

insert into public.blog_posts (id, title, content) values
  ('00000000-0000-4000-8000-000000000095', 'プロフィール', 'profile row, not a diary'),
  ('10000000-0000-4000-8000-000000000001', '夜のひとりごと', 'PRIVATE DIARY');
insert into public.bulletin_messages (id, author_name, content) values
  ('30000000-0000-4000-8000-000000000001', 'PRIVATE NAME', 'PRIVATE BODY');
