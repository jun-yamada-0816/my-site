\set ON_ERROR_STOP on
-- Runs after participation.sql and then bottle-usage.sql (twice: it must be safe to re-run).

-- Visitors: every kind the page sends is accepted by both the function and the table constraint.
set role anon;
set request.jwt.claim.role = 'anon';
do $$
declare k text;
begin
  foreach k in array array[
    'visit', 'bottle_seen', 'bottle_pick', 'bottle_throw', 'bottle_thanks', 'lights_seen',
    'news_seen', 'news_tap', 'profile_seen', 'blog_seen', 'diary_open', 'bbs_seen', 'bbs_typing',
    'mikuji_seen', 'mikuji_draw', 'welcome_seen', 'welcome_tap', 'promise_seen', 'mood_seen', 'mood_used',
    'coping_seen', 'affirm_next', 'services_seen', 'services_tap', 'links_seen', 'links_tap',
    'support_seen', 'help_tap', 'sos_open'] loop
    assert public.note_usage(k) = true, 'kind accepted: ' || k;
  end loop;
  begin perform public.note_usage('page_view'); raise exception 'unknown kind accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.note_usage(null); raise exception 'null kind accepted';
  exception when invalid_parameter_value then null; end;
  -- The older function keeps working for pages that still call it.
  assert public.note_site_signal('bbs_seen') = true, 'participation.sql function still counts';
  begin perform * from public.site_signals; raise exception 'visitor read usage rows';
  exception when insufficient_privilege then null; end;
  begin insert into public.site_signals (kind) values ('visit'); raise exception 'visitor inserted usage directly';
  exception when insufficient_privilege then null; end;
  begin perform public.site_usage_summary(); raise exception 'visitor read the usage summary';
  exception when insufficient_privilege then null; end;
  begin perform public.diary_view_counts(); raise exception 'visitor read diary view counts';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;
do $$ begin
  assert (select count(*) from public.site_signals) = 30, '29 kinds once + one legacy call';
  begin insert into public.site_signals (kind) values ('page_view'); raise exception 'constraint let an unknown kind in';
  exception when check_violation then null; end;
end $$;

-- Per-kind limit (300 in 10 minutes) and pruning after 400 days.
insert into public.site_signals (kind, created_at) select 'visit', now() - interval '401 days' from generate_series(1, 4);
insert into public.site_signals (kind) select 'visit' from generate_series(1, 299);
do $$
declare n bigint;
begin
  select count(*) into n from public.site_signals;
  assert public.note_usage('visit') = false, 'busy at 300 visits in 10 minutes';
  assert (select count(*) from public.site_signals) = n, 'nothing added while busy';
  assert public.note_usage('news_seen') = true, 'other kinds are not blocked';
  assert (select count(*) from public.site_signals where created_at < now() - interval '400 days') = 0, 'old usage pruned';
end $$;
delete from public.site_signals;

-- Diary views: real diaries only, never the profile row, no direct reads.
set role anon;
set request.jwt.claim.role = 'anon';
do $$ begin
  assert public.note_diary_view('10000000-0000-4000-8000-000000000001') = true, 'diary view counted';
  begin perform public.note_diary_view('00000000-0000-4000-8000-000000000095'); raise exception 'profile counted as a diary';
  exception when invalid_parameter_value then null; end;
  begin perform public.note_diary_view('10000000-0000-4000-8000-0000000000ff'); raise exception 'unknown diary counted';
  exception when invalid_parameter_value then null; end;
  begin perform public.note_diary_view(null); raise exception 'null diary counted';
  exception when invalid_parameter_value then null; end;
  begin perform * from public.diary_views; raise exception 'visitor read diary views';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;
insert into public.diary_views (post_id) select '10000000-0000-4000-8000-000000000001' from generate_series(1, 299);
do $$ begin
  assert public.note_diary_view('10000000-0000-4000-8000-000000000001') = false, 'diary views limited to 300 in 10 minutes';
end $$;
delete from public.diary_views;

