# Supabase のセットアップ手順

以前は `index.html` の先頭にコメントとして書いていた手順です。コメントは公開ページのソースから誰でも読めるため（管理者のメールアドレスも書かれていました）、2026-10-02 にこのファイルへ移しました。
`docs/` は `.vercelignore` で公開サイトに載せないようにしています。

1. https://supabase.com でプロジェクトを作成する
2. SQL Editor で、下の SQL を順に実行する
3. Authentication > Users で管理者アカウントを作成する（メールアドレスとパスワードを設定）。
   作ったら **Authentication > Sign In / Providers で「Allow new users to sign up」をオフ**にする。
   下のSQLの権限は「ログインしている人＝管理者」という前提なので、登録が開いていると誰でも管理者になれてしまう
4. Project Settings > API から URL と anon key（`sb_publishable_…`）をコピーし、`index.html` の `SUPABASE_URL` と `SUPABASE_ANON_KEY` を書き換える

掲示板の保護：最後に `bbs-moderation.sql` を実行し、README の「BBSの公開前チェック」の設定手順に従ってください。

管理者だけに絞る：すべてのSQLのあとに `admin-only.sql`（管理者のUIDを入れて）を実行してください。README の「管理者だけに絞る」を参照。
カフェ一覧を使う場合は、そのあとに `admin-cafes.sql` を実行します。

> Supabase の SQL Editor は、関数の定義を途中で区切って `syntax error at end of input` を出すことがあります。そのときは1文ずつ実行してください。

## 日記（blog_posts）

```sql
create table blog_posts (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  content text not null,
  created_at timestamptz default now()
);
alter table blog_posts enable row level security;
create policy "select_all"   on blog_posts for select using (true);
create policy "admin_insert" on blog_posts for insert with check (auth.role() = 'authenticated');
-- 日記の編集とプロフィールの保存に使います
create policy "admin_update" on blog_posts for update using (auth.role() = 'authenticated');
create policy "admin_delete" on blog_posts for delete using (auth.role() = 'authenticated');
```

## 掲示板（bulletin_messages）

```sql
create table bulletin_messages (
  id uuid default gen_random_uuid() primary key,
  author_name text not null,
  content text not null,
  created_at timestamptz default now()
);
alter table bulletin_messages enable row level security;
create policy "select_all"   on bulletin_messages for select using (true);
-- 書き込みは bbs-moderation.sql と api/bulletin.js を通します。
create policy "admin_delete" on bulletin_messages for delete using (auth.role() = 'authenticated');
```

### 返信と、管理者による編集

```sql
-- parent_id … 返信先の書き込みID（親を消すと返信もまとめて消える）
-- edited_at … 管理者が編集した日時（「編集済み」表示に使う）
alter table bulletin_messages
  add column if not exists parent_id uuid references bulletin_messages(id) on delete cascade,
  add column if not exists edited_at timestamptz;
create index if not exists bulletin_messages_parent_idx on bulletin_messages(parent_id);
-- 編集も公開前の判定を通します。セットアップの最後に bbs-moderation.sql を実行してください。
```

### 書き込みがあったら管理者にメールで知らせる

Supabase 側（データベース）から通知します。メールサービスの状態により届かない場合があります。メール送信には Resend（https://resend.com）を使います。

事前準備：

1. resend.com に、通知を受け取るメールアドレスで登録する（無料プランでは、登録したアドレス宛にのみ送信できます）
2. API Keys → Create API Key で `re_` から始まるキーを発行してコピー
3. 下の SQL の `re_ここにAPIキーを貼る` と `通知を受け取るメールアドレス` を差し替えて SQL Editor で実行

本番で使っている通知の関数は `bbs-moderation.sql` にあります（こちらには実際の宛先が入っています）。

```sql
-- HTTPリクエストを送るための拡張（Supabaseに同梱されている）
create extension if not exists pg_net;

-- APIキーは金庫(Vault)に入れる。関数の中に直接書かないので後から漏れにくい。
select vault.create_secret('re_ここにAPIキーを貼る', 'resend_api_key', '掲示板の通知メール用');

-- 通知には名前・本文・返信先を含めません。
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
      'to', jsonb_build_array('通知を受け取るメールアドレス'),
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

drop trigger if exists on_bulletin_message_created on bulletin_messages;
create trigger on_bulletin_message_created
  after insert on bulletin_messages
  for each row execute function notify_new_bulletin_message();
```

送信できているかの確認（新しい順に、直近の送信結果を見る）：

```sql
select created, status_code, content from net._http_response order by created desc limit 5;
```

`status_code` が 200 なら成功。401 なら API キー、403 なら宛先の制限を確認してください。

API キーを入れ替えるときは、消してから入れ直します。

```sql
delete from vault.secrets where name = 'resend_api_key';
select vault.create_secret('re_新しいキー', 'resend_api_key', '掲示板の通知メール用');
```

## 音楽（music_tracks）と Storage

**2026-11-11 に、サイトから音楽室を無くしました。** 下は、以前の構成の記録です。表と曲のファイルは消していないので、完全に消すときはダッシュボードの Storage → `music` でファイルを削除してください。

