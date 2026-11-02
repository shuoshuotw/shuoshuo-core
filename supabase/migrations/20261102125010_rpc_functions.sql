-- SPEC §6.6. Lock order everywhere: quote or comment row, then case row, then account_standing row.
-- Errors: RAISE '<ERROR_CODE>' USING ERRCODE = 'P0001', DETAIL = '<json>'. Core maps the code through errors.yaml.
-- Parameters keep the §6.6 names, so bodies qualify them with the function name.

-- Helpers

create function private.raise_error(code text, details jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', code using errcode = 'P0001', detail = coalesce(details::text, '');
end;
$$;

create function private.iso(value timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Core sends X-Request-Id on the RPC call; PostgREST exposes it here
create function private.audit(
  actor_id uuid, actor_type text, action text, target_type text, target_id text, metadata jsonb default '{}'
) returns void
language sql set search_path = '' as $$
  insert into public.audit_logs (actor_id, actor_type, action, target_type, target_id, metadata, request_id)
  values (actor_id, actor_type, action, target_type, target_id, metadata,
          nullif(current_setting('request.headers', true), '')::json->>'x-request-id');
$$;

-- A deleted account has no standing row, but its JWT stays valid for up to 15 minutes (§11.5)
create function private.lock_standing(actor uuid, exclusive boolean default false)
returns public.account_standing
language plpgsql set search_path = '' as $$
declare
  standing public.account_standing;
begin
  if exclusive then
    select * into standing from public.account_standing s where s.user_id = actor for update;
  else
    select * into standing from public.account_standing s where s.user_id = actor for share;
  end if;
  if not found then
    perform private.raise_error('TOKEN_INVALID');
  end if;
  return standing;
end;
$$;

create function private.assert_not_banned(actor uuid, exclusive boolean default false) returns void
language plpgsql set search_path = '' as $$
begin
  if (private.lock_standing(actor, exclusive)).status = 'banned' then
    perform private.raise_error('ACCOUNT_BANNED');
  end if;
end;
$$;

-- D-12: a suspension blocks writing quotes and comments, nothing else
create function private.assert_can_write_content(actor uuid, suspended_code text) returns void
language plpgsql set search_path = '' as $$
declare
  standing public.account_standing := private.lock_standing(actor);
begin
  if standing.status = 'banned' then
    perform private.raise_error('ACCOUNT_BANNED');
  end if;
  if standing.suspended_until > now() then
    perform private.raise_error(suspended_code, jsonb_build_object('until', private.iso(standing.suspended_until)));
  end if;
end;
$$;

create function private.assert_admin(actor uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.user_roles r where r.user_id = actor and r.role = 'admin') then
    perform private.raise_error('FORBIDDEN_ROLE');
  end if;
end;
$$;

create function private.standing_json(standing public.account_standing) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'status', case
      when standing.status = 'banned' then 'banned'
      when standing.suspended_until > now() then 'suspended'
      else 'active' end,
    'suspended_until', private.iso(standing.suspended_until),
    'strike_count', standing.strike_count,
    'strike_limit', 4,
    'can_submit', standing.status <> 'banned' and coalesce(standing.suspended_until <= now(), true),
    'can_comment', standing.status <> 'banned' and coalesce(standing.suspended_until <= now(), true)
  );
$$;

-- §9.4. The caller holds the standing lock. Returns whether this recalculation lifted a ban.
create function private.recalculate_standing(target uuid) returns boolean
language plpgsql set search_path = '' as $$
declare
  was_banned boolean;
  still_banned boolean := exists (
    select 1 from public.sanctions s
    where s.user_id = target and s.kind = 'account_ban' and s.lifted_at is null
  );
begin
  select s.status = 'banned' into was_banned from public.account_standing s where s.user_id = target;
  update public.account_standing s
  set strike_count = (
        select count(*) from public.violations v
        where v.user_id = target and v.counts_as_strike and v.overturned_at is null
      ),
      status = case when still_banned then 'banned'::public.standing_status else 'active' end,
      banned_at = case when still_banned then s.banned_at end,
      ban_reason = case when still_banned then s.ban_reason end,
      suspended_until = (
        select max(x.ends_at) from public.sanctions x
        where x.user_id = target and x.kind = 'submit_suspension' and x.lifted_at is null and x.ends_at > now()
      )
  where s.user_id = target;
  return coalesce(was_banned, false) and not still_banned;
end;
$$;

-- The caller holds the standing lock. Returns the number of revoked keys.
create function private.apply_ban(target uuid, actor uuid, reason text) returns int
language plpgsql set search_path = '' as $$
declare
  revoked int;
begin
  update public.account_standing s
  set status = 'banned', banned_at = now(), ban_reason = apply_ban.reason
  where s.user_id = target;
  update public.api_keys k
  set revoked_at = now(), revoked_reason = 'account_ban'
  where k.user_id = target and k.revoked_at is null;
  get diagnostics revoked = row_count;
  perform private.set_identity_block(target, true);
  perform private.audit(actor, 'admin', 'account.ban', 'user', target::text, jsonb_build_object('reason', reason));
  perform private.audit(actor, 'admin', 'api_key.revoke_all', 'user', target::text, jsonb_build_object('count', revoked));
  return revoked;
end;
$$;

create function private.lift_ban_effects(target uuid, actor uuid, reason text) returns void
language plpgsql set search_path = '' as $$
begin
  perform private.set_identity_block(target, false);
  perform private.audit(actor, 'admin', 'account.unban', 'user', target::text, jsonb_build_object('reason', reason));
end;
$$;

create function private.quote_json(quote public.quotes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', quote.id,
    'content', quote.content,
    'length', quote.length,
    'category', jsonb_build_object('key', c.key, 'name', c.name_zh),
    'source_from', quote.source_from,
    'submitter', jsonb_build_object('id', p.id, 'username', p.username, 'deleted', p.deleted_at is not null),
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

create function private.api_key_json(key public.api_keys) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', key.id,
    'name', key.name,
    'key_prefix', key.key_prefix,
    'scopes', key.scopes,
    'last_used_at', private.iso(key.last_used_at),
    'regenerated_at', private.iso(key.regenerated_at),
    'created_at', private.iso(key.created_at)
  );
$$;

-- Quotes

create function private.create_quote(
  actor uuid, content text, content_hash bytea, category text, source_from text, commit_from public.commit_source
) returns uuid
language plpgsql set search_path = '' as $$
declare
  new_id uuid;
  existing public.quotes;
begin
  perform private.assert_can_write_content(actor, 'SUBMISSION_SUSPENDED');
  begin
    insert into public.quotes (content, original_content, content_hash, category_key, source_from, submitter_id, commit_from)
    values (create_quote.content, create_quote.content, create_quote.content_hash, category,
            create_quote.source_from, actor, create_quote.commit_from)
    returning id into new_id;
  exception when unique_violation then
    select * into existing from public.quotes q
    where q.content_hash = create_quote.content_hash and q.status <> 'deleted';
    perform private.raise_error('QUOTE_DUPLICATE', jsonb_build_object(
      'existing_id', case when existing.status = 'removed' then null else existing.id end
    ));
  end;
  return new_id;
end;
$$;

create function private.update_quote(
  actor uuid, quote_id uuid, content text default null, content_hash bytea default null,
  category text default null, source_from text default null
) returns uuid
language plpgsql set search_path = '' as $$
declare
  quote public.quotes;
  existing public.quotes;
  content_changed boolean;
begin
  select * into quote from public.quotes q where q.id = update_quote.quote_id for update;
  if not found or quote.status = 'deleted' then
    perform private.raise_error('QUOTE_NOT_FOUND');
  end if;
  if quote.status = 'removed' then
    perform private.raise_error('QUOTE_REMOVED', jsonb_build_object('reason', quote.removed_reason));
  end if;
  if quote.submitter_id <> actor then
    perform private.raise_error('NOT_RESOURCE_OWNER');
  end if;
  if now() > quote.created_at + interval '24 hours' then
    perform private.raise_error('QUOTE_EDIT_WINDOW_EXPIRED');
  end if;
  if exists (
    select 1 from public.moderation_cases c
    where c.target_type = 'quote' and c.target_id = quote.id and c.status = 'open'
  ) then
    perform private.raise_error('QUOTE_HAS_OPEN_CASE');
  end if;
  perform private.assert_can_write_content(actor, 'SUBMISSION_SUSPENDED');

  content_changed := update_quote.content is not null and update_quote.content <> quote.content;
  begin
    update public.quotes q set
      content = coalesce(update_quote.content, q.content),
      content_hash = coalesce(update_quote.content_hash, q.content_hash),
      category_key = coalesce(category, q.category_key),
      source_from = coalesce(update_quote.source_from, q.source_from),
      edited_at = case when content_changed then now() else q.edited_at end
    where q.id = quote.id;
  exception when unique_violation then
    select * into existing from public.quotes q
    where q.content_hash = update_quote.content_hash and q.status <> 'deleted';
    perform private.raise_error('QUOTE_DUPLICATE', jsonb_build_object(
      'existing_id', case when existing.status = 'removed' then null else existing.id end
    ));
  end;

  perform private.audit(actor, 'user', 'quote.edit', 'quote', quote.id::text, jsonb_build_object(
    'before', jsonb_build_object('content', quote.content, 'category', quote.category_key, 'source_from', quote.source_from),
    'after', jsonb_build_object(
      'content', coalesce(update_quote.content, quote.content),
      'category', coalesce(category, quote.category_key),
      'source_from', coalesce(update_quote.source_from, quote.source_from)
    )
  ));
  return quote.id;
end;
$$;

create function private.delete_quote(actor uuid, quote_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  quote public.quotes;
begin
  select * into quote from public.quotes q where q.id = delete_quote.quote_id for update;
  if not found or quote.status = 'deleted' then
    perform private.raise_error('QUOTE_NOT_FOUND');
  end if;
  if quote.submitter_id <> actor then
    perform private.raise_error('NOT_RESOURCE_OWNER');
  end if;
  -- Deleting would free content_hash, letting removed content be submitted again (§6.4)
  if quote.status = 'removed' then
    perform private.raise_error('QUOTE_REMOVED', jsonb_build_object('reason', quote.removed_reason));
  end if;
  if exists (
    select 1 from public.moderation_cases c
    where c.target_type = 'quote' and c.target_id = quote.id and c.status = 'open'
  ) then
    perform private.raise_error('QUOTE_HAS_OPEN_CASE');
  end if;
  perform private.assert_not_banned(actor);
  update public.quotes q set status = 'deleted' where q.id = quote.id;
end;
$$;

create function private.set_reaction(actor uuid, quote_id uuid, kind text, value boolean)
returns table (active boolean, count int)
language plpgsql set search_path = '' as $$
declare
  quote public.quotes;
begin
  perform private.assert_not_banned(actor);
  select * into quote from public.quotes q where q.id = set_reaction.quote_id;
  if not found or quote.status = 'deleted' then
    perform private.raise_error('QUOTE_NOT_FOUND');
  end if;
  if quote.status = 'removed' then
    perform private.raise_error('QUOTE_REMOVED', jsonb_build_object('reason', quote.removed_reason));
  end if;

  if kind = 'like' then
    if value then
      insert into public.quote_likes (user_id, quote_id) values (actor, quote.id) on conflict do nothing;
    else
      delete from public.quote_likes l where l.user_id = actor and l.quote_id = quote.id;
    end if;
    return query select value, s.like_count from public.quote_stats s where s.quote_id = quote.id;
  elsif kind = 'favorite' then
    if value then
      insert into public.quote_favorites (user_id, quote_id) values (actor, quote.id) on conflict do nothing;
    else
      delete from public.quote_favorites f where f.user_id = actor and f.quote_id = quote.id;
    end if;
    return query select value, s.favorite_count from public.quote_stats s where s.quote_id = quote.id;
  else
    raise exception 'unknown reaction kind %', kind;
  end if;
end;
$$;

-- Comments

create function private.create_comment(actor uuid, quote_id uuid, content text) returns uuid
language plpgsql set search_path = '' as $$
declare
  quote public.quotes;
  new_id uuid;
begin
  perform private.assert_can_write_content(actor, 'COMMENTING_SUSPENDED');
  select * into quote from public.quotes q where q.id = create_comment.quote_id;
  if not found or quote.status = 'deleted' then
    perform private.raise_error('QUOTE_NOT_FOUND');
  end if;
  if quote.status = 'removed' then
    perform private.raise_error('QUOTE_REMOVED', jsonb_build_object('reason', quote.removed_reason));
  end if;
  insert into public.comments (quote_id, user_id, content)
  values (quote.id, actor, create_comment.content)
  returning id into new_id;
  return new_id;
end;
$$;

create function private.update_comment(actor uuid, comment_id uuid, content text) returns uuid
language plpgsql set search_path = '' as $$
declare
  comment public.comments;
begin
  select * into comment from public.comments c where c.id = comment_id for update;
  if not found or comment.status <> 'visible' then
    perform private.raise_error('COMMENT_NOT_FOUND');
  end if;
  if comment.user_id <> actor then
    perform private.raise_error('NOT_RESOURCE_OWNER');
  end if;
  if now() > comment.created_at + interval '20 minutes' then
    perform private.raise_error('COMMENT_EDIT_WINDOW_EXPIRED');
  end if;
  if exists (
    select 1 from public.moderation_cases c
    where c.target_type = 'comment' and c.target_id = comment.id and c.status = 'open'
  ) then
    perform private.raise_error('COMMENT_HAS_OPEN_CASE');
  end if;
  perform private.assert_can_write_content(actor, 'COMMENTING_SUSPENDED');
  update public.comments c set content = update_comment.content, edited_at = now() where c.id = comment.id;
  return comment.id;
end;
$$;

create function private.set_comment_pin(actor uuid, comment_id uuid, pinned boolean) returns timestamptz
language plpgsql set search_path = '' as $$
declare
  target_quote uuid;
  submitter uuid;
  comment public.comments;
  result timestamptz;
begin
  select c.quote_id into target_quote from public.comments c where c.id = comment_id;
  if not found then
    perform private.raise_error('COMMENT_NOT_FOUND');
  end if;
  -- The quote lock serialises concurrent pins, so the replaced pin never trips the unique index
  select q.submitter_id into submitter from public.quotes q where q.id = target_quote for update;
  select * into comment from public.comments c where c.id = comment_id for update;
  if comment.status <> 'visible' then
    perform private.raise_error('COMMENT_NOT_FOUND');
  end if;
  -- No admin exception (D-34)
  if submitter <> actor then
    perform private.raise_error('NOT_RESOURCE_OWNER');
  end if;
  perform private.assert_not_banned(actor);
  if pinned then
    update public.comments c set pinned_at = null
    where c.quote_id = target_quote and c.pinned_at is not null and c.id <> comment.id;
    result := coalesce(comment.pinned_at, now());
  else
    result := null;
  end if;
  update public.comments c set pinned_at = result where c.id = comment.id;
  return result;
end;
$$;

create function private.delete_comment(actor uuid, comment_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  comment public.comments;
begin
  select * into comment from public.comments c where c.id = comment_id for update;
  if not found or comment.status <> 'visible' then
    perform private.raise_error('COMMENT_NOT_FOUND');
  end if;
  if comment.user_id <> actor then
    perform private.raise_error('NOT_RESOURCE_OWNER');
  end if;
  if exists (
    select 1 from public.moderation_cases c
    where c.target_type = 'comment' and c.target_id = comment.id and c.status = 'open'
  ) then
    perform private.raise_error('COMMENT_HAS_OPEN_CASE');
  end if;
  perform private.assert_not_banned(actor);
  update public.comments c set status = 'deleted', pinned_at = null where c.id = comment.id;
end;
$$;

-- Governance

create function private.create_report(
  actor uuid, target_type public.report_target, target_id uuid, reason public.report_reason, detail text default null
) returns table (report_id uuid, became_under_review boolean)
language plpgsql set search_path = '' as $$
declare
  quote public.quotes;
  comment public.comments;
  case_row public.moderation_cases;
  discounted boolean;
  new_report uuid;
  flipped boolean := false;
begin
  if create_report.target_type = 'quote' then
    select * into quote from public.quotes q where q.id = create_report.target_id for update;
    if not found or quote.status = 'deleted' then
      perform private.raise_error('QUOTE_NOT_FOUND');
    end if;
    if quote.status = 'removed' then
      perform private.raise_error('QUOTE_REMOVED', jsonb_build_object('reason', quote.removed_reason));
    end if;
    if quote.submitter_id = actor then
      perform private.raise_error('CANNOT_REPORT_OWN');
    end if;
  else
    select * into comment from public.comments c where c.id = create_report.target_id for update;
    if not found or comment.status <> 'visible' then
      perform private.raise_error('COMMENT_NOT_FOUND');
    end if;
    if comment.user_id = actor then
      perform private.raise_error('CANNOT_REPORT_OWN');
    end if;
  end if;

  select * into case_row from public.moderation_cases c
  where c.target_type = create_report.target_type and c.target_id = create_report.target_id and c.status = 'open'
  for update;

  perform private.assert_not_banned(actor);

  if exists (
    select 1 from public.reports r
    where r.reporter_id = actor and r.target_type = create_report.target_type and r.target_id = create_report.target_id
  ) then
    perform private.raise_error('REPORT_DUPLICATE');
  end if;

  if case_row.id is null then
    insert into public.moderation_cases (target_type, target_id)
    values (create_report.target_type, create_report.target_id)
    returning * into case_row;
  end if;

  -- §9.2: new accounts and repeatedly dismissed reporters still open cases but do not count toward D-07
  select (select p.created_at > now() - interval '7 days' from public.profiles p where p.id = actor)
      or (
        select count(*) >= 5 from public.reports r
        join public.moderation_cases c on c.id = r.case_id
        where r.reporter_id = actor and r.status = 'dismissed' and c.resolved_at > now() - interval '30 days'
      )
  into discounted;

  insert into public.reports (case_id, target_type, target_id, reporter_id, reason, detail, is_discounted)
  values (case_row.id, create_report.target_type, create_report.target_id, actor,
          create_report.reason, create_report.detail, discounted)
  returning id into new_report;

  if not discounted then
    update public.moderation_cases c
    set effective_reporter_count = c.effective_reporter_count + 1
    where c.id = case_row.id
    returning * into case_row;
  end if;

  if create_report.target_type = 'quote' and quote.status = 'published' and case_row.effective_reporter_count >= 3 then
    update public.quotes q set status = 'under_review', under_review_since = now() where q.id = quote.id;
    perform private.audit(null, 'system', 'report.threshold_reached', 'quote', quote.id::text,
      jsonb_build_object('case_id', case_row.id));
    flipped := true;
  end if;

  return query select new_report, flipped;
end;
$$;

create function private.resolve_case(
  actor uuid, case_id uuid, resolution public.case_resolution, final_reason public.report_reason default null, note text default null
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
    if not subject_deleted then
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
    'resolution', resolution, 'final_reason', final_reason, 'target_type', target_kind, 'target_id', target
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

create function private.create_sanction(
  actor uuid, user_id uuid, kind public.sanction_kind, duration_days int default null, reason text default null
) returns table (sanction_id uuid, ends_at timestamptz, api_keys_revoked int)
language plpgsql set search_path = '' as $$
declare
  standing public.account_standing;
  new_id uuid;
  new_end timestamptz := null;
  revoked int := 0;
begin
  perform private.assert_admin(actor);
  if not exists (select 1 from public.profiles p where p.id = create_sanction.user_id and p.deleted_at is null) then
    perform private.raise_error('USER_NOT_FOUND');
  end if;
  standing := private.lock_standing(create_sanction.user_id, true);

  if kind = 'account_ban' then
    if standing.status = 'banned' then
      perform private.raise_error('ALREADY_BANNED');
    end if;
  else
    new_end := now() + make_interval(days => duration_days);
    update public.account_standing s
    set suspended_until = greatest(s.suspended_until, new_end)
    where s.user_id = create_sanction.user_id;
  end if;

  insert into public.sanctions (user_id, kind, source, ends_at, reason, issued_by)
  values (create_sanction.user_id, kind, 'manual', new_end, create_sanction.reason, actor)
  returning id into new_id;

  if kind = 'account_ban' then
    revoked := private.apply_ban(create_sanction.user_id, actor, create_sanction.reason);
  end if;
  perform private.audit(actor, 'admin', 'sanction.create', 'sanction', new_id::text, jsonb_build_object(
    'user_id', create_sanction.user_id, 'kind', kind, 'reason', create_sanction.reason
  ));
  return query select new_id, new_end, revoked;
end;
$$;

create function private.lift_sanction(actor uuid, sanction_id uuid, reason text) returns jsonb
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

-- Banned users may appeal, so no standing check here (§9.5)
create function private.create_appeal(actor uuid, target_type text, target_id uuid, statement text) returns uuid
language plpgsql set search_path = '' as $$
declare
  new_id uuid;
begin
  if create_appeal.target_type = 'sanction' then
    if not exists (select 1 from public.sanctions s where s.id = create_appeal.target_id and s.user_id = actor) then
      perform private.raise_error('APPEAL_TARGET_NOT_FOUND');
    end if;
  elsif create_appeal.target_type = 'violation' then
    -- A violation with a sanction is appealed through that sanction: one item, one appeal (§9.6)
    if not exists (
      select 1 from public.violations v
      where v.id = create_appeal.target_id and v.user_id = actor
        and not exists (select 1 from public.sanctions s where s.violation_id = v.id)
    ) then
      perform private.raise_error('APPEAL_TARGET_NOT_FOUND');
    end if;
  else
    raise exception 'unknown appeal target %', create_appeal.target_type;
  end if;

  begin
    insert into public.appeals (user_id, sanction_id, violation_id, statement)
    values (
      actor,
      case when create_appeal.target_type = 'sanction' then create_appeal.target_id end,
      case when create_appeal.target_type = 'violation' then create_appeal.target_id end,
      create_appeal.statement
    )
    returning id into new_id;
  exception when unique_violation then
    perform private.raise_error('APPEAL_ALREADY_EXISTS');
  end;
  return new_id;
end;
$$;

create function private.resolve_appeal(actor uuid, appeal_id uuid, decision text, note text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  appeal public.appeals;
  sanction public.sanctions;
  violation public.violations;
  case_row public.moderation_cases;
  restored boolean := false;
  lifted boolean := false;
  lifted_ban boolean;
  strikes int;
begin
  perform private.assert_admin(actor);
  if decision not in ('accept', 'reject') then
    raise exception 'unknown appeal decision %', decision;
  end if;

  select * into appeal from public.appeals a where a.id = appeal_id for update;
  if not found then
    perform private.raise_error('APPEAL_NOT_FOUND');
  end if;
  if appeal.status <> 'pending' then
    perform private.raise_error('APPEAL_ALREADY_RESOLVED');
  end if;

  if decision = 'accept' then
    select * into sanction from public.sanctions s where s.id = appeal.sanction_id;
    select * into violation from public.violations v where v.id = coalesce(appeal.violation_id, sanction.violation_id);
    select * into case_row from public.moderation_cases c where c.id = violation.case_id;

    if violation.quote_id is not null then
      perform 1 from public.quotes q where q.id = violation.quote_id for update;
      update public.quotes q set status = 'published', removed_at = null, removed_reason = null
      where q.id = violation.quote_id and q.status = 'removed';
      restored := found;
    elsif case_row.target_type = 'comment' then
      perform 1 from public.comments c where c.id = case_row.target_id for update;
      update public.comments c set status = 'visible' where c.id = case_row.target_id and c.status = 'removed';
      restored := found;
    end if;

    perform 1 from public.account_standing s where s.user_id = appeal.user_id for update;
    if violation.id is not null then
      update public.violations v set overturned_at = now() where v.id = violation.id;
    end if;
    if sanction.id is not null and sanction.lifted_at is null then
      update public.sanctions s
      set lifted_at = now(), lifted_by = actor, lift_reason = note
      where s.id = sanction.id;
      lifted := true;
    end if;
    lifted_ban := private.recalculate_standing(appeal.user_id);
    if lifted_ban then
      perform private.lift_ban_effects(appeal.user_id, actor, note);
    end if;
  end if;

  update public.appeals a set
    status = case decision when 'accept' then 'accepted'::public.appeal_status else 'rejected' end,
    decision_note = note, decided_by = actor, decided_at = now()
  where a.id = appeal.id;
  perform private.audit(actor, 'admin', 'appeal.resolve', 'appeal', appeal.id::text, jsonb_build_object(
    'decision', decision, 'target_restored', restored, 'sanction_lifted', lifted
  ));

  select s.strike_count into strikes from public.account_standing s where s.user_id = appeal.user_id;
  return jsonb_build_object('strike_count', strikes, 'sanction_lifted', lifted, 'target_restored', restored);
end;
$$;

create function private.reset_profile(actor uuid, user_id uuid, reason text) returns public.profiles
language plpgsql set search_path = '' as $$
declare
  profile public.profiles;
  old_name text;
begin
  perform private.assert_admin(actor);
  select p.username into old_name from public.profiles p where p.id = reset_profile.user_id and p.deleted_at is null;
  if not found then
    perform private.raise_error('USER_NOT_FOUND');
  end if;
  perform 1 from public.account_standing s where s.user_id = reset_profile.user_id for update;
  update public.profiles p set username = private.default_username()
  where p.id = reset_profile.user_id
  returning * into profile;
  perform private.audit(actor, 'admin', 'profile.reset', 'user', reset_profile.user_id::text, jsonb_build_object(
    'before', old_name, 'after', profile.username, 'reason', reason
  ));
  return profile;
end;
$$;

-- Account

create function private.update_profile(
  actor uuid, username text default null, likes_public boolean default null, favorites_public boolean default null
) returns public.profiles
language plpgsql set search_path = '' as $$
declare
  profile public.profiles;
begin
  perform private.assert_not_banned(actor);
  begin
    update public.profiles p set
      username = coalesce(update_profile.username, p.username),
      likes_public = coalesce(update_profile.likes_public, p.likes_public),
      favorites_public = coalesce(update_profile.favorites_public, p.favorites_public)
    where p.id = actor
    returning * into profile;
  exception when unique_violation then
    perform private.raise_error('USERNAME_TAKEN');
  end;
  return profile;
end;
$$;

create function private.create_api_key(actor uuid, name text, key_prefix text, key_hash bytea, scopes text[]) returns jsonb
language plpgsql set search_path = '' as $$
declare
  key public.api_keys;
begin
  -- Exclusive: serialises the limit count and any concurrent ban, so no key can escape revoke-all (T-08)
  perform private.assert_not_banned(actor, true);
  if (select count(*) from public.api_keys k where k.user_id = actor and k.revoked_at is null) >= 10 then
    perform private.raise_error('API_KEY_LIMIT_REACHED');
  end if;
  insert into public.api_keys (user_id, name, key_prefix, key_hash, scopes)
  values (actor, create_api_key.name, create_api_key.key_prefix, create_api_key.key_hash, create_api_key.scopes)
  returning * into key;
  perform private.audit(actor, 'user', 'api_key.create', 'api_key', key.id::text, jsonb_build_object(
    'name', key.name, 'scopes', key.scopes
  ));
  return private.api_key_json(key);
end;
$$;

create function private.regenerate_api_key(actor uuid, key_id uuid, key_prefix text, key_hash bytea) returns jsonb
language plpgsql set search_path = '' as $$
declare
  key public.api_keys;
begin
  perform private.assert_not_banned(actor, true);
  update public.api_keys k
  set key_prefix = regenerate_api_key.key_prefix, key_hash = regenerate_api_key.key_hash, regenerated_at = now()
  where k.id = key_id and k.user_id = actor and k.revoked_at is null
  returning * into key;
  if not found then
    perform private.raise_error('API_KEY_NOT_FOUND');
  end if;
  perform private.audit(actor, 'user', 'api_key.regenerate', 'api_key', key.id::text);
  return private.api_key_json(key);
end;
$$;

create function private.revoke_api_key(actor uuid, key_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform private.assert_not_banned(actor);
  update public.api_keys k
  set revoked_at = now(), revoked_reason = 'user'
  where k.id = key_id and k.user_id = actor and k.revoked_at is null;
  if not found then
    perform private.raise_error('API_KEY_NOT_FOUND');
  end if;
  perform private.audit(actor, 'user', 'api_key.delete', 'api_key', key_id::text);
end;
$$;

-- §11.5 step 2. Idempotent: the caller retries when auth.admin.deleteUser fails.
create function private.delete_account_data(actor uuid) returns int
language plpgsql set search_path = '' as $$
declare
  revoked int;
begin
  -- §6.6 lock order: comments, then their cases, then standing
  perform 1 from public.comments c where c.user_id = actor for update;
  perform 1 from public.moderation_cases m
  join public.comments c on m.target_type = 'comment' and m.target_id = c.id
  where c.user_id = actor and m.status = 'open'
  for update of m;

  perform 1 from public.account_standing s where s.user_id = actor for update;
  if not found then
    return 0;
  end if;

  update public.reports r set status = 'voided'
  from public.moderation_cases m, public.comments c
  where r.case_id = m.id and m.target_type = 'comment' and m.target_id = c.id
    and c.user_id = actor and m.status = 'open';
  update public.moderation_cases m set status = 'resolved', resolution = 'target_deleted', resolved_at = now()
  from public.comments c
  where m.target_type = 'comment' and m.target_id = c.id and c.user_id = actor and m.status = 'open';

  update public.api_keys k set revoked_at = now(), revoked_reason = 'user'
  where k.user_id = actor and k.revoked_at is null;
  get diagnostics revoked = row_count;

  delete from public.comments c where c.user_id = actor;
  delete from public.quote_likes l where l.user_id = actor;
  delete from public.quote_favorites f where f.user_id = actor;
  update public.profiles p set deleted_at = now(), avatar_url = null where p.id = actor;
  delete from public.account_standing s where s.user_id = actor;
  update public.reports r set reporter_id = null where r.reporter_id = actor;
  perform private.audit(actor, 'user', 'account.delete', 'user', actor::text);
  return revoked;
end;
$$;

-- Random and trending reads

create function private.sample_quotes(category text, n int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  r double precision := random();
  picked jsonb;
begin
  if n > 500 then
    raise exception 'sample_quotes n must be at most 500';
  end if;
  -- Random start, wrapping around once. Never ORDER BY random() on the whole table (§10.3).
  with head as (
    select q.* from public.quotes q
    where q.status = 'published' and q.category_key = category and q.random_key >= r
    order by q.random_key limit n
  ), tail as (
    select q.* from public.quotes q
    where q.status = 'published' and q.category_key = category and q.random_key < r
    order by q.random_key limit n
  ), combined as (
    select * from head union all select * from tail limit n
  )
  select coalesce(jsonb_agg(private.quote_json(c::public.quotes)), '[]') into picked from combined c;
  return jsonb_build_object(
    'quotes', picked,
    'category_total', (select count(*) from public.quotes q where q.status = 'published' and q.category_key = category)
  );
end;
$$;

-- categories null means every category; min and max default to the full length range
create function private.random_quote_fallback(categories text[], min int default null, max int default null) returns jsonb
language sql stable set search_path = '' as $$
  select private.quote_json(q)
  from public.quotes q
  where q.id = (
    select s.id from (
      select x.id from public.quotes x
      where x.status = 'published'
        and (categories is null or x.category_key = any (categories))
        and x.length between coalesce(random_quote_fallback.min, 1) and coalesce(random_quote_fallback.max, 100)
      limit 1000
    ) s
    order by random()
    limit 1
  );
$$;

-- D-37: score = likes in the last 7 days + 5 x freshness; freshness falls linearly from 1 to 0 over 48 hours
create function private.trending_quotes(categories text[], n int) returns jsonb
language sql stable set search_path = '' as $$
  with recent_likes as (
    select l.quote_id, count(*) as likes from public.quote_likes l
    where l.created_at >= now() - interval '7 days'
    group by l.quote_id
  ), candidates as (
    select quote_id as id from recent_likes
    union
    select q.id from public.quotes q
    where q.status = 'published' and q.created_at >= now() - interval '48 hours'
  ), ranked as (
    select q as quote,
      coalesce(r.likes, 0)
        + 5 * greatest(0, 1 - extract(epoch from now() - q.created_at) / 172800) as score
    from candidates c
    join public.quotes q on q.id = c.id
    left join recent_likes r on r.quote_id = q.id
    where q.status = 'published' and (categories is null or q.category_key = any (categories))
    order by score desc, q.created_at desc
    limit least(n, 50)
  )
  select coalesce(jsonb_agg(private.quote_json(quote) order by score desc, (quote).created_at desc), '[]') from ranked;
$$;

-- Daily pg_cron job. The case stays open (§9.2).
create function private.restore_expired_reviews() returns int
language plpgsql set search_path = '' as $$
declare
  restored int;
begin
  with expired as (
    update public.quotes q set status = 'published', under_review_since = null
    where q.status = 'under_review' and q.under_review_since <= now() - interval '7 days'
    returning q.id
  ), logged as (
    insert into public.audit_logs (actor_type, action, target_type, target_id)
    select 'system', 'quote.review_expired', 'quote', e.id::text from expired e
    returning 1
  )
  select count(*) into restored from logged;
  return restored;
end;
$$;

-- Everything above is callable by Core only. The two auth functions keep their own grants.
grant execute on all routines in schema private to service_role;
revoke execute on function private.hook_before_user_created(jsonb) from service_role;
revoke execute on function private.handle_new_user() from service_role;
