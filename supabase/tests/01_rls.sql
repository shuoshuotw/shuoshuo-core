-- TEST_PLAN §5.6 RLS-01 to RLS-09
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Only so pgTAP itself is callable after switching to these roles; rolled back with the test
grant usage on schema extensions to retention_job;

-- RLS-01
select is(
  (select array_agg(tablename::text) from pg_tables where schemaname in ('public', 'private') and not rowsecurity),
  null,
  'RLS-01 every table in public and private has RLS enabled'
);
select is(
  (select array_agg(distinct r::text) from pg_policies, unnest(roles) as r where schemaname in ('public', 'private')),
  array['retention_job'],
  'only retention_job has policies: anon and authenticated have no path to a row'
);

-- RLS-02, RLS-03, RLS-05
select is(
  (select array_agg(tablename::text) from pg_tables
   where schemaname = 'public'
     and (has_table_privilege('anon', schemaname || '.' || tablename, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_table_privilege('authenticated', schemaname || '.' || tablename, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))),
  null,
  'RLS-02/03 anon and authenticated hold no privilege on any public table'
);

set local role anon;
select throws_ok('select * from public.quotes', '42501', null, 'RLS-02 anon cannot read quotes');
select throws_ok($$insert into public.profiles (id, username) values (gen_random_uuid(), 'hacker')$$, '42501', null, 'RLS-02 anon cannot insert');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok('select * from public.profiles', '42501', null, 'RLS-03 authenticated cannot read own profile');
select throws_ok($$update public.account_standing set status = 'active'$$, '42501', null, 'RLS-05 cannot lift own ban');
select throws_ok($$insert into public.user_roles (user_id, role) values ('00000000-0000-4000-a000-000000000002', 'admin')$$, '42501', null, 'RLS-05 cannot grant self admin');
select throws_ok('select * from public.api_keys', '42501', null, 'RLS-05 cannot read api_keys');
select throws_ok('select * from public.audit_logs', '42501', null, 'RLS-05 cannot read audit_logs');
reset role;

-- RLS-06
select is(has_schema_privilege('anon', 'private', 'USAGE'), false, 'RLS-06 anon has no USAGE on private');
select is(has_schema_privilege('authenticated', 'private', 'USAGE'), false, 'RLS-06 authenticated has no USAGE on private');
select is(
  (select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  null,
  'RLS-06 anon and authenticated cannot execute any private function'
);
set local role authenticated;
select throws_ok(
  $$select private.create_sanction('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000003', 'account_ban', null, 'x')$$,
  '42501', null, 'RLS-06 authenticated cannot call RPC to impersonate an admin'
);
reset role;

-- RLS-07
insert into public.audit_logs (actor_type, action) values ('system', 'rls.test');
select throws_ok($$update public.audit_logs set action = 'x'$$, '42501', null, 'RLS-07 even the owner cannot UPDATE');
set local role service_role;
select throws_ok($$delete from public.audit_logs$$, '42501', null, 'RLS-07 service_role cannot DELETE');
reset role;
insert into public.audit_logs (actor_type, action, created_at) values ('system', 'rls.old', now() - interval '3 years');
set local role retention_job;
set local search_path = extensions, public;
select throws_ok(
  $$delete from public.audit_logs where action = 'rls.test'$$, '42501', null,
  'RLS-07 retention_job cannot delete rows younger than 2 years'
);
select lives_ok($$delete from public.audit_logs where action = 'rls.old'$$, 'RLS-07 retention_job can delete rows past 2 years');
reset role;
select is((select count(*)::int from public.audit_logs where action = 'rls.old'), 0, 'RLS-07 the old row is really gone');

-- RLS-08
select is(
  (select array_agg(p.proname::text order by p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef),
  array['handle_new_user', 'hook_before_user_created', 'set_identity_block'],
  'RLS-08 SECURITY DEFINER whitelist'
);

-- RLS-09
insert into private.identity_blocks (email_hmac)
select extensions.hmac('blocked@example.com', decrypted_secret, 'sha256')
from vault.decrypted_secrets where name = 'identity_pepper';
select is(has_function_privilege('supabase_auth_admin', 'private.hook_before_user_created(jsonb)', 'EXECUTE'), true, 'RLS-09 Auth can call the hook');
select is(
  private.hook_before_user_created('{"user":{"email":"Blocked@Example.com","app_metadata":{"provider":"github"}}}')->'error'->>'http_code',
  '403', 'RLS-09 blocked email is rejected, case-insensitively'
);
select is(
  private.hook_before_user_created('{"user":{"email":"new@example.com","app_metadata":{"provider":"github"}}}'),
  '{}'::jsonb, 'RLS-09 other email passes'
);
select is(
  private.hook_before_user_created('{"user":{"email":"new@example.com","app_metadata":{"provider":"email"}}}')->'error'->>'http_code',
  '403', 'RLS-09 provider outside the allow-list is rejected'
);

-- §11.5 retention, each job as it runs from pg_cron
insert into public.api_keys (user_id, name, key_prefix, key_hash, scopes, revoked_at) values
  ('00000000-0000-4000-a000-000000000002', 'old', 'p1', 'h1', '{}', now() - interval '91 days'),
  ('00000000-0000-4000-a000-000000000002', 'new', 'p2', 'h2', '{}', now() - interval '89 days');
insert into public.moderation_cases (id, target_type, target_id, status, reviewer_note, resolved_at)
values ('00000000-0000-4000-b000-000000000001', 'quote', gen_random_uuid(), 'resolved', '舊備註', now() - interval '13 months');
insert into public.reports (case_id, target_type, target_id, reason, detail)
select id, target_type, target_id, 'other', '舊內容' from public.moderation_cases where id = '00000000-0000-4000-b000-000000000001';

set local role retention_job;
delete from public.api_keys where revoked_at < now() - interval '90 days';
update public.reports r set detail = null
from public.moderation_cases c
where r.case_id = c.id and r.detail is not null and c.resolved_at < now() - interval '1 year';
update public.moderation_cases set reviewer_note = null
where reviewer_note is not null and resolved_at < now() - interval '1 year';
reset role;

select is((select array_agg(name) from public.api_keys where key_prefix in ('p1', 'p2')), array['new'], 'retention deletes keys revoked over 90 days ago only');
select is(
  (select row(c.reviewer_note, r.detail)::text from public.moderation_cases c join public.reports r on r.case_id = c.id where c.id = '00000000-0000-4000-b000-000000000001'),
  row(null::text, null::text)::text, 'retention clears text after a year and keeps the rows'
);

select * from finish();
rollback;
