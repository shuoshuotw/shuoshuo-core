-- Reports, cases, the strike ladder and appeals (SPEC §9)
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

set local role service_role;

-- Bans from integration runs leave rows here, and the counts below are absolute
delete from private.identity_blocks;

create temp table ids (name text primary key, id uuid) on commit drop;
create function pg_temp.id(key text) returns uuid language sql as $$ select id from ids where name = key $$;
create function pg_temp.hash(value text) returns bytea language sql as $$ select extensions.digest(value, 'sha256') $$;
create function pg_temp.new_quote(owner text, tag text) returns uuid language sql as $$
  select private.create_quote(pg_temp.id(owner), '治理測試的說說' || tag, pg_temp.hash(tag), 'original', '自己', 'web');
$$;
create function pg_temp.uphold(quote uuid) returns jsonb language plpgsql as $$
declare
  report uuid;
  target_case uuid;
begin
  select report_id into report from private.create_report(pg_temp.id('bob'), 'quote', quote, 'spam');
  select case_id into target_case from public.reports where id = report;
  return private.resolve_case(pg_temp.id('admin'), target_case, 'uphold', 'spam', '確認');
end;
$$;

insert into ids values
  ('admin', '00000000-0000-4000-a000-000000000001'),
  ('alice', '00000000-0000-4000-a000-000000000002'),
  ('bob', '00000000-0000-4000-a000-000000000003'),
  ('carol', '00000000-0000-4000-a000-000000000004'),
  ('dave', '00000000-0000-4000-a000-000000000005');

-- §9.2 decision table
insert into ids select 'q1', pg_temp.new_quote('alice', 'q1');
-- Written up front: a suspended or banned user cannot submit
insert into ids select tag, pg_temp.new_quote('alice', tag) from unnest(array['s1', 's2', 's3', 's4', 's5']) as tag;
select throws_ok($$select * from private.create_report(pg_temp.id('alice'), 'quote', pg_temp.id('q1'), 'spam')$$, 'P0001', 'CANNOT_REPORT_OWN', 'cannot report own quote');
select is((select became_under_review from private.create_report(pg_temp.id('bob'), 'quote', pg_temp.id('q1'), 'spam')), false, 'first report opens a case');
select throws_ok($$select * from private.create_report(pg_temp.id('bob'), 'quote', pg_temp.id('q1'), 'hate')$$, 'P0001', 'REPORT_DUPLICATE', 'one report per target per user');
select is((select became_under_review from private.create_report(pg_temp.id('carol'), 'quote', pg_temp.id('q1'), 'spam')), false, 'second reporter merges');

reset role;
-- A new account opens no threshold count (§9.2)
update public.profiles set created_at = now() where id = pg_temp.id('admin');
set local role service_role;
select is((select became_under_review from private.create_report(pg_temp.id('admin'), 'quote', pg_temp.id('q1'), 'spam')), false, 'discounted reporter does not reach the threshold');
select is(
  (select row(effective_reporter_count, (select count(*) from public.reports r where r.case_id = c.id))::text from public.moderation_cases c where c.target_id = pg_temp.id('q1')),
  row(2, 3::bigint)::text, 'discounted report is kept but not counted; a single case holds all reports'
);
select is((select became_under_review from private.create_report(pg_temp.id('dave'), 'quote', pg_temp.id('q1'), 'spam')), true, 'D-07 third effective reporter flips under_review');
select is((select status::text from public.quotes where id = pg_temp.id('q1')), 'under_review', 'quote is under_review');
select ok(exists (select 1 from public.audit_logs where action = 'report.threshold_reached' and target_id = pg_temp.id('q1')::text), 'threshold is audited');

-- Editing and deleting are blocked while a case is open
select throws_ok($$select private.update_quote(pg_temp.id('alice'), pg_temp.id('q1'), '想改掉')$$, 'P0001', 'QUOTE_HAS_OPEN_CASE', 'ED-04 no edit with an open case');
select throws_ok($$select private.delete_quote(pg_temp.id('alice'), pg_temp.id('q1'))$$, 'P0001', 'QUOTE_HAS_OPEN_CASE', 'no self-delete with an open case');

-- Authorization on governance RPC
insert into ids select 'case1', id from public.moderation_cases where target_id = pg_temp.id('q1');
select throws_ok($$select private.resolve_case(pg_temp.id('bob'), pg_temp.id('case1'), 'dismiss')$$, 'P0001', 'FORBIDDEN_ROLE', 'non-admin cannot resolve');
select throws_ok($$select private.resolve_case(pg_temp.id('admin'), gen_random_uuid(), 'dismiss')$$, 'P0001', 'CASE_NOT_FOUND', 'unknown case');

-- Dismiss
select is((private.resolve_case(pg_temp.id('admin'), pg_temp.id('case1'), 'dismiss'))->>'target_status', 'published', 'dismiss returns the quote to published');
select is((select array_agg(distinct status::text) from public.reports where case_id = pg_temp.id('case1')), array['dismissed'], 'reports are dismissed');
select throws_ok($$select private.resolve_case(pg_temp.id('admin'), pg_temp.id('case1'), 'dismiss')$$, 'P0001', 'CASE_ALREADY_RESOLVED', 'resolving twice fails');
select is((select strike_count from public.account_standing where user_id = pg_temp.id('alice')), 0, 'dismiss gives no strike');

