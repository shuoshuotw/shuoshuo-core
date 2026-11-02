-- SPEC §6: tables, indexes, grants and RLS. All access goes through Core (service_role).

create schema if not exists private;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- Global, not per schema: PUBLIC's EXECUTE is a built-in default that a per-schema rule cannot remove
alter default privileges revoke execute on routines from public;
alter default privileges in schema public revoke execute on routines from anon, authenticated;

-- §6.2

create type public.quote_status as enum ('published', 'under_review', 'removed', 'deleted');
create type public.commit_source as enum ('web', 'api');
create type public.comment_status as enum ('visible', 'removed', 'deleted');
create type public.report_reason as enum (
  'harassment', 'hate', 'sexual', 'violence', 'privacy', 'spam', 'misinformation', 'simplified_chinese', 'other'
);
create type public.report_status as enum ('pending', 'upheld', 'dismissed', 'voided');
create type public.report_target as enum ('quote', 'comment');
create type public.case_status as enum ('open', 'resolved');
create type public.case_resolution as enum ('dismiss', 'uphold', 'target_deleted');
create type public.standing_status as enum ('active', 'banned');
create type public.sanction_kind as enum ('submit_suspension', 'account_ban');
create type public.sanction_source as enum ('auto', 'manual');
create type public.appeal_status as enum ('pending', 'accepted', 'rejected');
create type public.app_role as enum ('admin');

-- §6.3

create table public.profiles (
  -- no FK to auth.users: this row outlives the account so quotes keep their name (D-22)
  id uuid primary key,
  username text not null check (char_length(username) between 2 and 30),
  avatar_url text,
  likes_public boolean not null default true,
  favorites_public boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.account_standing (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status public.standing_status not null default 'active',
  suspended_until timestamptz,
  strike_count int not null default 0 check (strike_count >= 0),
  banned_at timestamptz,
  ban_reason text,
  updated_at timestamptz not null default now()
);

create table public.categories (
  key text primary key,
  name_zh text not null,
  name_en text not null,
  sort_order smallint not null
);

insert into public.categories (key, name_zh, name_en, sort_order) values
  ('anime', '動畫', 'Anime', 1),
  ('manga', '漫畫', 'Manga', 2),
  ('game', '遊戲', 'Games', 3),
  ('music', '音樂', 'Music', 4),
  ('literature', '文學', 'Literature', 5),
  ('original', '原創', 'Original', 6),
  ('flim', '影視', 'Film & TV', 7),
  ('poetry', '詩詞', 'Poetry', 8),
  ('internet', '網路', 'Internet', 9),
  ('philosophy', '哲學', 'Philosophy', 10),
  ('anti-motiv', '毒雞湯', 'Toxic Chicken Soup', 11),
  ('ai', 'AI', 'AI', 12),
  ('other', '其他', 'Other', 13);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  content text not null check (char_length(content) between 2 and 100),
  original_content text not null,
  content_hash bytea not null,
  length int generated always as (char_length(content)) stored,
  category_key text not null references public.categories (key),
  source_from text not null check (char_length(source_from) between 1 and 100),
  submitter_id uuid not null references public.profiles (id),
  commit_from public.commit_source not null,
  status public.quote_status not null default 'published',
  random_key double precision not null default random(),
  removed_at timestamptz,
  removed_reason public.report_reason,
  under_review_since timestamptz,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Separate from quotes so a like does not rewrite the quote row (§6.3)
create table public.quote_stats (
  quote_id uuid primary key references public.quotes (id) on delete cascade,
  like_count int not null default 0,
  favorite_count int not null default 0,
  comment_count int not null default 0,
  updated_at timestamptz not null default now()
);

create table public.quote_likes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, quote_id)
);

