-- API keys, profile, sanctions, account deletion and reads (SPEC §6.6, §10.3, §11.5, D-37)
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

set local role service_role;

create temp table ids (name text primary key, id uuid) on commit drop;
create function pg_temp.id(key text) returns uuid language sql as $$ select id from ids where name = key $$;
create function pg_temp.hash(value text) returns bytea language sql as $$ select extensions.digest(value, 'sha256') $$;

insert into ids values
  ('admin', '00000000-0000-4000-a000-000000000001'),
  ('alice', '00000000-0000-4000-a000-000000000002'),
  ('bob', '00000000-0000-4000-a000-000000000003'),
  ('carol', '00000000-0000-4000-a000-000000000004'),
  ('seed_alice', '00000000-0000-4000-8000-000000000104'),
  ('seed_bob', '00000000-0000-4000-8000-000000000105');

-- API keys
insert into ids select 'key1', (private.create_api_key(pg_temp.id('alice'), '部落格', 'shuoshuo_test_aaaaaaaa', pg_temp.hash('k1'), array['quotes:read'])->>'id')::uuid;
select is(
  (select array_agg(k order by k) from jsonb_object_keys(private.api_key_json((select k from public.api_keys k where k.id = pg_temp.id('key1')))) k),
  array['created_at', 'id', 'key_prefix', 'last_used_at', 'name', 'regenerated_at', 'scopes'],
  'SEC-06 api_key_json carries no hash'
);
select throws_ok($$select private.revoke_api_key(pg_temp.id('bob'), pg_temp.id('key1'))$$, 'P0001', 'API_KEY_NOT_FOUND', 'SEC-04 cannot revoke another user''s key');
select is((private.regenerate_api_key(pg_temp.id('alice'), pg_temp.id('key1'), 'shuoshuo_test_bbbbbbbb', pg_temp.hash('k2')))->>'id', pg_temp.id('key1')::text, 'regenerate keeps the id');
select is((select key_hash from public.api_keys where id = pg_temp.id('key1')), pg_temp.hash('k2'), 'regenerate replaces the hash');
select lives_ok($$select private.revoke_api_key(pg_temp.id('alice'), pg_temp.id('key1'))$$, 'owner revokes');
select throws_ok($$select private.regenerate_api_key(pg_temp.id('alice'), pg_temp.id('key1'), 'x', pg_temp.hash('k3'))$$, 'P0001', 'API_KEY_NOT_FOUND', 'revoked key cannot regenerate');
do $$ begin
  for i in 1..10 loop
    perform private.create_api_key(pg_temp.id('bob'), 'k' || i, 'p' || i, pg_temp.hash('bob' || i), array['quotes:read']);
  end loop;
end $$;
select throws_ok($$select private.create_api_key(pg_temp.id('bob'), 'k11', 'p11', pg_temp.hash('bob11'), array['quotes:read'])$$, 'P0001', 'API_KEY_LIMIT_REACHED', 'SEC-08 limit of 10');

-- Profile
select is((private.update_profile(pg_temp.id('alice'), likes_public => false)).likes_public, false, 'privacy setting changes');
select is((private.update_profile(pg_temp.id('alice'), likes_public => null)).likes_public, false, 'null leaves a field unchanged');
select throws_ok($$select private.update_profile(pg_temp.id('alice'), '阿華')$$, 'P0001', 'USERNAME_TAKEN', 'name in use');
select lives_ok($$select private.update_profile(pg_temp.id('alice'), '新名字')$$, 'name can change');
select throws_ok($$select private.reset_profile(pg_temp.id('bob'), pg_temp.id('alice'), '不當')$$, 'P0001', 'FORBIDDEN_ROLE', 'non-admin cannot reset');
select matches((private.reset_profile(pg_temp.id('admin'), pg_temp.id('alice'), '不當名稱')).username, '^讀者[0-9a-f]{4}$', 'reset gives the default form');

-- Manual sanctions
select throws_ok($$select * from private.create_sanction(pg_temp.id('bob'), pg_temp.id('carol'), 'account_ban', null, 'x')$$, 'P0001', 'FORBIDDEN_ROLE', 'non-admin cannot sanction');
select throws_ok($$select * from private.create_sanction(pg_temp.id('admin'), gen_random_uuid(), 'account_ban', null, 'x')$$, 'P0001', 'USER_NOT_FOUND', 'unknown user');
insert into ids select 'manual', sanction_id from private.create_sanction(pg_temp.id('admin'), pg_temp.id('carol'), 'submit_suspension', 3, '張貼不當內容');
select is((select strike_count from public.account_standing where user_id = pg_temp.id('carol')), 0, 'manual sanction adds no strike');
select ok((select suspended_until > now() from public.account_standing where user_id = pg_temp.id('carol')), 'manual suspension applies');
select is((private.lift_sanction(pg_temp.id('admin'), pg_temp.id('manual'), '誤判'))->'standing'->>'status', 'active', 'lifting recalculates standing');
select throws_ok($$select private.lift_sanction(pg_temp.id('admin'), pg_temp.id('manual'), '再解一次')$$, 'P0001', 'SANCTION_ALREADY_LIFTED', 'lift once');
select lives_ok($$select * from private.create_sanction(pg_temp.id('admin'), pg_temp.id('carol'), 'account_ban', null, '嚴重違規')$$, 'manual ban');
select throws_ok($$select * from private.create_sanction(pg_temp.id('admin'), pg_temp.id('carol'), 'account_ban', null, '再一次')$$, 'P0001', 'ALREADY_BANNED', 'cannot ban twice');

