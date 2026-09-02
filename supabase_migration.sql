-- =====================================================================
-- Lisbon Hazard Map — Usability Study : Supabase schema
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Security model: the anon key is PUBLIC on a static GitHub Pages site.
-- Protection therefore comes from RLS, not from key secrecy:
--   * anon may INSERT only
--   * anon may NOT SELECT / UPDATE / DELETE
-- A participant can write their own data and read nothing back.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SESSIONS  — one row per participant run
-- ---------------------------------------------------------------------
create table if not exists public.sessions (
  session_id        uuid primary key,
  participant_code  text,                       -- optional label you hand out
  group_code        text not null check (group_code in ('G1','G2','G3','G4')),
  block1_interface  char(1) not null check (block1_interface in ('A','B')),
  block1_set        text    not null check (block1_set in ('S1','S2')),
  block2_interface  char(1) not null check (block2_interface in ('A','B')),
  block2_set        text    not null check (block2_set in ('S1','S2')),

  consent_given     boolean not null default false,
  pointer_type      text,                       -- 'mouse' | 'touch' | 'unknown'
  is_touch_device   boolean,
  screen_w          int,
  screen_h          int,
  viewport_w        int,
  viewport_h        int,
  device_pixel_ratio real,
  user_agent        text,
  timezone          text,
  locale            text,

  app_version       text,
  trials_version    text,

  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  completed         boolean not null default false,
  abandoned_reason  text,

  -- the two blocks must use different interfaces and different trial sets
  constraint block_interfaces_differ check (block1_interface <> block2_interface),
  constraint block_sets_differ       check (block1_set <> block2_set)
);

-- ---------------------------------------------------------------------
-- 2. TRIALS — one row per trial, with metrics precomputed client-side
--    Raw events are kept too, so any metric can be recomputed later.
-- ---------------------------------------------------------------------
create table if not exists public.trials (
  id                      bigserial primary key,
  session_id              uuid not null references public.sessions(session_id) on delete cascade,

  trial_id                text not null,        -- 'S1-s1', 'PRACTICE-1', ...
  block                   smallint not null check (block in (1,2)),
  trial_index             smallint not null,    -- order within the block (0 = practice)
  is_practice             boolean not null default false,

  interface               char(1) not null check (interface in ('A','B')),
  set_code                text,
  slot                    text,
  difficulty              text check (difficulty in ('easy','moderate','hard')),
  attribute               text,
  direction               text check (direction in ('max','min')),
  gap_pct                 real,

  target_zone_id          text not null,
  response_zone_id        text,
  correct                 boolean,
  timed_out               boolean not null default false,

  -- primary + secondary dependent variables
  ms_to_first_inspect     integer,
  ms_to_response          integer,              -- PRIMARY DV
  n_inspections           integer,
  n_unique_zones_inspected integer,
  n_revisits              integer,              -- working-memory proxy
  n_zoom                  integer,
  n_pan                   integer,
  path_px                 double precision,
  panel_dwell_ms          integer,              -- interface B only
  n_move_samples          integer,

  started_at_wall         timestamptz,
  created_at              timestamptz not null default now(),

  unique (session_id, block, trial_id)
);

create index if not exists trials_session_idx on public.trials(session_id);
create index if not exists trials_interface_idx on public.trials(interface, difficulty);

-- ---------------------------------------------------------------------
-- 3. EVENTS — discrete interaction events (small; this is what you query)
--    t_ms is relative to trial start (performance.now) => clock-skew free
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id            bigserial primary key,
  session_id    uuid not null references public.sessions(session_id) on delete cascade,
  trial_id      text not null,
  block         smallint not null check (block in (1,2)),

  t_ms          integer not null,
  type          text not null check (type in (
                   'trial_start','trial_end','hover_enter','hover_exit','click',
                   'popup_open','popup_close','panel_update',
                   'zoom','pan','prompt_read','window_blur','window_focus')),

  zone_id       text,
  is_candidate  boolean,
  is_target     boolean,

  lat           double precision,   -- map coords survive zoom/pan
  lng           double precision,
  zoom_level    real,
  extra         jsonb,

  created_at    timestamptz not null default now()
);

create index if not exists events_session_trial_idx on public.events(session_id, block, trial_id);
create index if not exists events_type_idx on public.events(type);

-- ---------------------------------------------------------------------
-- 4. TRACES — bulk mouse path, ONE row per trial (keeps events small)
--    points = {"t":[...],"x":[...],"y":[...],"lat":[...],"lng":[...]}
-- ---------------------------------------------------------------------
create table if not exists public.traces (
  id           bigserial primary key,
  session_id   uuid not null references public.sessions(session_id) on delete cascade,
  trial_id     text not null,
  block        smallint not null check (block in (1,2)),
  sample_hz    smallint,
  n_points     integer,
  points       jsonb not null,
  created_at   timestamptz not null default now(),
  unique (session_id, block, trial_id)
);

-- ---------------------------------------------------------------------
-- 5. HEARTBEAT — 1 row, readable by anon, used ONLY by the keep-alive job
--    A real SELECT against it counts as database activity and prevents
--    the free-tier 7-day inactivity pause.
-- ---------------------------------------------------------------------
create table if not exists public.heartbeat (
  id        smallint primary key default 1,
  pinged_at timestamptz not null default now(),
  constraint heartbeat_single_row check (id = 1)
);
insert into public.heartbeat (id) values (1) on conflict (id) do nothing;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.sessions  enable row level security;
alter table public.trials    enable row level security;
alter table public.events    enable row level security;
alter table public.traces    enable row level security;
alter table public.heartbeat enable row level security;

