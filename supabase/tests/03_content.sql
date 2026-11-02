-- RPC behaviour for quotes, reactions and comments (SPEC §6.6, D-12, D-32 to D-34). Runs as Core's role.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

set local role service_role;

create temp table ids (name text primary key, id uuid) on commit drop;
create function pg_temp.id(key text) returns uuid language sql as $$ select id from ids where name = key $$;
create function pg_temp.hash(value text) returns bytea language sql as $$ select extensions.digest(value, 'sha256') $$;

-- alice, bob, carol: seed users. quote_a belongs to alice, quote_b to bob.
insert into ids values
  ('admin', '00000000-0000-4000-a000-000000000001'),
  ('alice', '00000000-0000-4000-a000-000000000002'),
  ('bob', '00000000-0000-4000-a000-000000000003'),
  ('carol', '00000000-0000-4000-a000-000000000004');

insert into ids select 'quote_a', private.create_quote(pg_temp.id('alice'), '測試用的第一句話', pg_temp.hash('a1'), 'original', '自己', 'web');
select ok(pg_temp.id('quote_a') is not null, 'create_quote returns an id');
select is(
  (select row(q.original_content, q.status::text, s.like_count)::text from public.quotes q join public.quote_stats s on s.quote_id = q.id where q.id = pg_temp.id('quote_a')),
  row('測試用的第一句話', 'published', 0)::text,
  'create_quote stores original_content and creates stats'
);
select throws_ok(
  $$select private.create_quote(pg_temp.id('bob'), '另一句', pg_temp.hash('a1'), 'original', '自己', 'api')$$,
  'P0001', 'QUOTE_DUPLICATE', 'duplicate hash is rejected'
);

-- Edit (D-32)
select lives_ok($$select private.update_quote(pg_temp.id('alice'), pg_temp.id('quote_a'), source_from => '改來源')$$, 'source_from alone can change');
select is((select edited_at from public.quotes where id = pg_temp.id('quote_a')), null, 'edited_at stays null when content did not change');
select lives_ok($$select private.update_quote(pg_temp.id('alice'), pg_temp.id('quote_a'), '測試用的第二句話', pg_temp.hash('a2'))$$, 'owner edits content');
select is(
  (select row(content, original_content, edited_at is not null)::text from public.quotes where id = pg_temp.id('quote_a')),
  row('測試用的第二句話', '測試用的第一句話', true)::text,
  'ED-01 content changes, original_content never does, edited_at set'
);
select is(
  (select metadata->'before'->>'content' from public.audit_logs where action = 'quote.edit' and target_id = pg_temp.id('quote_a')::text order by id desc limit 1),
  '測試用的第一句話', 'ED-01 audit keeps the content before the edit'
);
select throws_ok($$select private.update_quote(pg_temp.id('bob'), pg_temp.id('quote_a'), '別人來改')$$, 'P0001', 'NOT_RESOURCE_OWNER', 'ED-02 non-owner cannot edit');
reset role;
update public.quotes set created_at = now() - interval '25 hours' where id = pg_temp.id('quote_a');
set local role service_role;
select throws_ok($$select private.update_quote(pg_temp.id('alice'), pg_temp.id('quote_a'), '過期再改')$$, 'P0001', 'QUOTE_EDIT_WINDOW_EXPIRED', 'ED-07 edit window is 24 hours');

-- Reactions
insert into ids select 'quote_b', private.create_quote(pg_temp.id('bob'), '鮑伯的一句話', pg_temp.hash('b1'), 'original', '自己', 'web');
select is((select count from private.set_reaction(pg_temp.id('alice'), pg_temp.id('quote_b'), 'like', true)), 1, 'like adds one');
select is((select count from private.set_reaction(pg_temp.id('alice'), pg_temp.id('quote_b'), 'like', true)), 1, 'like is idempotent');
select is((select count from private.set_reaction(pg_temp.id('alice'), pg_temp.id('quote_b'), 'favorite', true)), 1, 'favorite adds one');
select is((select count from private.set_reaction(pg_temp.id('alice'), pg_temp.id('quote_b'), 'like', false)), 0, 'unlike removes one');
select is((select active from private.set_reaction(pg_temp.id('alice'), pg_temp.id('quote_b'), 'like', false)), false, 'unlike is idempotent');
select throws_ok($$select private.set_reaction(pg_temp.id('alice'), gen_random_uuid(), 'like', true)$$, 'P0001', 'QUOTE_NOT_FOUND', 'unknown quote');