-- Bottles: only the fixed recipients and words; the thrower gets an id and a private key.
set role anon;
set request.jwt.claim.role = 'anon';
do $$
declare r jsonb; b jsonb; s jsonb;
begin
  assert public.sea_bottle_count() = 0, 'empty sea';
  assert public.pick_bottle() is null, 'nothing to pick from an empty sea';
  begin perform public.throw_bottle('everyone', 'here'); raise exception 'unknown recipient accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.throw_bottle('lonely', '<script>'); raise exception 'free text accepted as a word';
  exception when invalid_parameter_value then null; end;
  begin perform public.throw_bottle(null, 'here'); raise exception 'null recipient accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.throw_bottle('lonely', null); raise exception 'null word accepted';
  exception when invalid_parameter_value then null; end;

  r := public.throw_bottle('lonely', 'here');
  assert (r->>'ok')::boolean and r->>'id' is not null and r->>'key' is not null and r->>'id' <> r->>'key', 'thrown: ' || r::text;
  perform set_config('test.first_id', r->>'id', false);   -- kept for the next block
  assert public.sea_bottle_count() = 1, 'one bottle in the sea';
  begin perform * from public.sea_bottles; raise exception 'visitor read the bottles table';
  exception when insufficient_privilege then null; end;
  begin insert into public.sea_bottles (to_kind, word) values ('lonely', 'here'); raise exception 'visitor inserted a bottle directly';
  exception when insufficient_privilege then null; end;
  begin perform * from public.sea_bottle_rate; raise exception 'visitor read the rate table';
  exception when insufficient_privilege then null; end;

  -- Picking: fixed fields only, the time rounded to the hour, no key, and the count goes up.
  b := public.pick_bottle();
  assert b->>'id' = r->>'id' and b->>'to' = 'lonely' and b->>'word' = 'here' and (b->>'from_admin')::boolean = false, 'picked: ' || b::text;
  assert not (b ? 'key') and not (b ? 'owner_key') and not (b ? 'picks'), 'no key or counts for the picker: ' || b::text;
  assert (b->>'at')::timestamptz = date_trunc('hour', now()), 'time rounded to the hour: ' || b::text;
  s := public.bottle_status(array[(r->>'key')::uuid]);
  assert jsonb_array_length(s) = 1 and (s->0->>'picks')::int = 1 and (s->0->>'thanks')::int = 0, 'status after a pick: ' || s::text;
  -- The id handed to pickers is not the key: it cannot be used to read the status.
  assert public.bottle_status(array[(r->>'id')::uuid]) = '[]'::jsonb, 'status needs the key, not the id';
  assert public.bottle_status('{}') = '[]'::jsonb, 'no keys, no rows';

  -- Skipping: my own and already-seen bottles are not handed back.
  assert public.pick_bottle(null, array[(r->>'id')::uuid]) is null, 'skipped bottle is not picked';
  begin perform public.pick_bottle('nobody'); raise exception 'unknown recipient accepted when picking';
  exception when invalid_parameter_value then null; end;
  begin perform public.pick_bottle(null, (select array_agg(gen_random_uuid()) from generate_series(1, 201)));
    raise exception 'more than 200 ids accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.bottle_status((select array_agg(gen_random_uuid()) from generate_series(1, 21)));
    raise exception 'more than 20 keys accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.bottle_status(null); raise exception 'null keys accepted';
  exception when invalid_parameter_value then null; end;

  -- Thanks.
  assert public.thank_bottle((r->>'id')::uuid) = true, 'thanks accepted';
  assert public.thank_bottle('40000000-0000-4000-8000-0000000000ff') = false, 'unknown bottle: no thanks, no error';
  begin perform public.thank_bottle(null); raise exception 'null id accepted';
  exception when invalid_parameter_value then null; end;
  s := public.bottle_status(array[(r->>'key')::uuid]);
  assert (s->0->>'picks')::int = 1 and (s->0->>'thanks')::int = 1, 'status after thanks: ' || s::text;
end $$;

