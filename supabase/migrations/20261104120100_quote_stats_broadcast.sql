-- Live counts on the lists: every change to a quote's counts is broadcast on the public Realtime topic quote-stats,
-- event stats. The counts go out with every quote anyway, so the topic needs no authorization. Definer rights, so the
-- broadcast goes out whoever's write moved the count.
create function private.broadcast_quote_stats() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id', new.quote_id,
      'like_count', new.like_count,
      'favorite_count', new.favorite_count,
      'comment_count', new.comment_count
    ),
    'stats',
    'quote-stats',
    false
  );
  return null;
end;
$$;

revoke all on function private.broadcast_quote_stats() from public;

create trigger quote_stats_broadcast after update on public.quote_stats
  for each row
  when (old.like_count is distinct from new.like_count
        or old.favorite_count is distinct from new.favorite_count
        or old.comment_count is distinct from new.comment_count)
  execute function private.broadcast_quote_stats();
