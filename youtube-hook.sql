-- 既存の記録・権限・RLSを変更せず、Studio手入力用の列がない場合だけ追加する。
-- Supabase SQL Editorで実行。何度実行しても保存済みデータは保持する。
begin;
alter table public.sv_metrics add column if not exists stayed_pct numeric;
comment on column public.sv_metrics.stayed_pct is
  'YouTube Studioの視聴を継続した割合（0〜100%、未入力はNULL）。スワイプして次へは100からこの値を引いて表示。';
commit;
