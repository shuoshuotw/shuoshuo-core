-- A deleted account's name is shown with （已刪除） after it (D-22), so no living account may carry those words: a
-- name that does at sign-up, (已刪除) or （已刪除） alike (the brackets are stripped, the words are not), gets the
-- default form instead. Renaming refuses them in Core (lib/validators/me.ts). The default form is now 說說使用者-
-- and five characters; names already given keep theirs.

create or replace function private.default_username() returns text
language plpgsql set search_path = '' as $$
declare
  candidate text;
begin
  loop
    candidate := '說說使用者-' || upper(left(encode(extensions.gen_random_bytes(3), 'hex'), 5));
    exit when not exists (
      select 1 from public.profiles where lower(username) = lower(candidate) and deleted_at is null
    );
  end loop;
  return candidate;
end;
$$;

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
  if char_length(wanted) < 2 or position('已刪除' in wanted) > 0 then
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