create table public.quote_favorites (
  user_id uuid not null references public.profiles (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, quote_id)
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  status public.comment_status not null default 'visible',
  edited_at timestamptz,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.moderation_cases (
  id uuid primary key default gen_random_uuid(),
  target_type public.report_target not null,
  target_id uuid not null,
  status public.case_status not null default 'open',
  effective_reporter_count int not null default 0,
  resolution public.case_resolution,
  final_reason public.report_reason,
  reviewer_note text check (char_length(reviewer_note) <= 1000),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.moderation_cases (id),
  target_type public.report_target not null,
  target_id uuid not null,
  reporter_id uuid references public.profiles (id) on delete set null,
  reason public.report_reason not null,
  detail text check (char_length(detail) <= 500),
  status public.report_status not null default 'pending',
  is_discounted boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.violations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  quote_id uuid references public.quotes (id),
  case_id uuid not null unique references public.moderation_cases (id),
  reason public.report_reason not null,
  counts_as_strike boolean not null,
  overturned_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.sanctions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  violation_id uuid references public.violations (id),
  kind public.sanction_kind not null,
  source public.sanction_source not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  reason text not null,
  issued_by uuid,
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text
);

create table public.appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  sanction_id uuid references public.sanctions (id),
  violation_id uuid references public.violations (id),
  statement text not null check (char_length(statement) between 20 and 1000),
  status public.appeal_status not null default 'pending',
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (num_nonnulls(sanction_id, violation_id) = 1)
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  key_prefix text not null,
  key_hash bytea not null unique,
  scopes text[] not null,
  last_used_at timestamptz,
  regenerated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('user', 'account_ban', 'admin')),
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_type text not null check (actor_type in ('user', 'admin', 'system')),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  request_id text,
  created_at timestamptz not null default now()
);

create table private.identity_blocks (
  email_hmac bytea primary key,
  created_at timestamptz not null default now()
);

-- §6.4

create index quotes_pool_idx on public.quotes (category_key, random_key) where status = 'published';
create index quotes_length_idx on public.quotes (category_key, length) where status = 'published';
create index quotes_review_idx on public.quotes (under_review_since) where status = 'under_review';
create index quotes_list_idx on public.quotes (created_at desc, id desc) where status = 'published';
create index quotes_category_list_idx on public.quotes (category_key, created_at desc, id desc) where status = 'published';
create index quotes_submitter_idx on public.quotes (submitter_id, created_at desc, id desc);
create unique index quotes_content_hash_idx on public.quotes (content_hash) where status <> 'deleted';

create index quote_likes_quote_idx on public.quote_likes (quote_id);
create index quote_likes_user_idx on public.quote_likes (user_id, created_at desc, quote_id);
create index quote_likes_recent_idx on public.quote_likes (created_at desc);
create index quote_favorites_quote_idx on public.quote_favorites (quote_id);
create index quote_favorites_user_idx on public.quote_favorites (user_id, created_at desc, quote_id);

create index comments_list_idx on public.comments (quote_id, created_at desc, id desc) where status = 'visible';
create index comments_user_idx on public.comments (user_id, created_at desc);
create unique index comments_pinned_idx on public.comments (quote_id) where pinned_at is not null;

create unique index profiles_username_idx on public.profiles (lower(username)) where deleted_at is null;

create unique index cases_open_target_idx on public.moderation_cases (target_type, target_id) where status = 'open';
create index cases_queue_idx on public.moderation_cases (status, effective_reporter_count desc, created_at, id);

create unique index reports_once_idx on public.reports (reporter_id, target_type, target_id);
create index reports_case_idx on public.reports (case_id);
create index reports_reporter_idx on public.reports (reporter_id, created_at desc);

create index violations_strikes_idx on public.violations (user_id) where counts_as_strike and overturned_at is null;
create index violations_quote_idx on public.violations (quote_id);

create index sanctions_user_idx on public.sanctions (user_id, starts_at desc);
create index sanctions_violation_idx on public.sanctions (violation_id);

create unique index appeals_sanction_idx on public.appeals (sanction_id);
create unique index appeals_violation_idx on public.appeals (violation_id);
create index appeals_queue_idx on public.appeals (status, created_at);
create index appeals_user_idx on public.appeals (user_id, created_at desc);

create index api_keys_user_idx on public.api_keys (user_id) where revoked_at is null;

