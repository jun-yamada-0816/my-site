\set ON_ERROR_STOP on
-- Runs after admin-only.sql. Each block switches to a client role and asserts what it can do.

create function pg_temp.as_client(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), false);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), false);
end $$;

-- The admin row exists exactly once, even after running the file twice.
do $$ begin
  assert (select count(*) from public.site_admins) = 1, 'one admin expected';
  assert exists (select 1 from public.site_admins where user_id = '11111111-1111-4111-8111-111111111111');
end $$;

-- Visitor (anon): reads the diary, cannot write it, records a normal visit, oversized visits are refused.
select pg_temp.as_client('anon', null);
set role anon;
do $$
declare n int;
begin
  assert (select count(*) from public.blog_posts) = 2, 'anon should read the diary';
  begin
    insert into public.blog_posts (title, content) values ('x', 'x');
    raise exception 'anon insert into blog_posts should fail';
  exception when insufficient_privilege then null;
  end;
  insert into public.sv_site_visits (source, video_slug, path, referrer)
    values ('youtube', 'v120', '/', 'https://www.youtube.com/');
  begin
    insert into public.sv_site_visits (source, referrer) values ('youtube', repeat('a', 1001));
    raise exception 'oversized referrer should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.sv_site_visits (source, visited_at) values ('youtube', now() - interval '2 days');
    raise exception 'backdated visit should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.is_site_admin();
    raise exception 'anon should not execute is_site_admin';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Someone who signed up on their own: logged in, but not an admin.
select pg_temp.as_client('authenticated', '22222222-2222-4222-8222-222222222222');
set role authenticated;
do $$
declare n int;
begin
  assert not public.is_site_admin(), 'stranger must not be admin';
  assert (select count(*) from public.blog_posts) = 0, 'stranger sees no rows through the restriction';
  assert (select count(*) from public.sv_config) = 0, 'stranger must not read the API key';
  assert (select count(*) from public.sv_site_visits) = 0, 'stranger must not read visits';
  update public.blog_posts set title = 'defaced';
  get diagnostics n = row_count;
  assert n = 0, 'stranger must not update diary';
  delete from public.blog_posts;
  get diagnostics n = row_count;
  assert n = 0, 'stranger must not delete diary';
  begin
    insert into public.blog_posts (title, content) values ('spam', 'spam');
    raise exception 'stranger insert into blog_posts should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('music', 'evil.mp3');
    raise exception 'stranger upload should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.site_admins;
    raise exception 'site_admins should not be readable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The admin keeps every permission they had before.
select pg_temp.as_client('authenticated', '11111111-1111-4111-8111-111111111111');
set role authenticated;
do $$
declare n int;
begin
  assert public.is_site_admin(), 'admin must be admin';
  assert (select count(*) from public.blog_posts) = 2;
  assert (select count(*) from public.sv_config) = 1, 'admin reads config';
  assert (select count(*) from public.sv_site_visits) = 1, 'admin reads the one accepted visit';
  insert into public.blog_posts (title, content) values ('日記3', '本文3');
  update public.blog_posts set content = '直した' where title = '日記3';
  get diagnostics n = row_count;
  assert n = 1, 'admin update';
  delete from public.blog_posts where title = '日記3';
  get diagnostics n = row_count;
  assert n = 1, 'admin delete';
  insert into storage.objects (bucket_id, name) values ('music', 'song.mp3');
end $$;
reset role;

\echo admin-only checks passed
