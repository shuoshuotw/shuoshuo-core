-- TEST_PLAN RLS-10, PV-04
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create function pg_temp.signup(meta jsonb) returns uuid language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
          gen_random_uuid() || '@example.com', meta)
  returning id;
$$;

create function pg_temp.name_of(meta jsonb) returns text language plpgsql as $$
declare
  new_id uuid := pg_temp.signup(meta);
begin
  return (select username from public.profiles where id = new_id);
end;
$$;

select is(
  pg_temp.name_of('{"full_name":"陳大文"}'),
  '陳大文', 'RLS-10 full_name becomes the username'
);
select is(
  pg_temp.name_of('{"name":"neo_tw"}'),
  'neo_tw', 'RLS-10 falls back to name'
);
select matches(
  pg_temp.name_of('{}'),
  '^說說使用者-[0-9A-F]{5}$', 'RLS-10 no name gets the default form'
);
select is(
  char_length(pg_temp.name_of(jsonb_build_object('full_name', repeat('長', 40)))),
  30, 'RLS-10 long name is truncated to 30'
);
select matches(
  pg_temp.name_of('{"full_name":"!@#"}'),
  '^說說使用者-[0-9A-F]{5}$', 'RLS-10 name without allowed characters gets the default form'
);
select matches(
  pg_temp.name_of('{"full_name":"小明"}'),
  '^說說使用者-[0-9A-F]{5}$', 'RLS-10 name collision gets the default form'
);
select matches(
  pg_temp.name_of('{"full_name":"ALICE"}'),
  '^ALICE$', 'a Latin name keeps its case'
);
select matches(
  pg_temp.name_of('{"full_name":"alice"}'),
  '^說說使用者-[0-9A-F]{5}$', 'RLS-10 collision check ignores case (D-35)'
);

-- A deleted account's name is shown with （已刪除） after it (D-22): a new one carrying those words takes the default form
select matches(
  pg_temp.name_of('{"full_name":"小華（已刪除）"}'),
  '^說說使用者-[0-9A-F]{5}$', 'a name marked （已刪除） gets the default form'
);
select matches(
  pg_temp.name_of('{"full_name":"說說官方"}'),
  '^說說使用者-[0-9A-F]{5}$', 'the site''s own name 說說官方 gets the default form'
);
select matches(
  pg_temp.name_of('{"name":"已刪除的人"}'),
  '^說說使用者-[0-9A-F]{5}$', 'a name with 已刪除 in it gets the default form'
);

-- Separate statements: one statement's snapshot cannot see rows its own trigger inserted
create temp table created on commit drop as
  select pg_temp.signup('{"full_name":"新朋友","avatar_url":"https://evil.example/pixel.gif"}') as id;
select is(
  (select row(p.avatar_url, p.likes_public, p.favorites_public, s.status::text, s.strike_count)::text
   from created c join public.profiles p on p.id = c.id join public.account_standing s on s.user_id = c.id),
  row(null::text, true, true, 'active', 0)::text,
  'RLS-10 standing row is created; untrusted avatar host is dropped; PV-04 lists default to public'
);
create temp table with_avatar on commit drop as
  select pg_temp.signup('{"full_name":"有頭像","avatar_url":"https://avatars.githubusercontent.com/u/1"}') as id;
select is(
  (select p.avatar_url from public.profiles p join with_avatar a on a.id = p.id),
  'https://avatars.githubusercontent.com/u/1', 'allowed avatar host is kept'
);

-- A deleted account frees its name (D-35)
update public.profiles set deleted_at = now() where id = '00000000-0000-4000-a000-000000000005';
select is(
  pg_temp.name_of('{"full_name":"阿德"}'),
  '阿德', 'D-35 the name of a deleted account can be taken'
);

select * from finish();
rollback;
