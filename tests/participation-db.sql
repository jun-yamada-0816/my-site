\set ON_ERROR_STOP on
-- Runs after participation.sql has been applied twice (it must be safe to re-run).

-- Visitors: lights, validation, no direct table access.
set role anon;
set request.jwt.claim.role = 'anon';
do $$
declare r jsonb;
begin
  r := public.light_star('lonely');
  assert (r->>'ok')::boolean, 'light accepted: ' || r::text;
  assert (r->>'total')::int = 1 and (r->'by_mood'->>'lonely')::int = 1, 'summary after light: ' || r::text;
  r := public.light_star('calm');
  assert (r->>'total')::int = 2 and (r->'by_mood'->>'calm')::int = 1, 'second light: ' || r::text;
  assert (public.star_lights_summary()->>'total')::int = 2, 'summary readable without adding';
  begin perform public.light_star('evil'); raise exception 'unknown mood accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.light_star(null); raise exception 'null mood accepted';
  exception when invalid_parameter_value then null; end;
  begin perform * from public.star_lights; raise exception 'visitor read the lights table';
  exception when insufficient_privilege then null; end;
  begin insert into public.star_lights (mood) values ('calm'); raise exception 'visitor inserted directly';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;

-- The 24-hour window, pruning after 400 days, and the global limit.
insert into public.star_lights (mood, created_at) select 'tired', now() - interval '401 days' from generate_series(1, 3);
insert into public.star_lights (mood, created_at) select 'tired', now() - interval '25 hours' from generate_series(1, 5);
do $$
declare r jsonb;
begin
  r := public.light_star('tired');
  assert (r->>'total')::int = 3 and (r->'by_mood'->>'tired')::int = 1, '24h window only: ' || r::text;
  assert (select count(*) from public.star_lights where created_at < now() - interval '400 days') = 0, 'old lights pruned';
  assert (select count(*) from public.star_lights) = 8, 'recent and 25h-old lights kept';
end $$;
insert into public.star_lights (mood) select 'sleepless' from generate_series(1, 300);
do $$
declare r jsonb; n bigint;
begin
  select count(*) into n from public.star_lights;
  r := public.light_star('wordless');
  assert not (r->>'ok')::boolean, 'busy when 300 lights in 10 minutes';
  assert (select count(*) from public.star_lights) = n, 'nothing added while busy';
  assert (r->>'total')::int = 303, 'busy answer still carries the counts: ' || r::text;
end $$;
delete from public.star_lights where mood = 'sleepless';

-- "Me too" on diaries: only real diaries, never the profile row, no direct reads.
set role anon;
set request.jwt.claim.role = 'anon';
do $$ begin
  assert public.send_metoo('10000000-0000-4000-8000-000000000001') = true, 'me too accepted';
  begin perform public.send_metoo('00000000-0000-4000-8000-000000000095'); raise exception 'profile accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.send_metoo('10000000-0000-4000-8000-0000000000ff'); raise exception 'unknown diary accepted';
  exception when invalid_parameter_value then null; end;
  begin perform * from public.diary_metoo; raise exception 'visitor read me-too rows';
  exception when insufficient_privilege then null; end;
  begin perform public.diary_metoo_count('10000000-0000-4000-8000-000000000001'); raise exception 'visitor read a count';
  exception when insufficient_privilege then null; end;
  begin perform public.participation_summary(14); raise exception 'visitor read the summary';
  exception when insufficient_privilege then null; end;
end $$;

-- Reports: fixed reasons only, existing messages only, no direct reads.
do $$ begin
  assert public.report_bulletin('30000000-0000-4000-8000-000000000001', 'worry') = true, 'report accepted';
  begin perform public.report_bulletin('30000000-0000-4000-8000-000000000001', 'other'); raise exception 'unknown reason accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.report_bulletin('30000000-0000-4000-8000-0000000000ff', 'spam'); raise exception 'unknown message accepted';
  exception when invalid_parameter_value then null; end;
  begin perform * from public.bulletin_reports; raise exception 'visitor read reports';
  exception when insufficient_privilege then null; end;
