-- §8.8.2: a key lasts 30, 60, 90, 180 or 360 days, or for good once its owner has allowed that in the security
-- settings. Keys made before this have no end date, as they were made.
alter table public.api_keys add column expires_at timestamptz;

-- §8.7.2: the security settings' switch that allows keys without an end date
alter table public.profiles add column allow_permanent_api_keys boolean not null default false;

-- §12.8: 減少動態效果 follows the account to every device it signs in on
alter table public.profiles add column reduce_motion boolean not null default false;

create or replace function private.api_key_json(key public.api_keys) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', key.id,
    'name', key.name,
    'key_prefix', key.key_prefix,
    'scopes', key.scopes,
    'expires_at', private.iso(key.expires_at),
    'last_used_at', private.iso(key.last_used_at),
    'regenerated_at', private.iso(key.regenerated_at),
    'created_at', private.iso(key.created_at)
  );
$$;

drop function private.create_api_key(uuid, text, text, bytea, text[]);

create function private.create_api_key(
  actor uuid, name text, key_prefix text, key_hash bytea, scopes text[], expires_at timestamptz default null
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  key public.api_keys;
begin
  -- Exclusive: serialises the limit count and any concurrent ban, so no key can escape revoke-all (T-08)
  perform private.assert_not_banned(actor, true);
  if create_api_key.expires_at is null
    and not (select p.allow_permanent_api_keys from public.profiles p where p.id = actor) then
    perform private.raise_error('API_KEY_PERMANENT_DISABLED');
  end if;
  if (select count(*) from public.api_keys k where k.user_id = actor and k.revoked_at is null) >= 10 then
    perform private.raise_error('API_KEY_LIMIT_REACHED');
  end if;
  insert into public.api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
  values (actor, create_api_key.name, create_api_key.key_prefix, create_api_key.key_hash, create_api_key.scopes, create_api_key.expires_at)
  returning * into key;
  perform private.audit(actor, 'user', 'api_key.create', 'api_key', key.id::text, jsonb_build_object(
    'name', key.name, 'scopes', key.scopes, 'expires_at', private.iso(key.expires_at)
  ));
  return private.api_key_json(key);
end;
$$;

-- §8.7.1: the picture is one of the account's own sign-in providers' (Core reads and checks it), or none
drop function private.update_profile(uuid, text, boolean, boolean);

create function private.update_profile(
  actor uuid,
  username text default null,
  likes_public boolean default null,
  favorites_public boolean default null,
  allow_permanent_api_keys boolean default null,
  set_avatar boolean default false,
  avatar_url text default null,
  reduce_motion boolean default null
) returns public.profiles
language plpgsql set search_path = '' as $$
declare
  profile public.profiles;
  revoked uuid;
begin
  perform private.assert_not_banned(actor);
  begin
    update public.profiles p set
      username = coalesce(update_profile.username, p.username),
      likes_public = coalesce(update_profile.likes_public, p.likes_public),
      favorites_public = coalesce(update_profile.favorites_public, p.favorites_public),
      allow_permanent_api_keys = coalesce(update_profile.allow_permanent_api_keys, p.allow_permanent_api_keys),
      avatar_url = case when update_profile.set_avatar then update_profile.avatar_url else p.avatar_url end,
      reduce_motion = coalesce(update_profile.reduce_motion, p.reduce_motion)
    where p.id = actor
    returning * into profile;
  exception when unique_violation then
    perform private.raise_error('USERNAME_TAKEN');
  end;
  -- §8.8.2: taking the leave back revokes every key that never expires, each audited as its owner's own delete
  if update_profile.allow_permanent_api_keys is false then
    for revoked in
      update public.api_keys k set revoked_at = now(), revoked_reason = 'user'
      where k.user_id = actor and k.revoked_at is null and k.expires_at is null
      returning k.id
    loop
      perform private.audit(actor, 'user', 'api_key.delete', 'api_key', revoked::text, jsonb_build_object('reason', 'permanent_disallowed'));
    end loop;
  end if;
  return profile;
end;
$$;

grant execute on function private.create_api_key(uuid, text, text, bytea, text[], timestamptz) to service_role;
grant execute on function private.update_profile(uuid, text, boolean, boolean, boolean, boolean, text, boolean) to service_role;