-- Order: the recipient that matches tonight's light first, then the least-picked.
do $$
declare first_id text := current_setting('test.first_id'); a jsonb; b jsonb; c jsonb; got jsonb;
begin
  a := public.throw_bottle('sleepless', 'same_night');
  b := public.throw_bottle('sleepless', 'enough');
  c := public.throw_bottle('anyone', 'see_you');
  got := public.pick_bottle('sleepless');
  assert got->>'to' = 'sleepless', 'matching recipient first: ' || got::text;
  got := public.pick_bottle('sleepless', array[(got->>'id')::uuid]);
  assert got->>'to' = 'sleepless', 'second matching bottle next: ' || got::text;
  -- Without a recipient: the only bottle never picked comes before the ones picked once.
  got := public.pick_bottle();
  assert got->>'id' = c->>'id', 'least-picked first: ' || got::text;
  -- All four have been picked once now; skipping three leaves the fourth.
  got := public.pick_bottle(null, array[(a->>'id')::uuid, (b->>'id')::uuid, (c->>'id')::uuid]);
  assert got->>'id' = first_id, 'the one bottle not skipped: ' || got::text;
  assert public.sea_bottle_count() = 4, 'four bottles in the sea';
end $$;
reset role;
reset request.jwt.claim.role;
do $$ begin
  assert (select sum(picks) from public.sea_bottles) = 5 and (select sum(thanks) from public.sea_bottles) = 1, 'five picks and one thanks recorded';
  assert (select count(*) from public.sea_bottles where from_admin) = 0, 'visitor bottles are not marked as the admin''s';
  assert (select count(*) from public.sea_bottle_rate) between 1 and 2, 'picks and thanks are tallied per ten minutes';
end $$;

-- Limits: past 300 picks in ten minutes a bottle is still handed over but not counted; thanks are refused.
insert into public.sea_bottle_rate (bucket, picks, thanks)
  select to_timestamp(floor(extract(epoch from now()) / 600) * 600) + i * interval '10 minutes', 300, 300
  from generate_series(0, 1) as i   -- this ten minutes and the next, in case the clock turns over mid-test
  on conflict (bucket) do update set picks = 300, thanks = 300;
insert into public.sea_bottle_rate (bucket, picks) values (now() - interval '2 days', 7);
do $$
declare before_picks bigint; before_thanks bigint; got jsonb;
begin
  select sum(picks), sum(thanks) into before_picks, before_thanks from public.sea_bottles;
  got := public.pick_bottle();
  assert got->>'id' is not null, 'a bottle is still handed over when busy';
  assert (select sum(picks) from public.sea_bottles) = before_picks, 'but the pick is not counted';
  assert public.thank_bottle((got->>'id')::uuid) = false, 'thanks refused when busy';
  assert (select sum(thanks) from public.sea_bottles) = before_thanks, 'and not counted';
  assert (select count(*) from public.sea_bottle_rate where bucket < now() - interval '1 day') = 0, 'old rate rows pruned';
end $$;
delete from public.sea_bottle_rate;

-- Limits on throwing (30 in ten minutes, 300 in a day) and pruning after 400 days.
insert into public.sea_bottles (to_kind, word, created_at) select 'tired', 'rest', now() - interval '401 days' from generate_series(1, 2);
insert into public.sea_bottles (to_kind, word, created_at) select 'tired', 'rest', now() - interval '2 hours' from generate_series(1, 295);
do $$
declare r jsonb;
begin
  r := public.throw_bottle('tired', 'slowly');
  assert (r->>'ok')::boolean, 'under both limits: ' || r::text;
  assert (select count(*) from public.sea_bottles where created_at < now() - interval '400 days') = 0, 'old bottles drift away';
  r := public.throw_bottle('tired', 'slowly');
  assert not (r->>'ok')::boolean and not (r ? 'id'), 'busy at 300 bottles in a day: ' || r::text;
end $$;
delete from public.sea_bottles where word in ('rest', 'slowly');
insert into public.sea_bottles (to_kind, word) select 'tired', 'rest' from generate_series(1, 26);
do $$
declare r jsonb;
begin
  r := public.throw_bottle('tired', 'slowly');
  assert not (r->>'ok')::boolean, 'busy at 30 bottles in ten minutes: ' || r::text;
