-- §9.4: a case can be upheld without a penalty. The reported content is taken down all the same, but no violation is
-- recorded, no strike is counted and no sanction follows. `penalized` says which way an upheld case went (null for the
-- rest); every case upheld before this was penalized.
alter table public.moderation_cases add column penalized boolean;
update public.moderation_cases set penalized = true where resolution = 'uphold';

drop function private.resolve_case(uuid, uuid, public.case_resolution, public.report_reason, text);

create function private.resolve_case(
  actor uuid,
  case_id uuid,
  resolution public.case_resolution,
  final_reason public.report_reason default null,
  note text default null,
  penalize boolean default true
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  target_kind public.report_target;
  target uuid;
  quote public.quotes;
  comment public.comments;
  case_row public.moderation_cases;
  subject uuid;
  subject_deleted boolean;
  standing public.account_standing;
  new_strikes int;
  new_violation uuid;
  target_status text;
  sanction_json jsonb := null;
  revoked int := 0;
  duration interval;
  new_end timestamptz;
begin
  perform private.assert_admin(actor);
  if resolution not in ('dismiss', 'uphold') then
    raise exception 'resolve_case does not accept %', resolution;
  end if;

  select c.target_type, c.target_id into target_kind, target from public.moderation_cases c where c.id = case_id;
  if not found then
    perform private.raise_error('CASE_NOT_FOUND');
  end if;

  if target_kind = 'quote' then
    select * into quote from public.quotes q where q.id = target for update;
    subject := quote.submitter_id;
    target_status := quote.status;
  else
    select * into comment from public.comments c where c.id = target for update;
    subject := comment.user_id;
    target_status := comment.status;
  end if;

  select * into case_row from public.moderation_cases c where c.id = case_id for update;
  if case_row.status = 'resolved' then
    perform private.raise_error('CASE_ALREADY_RESOLVED');
  end if;

  update public.moderation_cases c set
    status = 'resolved', resolution = resolve_case.resolution, final_reason = resolve_case.final_reason,
    penalized = case when resolve_case.resolution = 'uphold' then resolve_case.penalize end,
    reviewer_note = note, resolved_by = actor, resolved_at = now()
  where c.id = case_row.id;
  update public.reports r
  set status = case resolve_case.resolution when 'uphold' then 'upheld'::public.report_status else 'dismissed' end
  where r.case_id = case_row.id;

  if resolution = 'dismiss' then
    if target_kind = 'quote' and quote.status = 'under_review' then
      update public.quotes q set status = 'published', under_review_since = null where q.id = quote.id;
      target_status := 'published';
    end if;
  else
    if target_kind = 'quote' then
      update public.quotes q set
        status = 'removed', removed_at = now(), removed_reason = resolve_case.final_reason, under_review_since = null
      where q.id = quote.id;
    else
      update public.comments c set status = 'removed', pinned_at = null where c.id = comment.id;
      perform private.audit(actor, 'admin', 'comment.remove', 'comment', comment.id::text,
        jsonb_build_object('reason', final_reason));
    end if;
    target_status := 'removed';

    select p.deleted_at is not null into subject_deleted from public.profiles p where p.id = subject;
    -- Upheld without a penalty: the content is gone and nothing is held against its author
    if not subject_deleted and resolve_case.penalize then
      insert into public.violations (user_id, quote_id, case_id, reason, counts_as_strike)
      values (subject, quote.id, case_row.id, final_reason, target_kind = 'quote')
      returning id into new_violation;

      -- §9.4 ladder; comments never count (D-14)
      if target_kind = 'quote' then
        standing := private.lock_standing(subject, true);
        new_strikes := standing.strike_count + 1;
        update public.account_standing s set strike_count = new_strikes where s.user_id = subject;

        if standing.status = 'banned' then
          null;
        elsif new_strikes >= 4 then
          insert into public.sanctions (user_id, violation_id, kind, source, reason, issued_by)
          values (subject, new_violation, 'account_ban', 'auto', format('確認違規（第 %s 次）', new_strikes), actor);
          revoked := private.apply_ban(subject, actor, format('確認違規（第 %s 次）', new_strikes));
          sanction_json := jsonb_build_object('kind', 'account_ban', 'ends_at', null);
        else
          duration := case new_strikes when 1 then interval '7 days' when 2 then interval '30 days' else interval '90 days' end;
          new_end := greatest(standing.suspended_until, now() + duration);
          insert into public.sanctions (user_id, violation_id, kind, source, ends_at, reason, issued_by)
          values (subject, new_violation, 'submit_suspension', 'auto', new_end, format('確認違規（第 %s 次）', new_strikes), actor);
          update public.account_standing s set suspended_until = new_end where s.user_id = subject;
          sanction_json := jsonb_build_object('kind', 'submit_suspension', 'ends_at', private.iso(new_end));
        end if;
      end if;
    end if;
  end if;

  perform private.audit(actor, 'admin', 'case.resolve', 'case', case_row.id::text, jsonb_build_object(
    'resolution', resolution, 'final_reason', final_reason, 'target_type', target_kind, 'target_id', target,
    'penalize', case when resolution = 'uphold' then penalize end
  ));

  return jsonb_build_object(
    'target_status', target_status,
    'violation_id', new_violation,
    'strike_count', new_strikes,
    'sanction', sanction_json,
    'api_keys_revoked', revoked
  );
end;
$$;

grant execute on function private.resolve_case(uuid, uuid, public.case_resolution, public.report_reason, text, boolean) to service_role;