-- Clean re-runs
drop policy if exists anon_insert_sessions on public.sessions;
drop policy if exists anon_insert_trials   on public.trials;
drop policy if exists anon_insert_events   on public.events;
drop policy if exists anon_insert_traces   on public.traces;
drop policy if exists anon_update_sessions on public.sessions;
drop policy if exists anon_read_heartbeat  on public.heartbeat;

-- INSERT-only for anonymous participants
create policy anon_insert_sessions on public.sessions
  for insert to anon with check (true);
create policy anon_insert_trials on public.trials
  for insert to anon with check (true);
create policy anon_insert_events on public.events
  for insert to anon with check (true);
create policy anon_insert_traces on public.traces
  for insert to anon with check (true);

-- The session row is created at start and must be marked complete at the end.
-- USING (not completed) means a row can be finalised exactly once and never
-- edited again — an audit-friendly one-way transition.
create policy anon_update_sessions on public.sessions
  for update to anon
  using (completed = false)
  with check (true);

-- Heartbeat is readable so the keep-alive job performs a genuine query
create policy anon_read_heartbeat on public.heartbeat
  for select to anon using (true);

-- Explicit grants (defence in depth; RLS still applies on top)
revoke all on public.sessions, public.trials, public.events, public.traces, public.heartbeat from anon;
grant insert on public.sessions, public.trials, public.events, public.traces to anon;
grant update (completed, completed_at, abandoned_reason) on public.sessions to anon;
-- Required so PostgREST can locate the row in UPDATE ... WHERE session_id = ...
-- PostgreSQL needs SELECT privilege on any column named in a WHERE clause.
-- Safe: there is no SELECT policy, so anon still reads zero rows.
grant select (session_id) on public.sessions to anon;
grant select on public.heartbeat to anon;
grant usage, select on all sequences in schema public to anon;

-- ---------------------------------------------------------------------
-- Session completion via SECURITY DEFINER function.
-- A direct UPDATE from anon must satisfy RLS, column grants AND PostgREST's
-- need for SELECT privilege on the WHERE column. This runs as the owner and
-- reports whether a row actually changed.
-- ---------------------------------------------------------------------
create or replace function public.complete_session(
  p_session_id uuid,
  p_reason     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.sessions
     set completed        = (p_reason is null),
         completed_at     = now(),
         abandoned_reason = p_reason
   where session_id = p_session_id
     and completed  = false;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.complete_session(uuid, text) from public;
grant execute on function public.complete_session(uuid, text) to anon;

-- =====================================================================
-- ANALYSIS VIEWS  (owner / service_role only — anon has no SELECT)
-- =====================================================================

-- Per-trial rows joined to condition, ready for a paired analysis
create or replace view public.v_trial_analysis as
select
  s.session_id, s.group_code, s.participant_code,
  t.block, t.trial_index, t.interface, t.set_code, t.slot,
  t.difficulty, t.attribute, t.direction, t.gap_pct,
  t.target_zone_id, t.response_zone_id, t.correct, t.timed_out,
  t.ms_to_response, t.ms_to_first_inspect,
  t.n_inspections, t.n_unique_zones_inspected, t.n_revisits,
  t.n_zoom, t.n_pan, t.path_px, t.panel_dwell_ms
from public.trials t
join public.sessions s using (session_id)
where t.is_practice = false
  and s.completed = true
  and s.consent_given = true;

-- Per-participant A-vs-B contrast: the within-subjects effect, one row each
create or replace view public.v_participant_contrast as
select
  session_id,
  group_code,
  avg(ms_to_response) filter (where interface = 'A') as mean_ms_A,
  avg(ms_to_response) filter (where interface = 'B') as mean_ms_B,
  avg(ms_to_response) filter (where interface = 'A')
    - avg(ms_to_response) filter (where interface = 'B') as ms_diff_A_minus_B,
  avg(n_revisits) filter (where interface = 'A') as mean_revisits_A,
  avg(n_revisits) filter (where interface = 'B') as mean_revisits_B,
  avg(n_zoom) filter (where interface = 'A') as mean_zoom_A,
  avg(n_zoom) filter (where interface = 'B') as mean_zoom_B,
  count(*) filter (where correct) as n_correct,
  count(*) as n_trials
from public.v_trial_analysis
group by session_id, group_code;

-- Data-quality triage: spot partial or suspicious sessions before analysis
create or replace view public.v_session_quality as
select
  s.session_id, s.group_code, s.consent_given, s.completed,
  s.is_touch_device, s.started_at, s.completed_at,
  count(t.id) filter (where not t.is_practice) as measured_trials,
  count(t.id) filter (where t.timed_out)        as timeouts,
  round(100.0 * count(t.id) filter (where t.correct and not t.is_practice)
        / nullif(count(t.id) filter (where not t.is_practice),0), 1) as pct_correct
from public.sessions s
left join public.trials t using (session_id)
group by s.session_id, s.group_code, s.consent_given, s.completed,
         s.is_touch_device, s.started_at, s.completed_at;