end $$;
delete from public.sea_bottles where word = 'rest';

-- Admin-only numbers. Rows are placed around today's start in Japan time.
insert into public.site_visits (id, count) values (1, 975);
insert into public.star_lights (mood) values ('lonely');
insert into public.diary_metoo (post_id) values ('10000000-0000-4000-8000-000000000001');
do $$
declare d0 timestamptz := ((now() at time zone 'Asia/Tokyo')::date)::timestamp at time zone 'Asia/Tokyo';
begin
  insert into public.site_signals (kind, created_at) values
    ('visit', d0), ('visit', now()),                       -- today
    ('visit', d0 - interval '1 minute'),                   -- yesterday in Japan
    ('visit', d0 - interval '6 days'),                     -- the first of the 7 days
    ('visit', d0 - interval '6 days 1 minute'),            -- just outside the 7 days
    ('visit', d0 - interval '29 days'),                    -- the first of the 30 days
    ('visit', d0 - interval '100 days'),
    ('bottle_pick', now()), ('mikuji_draw', d0 - interval '2 days');
  insert into public.diary_views (post_id, created_at) values
    ('10000000-0000-4000-8000-000000000001', now()),
    ('10000000-0000-4000-8000-000000000001', d0 - interval '3 days'),
    ('10000000-0000-4000-8000-000000000002', d0 - interval '40 days');
end $$;
set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '20000000-0000-4000-8000-0000000000aa';
do $$ begin
  begin perform public.site_usage_summary(); raise exception 'non-admin read the usage summary';
  exception when insufficient_privilege then null; end;
  begin perform public.diary_view_counts(); raise exception 'non-admin read diary view counts';
  exception when insufficient_privilege then null; end;
  -- A signed-in non-admin can use the bottles like any visitor, but is not the admin.
  assert (public.throw_bottle('anxious', 'not_alone')->>'ok')::boolean, 'signed-in visitor can throw';
