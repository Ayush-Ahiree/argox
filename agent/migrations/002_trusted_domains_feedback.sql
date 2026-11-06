-- 002: trusted destinations per project + "was this decision right?" feedback.
-- Safe to run more than once. Run in the Supabase SQL editor BEFORE (or
-- right after) deploying the backend that uses it; the backend tolerates
-- the column being missing for reads, but saving trusted destinations and
-- feedback return 503 until this has run.

-- Hosts the project trusts as destinations, on top of the built-in internal
-- ones (localhost, ...). Sending sensitive data there is not blocked.
-- Entries are plain hosts ("api.example.com") or subdomain wildcards
-- ("*.example.com"); the backend normalizes and validates before saving.
alter table policies
    add column if not exists trusted_domains jsonb not null default '[]';

create table if not exists feedback (
    id bigint generated always as identity primary key,
    project_id uuid not null references projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    verdict text not null check (verdict in ('correct', 'false_positive')),
    session_id text,
    tool text,
    target text,
    decision text,
    reasons jsonb not null default '[]',
    note text,
    event_ts timestamptz,       -- when the judged decision happened
    created_at timestamptz not null default now()
);
create index if not exists feedback_project_id_created_idx on feedback(project_id, created_at desc);

alter table feedback enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'feedback' and policyname = 'own project feedback') then
        create policy "own project feedback" on feedback
            for all using (
                exists (select 1 from projects p where p.id = feedback.project_id and p.user_id = auth.uid())
            );
    end if;
end $$;
