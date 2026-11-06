// Local testing only: puts a local account into the states the admin pages and the standing pages need to be seen in
// (an admin, a confirmed violation, a suspension, a ban, an appeal, open cases), through the database's own functions
// where it has them, so every page reads what the real flow would have left. It talks to the local Supabase stack's
// database container and nothing else; the hosted project is never reached.
import { spawnSync } from "node:child_process";

const CONTAINER = "supabase_db_shuoshuo-core";
const REASONS = ["spam", "harassment", "hate", "misinformation", "simplified_chinese", "other"];

const HELP = `本機測試用：切換帳號狀態（只動本機 Supabase 的資料庫）

  pnpm dev:state list [關鍵字]            列出帳號、管理員、狀態與違規次數
  pnpm dev:state admin <名稱> [on|off]    設為管理員（off 取消）
  pnpm dev:state strike <名稱> [原因]     確認一次說說違規：照正式流程計次，第 1、2、3 次停權 7、30、90 天，第 4 次封禁
  pnpm dev:state comment <名稱> [原因]    確認一次留言違規（只記錄，不計次）
  pnpm dev:state suspend <名稱> <天數>    手動停權（不能提交說說與留言）
  pnpm dev:state ban <名稱>               手動封禁（API Key 會一併撤銷）
  pnpm dev:state appeal <名稱>            為最近一筆處分（沒有就是違規）送出申訴，給後台申訴佇列
  pnpm dev:state cases [數量]             隨機檢舉幾則說說，給後台案件佇列（預設 5）
  pnpm dev:state reset <名稱>             解除所有處分、撤銷所有違規並還原被移除的說說，回到正常

原因：${REASONS.join("、")}（預設 spam）
測試用的說說與留言都會標上「本機測試」。改完後重新整理頁面即可看到。`;

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function run(sql) {
  const result = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-P", "pager=off", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (result.error) {
    console.error(`沒辦法執行 docker：${result.error.message}`);
    process.exit(1);
  }
  // Notices are what the commands report; psql writes them to stderr
  const notes = result.stderr
    .split("\n")
    .map((line) => line.replace(/^psql:<stdin>:\d+: /, "").replace(/^(NOTICE|ERROR|CONTEXT|DETAIL):\s*/, (_, kind) => (kind === "ERROR" ? "錯誤：" : "")))
    .filter((line) => line.trim() && !line.startsWith("PL/pgSQL"));
  if (result.stdout.trim()) console.log(result.stdout.trimEnd());
  if (notes.length) (result.status === 0 ? console.log : console.error)(notes.join("\n"));
  if (result.status !== 0) process.exit(1);
}

// The named account (target) and an admin to act as (actor): another admin if there is one, else the account itself
const withTarget = (name, body, { needsAdmin = true } = {}) => `
select set_config('dev.name', ${literal(name)}, false) \\g /dev/null
do $body$
declare
  target uuid;
  actor uuid;
begin
  select p.id into target from public.profiles p
  where lower(p.username) = lower(current_setting('dev.name')) and p.deleted_at is null;
  if target is null then
    raise exception '找不到使用者「%」', current_setting('dev.name');
  end if;
  select r.user_id into actor from public.user_roles r where r.role = 'admin' order by r.user_id = target, r.created_at limit 1;
  if ${needsAdmin} and actor is null then
    raise exception '本機還沒有管理員，先執行 pnpm dev:state admin <名稱>';
  end if;
  ${body}
end
$body$;`;

const reasonOf = (value = "spam") => {
  if (!REASONS.includes(value)) {
    console.error(`原因只能是：${REASONS.join("、")}`);
    process.exit(1);
  }
  return literal(value);
};

const [command, ...args] = process.argv.slice(2);
const name = args[0];
const needName = () => {
  if (!name) {
    console.error(HELP);
    process.exit(1);
  }
};

