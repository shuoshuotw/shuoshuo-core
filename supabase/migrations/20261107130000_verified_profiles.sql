-- An account the site vouches for, such as 說說官方: its name carries a check wherever it is shown. Set by hand in
-- SQL on the environment itself; no route writes it.
alter table public.profiles add column verified boolean not null default false;

-- The name 說說官方 belongs to the site: no account takes it, or a name made from it, at sign-up (Core refuses it on
-- rename, lib/validators/me.ts)
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wanted text := left(
    regexp_replace(
      normalize(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''), nfc),
      '[^0-9A-Za-z_\-々〇㐀-䶿一-鿿豈-﫿\U00020000-\U0003134F]', '', 'g'
    ),
    30
  );
  avatar text := new.raw_user_meta_data->>'avatar_url';
begin
  -- Only the image hosts allowed by the CSP (§11.4); anything else could be a tracking pixel
  if avatar !~ '^https://([a-z0-9-]+\.googleusercontent\.com|cdn\.discordapp\.com|avatars\.githubusercontent\.com)/' then
    avatar := null;
  end if;
  if char_length(wanted) < 2 or position('已刪除' in wanted) > 0 or position('說說官方' in wanted) > 0 then
    wanted := private.default_username();
  end if;
  loop
    begin
      insert into public.profiles (id, username, avatar_url) values (new.id, wanted, avatar);
      exit;
    exception when unique_violation then
      wanted := private.default_username();
    end;
  end loop;
  insert into public.account_standing (user_id) values (new.id);
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;

-- Keep in step with QUOTE_SELECT in lib/quotes/serialize.ts (§8.2.2)
create or replace function private.quote_json(quote public.quotes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', quote.id,
    'content', quote.content,
    'length', quote.length,
    'category', jsonb_build_object('key', c.key, 'name', c.name_zh),
    'source_from', quote.source_from,
    'submitter', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'deleted', p.deleted_at is not null, 'verified', p.verified),
    'stats', jsonb_build_object(
      'like_count', coalesce(s.like_count, 0),
      'favorite_count', coalesce(s.favorite_count, 0),
      'comment_count', coalesce(s.comment_count, 0)
    ),
    'status', quote.status,
    'commit_from', quote.commit_from,
    'edited_at', private.iso(quote.edited_at),
    'created_at', private.iso(quote.created_at)
  )
  from public.categories c, public.profiles p
  left join public.quote_stats s on s.quote_id = quote.id
  where c.key = quote.category_key and p.id = quote.submitter_id;
$$;
