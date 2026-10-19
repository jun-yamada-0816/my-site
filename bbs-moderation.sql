-- Run in Supabase SQL Editor BEFORE deploying the new frontend/API.
-- This immediately closes old direct posting/editing. Reading/deletion stays available.
begin;

alter table public.bulletin_messages
  add column if not exists parent_id uuid references public.bulletin_messages(id) on delete cascade,
  add column if not exists edited_at timestamptz;
alter table public.bulletin_messages enable row level security;
drop policy if exists insert_all on public.bulletin_messages;
drop policy if exists admin_update on public.bulletin_messages;
revoke insert, update on public.bulletin_messages from public, anon, authenticated;
grant select on public.bulletin_messages to anon, authenticated;
grant select, insert, update, delete on public.bulletin_messages to service_role;

-- A second barrier, including requests through SECURITY DEFINER RPCs carrying a client JWT.
create or replace function public.bbs_require_server_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') or auth.role() in ('anon', 'authenticated') then
    raise exception 'Use the moderated submission endpoint' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.bbs_require_server_write() from public, anon, authenticated;
drop trigger if exists bbs_server_write_only on public.bulletin_messages;
create trigger bbs_server_write_only before insert or update on public.bulletin_messages
  for each row execute function public.bbs_require_server_write();

-- Only keyed, daily IP hashes and counters; no post text or names are stored here.
create table if not exists public.bbs_submission_limits (
  key text not null,
  day date not null,
  attempts integer not null,
  last_attempt timestamptz not null,
  primary key (key, day)
);
alter table public.bbs_submission_limits enable row level security;
revoke all on public.bbs_submission_limits from public, anon, authenticated;

create or replace function public.bbs_take_submission_slot(p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  t timestamptz := clock_timestamp();
  d date := (t at time zone 'UTC')::date;
  visitor public.bbs_submission_limits%rowtype;
  total integer;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid key';
  end if;
  -- Serialize admissions across server instances; counts include rejected attempts.
  perform pg_advisory_xact_lock(71862026, 1);
  delete from public.bbs_submission_limits where day < d - 1;
  select * into visitor from public.bbs_submission_limits where key = p_key and day = d;
  select attempts into total from public.bbs_submission_limits where key = 'global' and day = d;
  if coalesce(total, 0) >= 200 or coalesce(visitor.attempts, 0) >= 20
     or visitor.last_attempt > t - interval '30 seconds' then
    return false;
  end if;
  insert into public.bbs_submission_limits as limits (key, day, attempts, last_attempt)
    values (p_key, d, 1, t), ('global', d, 1, t)
    on conflict (key, day) do update
      set attempts = limits.attempts + 1, last_attempt = excluded.last_attempt;
  return true;
end;
$$;
revoke all on function public.bbs_take_submission_slot(text) from public, anon, authenticated;
grant execute on function public.bbs_take_submission_slot(text) to service_role;

-- Replace the existing notification. Never include names, text, or quoted replies.
-- pg_net and Vault are already used by the site's optional Resend integration.
create or replace function public.notify_new_bulletin_message()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare api_key text;
begin
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if api_key is null then return new; end if;
  perform net.http_post(
    url => 'https://api.resend.com/emails',
    headers => jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || api_key),
    body => jsonb_build_object(
      'from', 'Hoshi no Umi <onboarding@resend.dev>',
      'to', jsonb_build_array('jun_yamada_0816@yahoo.co.jp'),
      'subject', '【星の海】掲示板に新しい書き込みがありました',
      'html', '<p>掲示板に新しい書き込みがあります。</p><p>通知にはお名前や本文を載せていません。</p><p><a href="https://hoshinoumi.org/#bulletin">掲示板をひらく</a></p>'
    )
  );
  return new;
exception when others then
  -- Optional email failure must not cause a successful post to be retried.
  return new;
end;
$fn$;

-- Keep the existing notification trigger if installed; do not enable email for new users.
notify pgrst, 'reload schema';
commit;
