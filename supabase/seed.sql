-- Local and test data only (TEST_PLAN §3): 13 categories x 20 quotes with fixed UUIDs.
-- Never applied to Production. `supabase db push` does not run this file.

select vault.create_secret('local-test-pepper', 'identity_pepper');

-- The trigger on auth.users creates profiles and account_standing
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, '', now() - interval '60 days',
  '{"provider":"github","providers":["github"]}', jsonb_build_object('full_name', name),
  now() - interval '60 days', now() - interval '60 days'
from (values
  ('00000000-0000-4000-a000-000000000001'::uuid, 'admin@example.com', '管理員'),
  ('00000000-0000-4000-a000-000000000002'::uuid, 'alice@example.com', '小明'),
  ('00000000-0000-4000-a000-000000000003'::uuid, 'bob@example.com', '阿華'),
  ('00000000-0000-4000-a000-000000000004'::uuid, 'carol@example.com', 'carol_tw'),
  ('00000000-0000-4000-a000-000000000005'::uuid, 'dave@example.com', '阿德')
) as seed_users (id, email, name);

update public.profiles
set created_at = now() - interval '60 days'
where id in (select id from auth.users);

insert into public.user_roles (user_id, role) values ('00000000-0000-4000-a000-000000000001', 'admin');

insert into public.quotes (id, content, original_content, content_hash, category_key, source_from, submitter_id, commit_from, created_at)
with categories as (
  select * from (values
    (1, 'anime', '動畫', '動畫', '《葬送的芙莉蓮》'),
    (2, 'manga', '漫畫', '漫畫', '《灌籃高手》'),
    (3, 'game', '遊戲', '遊戲', '《薩爾達傳說》'),
    (4, 'music', '音樂', '音樂', '〈稻香〉'),
    (5, 'literature', '文學', '文學', '《小王子》'),
    (6, 'original', '原創', '原創', '自己寫的'),
    (7, 'flim', '影視', '影視', '《阿甘正傳》'),
    (8, 'poetry', '詩詞', '詩詞', '〈將進酒〉'),
    (9, 'internet', '網路', '網路', '某個論壇'),
    (10, 'philosophy', '哲學', '哲學', '《蘇菲的世界》'),
    (11, 'anti-motiv', '毒雞湯', '雞湯', '朋友的朋友'),
    (12, 'ai', 'AI', '智慧', '一段對話'),
    (13, 'other', '其他', '其他', '路邊看到的')
  ) as c (n, key, name, short, source)
), lines as (
  select * from (values
    (1, null),
    (2, '%s裡的這句話，我一直記到現在。'),
    (3, '有些%s，要等到長大才聽得懂。'),
    (4, '%s教會我的第一件事，是慢慢來。'),
    (5, '走過這麼遠，還是會想起那段%s。'),
    (6, '如果沒有%s，日子大概會安靜很多。'),
    (7, '今天也想把%s好好看完 🌙'),
    (8, '笑著笑著，就在%s裡掉了眼淚 😂'),
    (9, '%s很短，後勁很長。'),
    (10, '別問%s有什麼用，喜歡就夠了。'),
    (11, '這段%s，適合下雨天一個人讀。'),
    (12, '世界很吵，%s剛好。'),
    (13, '你說的那段%s，我後來也懂了。'),
    (14, '%s沒有標準答案，只有當下的心情。'),
    (15, '關於%s，我們都還在學。'),
    (16, '願你在%s裡，遇見想成為的人。'),
    (17, '那年夏天的%s，還在耳邊。'),
    (18, '%s不會說話，卻什麼都懂。'),
    (19, '把%s收進口袋，下次難過時拿出來。'),
    (20, null)
  ) as l (n, template)
), composed as (
  select c.n as cat, l.n as line, c.key, c.source,
    case l.n
      when 1 then c.short
      -- exactly 100 code points, the upper bound of D-19
      when 20 then left(repeat(c.name || '是一段很長很長的路，走著走著就到了今天，', 10), 100)
      else format(l.template, c.name)
    end as content
  from categories c cross join lines l
)
select
  ('00000000-0000-4000-8000-' || lpad((cat * 100 + line)::text, 12, '0'))::uuid,
  content,
  content,
  extensions.digest(
    regexp_replace(lower(normalize(content, nfkc)), '[[:space:]!-/:-@\[-`{-~「」『』，。！？、；：（）《》〈〉…—～·]', '', 'g'),
    'sha256'
  ),
  key,
  source,
  ('00000000-0000-4000-a000-00000000000' || (2 + (line % 4))::text)::uuid,
  'web',
  now() - make_interval(hours => (cat - 1) * 20 + line * 3)
from composed;