end $$;
set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
do $$
declare s jsonb; v jsonb; r jsonb; today text := to_char((now() at time zone 'Asia/Tokyo')::date, 'YYYY-MM-DD');
begin
  r := public.throw_bottle('anyone', 'thanks');
  assert (r->>'ok')::boolean, 'admin can throw';
  s := public.site_usage_summary();
  assert s->>'today' = today, 'today in Japan: ' || (s->>'today');
  assert s->>'since' = to_char(((now() at time zone 'Asia/Tokyo')::date - 100), 'YYYY-MM-DD'), 'counting since the first visit: ' || (s->>'since');
  assert (s->>'counter_total')::int = 975, 'the footprint counter: ' || (s->>'counter_total');
  v := s->'counts'->'signal'->'visit';
  assert (v->>'today')::int = 2 and (v->>'d7')::int = 4 and (v->>'d30')::int = 6 and (v->>'all')::int = 7, 'visit windows: ' || v::text;
  assert (s->'counts'->'signal'->'bottle_pick'->>'today')::int = 1, 'bottle picks today';
  v := s->'counts'->'signal'->'mikuji_draw';
  assert (v->>'today')::int = 0 and (v->>'d7')::int = 1, 'mikuji windows: ' || v::text;
  v := s->'counts'->'view'->'all';
  assert (v->>'today')::int = 1 and (v->>'d7')::int = 2 and (v->>'d30')::int = 2 and (v->>'all')::int = 3, 'diary view windows: ' || v::text;
  assert (s->'counts'->'light'->'lonely'->>'all')::int >= 1, 'lights by mood come along: ' || (s->'counts'->'light')::text;
  assert (s->'counts'->'metoo'->'all'->>'all')::int >= 1, 'me too comes along';
  assert (s->'counts'->'bbs'->'post'->>'all')::int = 1, 'BBS posts come along';
  assert (s->'counts'->'bottle_to'->'lonely'->>'all')::int = 1 and (s->'counts'->'bottle_word'->'thanks'->>'today')::int = 1, 'bottles by recipient and word: ' || (s->'counts')::text;
  v := s->'bottles';
  assert (v->>'in_sea')::int = 6 and (v->>'from_admin')::int = 1 and (v->>'picked_once')::int = 4
     and (v->>'picks')::int = 5 and (v->>'thanks')::int = 1, 'bottle totals: ' || v::text;
  -- Top diaries per window, with titles; a diary viewed only 40 days ago is in "all" alone.
  assert jsonb_array_length(s->'top_diaries'->'today') = 1 and s->'top_diaries'->'today'->0->>'title' = '夜のひとりごと'
     and (s->'top_diaries'->'today'->0->>'n')::int = 1, 'top today: ' || (s->'top_diaries'->'today')::text;
  assert (s->'top_diaries'->'d30'->0->>'n')::int = 2 and jsonb_array_length(s->'top_diaries'->'d30') = 1, 'top 30 days';
  assert jsonb_array_length(s->'top_diaries'->'all') = 2 and s->'top_diaries'->'all'->1->>'title' = '朝のひとりごと', 'top all: ' || (s->'top_diaries'->'all')::text;
  -- Fourteen days in order, the last one today; days without records are zero, not missing.
  assert jsonb_array_length(s->'daily') = 14 and s->'daily'->13->>'day' = today, 'fourteen days ending today: ' || (s->'daily')::text;
  assert (s->'daily'->13->'kinds'->>'visit')::int = 2 and (s->'daily'->12->'kinds'->>'visit')::int = 1
     and (s->'daily'->7->'kinds'->>'visit')::int = 1 and s->'daily'->1->'kinds' = '{}'::jsonb, 'daily counts: ' || (s->'daily')::text;
  -- Twenty-four hours, summing to the visits of the 30 days.
  assert jsonb_array_length(s->'hours') = 24, 'twenty-four hours';
  assert (select sum(h::int) from jsonb_array_elements_text(s->'hours') as h) = 6, 'hours sum to 30-day visits: ' || (s->'hours')::text;
  assert (s->'hours'->>0)::int >= 3, 'midnight rows land on hour 0 in Japan: ' || (s->'hours')::text;
  -- Nothing in the summary can identify a visitor: no keys, no ids of bottles.
  assert s::text not like '%' || (r->>'key') || '%' and s::text not like '%' || (r->>'id') || '%', 'no bottle key or id in the summary';
  v := public.diary_view_counts();
  assert (v->>'10000000-0000-4000-8000-000000000001')::int = 2 and (v->>'10000000-0000-4000-8000-000000000002')::int = 1, 'views per diary: ' || v::text;
end $$;
reset role;
reset request.jwt.claim.role;
reset request.jwt.claim.sub;
do $$ begin
  assert (select count(*) from public.sea_bottles where from_admin) = 1, 'only the admin''s bottle is marked';
end $$;

-- Deleting a diary takes its views with it.
delete from public.blog_posts where id = '10000000-0000-4000-8000-000000000002';
do $$ begin
  assert (select count(*) from public.diary_views) = 2, 'views of a deleted diary are removed';
end $$;

-- Re-running either SQL file with records in place keeps every record,
-- and re-running participation.sql does not take the new kinds away.
\i /work/bottle-usage.sql
\i /work/participation.sql
do $$ begin
  assert (select count(*) from public.site_signals) = 9, 'usage kept after re-run';
  assert (select count(*) from public.diary_views) = 2, 'diary views kept after re-run';
  assert (select count(*) from public.sea_bottles) = 6, 'bottles kept after re-run';
  assert (select sum(picks) from public.sea_bottles) = 5, 'pick counts kept after re-run';
end $$;
set role anon;
set request.jwt.claim.role = 'anon';
do $$ begin
  assert public.note_usage('mikuji_draw') = true, 'new kinds still counted after participation.sql is re-run';
  assert public.note_site_signal('bbs_typing') = true, 'old function still counts';
  begin perform public.note_site_signal('visit'); raise exception 'old function took a new kind';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
reset request.jwt.claim.role;

\echo 'bottle-usage-db: all checks passed'