-- Reads
select is(jsonb_array_length((private.sample_quotes('anime', 5))->'quotes'), 5, 'sample_quotes honours n');
select is(((private.sample_quotes('anime', 500))->>'category_total')::int, 20, 'category_total comes back');
select is(jsonb_array_length((private.sample_quotes('anime', 500))->'quotes'), 20, 'sample wraps around to return every quote');
select throws_ok($$select private.sample_quotes('anime', 501)$$, 'P0001', 'sample_quotes n must be at most 500', 'n is capped below the Data API row limit');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((private.sample_quotes('anime', 1))->'quotes'->0) k),
  array['category', 'commit_from', 'content', 'created_at', 'edited_at', 'id', 'length', 'source_from', 'stats', 'status', 'submitter'],
  'quote_json has exactly the Quote fields of §8.2.2'
);
select is((private.random_quote_fallback(array['anime'], 100, 100))->>'length', '100', 'fallback honours the length range');
select is(private.random_quote_fallback(array['no-such-category']), null, 'fallback finds nothing');

-- D-37: a fresh quote scores 5, one like in the last 7 days scores 1, older likes score nothing
reset role;
insert into public.quote_likes (user_id, quote_id, created_at) values
  (pg_temp.id('bob'), pg_temp.id('seed_bob'), now() - interval '8 days');
update public.quotes set created_at = now() where id = pg_temp.id('seed_alice');
update public.quotes set created_at = now() - interval '30 days' where id = pg_temp.id('seed_bob');
set local role service_role;
select is(
  (private.trending_quotes(null, 1))->0->>'id', pg_temp.id('seed_alice')::text, 'TR-01 the freshest quote leads'
);
select ok(
  not exists (select 1 from jsonb_array_elements(private.trending_quotes(null, 50)) e where e->>'id' = pg_temp.id('seed_bob')::text),
  'TR-01 a like older than 7 days does not make a quote a candidate'
);

-- Account deletion (§11.5)
insert into ids select 'bob_comment', private.create_comment(pg_temp.id('bob'), pg_temp.id('seed_alice'), '會被刪除的留言');
insert into ids select 'bob_quote', private.create_quote(pg_temp.id('bob'), '刪帳後仍會留下的說說', pg_temp.hash('keep'), 'original', '自己', 'web');
select lives_ok($$select private.set_reaction(pg_temp.id('bob'), pg_temp.id('seed_alice'), 'like', true)$$, 'bob likes before deleting');
select lives_ok($$select * from private.create_report(pg_temp.id('admin'), 'comment', pg_temp.id('bob_comment'), 'spam')$$, 'bob has a comment with an open case');
select lives_ok($$select * from private.create_report(pg_temp.id('bob'), 'quote', pg_temp.id('seed_alice'), 'spam')$$, 'bob filed a report');
select is(private.delete_account_data(pg_temp.id('bob')), 10, 'deletion revokes active keys');
select is(
  (select row(p.username, p.avatar_url, p.deleted_at is not null)::text from public.profiles p where p.id = pg_temp.id('bob')),
  row('阿華', null::text, true)::text, 'D-22 profile keeps the name'
);
select is((select count(*)::int from public.account_standing where user_id = pg_temp.id('bob')), 0, 'standing row is gone');
select is((select count(*)::int from public.comments where user_id = pg_temp.id('bob')), 0, 'comments are gone');
select is((select like_count from public.quote_stats where quote_id = pg_temp.id('seed_alice')), 0, 'like count is decremented');
select is((select status::text from public.quotes where id = pg_temp.id('bob_quote')), 'published', 'D-22 quotes stay');
select is(
  (select row(c.resolution::text, (select status::text from public.reports r where r.case_id = c.id limit 1))::text from public.moderation_cases c where c.target_id = pg_temp.id('bob_comment')),
  row('target_deleted', 'voided')::text, 'comment case closes as target_deleted with voided reports'
);
select is((select count(*)::int from public.reports where target_id = pg_temp.id('seed_alice') and reporter_id is null), 1, 'reporter identity is cleared, the report stays');
select is(private.delete_account_data(pg_temp.id('bob')), 0, '§11.5 step 2 is idempotent');
select * from finish();
rollback;
