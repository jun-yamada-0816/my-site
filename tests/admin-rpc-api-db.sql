\set ON_ERROR_STOP on
-- Connected as authenticator, the way PostgREST reaches the database.
-- A request that arrives through the API without any login information must not be treated
-- like the SQL Editor: the gate looks at how the session connected, not only at the claims.
set role authenticated;
do $$
begin
  begin
    perform public.sync_youtube();
    raise exception 'an API session without claims should be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.youtube_api_key_status();
    raise exception 'an API session without claims should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
begin
  begin
    perform public.refresh_it_news(3);
    raise exception 'a non-admin login should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select count(*) as admin_sync_rows from public.sync_youtube();
select public.youtube_api_key_status();
