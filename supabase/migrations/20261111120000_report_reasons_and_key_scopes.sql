-- More reasons a report can give (§9.2). `other` stays for the reports and removals that already carry it; a report of
-- mere dislike is answered by Core and never reaches the database.
alter type public.report_reason add value if not exists 'self_harm';
alter type public.report_reason add value if not exists 'intellectual_property';
alter type public.report_reason add value if not exists 'security_risk';

-- An API Key no longer comments (§7.5): the scope comes off the keys that were given it
update public.api_keys set scopes = array_remove(scopes, 'comments:write') where 'comments:write' = any(scopes);
