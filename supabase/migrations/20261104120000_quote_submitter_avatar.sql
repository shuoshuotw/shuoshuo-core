-- The submitter's picture goes out with every quote, so the lists can show it beside the name. Keep in step with
-- QUOTE_SELECT in lib/quotes/serialize.ts (§8.2.2). Account deletion already clears avatar_url.
create or replace function private.quote_json(quote public.quotes) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', quote.id,
    'content', quote.content,
    'length', quote.length,
    'category', jsonb_build_object('key', c.key, 'name', c.name_zh),
    'source_from', quote.source_from,
    'submitter', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'deleted', p.deleted_at is not null),
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