switch (command) {
  case "list":
    run(`
select set_config('dev.like', ${literal(`%${args[0] ?? ""}%`)}, false) \\g /dev/null
select p.username as 名稱,
       case when exists (select 1 from public.user_roles r where r.user_id = p.id) then '是' else '' end as 管理員,
       case when s.status = 'banned' then '封禁' when s.suspended_until > now() then '停權至 ' || to_char(s.suspended_until at time zone 'Asia/Taipei', 'MM/DD HH24:MI') else '正常' end as 狀態,
       s.strike_count as 違規次數,
       (select count(*) from public.appeals a where a.user_id = p.id and a.status = 'pending') as 待審申訴
from public.profiles p
left join public.account_standing s on s.user_id = p.id
where p.deleted_at is null and p.username ilike current_setting('dev.like')
order by p.username like '測試%', p.created_at desc
limit 30;
select count(*) as 待審案件 from public.moderation_cases where status = 'open';`);
    break;

  case "admin": {
    needName();
    const off = args[1] === "off";
    run(
      withTarget(
        name,
        off
          ? `delete from public.user_roles r where r.user_id = target and r.role = 'admin';
  raise notice '已取消「%」的管理員', current_setting('dev.name');`
          : `insert into public.user_roles (user_id, role) values (target, 'admin') on conflict do nothing;
  raise notice '「%」現在是管理員，後台在 /admin', current_setting('dev.name');`,
        { needsAdmin: false },
      ),
    );
    break;
  }

  case "strike":
    needName();
    run(
      withTarget(
        name,
        `declare
    quote uuid;
    body text := '（本機測試）違規的說說 ' || to_char(clock_timestamp(), 'MMDD-HH24MISS-US');
    case_id uuid;
    outcome jsonb;
  begin
    -- A quote of its own, so the account's real quotes stay as they are
    insert into public.quotes (content, original_content, content_hash, category_key, source_from, submitter_id, commit_from)
    values (body, body, sha256(convert_to(body, 'UTF8')), 'other', '本機測試', target, 'web')
    returning id into quote;
    insert into public.moderation_cases (target_type, target_id) values ('quote', quote) returning id into case_id;
    insert into public.reports (case_id, target_type, target_id, reporter_id, reason, detail)
    values (case_id, 'quote', quote, nullif(actor, target), ${reasonOf(args[1])}, '本機測試的檢舉');
    outcome := private.resolve_case(actor, case_id, 'uphold', ${reasonOf(args[1])}, '本機測試');
    raise notice '已確認違規：第 % 次，處分 %', outcome->>'strike_count', coalesce(outcome->'sanction'->>'kind', '無');
  end;`,
      ),
    );
    break;

  case "comment":
    needName();
    run(
      withTarget(
        name,
        `declare
    quote uuid;
    comment uuid;
    case_id uuid;
  begin
    select q.id into quote from public.quotes q where q.status = 'published' order by q.created_at desc limit 1;
    if quote is null then
      raise exception '本機沒有公開的說說可以留言';
    end if;
    insert into public.comments (quote_id, user_id, content) values (quote, target, '（本機測試）違規的留言')
    returning id into comment;
    insert into public.moderation_cases (target_type, target_id) values ('comment', comment) returning id into case_id;
    insert into public.reports (case_id, target_type, target_id, reporter_id, reason, detail)
    values (case_id, 'comment', comment, nullif(actor, target), ${reasonOf(args[1])}, '本機測試的檢舉');
    perform private.resolve_case(actor, case_id, 'uphold', ${reasonOf(args[1])}, '本機測試');
    raise notice '已確認留言違規（不計次）';
  end;`,
      ),
    );
    break;

  case "suspend": {
    needName();
    const days = Number(args[1]);
    if (!Number.isInteger(days) || days < 1) {
      console.error("天數要是正整數，例如 pnpm dev:state suspend 小明 7");
      process.exit(1);
    }
    run(
      withTarget(
        name,
        `perform private.create_sanction(actor, target, 'submit_suspension', ${days}, '本機測試：手動停權');
  raise notice '已停權 % 天', ${days};`,
      ),
    );
    break;
  }

  case "ban":
    needName();
    run(
      withTarget(
        name,
        `perform private.create_sanction(actor, target, 'account_ban', null, '本機測試：手動封禁');
  raise notice '已封禁「%」', current_setting('dev.name');`,
      ),
    );
    break;

  case "appeal":
    needName();
    run(
      withTarget(
        name,
        `declare
    sanction uuid;
    violation uuid;
    statement text := '（本機測試）我認為這次處分有誤，請再看一次這則內容的上下文，謝謝。';
  begin
    select s.id into sanction from public.sanctions s where s.user_id = target and s.lifted_at is null order by s.starts_at desc limit 1;
    if sanction is not null then
      perform private.create_appeal(target, 'sanction', sanction, statement);
      raise notice '已為最近一筆處分送出申訴';
      return;
    end if;
    select v.id into violation from public.violations v
    where v.user_id = target and v.overturned_at is null and not exists (select 1 from public.sanctions s where s.violation_id = v.id)
    order by v.created_at desc limit 1;
    if violation is null then
      raise exception '「%」沒有可以申訴的處分或違規，先執行 strike 或 comment', current_setting('dev.name');
    end if;
    perform private.create_appeal(target, 'violation', violation, statement);
    raise notice '已為最近一筆違規送出申訴';
  end;`,
        { needsAdmin: false },
      ),
    );
    break;

  case "cases": {
    const count = Number(args[0] ?? 5);
    if (!Number.isInteger(count) || count < 1) {
      console.error("數量要是正整數");
      process.exit(1);
    }
    run(`
do $body$
declare
  made int := 0;
  tries int := 0;
  quote public.quotes;
  reporter uuid;
  reasons public.report_reason[] := array[${REASONS.map(literal).join(", ")}]::public.report_reason[];
begin
  while made < ${count} and tries < ${count * 20} loop
    tries := tries + 1;
    select * into quote from public.quotes q where q.status = 'published' order by random() limit 1;
    exit when quote.id is null;
    select p.id into reporter from public.profiles p
    join public.account_standing s on s.user_id = p.id
    where p.deleted_at is null and s.status = 'active' and p.id <> quote.submitter_id
      and not exists (select 1 from public.reports r where r.reporter_id = p.id and r.target_id = quote.id)
    order by random() limit 1;
    continue when reporter is null;
    begin
      perform private.create_report(reporter, 'quote', quote.id, reasons[1 + floor(random() * array_length(reasons, 1))::int], '本機測試的檢舉');
      made := made + 1;
    exception when others then
      -- A pair the rules refuse (the reporter banned meanwhile, say): another pair is drawn
      null;
    end;
  end loop;
  raise notice '已送出 % 筆檢舉，後台在 /admin/cases', made;
end
$body$;`);
    break;
  }

  case "reset":
    needName();
    run(
      withTarget(
        name,
        `perform 1 from public.account_standing s where s.user_id = target for update;
  update public.sanctions s set lifted_at = now(), lifted_by = actor, lift_reason = '本機測試：重設'
  where s.user_id = target and s.lifted_at is null;
  update public.violations v set overturned_at = now() where v.user_id = target and v.overturned_at is null;
  -- Real quotes taken down come back; the ones written for these tests go away
  update public.quotes q set status = 'published', removed_at = null, removed_reason = null
  from public.violations v where v.user_id = target and v.quote_id = q.id and q.status = 'removed' and q.source_from <> '本機測試';
  update public.quotes q set status = 'deleted' where q.submitter_id = target and q.source_from = '本機測試';
  update public.comments c set status = 'deleted' where c.user_id = target and c.content = '（本機測試）違規的留言';
  if private.recalculate_standing(target) then
    perform private.lift_ban_effects(target, actor, '本機測試：重設');
  end if;
  raise notice '「%」已回到正常狀態', current_setting('dev.name');`,
        { needsAdmin: false },
      ),
    );
    break;

  default:
    console.log(HELP);
}
