-- §9.2: a case whose quote went back to published after 7 days in review stays open and goes to the front of the queue.
-- The timestamp is the only state needed; the queue is short enough that this needs no index of its own.
alter table public.moderation_cases add column review_expired_at timestamptz;

create or replace function private.restore_expired_reviews() returns int
language plpgsql set search_path = '' as $$
declare
  restored int;
begin
  with expired as (
    update public.quotes q set status = 'published', under_review_since = null
    where q.status = 'under_review' and q.under_review_since <= now() - interval '7 days'
    returning q.id
  ), flagged as (
    update public.moderation_cases c set review_expired_at = now()
    from expired e
    where c.target_type = 'quote' and c.target_id = e.id and c.status = 'open'
  ), logged as (
    insert into public.audit_logs (actor_type, action, target_type, target_id)
    select 'system', 'quote.review_expired', 'quote', e.id::text from expired e
    returning 1
  )
  select count(*) into restored from logged;
  return restored;
end;
$$;
