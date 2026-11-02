-- The indexes the hot reads depend on must stay usable (SPEC §10.3, D-37). Seq scans are off because a
-- table this small would otherwise always seq-scan, which says nothing about the plan at real sizes.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

create function pg_temp.plan_of(query text) returns text language plpgsql as $$
declare
  line text;
  result text := '';
begin
  for line in execute 'explain ' || query loop
    result := result || line || E'\n';
  end loop;
  return result;
end;
$$;

set local enable_seqscan = off;

select matches(
  pg_temp.plan_of($$select id from public.quotes where status = 'published' and category_key = 'anime' and length between 2 and 10 limit 1000$$),
  'quotes_length_idx', 'RD-08 the length fallback uses the partial length index'
);
select doesnt_match(
  pg_temp.plan_of($$select id from public.quotes where status = 'published' and category_key = 'anime' and length between 2 and 10 limit 1000$$),
  'Seq Scan', 'RD-08 the length fallback has no sequential scan'
);
select matches(
  pg_temp.plan_of($$select quote_id, count(*) from public.quote_likes where created_at >= now() - interval '7 days' group by quote_id$$),
  'quote_likes_recent_idx', 'TR-04 trending counts recent likes through the created_at index'
);
select is(jsonb_array_length((private.sample_quotes('anime', 20))->'quotes'), 20, 'RD-10 sample_quotes returns all it was asked for');

select * from finish();
rollback;