-- Comments
insert into ids select 'c1', private.create_comment(pg_temp.id('carol'), pg_temp.id('quote_b'), '第一則留言');
insert into ids select 'c2', private.create_comment(pg_temp.id('alice'), pg_temp.id('quote_b'), '第二則留言');
select is((select comment_count from public.quote_stats where quote_id = pg_temp.id('quote_b')), 2, 'comment_count follows inserts');
select lives_ok($$select private.update_comment(pg_temp.id('carol'), pg_temp.id('c1'), '改過的留言')$$, 'author edits within the window');
select ok((select edited_at is not null from public.comments where id = pg_temp.id('c1')), 'edited_at set');
select throws_ok($$select private.update_comment(pg_temp.id('bob'), pg_temp.id('c1'), '別人來改')$$, 'P0001', 'NOT_RESOURCE_OWNER', 'non-author cannot edit');
reset role;
update public.comments set created_at = now() - interval '21 minutes' where id = pg_temp.id('c2');
set local role service_role;
select throws_ok($$select private.update_comment(pg_temp.id('alice'), pg_temp.id('c2'), '過期再改')$$, 'P0001', 'COMMENT_EDIT_WINDOW_EXPIRED', 'ED-06 edit window is 20 minutes');

-- Pin (D-34)
select ok(private.set_comment_pin(pg_temp.id('bob'), pg_temp.id('c1'), true) is not null, 'PN-01 quote submitter can pin');
select throws_ok($$select private.set_comment_pin(pg_temp.id('carol'), pg_temp.id('c1'), true)$$, 'P0001', 'NOT_RESOURCE_OWNER', 'PN-01 comment author who is not the submitter cannot pin');
select throws_ok($$select private.set_comment_pin(pg_temp.id('admin'), pg_temp.id('c1'), true)$$, 'P0001', 'NOT_RESOURCE_OWNER', 'PN-01 admin cannot pin for someone else');
select lives_ok($$select private.set_comment_pin(pg_temp.id('bob'), pg_temp.id('c2'), true)$$, 'PN-02 pinning another comment replaces the first');
select is(
  (select array_agg(id) from public.comments where quote_id = pg_temp.id('quote_b') and pinned_at is not null),
  array[pg_temp.id('c2')], 'PN-02 exactly one pinned comment'
);
select lives_ok($$select private.delete_comment(pg_temp.id('alice'), pg_temp.id('c2'))$$, 'author deletes own comment');
select is(
  (select row(status::text, pinned_at)::text from public.comments where id = pg_temp.id('c2')),
  row('deleted', null::timestamptz)::text, 'PN-04 deleting clears the pin'
);
select is((select comment_count from public.quote_stats where quote_id = pg_temp.id('quote_b')), 1, 'comment_count follows deletes');
select throws_ok($$select private.delete_comment(pg_temp.id('alice'), pg_temp.id('c2'))$$, 'P0001', 'COMMENT_NOT_FOUND', 'deleted comment is gone');

-- Delete quote, then the content can be submitted again (§6.4)
select throws_ok($$select private.delete_quote(pg_temp.id('alice'), pg_temp.id('quote_b'))$$, 'P0001', 'NOT_RESOURCE_OWNER', 'non-owner cannot delete');
select lives_ok($$select private.delete_quote(pg_temp.id('bob'), pg_temp.id('quote_b'))$$, 'owner deletes');
select lives_ok($$select private.create_quote(pg_temp.id('alice'), '鮑伯的一句話', pg_temp.hash('b1'), 'original', '自己', 'web')$$, 'self-deleted content can be resubmitted');
select throws_ok($$select private.update_quote(pg_temp.id('bob'), pg_temp.id('quote_b'), '刪掉了還改')$$, 'P0001', 'QUOTE_NOT_FOUND', 'deleted quote cannot be edited');

-- Suspension and ban (D-12, §9.5)
reset role;
update public.account_standing set suspended_until = now() + interval '7 days' where user_id = pg_temp.id('carol');
set local role service_role;
select throws_ok($$select private.create_quote(pg_temp.id('carol'), '封禁中提交', pg_temp.hash('c1'), 'original', '自己', 'web')$$, 'P0001', 'SUBMISSION_SUSPENDED', 'suspended user cannot submit');
select throws_ok($$select private.create_comment(pg_temp.id('carol'), pg_temp.id('quote_a'), '封禁中留言')$$, 'P0001', 'COMMENTING_SUSPENDED', 'D-12 suspended user cannot comment');
select lives_ok($$select private.set_reaction(pg_temp.id('carol'), pg_temp.id('quote_a'), 'like', true)$$, 'D-12 suspended user can still like');
reset role;
update public.account_standing set status = 'banned', suspended_until = null where user_id = pg_temp.id('carol');
set local role service_role;
select throws_ok($$select private.set_reaction(pg_temp.id('carol'), pg_temp.id('quote_a'), 'like', false)$$, 'P0001', 'ACCOUNT_BANNED', 'banned user cannot react');
select throws_ok($$select private.create_quote(gen_random_uuid(), '刪帳後的舊 JWT', pg_temp.hash('x'), 'original', '自己', 'web')$$, 'P0001', 'TOKEN_INVALID', '§11.5 no standing row answers TOKEN_INVALID');

select * from finish();
rollback;