end $$;

-- BBS signals: fixed kinds only.
do $$ begin
  assert public.note_site_signal('bbs_seen') = true, 'seen counted';
  assert public.note_site_signal('bbs_typing') = true, 'typing counted';
  begin perform public.note_site_signal('page_view'); raise exception 'unknown kind accepted';
  exception when invalid_parameter_value then null; end;
  begin perform * from public.site_signals; raise exception 'visitor read signals';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;

-- Re-running the SQL file with records in place keeps every record and a single trigger.
\i /work/participation.sql
do $$ begin
  assert (select count(*) from public.star_lights) = 8, 'lights kept after re-run';
  assert (select count(*) from public.diary_metoo) = 1, 'me too kept after re-run';
  assert (select count(*) from public.bulletin_reports) = 1, 'reports kept after re-run';
  assert (select count(*) from public.site_signals) = 2, 'signals kept after re-run';
  assert (select count(*) from pg_trigger where tgname = 'on_bulletin_report_created') = 1, 'one report trigger';
end $$;

-- The report email carries only the reason: no name, body or message id.
do $$ begin
  assert (select count(*) from public.test_emails) = 1, 'one report email';
  assert (select body->>'html' like '%書いた人のことが心配%' from public.test_emails), 'reason in the email';
  assert (select body::text not like '%PRIVATE%' and body::text not like '%30000000-%' from public.test_emails), 'no name, body or id in the email';
end $$;
-- No key: no email. A failing mail call must not lose the report.
delete from vault.decrypted_secrets;
select public.report_bulletin('30000000-0000-4000-8000-000000000001', 'spam');
insert into vault.decrypted_secrets values ('resend_api_key', 'fake-test-key');
create or replace function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as $$
begin raise exception 'mail service down'; end;
$$;
select public.report_bulletin('30000000-0000-4000-8000-000000000001', 'attack');
do $$ begin
  assert (select count(*) from public.test_emails) = 1, 'no email without a key, none when sending fails';
  assert (select count(*) from public.bulletin_reports) = 3, 'reports kept even when email fails';
end $$;
-- Global hourly limit on reports.
insert into public.bulletin_reports (message_id, reason)
  select '30000000-0000-4000-8000-000000000001', 'spam' from generate_series(1, 27);
do $$ begin
  assert public.report_bulletin('30000000-0000-4000-8000-000000000001', 'spam') = false, 'reports limited to 30 an hour';
end $$;
delete from public.bulletin_reports where reason = 'spam';

-- Admin-only numbers.
set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '20000000-0000-4000-8000-0000000000aa';
do $$ begin
  begin perform public.participation_summary(14); raise exception 'non-admin read the summary';
  exception when insufficient_privilege then null; end;
  begin perform public.diary_metoo_count('10000000-0000-4000-8000-000000000001'); raise exception 'non-admin read a count';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
do $$
declare s jsonb;
begin
  s := public.participation_summary(14);
  assert (s->'lights'->>'lonely')::int = 1 and (s->'lights'->>'calm')::int = 1, 'lights by mood: ' || s::text;
  assert (s->'lights'->>'tired')::int = 6, 'lights older than 24h still count in 14 days: ' || s::text;
  assert (s->>'metoo')::int = 1 and s->'metoo_posts'->0->>'title' = '夜のひとりごと', 'me too by diary: ' || s::text;
  assert (s->'reports'->>'worry')::int = 1 and (s->'reports'->>'attack')::int = 1, 'reports by reason: ' || s::text;
  assert (s->>'bbs_seen')::int = 1 and (s->>'bbs_typing')::int = 1, 'BBS signals: ' || s::text;
  assert (s->>'bbs_posts')::int = 1 and (s->>'bbs_replies')::int = 0, 'BBS posts: ' || s::text;
  assert public.diary_metoo_count('10000000-0000-4000-8000-000000000001') = 1, 'count for one diary';
  begin perform public.participation_summary(0); raise exception 'zero days accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
reset request.jwt.claim.role;
reset request.jwt.claim.sub;

\echo 'participation-db: all checks passed'
