\set ON_ERROR_STOP on
-- Runs after admin-only.sql and admin-cafes.sql (twice). Only the admin can read the cafe list.

do $$ begin
  assert (select count(*) from public.admin_cafes) = 190, 'all 190 cafes, no duplicates after re-run';
  assert (select count(*) from public.admin_cafes where area = '西区') = 90;
  assert (select name from public.admin_cafes where id = 'nishi-023') = 'farmer''s kitchen BLACKBIRD';
end $$;

select set_config('request.jwt.claim.role', 'anon', false), set_config('request.jwt.claim.sub', '', false);
set role anon;
do $$ begin
  begin
    perform 1 from public.admin_cafes;
    raise exception 'anon must not read admin_cafes';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.role', 'authenticated', false),
       set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.admin_cafes) = 0, 'a non-admin login sees nothing';
  begin
    insert into public.admin_cafes values ('x', 1, '西区', 'x', 'x');
    raise exception 'nobody writes through the API';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.admin_cafes) = 190, 'the admin reads the list';
  begin
    update public.admin_cafes set name = 'x';
    raise exception 'the page is read-only, even for the admin';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo admin-cafes checks passed