create index audit_logs_target_idx on public.audit_logs (target_type, target_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

-- Triggers

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger account_standing_updated_at before update on public.account_standing
  for each row execute function private.set_updated_at();
create trigger quotes_updated_at before update on public.quotes
  for each row execute function private.set_updated_at();
create trigger quote_stats_updated_at before update on public.quote_stats
  for each row execute function private.set_updated_at();
create trigger comments_updated_at before update on public.comments
  for each row execute function private.set_updated_at();

create function private.create_quote_stats() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.quote_stats (quote_id) values (new.id);
  return new;
end;
$$;

create trigger quotes_create_stats after insert on public.quotes
  for each row execute function private.create_quote_stats();

create function private.count_like() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.quote_stats
  set like_count = like_count + case tg_op when 'INSERT' then 1 else -1 end
  where quote_id = coalesce(new.quote_id, old.quote_id);
  return null;
end;
$$;

create trigger quote_likes_count after insert or delete on public.quote_likes
  for each row execute function private.count_like();

create function private.count_favorite() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.quote_stats
  set favorite_count = favorite_count + case tg_op when 'INSERT' then 1 else -1 end
  where quote_id = coalesce(new.quote_id, old.quote_id);
  return null;
end;
$$;

create trigger quote_favorites_count after insert or delete on public.quote_favorites
  for each row execute function private.count_favorite();

-- comment_count covers visible comments only
create function private.count_comment() returns trigger
language plpgsql set search_path = '' as $$
declare
  delta int := (case when tg_op <> 'DELETE' and new.status = 'visible' then 1 else 0 end)
             - (case when tg_op <> 'INSERT' and old.status = 'visible' then 1 else 0 end);
begin
  if delta <> 0 then
    update public.quote_stats
    set comment_count = comment_count + delta
    where quote_id = coalesce(new.quote_id, old.quote_id);
  end if;
  return null;
end;
$$;

create trigger comments_count after insert or update of status or delete on public.comments
  for each row execute function private.count_comment();

-- Append-only; retention_job may only purge rows past the 2-year retention (§6.3)
create function private.guard_audit_logs() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_user = 'retention_job' and old.created_at < now() - interval '2 years' then
    return old;
  end if;
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;

create trigger audit_logs_guard before update or delete on public.audit_logs
  for each row execute function private.guard_audit_logs();

-- §6.5: no policy for anon or authenticated on purpose. RLS is the second line of defence if a GRANT is ever added by mistake.

alter table public.profiles enable row level security;
alter table public.account_standing enable row level security;
alter table public.categories enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_stats enable row level security;
alter table public.quote_likes enable row level security;
alter table public.quote_favorites enable row level security;
alter table public.comments enable row level security;
alter table public.moderation_cases enable row level security;
alter table public.reports enable row level security;
alter table public.violations enable row level security;
alter table public.sanctions enable row level security;
alter table public.appeals enable row level security;
alter table public.api_keys enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_logs enable row level security;
alter table private.identity_blocks enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
revoke update, delete, truncate on public.audit_logs from service_role;

-- WARNING: Supabase's custom-schema guide grants USAGE to anon and authenticated. Never do that here:
-- RPC trusts its actor argument, so that grant would let anyone impersonate any user (§6.5).
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, delete on private.identity_blocks to service_role;

-- §11.5
create role retention_job nologin;
grant usage on schema public to retention_job;
grant select, delete on public.audit_logs to retention_job;
grant select, update (detail) on public.reports to retention_job;
grant select, update (reviewer_note) on public.moderation_cases to retention_job;
grant select, delete on public.api_keys to retention_job;
grant retention_job to postgres;
-- Unlike service_role this role does not bypass RLS: without policies its jobs would silently touch no rows
create policy retention_read on public.audit_logs for select to retention_job using (true);
create policy retention_delete on public.audit_logs for delete to retention_job using (true);
create policy retention_read on public.reports for select to retention_job using (true);
create policy retention_update on public.reports for update to retention_job using (true);
create policy retention_read on public.moderation_cases for select to retention_job using (true);
create policy retention_update on public.moderation_cases for update to retention_job using (true);
create policy retention_read on public.api_keys for select to retention_job using (true);
create policy retention_delete on public.api_keys for delete to retention_job using (true);