-- Ladder (§9.4)
select is((pg_temp.uphold(pg_temp.id('s1')))->'sanction'->>'kind', 'submit_suspension', 'strike 1 suspends');
select is(
  (select round(extract(epoch from suspended_until - now()) / 86400) from public.account_standing where user_id = pg_temp.id('alice')),
  7::numeric, 'strike 1 lasts 7 days'
);
select is((select can_submit from jsonb_to_record(private.standing_json((select s from public.account_standing s where s.user_id = pg_temp.id('alice')))) as x(can_submit boolean)), false, 'standing_json shows suspended');
select is((select status from jsonb_to_record(private.standing_json((select s from public.account_standing s where s.user_id = pg_temp.id('alice')))) as x(status text)), 'suspended', 'suspended is computed');

select is((pg_temp.uphold(pg_temp.id('s2')))->>'strike_count', '2', 'strike 2');
select is(
  (select round(extract(epoch from suspended_until - now()) / 86400) from public.account_standing where user_id = pg_temp.id('alice')),
  30::numeric, 'strike 2 extends to the later end, 30 days'
);

select is((pg_temp.uphold(pg_temp.id('s3')))->>'strike_count', '3', 'strike 3');
select is(
  (select round(extract(epoch from suspended_until - now()) / 86400) from public.account_standing where user_id = pg_temp.id('alice')),
  90::numeric, 'strike 3 extends to the later end, 90 days'
);

-- Strike 4 bans, revokes keys and blocks the email
select lives_ok($$select private.create_api_key(pg_temp.id('alice'), '將被撤銷', 'p1', pg_temp.hash('k1'), array['quotes:read'])$$, 'key exists before the ban');
create temp table effects on commit drop as select pg_temp.uphold(pg_temp.id('s4')) as value;
select is((select value->'sanction'->>'kind' from effects), 'account_ban', 'strike 4 bans');
select is((select value->>'api_keys_revoked' from effects), '1', 'ban revokes every key');
select is((select revoked_reason from public.api_keys where user_id = pg_temp.id('alice') and key_prefix = 'p1'), 'account_ban', 'revoked_reason is account_ban');
select is(
  (select count(*)::int from private.identity_blocks),
  1, 'ban stores the email HMAC'
);
select throws_ok($$select private.create_comment(pg_temp.id('alice'), pg_temp.id('q1'), '封號後留言')$$, 'P0001', 'ACCOUNT_BANNED', 'banned user cannot comment');
select throws_ok($$select private.create_api_key(pg_temp.id('alice'), '封號後', 'p2', pg_temp.hash('k2'), array['quotes:read'])$$, 'P0001', 'ACCOUNT_BANNED', 'T-08 banned user cannot create a key');

-- Banned users stay able to appeal; strikes still accumulate without another sanction
select is((pg_temp.uphold(pg_temp.id('s5')))->'sanction', 'null'::jsonb, 'strike 5 adds no sanction');
select is((select strike_count from public.account_standing where user_id = pg_temp.id('alice')), 5, 'strike 5 is counted');

-- Appeal (§9.6)
insert into ids select 'ban_sanction', id from public.sanctions where user_id = pg_temp.id('alice') and kind = 'account_ban';
insert into ids select 'appeal1', private.create_appeal(pg_temp.id('alice'), 'sanction', pg_temp.id('ban_sanction'), '這句話是我引用的詩詞，並非違規內容，請重新檢視。');
select throws_ok(
  $$select private.create_appeal(pg_temp.id('alice'), 'sanction', pg_temp.id('ban_sanction'), '這句話是我引用的詩詞，並非違規內容，請重新檢視。')$$,
  'P0001', 'APPEAL_ALREADY_EXISTS', 'one appeal per item'
);
select throws_ok(
  $$select private.create_appeal(pg_temp.id('bob'), 'sanction', pg_temp.id('ban_sanction'), '這句話是我引用的詩詞，並非違規內容，請重新檢視。')$$,
  'P0001', 'APPEAL_TARGET_NOT_FOUND', 'cannot appeal for someone else'
);
create temp table appeal_effects on commit drop as
  select private.resolve_appeal(pg_temp.id('admin'), pg_temp.id('appeal1'), 'accept', '確認為誤判') as value;
select is((select value from appeal_effects), '{"strike_count":4,"sanction_lifted":true,"target_restored":true}'::jsonb, 'accepted appeal overturns, lifts and restores');
select is((select status::text from public.account_standing where user_id = pg_temp.id('alice')), 'active', 'standing is recalculated');
select is((select count(*)::int from private.identity_blocks), 0, 'unbanning removes the email HMAC');
select throws_ok($$select private.resolve_appeal(pg_temp.id('admin'), pg_temp.id('appeal1'), 'accept', '再一次')$$, 'P0001', 'APPEAL_ALREADY_RESOLVED', 'appeal resolves once');
select is((select revoked_at is not null from public.api_keys where key_prefix = 'p1'), true, 'D-17 keys stay revoked');

-- Comment case (D-14) and removed quote rules
insert into ids select 'q2', pg_temp.new_quote('bob', 'q2');
insert into ids select 'c1', private.create_comment(pg_temp.id('carol'), pg_temp.id('q2'), '一則留言');
select lives_ok($$select * from private.create_report(pg_temp.id('dave'), 'comment', pg_temp.id('c1'), 'hate')$$, 'report a comment');
insert into ids select 'case2', id from public.moderation_cases where target_id = pg_temp.id('c1');
select is((private.resolve_case(pg_temp.id('admin'), pg_temp.id('case2'), 'uphold', 'hate'))->>'strike_count', null, 'D-14 comment upheld gives no strike');
select is(
  (select row(v.counts_as_strike, c.status::text)::text from public.violations v join public.comments c on c.id = pg_temp.id('c1') where v.case_id = pg_temp.id('case2')),
  row(false, 'removed')::text, 'D-14 violation does not count and the comment is removed'
);

select * from finish();
rollback;
