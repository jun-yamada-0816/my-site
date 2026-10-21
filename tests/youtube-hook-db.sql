-- 使い捨てDB専用。既存のsv_metricsがあるDBでは先頭で失敗する。
\set ON_ERROR_STOP on
create table public.sv_metrics (id integer primary key, views integer);
alter table public.sv_metrics enable row level security;
create role hook_test_viewer;
grant select on public.sv_metrics to hook_test_viewer;
create policy hook_test_read on public.sv_metrics for select to hook_test_viewer using (true);
insert into public.sv_metrics values (1, 123);
\ir ../youtube-hook.sql
update public.sv_metrics set stayed_pct = 0 where id = 1;
\ir ../youtube-hook.sql
do $$ begin
  assert (select count(*) from public.sv_metrics) = 1;
  assert (select views = 123 and stayed_pct = 0 from public.sv_metrics where id = 1);
  assert (select relrowsecurity from pg_class where oid = 'public.sv_metrics'::regclass);
  assert has_table_privilege('hook_test_viewer','public.sv_metrics','select');
  assert not has_table_privilege('hook_test_viewer','public.sv_metrics','insert');
  assert exists (select 1 from pg_policies where tablename='sv_metrics' and policyname='hook_test_read');
end $$;
select 'PASS: hook migration preserves rows, zero, RLS and privileges across reruns';
