\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.role() returns text language sql as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create table public.bulletin_messages (
  id uuid primary key default gen_random_uuid(), author_name text not null,
  content text not null, created_at timestamptz default now()
);
alter table public.bulletin_messages enable row level security;
grant all on public.bulletin_messages to anon, authenticated, service_role;
create policy select_all on public.bulletin_messages for select using (true);
create policy insert_all on public.bulletin_messages for insert with check (true);
create policy admin_update on public.bulletin_messages for update using (auth.role() = 'authenticated');
create schema vault;
create table vault.decrypted_secrets(name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('resend_api_key', 'fake-test-key');
create schema net;
create table public.test_emails(body jsonb);
create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as $$
begin insert into public.test_emails values (body); return 1; end;
$$;
