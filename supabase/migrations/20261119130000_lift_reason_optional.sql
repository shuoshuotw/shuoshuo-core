-- A lift's reason is the admin's to give or leave out: without one, the sanction is lifted with no reason recorded
create or replace function private.lift_sanction(actor uuid, sanction_id uuid, reason text default null) returns jsonb
language plpgsql set search_path = '' as $$
declare
  sanction public.sanctions;
  standing public.account_standing;
  lifted_ban boolean;
begin
  perform private.assert_admin(actor);
  select * into sanction from public.sanctions s where s.id = sanction_id;
  if not found then
    perform private.raise_error('SANCTION_NOT_FOUND');
  end if;
  perform 1 from public.account_standing s where s.user_id = sanction.user_id for update;
  select * into sanction from public.sanctions s where s.id = sanction_id;
  if sanction.lifted_at is not null or sanction.ends_at <= now() then
    perform private.raise_error('SANCTION_ALREADY_LIFTED');
  end if;

  update public.sanctions s
  set lifted_at = now(), lifted_by = actor, lift_reason = lift_sanction.reason
  where s.id = sanction.id;
  lifted_ban := private.recalculate_standing(sanction.user_id);
  if lifted_ban then
    perform private.lift_ban_effects(sanction.user_id, actor, reason);
  end if;
  perform private.audit(actor, 'admin', 'sanction.lift', 'sanction', sanction.id::text, jsonb_build_object('reason', reason));

  select * into standing from public.account_standing s where s.user_id = sanction.user_id;
  return jsonb_build_object(
    'lifted_at', private.iso(now()),
    'standing', case when standing.user_id is null then null else private.standing_json(standing) end
  );
end;
$$;