```sql
create table music_tracks (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text default '',
  file_url text not null,
  created_at timestamptz default now()
);
alter table music_tracks enable row level security;
create policy "select_all"   on music_tracks for select using (true);
create policy "admin_insert" on music_tracks for insert with check (auth.role() = 'authenticated');
create policy "admin_delete" on music_tracks for delete using (auth.role() = 'authenticated');
```

ダッシュボード → Storage → New bucket で、名前 `music`、Public bucket を ON にして作成します。作成後、SQL Editor で実行します。

```sql
create policy "public_read"   on storage.objects for select using (bucket_id = 'music');
create policy "admin_upload"  on storage.objects for insert with check (bucket_id = 'music' and auth.role() = 'authenticated');
create policy "admin_delete"  on storage.objects for delete using (bucket_id = 'music' and auth.role() = 'authenticated');
```

## 訪問者カウンター

```sql
create table site_visits (
  id int primary key default 1,
  count bigint not null default 0,
  constraint single_row check (id = 1)
);
insert into site_visits (id, count) values (1, 0);
alter table site_visits enable row level security;
create policy "select_all" on site_visits for select using (true);

-- security definer なので anon は count を直接更新できず、
-- この関数経由で +1 するだけに制限される
create or replace function increment_visit_count()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  update site_visits set count = count + 1 where id = 1 returning count into new_count;
  return new_count;
end;
$$;
grant execute on function increment_visit_count() to anon, authenticated;

-- 数え直したいとき（N は入れたい数）
-- update site_visits set count = N where id = 1;
```

## 日記の閲覧数・音楽の再生数（使わなくなりました）

**2026-11-11 から、このSQLは使いません。実行しないでください。** 日記の閲覧数は `bottle-usage.sql`（下の章）で数え、管理者にだけ表示します。サイトはもう `view_count`・`play_count` を読まず、下の2つの関数も呼びません。下は、以前の構成の記録です（本番では一度も実行されていません）。

```sql
alter table blog_posts   add column if not exists view_count bigint not null default 0;
alter table music_tracks add column if not exists play_count bigint not null default 0;

-- security definer なので anon はカウントを直接更新できず、
-- これらの関数経由で +1 するだけに制限される
create or replace function increment_post_views(post_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  update blog_posts set view_count = view_count + 1
    where id = post_id returning view_count into new_count;
  return new_count;
end;
$$;
grant execute on function increment_post_views(uuid) to anon, authenticated;

create or replace function increment_track_plays(track_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  update music_tracks set play_count = play_count + 1
    where id = track_id returning play_count into new_count;
  return new_count;
end;
$$;
grant execute on function increment_track_plays(uuid) to anon, authenticated;
```

## 星の小瓶・利用回数・日記ごとの閲覧数（bottle-usage.sql、2026-11-11）

**本番ではまだ実行されていません（2026-11-11 時点）。** 実行するまで、星の小瓶は管理人がはじめに置いた小瓶だけが拾え、利用状況のページ（`usage.html`）は「このSQLを実行してください」と出ます。サイトはエラーにならずに使えます。

1. 先に `admin-only.sql` と `participation.sql` が実行済みであること（済んでいないと、何も変えずに「先に◯◯を実行してください」と止まります）。
2. SQL Editor で `bottle-usage.sql` をまるごと1回実行します。何度実行しても記録は消えません。
3. 確かめ方：トップページの「星の小瓶」で小瓶を1本流すと、「いま、この海には 1本の小瓶が浮かんでいます。」と出ます。管理者メニューの「利用状況を見る」に数が出ます。

作られるもの：`diary_views`（どの日記が、いつ開かれたか）、`sea_bottles`（小瓶。宛先とことばは決まった記号だけ）、`sea_bottle_rate`（水増しを防ぐための10分ごとの数）。`site_signals` は数える種類を増やします。どの表も訪問者から直接は読み書きできません。数を読む関数（`site_usage_summary`・`diary_view_counts`）は、`is_site_admin()` のときだけ答えます。

テストは `tests/run-bottle-usage-db.sh`（使い捨ての postgres:16、ネットワークなし）。

## 星の灯り・「私も」・「知らせる」（participation.sql、2026-11-09）

**本番では実行済みです（2026-11-11 に、公開の関数が答えることを確認）。** 実行するまで、星の灯りはその端末の中だけで灯り、「私も」「知らせる」は「いまは届けられません」と出ます。サイトはエラーにならずに使えます。

1. 先に `admin-only.sql` と `bbs-moderation.sql` が実行済みであることを確かめます（どちらも実行済みなら何もしなくてよい）。
2. Supabase の **SQL Editor** で `participation.sql` をまるごと貼り付けて、1回実行します。何度実行しても記録は消えません。
3. サイトを開き、星の灯りをひとつ選ぶと、灯りの数が出ることを確かめます。YouTube分析ページのダッシュボードに「星の海の小さな参加」の数が出ます。

残すのは種類と時刻だけです（名前・文章・IPアドレスは保存しない）。表は訪問者から直接読めず、関数を通して1行足せるだけです。数を読めるのは管理者（`is_site_admin()`）だけです。
「知らせる」が届くと、掲示板の通知と同じ宛先にメールします（Vault の `resend_api_key` があるときだけ。本文・名前は載せず、理由だけ）。
