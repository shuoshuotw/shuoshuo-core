-- SPEC §6.7. The only SECURITY DEFINER functions besides private.set_identity_block (TEST_PLAN RLS-08).

create function private.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  provider text := event->'user'->'app_metadata'->>'provider';
  pepper text;
begin
  if provider is null or provider not in ('google', 'discord', 'github') then
    return jsonb_build_object('error', jsonb_build_object('message', 'Provider not allowed', 'http_code', 403));
  end if;
  select decrypted_secret into pepper from vault.decrypted_secrets where name = 'identity_pepper';
  -- Fail closed: Auth answers 500, new users cannot register, existing users are unaffected
  if pepper is null then
    raise exception 'identity_pepper is missing';
  end if;
  if exists (
    select 1 from private.identity_blocks
    where email_hmac = extensions.hmac(lower(event->'user'->>'email'), pepper, 'sha256')
  ) then
    return jsonb_build_object('error', jsonb_build_object('message', 'Account blocked', 'http_code', 403));
  end if;
  return '{}'::jsonb;
end;
$$;

revoke all on function private.hook_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;

create function private.default_username() returns text
language plpgsql set search_path = '' as $$
declare
  candidate text;
begin
  loop
    candidate := '讀者' || encode(extensions.gen_random_bytes(2), 'hex');
    exit when not exists (
      select 1 from public.profiles where lower(username) = candidate and deleted_at is null
    );
  end loop;
  return candidate;
end;
$$;

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wanted text := left(
    regexp_replace(
      normalize(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''), nfc),
      '[^0-9A-Za-z_\-々〇㐀-䶿一-鿿豈-﫿\U00020000-\U0003134F]', '', 'g'
    ),
    30
  );
  avatar text := new.raw_user_meta_data->>'avatar_url';
begin
  -- Only the image hosts allowed by the CSP (§11.4); anything else could be a tracking pixel
  if avatar !~ '^https://([a-z0-9-]+\.googleusercontent\.com|cdn\.discordapp\.com|avatars\.githubusercontent\.com)/' then
    avatar := null;
  end if;
  if char_length(wanted) < 2 then
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

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Ban and unban run from SECURITY INVOKER RPCs as service_role, which can read neither auth.* nor Vault.
create function private.set_identity_block(target uuid, blocked boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pepper text;
begin
  select decrypted_secret into pepper from vault.decrypted_secrets where name = 'identity_pepper';
  if pepper is null then
    raise exception 'identity_pepper is missing';
  end if;
  with verified as (
    select email from auth.users where id = target and email is not null and email_confirmed_at is not null
    union
    select identity_data->>'email' from auth.identities
    where user_id = target and identity_data->>'email' is not null and (identity_data->>'email_verified')::boolean
  ), hashed as (
    select extensions.hmac(lower(email), pepper, 'sha256') as email_hmac from verified
  ), added as (
    insert into private.identity_blocks (email_hmac)
    select email_hmac from hashed where blocked
    on conflict do nothing
    returning 1
  )
  delete from private.identity_blocks b
  using hashed h
  where not blocked and b.email_hmac = h.email_hmac;
end;
$$;

revoke all on function private.set_identity_block(uuid, boolean) from public, anon, authenticated;
grant execute on function private.set_identity_block(uuid, boolean) to service_role;
