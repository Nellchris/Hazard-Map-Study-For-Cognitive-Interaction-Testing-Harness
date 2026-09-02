# Logging Backend — Setup

Three files, in order. Total setup time ~20 minutes.

---

## 1. Create the Supabase project

1. supabase.com → New project (no card required).
2. **Region:** choose an EU region (Ireland or Frankfurt) — typically the lowest
   latency from West Africa, and convenient for collaborators in Europe.
3. Wait for provisioning, then note from **Project Settings → API**:
   - Project URL — `https://<ref>.supabase.co`
   - `anon` public key

> Latency does not affect your measurements. All timings use
> `performance.now()` relative to trial start; uploads happen afterwards.

---

## 2. Run the migration

**SQL Editor → New query →** paste all of `supabase_migration.sql` → **Run**.

Creates `sessions`, `trials`, `events`, `traces`, `heartbeat`, the RLS policies,
and three analysis views.

**Verify RLS is doing its job.** In a terminal:

```bash
# Should return [] or a permission error — NOT your data
curl "https://<ref>.supabase.co/rest/v1/sessions?select=*" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"

# Should return [{"id":1}] — the keep-alive path
curl "https://<ref>.supabase.co/rest/v1/heartbeat?select=id" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

If the first command returns session rows, RLS is misconfigured — stop and fix
it before collecting data.

---

## 3. Keep-alive workflow

Copy `keepalive.yml` to `.github/workflows/keepalive.yml`.

Add two repo secrets (**Settings → Secrets and variables → Actions**):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`.

Run it once manually from the **Actions** tab to confirm it passes.

**Why this exists:** free-tier projects pause after 7 days without database
activity. A paused project is unreachable and participants would hit silent
failures. Two caveats:

- GitHub disables scheduled workflows in repos idle for ~60 days. Before a new
  recruitment push, check the Actions tab and re-enable if needed.
- The free tier has **no backups**. Export your data periodically (Table Editor
  → Export CSV, or `pg_dump` via the connection string). For a scholarship
  portfolio, losing collected data would be far worse than the ten minutes this
  takes.

---

## 4. Wire up the logger

```js
import { Logger, attachLeafletTelemetry, attachZoneHandlers } from './logger.js';

const log = new Logger({
  supabaseUrl: 'https://<ref>.supabase.co',
  supabaseAnonKey: '<ANON_KEY>',   // public by design; RLS is the guard
  trialsVersion: '1.0',
  moveHz: 10,
});

// after the consent screen
await log.initSession({ consentGiven: true });
const plan = log.getPlan();     // { block1:{interface,set}, block2:{...} }

attachLeafletTelemetry(map, log);

// per trial
log.startTrial({ trial, interface: plan.block1.interface, block: 1, trialIndex: 1 });
attachZoneHandlers(layer, zoneId, props, log, plan.block1.interface, {
  onReveal: (id, p) => showPopupOrPanel(id, p),
  onAnswer: (id) => finishTrial(id),
});
await log.endTrial({ responseZoneId, correct: responseZoneId === trial.target_zone_id });

// at the end
await log.completeSession();
```

### Group assignment

Random by default. For a small hand-recruited sample, assign deliberately with a
URL parameter so your four counterbalance cells stay balanced:

```
https://you.github.io/hazard-study/?g=G1&p=P007
```

Keep a private list mapping `p=` codes to people; never put names in the app.

### What the logger guarantees

- One batch per trial (~12 requests per participant).
- Failed batches persist to `localStorage` and retry on the next page load.
- `pagehide` / `visibilitychange` flush via `sendBeacon`, so a closed tab
  mid-trial still salvages data.
- Raw traces **and** precomputed metrics are stored, so you can redefine a
  metric later and recompute from the raw events.

**Verified by simulation:** 2,700 mousemove events at 60 Hz downsample to exactly
10.0 Hz; ~10 KB per trial; **~7 MB for 60 participants** against a 500 MB limit.

---

## 5. Consent and ethics

You have participants (friends, and lecturers abroad who may be in the EU), and
you are collecting behavioural telemetry. A consent screen is both the right
thing to do and evidence of rigour for scholarship reviewers.

Your consent screen should state:
- what is recorded (mouse movement, clicks, zoom/pan, timing — **no** keystrokes,
  no personal identifiers)
- that data is anonymous and identified only by a random session ID
- where it is stored (Supabase, EU region)
- that participation is voluntary and can be stopped at any time
- your contact address

Do not set `consent_given: true` unless they actively agreed. The analysis views
already filter to `consent_given = true` and `completed = true`.

---

## 6. First queries

```sql
-- data quality triage
select * from v_session_quality order by started_at desc;

-- the headline within-subjects contrast
select * from v_participant_contrast;

-- primary DV by interface and difficulty
select interface, difficulty,
       count(*) n, round(avg(ms_to_response)) mean_ms,
       round(avg(n_revisits),2) mean_revisits,
       round(100.0*avg(case when correct then 1 else 0 end),1) pct_correct
from v_trial_analysis
group by interface, difficulty
order by difficulty, interface;
```

The second query is the study in one table: if the persistent panel (B) helps,
`mean_ms` and `mean_revisits` should be lower for B, and the gap should widen on
the `hard` trials.
