-- §9.2 and §11.5. One job per data type, so a failure in one leaves the others running.

create extension if not exists pg_cron;

select cron.schedule('restore-expired-reviews', '0 18 * * *', 'select private.restore_expired_reviews()');

select cron.schedule('retention-audit-logs', '10 18 * * *', $$
  begin;
  set local role retention_job;
  delete from public.audit_logs where created_at < now() - interval '2 years';
  commit;
$$);

select cron.schedule('retention-report-text', '20 18 * * *', $$
  begin;
  set local role retention_job;
  update public.reports r set detail = null
  from public.moderation_cases c
  where r.case_id = c.id and r.detail is not null and c.resolved_at < now() - interval '1 year';
  update public.moderation_cases set reviewer_note = null
  where reviewer_note is not null and resolved_at < now() - interval '1 year';
  commit;
$$);

select cron.schedule('retention-api-keys', '30 18 * * *', $$
  begin;
  set local role retention_job;
  delete from public.api_keys where revoked_at < now() - interval '90 days';
  commit;
$$);
