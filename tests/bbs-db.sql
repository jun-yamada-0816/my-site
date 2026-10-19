\set ON_ERROR_STOP on
create trigger on_bulletin_message_created after insert on public.bulletin_messages
  for each row execute function public.notify_new_bulletin_message();

set role service_role;
set request.jwt.claim.role = 'service_role';
insert into public.bulletin_messages(id, author_name, content)
  values ('30000000-0000-4000-8000-000000000001', 'PRIVATE NAME', 'PRIVATE BODY');
do $$ begin
  assert public.bbs_take_submission_slot(repeat('a',64)) = true, 'First attempt allowed';
  assert public.bbs_take_submission_slot(repeat('a',64)) = false, 'Immediate repeat blocked';
end $$;
reset role;
reset request.jwt.claim.role;
do $$ begin
  assert (select count(*) from public.test_emails) = 1, 'Published post notification';
  assert (select body->>'html' like '%https://hoshinoumi.org/#bulletin%' from public.test_emails), 'Notification links to canonical domain';
  assert (select body::text not like '%PRIVATE%' from public.test_emails), 'No name or body in email';
end $$;

set role anon;
set request.jwt.claim.role = 'anon';
do $$ begin
  assert (select count(*) from public.bulletin_messages) = 1, 'Public read retained';
  begin
    insert into public.bulletin_messages(author_name,content) values ('attacker','direct');
    raise exception 'Anonymous insert unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.bbs_take_submission_slot(repeat('b',64));
    raise exception 'Anonymous rate RPC unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.bbs_submission_limits;
    raise exception 'Anonymous rate data read unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.role = 'authenticated';
do $$ begin
  begin
    insert into public.bulletin_messages(author_name,content) values ('attacker','direct');
    raise exception 'Authenticated insert unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.bulletin_messages set content = 'replacement attack';
    raise exception 'Unmoderated edit unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;

-- Even an accidentally restored old policy/grant cannot reopen direct writes.
grant insert, update on public.bulletin_messages to anon, authenticated;
create policy insert_all on public.bulletin_messages for insert with check (true);
create policy admin_update on public.bulletin_messages for update using (true);
set role anon;
set request.jwt.claim.role = 'anon';
do $$ begin
  begin
    insert into public.bulletin_messages(author_name,content) values ('attacker','bypass');
    raise exception 'Trigger failed to stop anonymous insert';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.role = 'authenticated';
do $$ begin
  begin
    update public.bulletin_messages set content = 'bypass';
    raise exception 'Trigger failed to stop authenticated update';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
reset request.jwt.claim.role;

update public.bbs_submission_limits set attempts = 20, last_attempt = now() - interval '1 minute' where key = repeat('a',64);
set role service_role;
set request.jwt.claim.role = 'service_role';
do $$ begin
  assert public.bbs_take_submission_slot(repeat('a',64)) = false, 'Daily per-IP cap';
  assert public.bbs_take_submission_slot(repeat('b',64)) = true, 'Other visitor allowed';
end $$;
reset role;
reset request.jwt.claim.role;
update public.bbs_submission_limits set attempts = 200 where key = 'global';
set role service_role;
set request.jwt.claim.role = 'service_role';
do $$ begin
  assert public.bbs_take_submission_slot(repeat('c',64)) = false, 'Global model-spend cap';
end $$;
reset role;
reset request.jwt.claim.role;
do $$ begin
  assert (select count(*) from public.bulletin_messages) = 1, 'Only approved post remains';
  assert (select count(*) from public.test_emails) = 1, 'Blocked requests never notify';
  assert (select content = 'PRIVATE BODY' from public.bulletin_messages), 'Blocked edits changed nothing';
end $$;
select 'BBS database checks passed' as result;
