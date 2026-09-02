# Flood hazard map — interface comparison study

A browser-based experiment comparing two ways of presenting flood hazard
information on a map of the Lisbon waterfront, while logging how people search.

**Question:** when someone has to compare attribute values across several map
features, does a transient click-to-open popup cost them more than a side panel
that stays put?

---

## Design

Within-subjects crossover. Every participant does both interfaces on different
but difficulty-matched task sets.

| | Interface A | Interface B |
|---|---|---|
| Map | full width | narrower |
| Details reveal on | click | hover |
| Details shown in | popup on the map | panel beside the map |
| Details persist | until dismissed | until another zone is pointed at |
| Answer committed by | "Select this zone" button | "Select this zone" button |

Everything else — geometry, colours, field set, wording, timing — is identical.
Commitment is deliberately symmetric so the two interfaces differ only in how
information is *accessed and held*, not in how an answer is given.

**Task.** Six flood zones are outlined. All are the same colour and the same
severity, so the answer cannot be read off the map: the participant must inspect
zones and compare a value. For example, *"Among the outlined zones, click the one
with the most exposed buildings."*

**Counterbalancing.** Four groups rotate interface order and which task set goes
with which interface:

| Group | First half | Second half |
|---|---|---|
| G1 | A · S1 | B · S2 |
| G2 | B · S1 | A · S2 |
| G3 | A · S2 | B · S1 |
| G4 | B · S2 | A · S1 |

Pin a group per participant with a URL parameter — with a small hand-recruited
sample this keeps the four cells balanced, which random assignment would not:

```
https://<user>.github.io/<repo>/?g=G2&p=P007
```

`p` is an optional label for your own private records. Never put names in it.

---

## Guards against shortcuts

The task only measures search and comparison if the answer can't be guessed from
the picture. Three things are enforced when the trials are generated:

- **Colour** — every candidate in a trial has the same severity, so fill colour
  carries no information.
- **Size** — the target always has at least three candidates *larger* (or
  smaller, for "fewest" questions) than it, and within each candidate set the
  correlation between zone area and the answer attribute is capped at |0.6|.
- **Ties** — the target attribute is never tied between candidates.

Difficulty is set by the gap between the best and second-best value: easy
25–60%, moderate 12–25%, hard 2–10%. The hard pairs differ by as little as 3.6%
(83 vs 80 buildings) — a difference nobody can resolve without deliberate
comparison.

---

## Repository layout

```
index.html              all study screens
css/study.css           one stylesheet, shared by both interfaces
js/config.js            Supabase keys and study parameters  <- EDIT THIS
js/logger.js            telemetry: batching, retry, beacon flush
js/mapview.js           shared map, zone rendering, A/B reveal behaviour
js/study.js             flow controller
data/trials.json        the 12 trials + counterbalance table
data/zones.geojson      69 hazard zones with exposure attributes
```

---

## Setup

1. Create the Supabase project and run `supabase_migration.sql` — see
   `SETUP.md` for the full walkthrough, including the RLS verification step.
2. Put your project URL and anon key in `js/config.js`, and set `CONTACT`.
3. Add `.github/workflows/keepalive.yml` and its two repo secrets, so the free
   tier doesn't pause mid-study.
4. Enable GitHub Pages (Settings → Pages → deploy from branch).
5. Open the site yourself first, complete a run, and confirm rows land in the
   Supabase table editor before sending any links out.

Run locally with any static server (module scripts don't work over `file://`):

```bash
python3 -m http.server 8000
```

---

## The data

`data/zones.geojson` is derived, not official. Provenance:

JRC/EFAS river flood hazard, 100-year return period depth raster (tile
`ID108_N40_W10`) → clipped to the Lisbon waterfront → classified into three
depth bands → vectorised → buffered by severity → morphological closing →
simplified. Building counts come from OpenStreetMap footprints, counted by
centroid within 150 m of each zone.

**These zones are a visualisation proxy for a usability experiment. They are not
an official inundation boundary and must not be used for planning or safety
decisions.** The global river model represents the Tagus as a single-cell-wide
flowline, so the widths here are a rendering choice, not a hydrological result.

Basemap © OpenStreetMap contributors, © CARTO. OSM data under ODbL.

---

## Analysis

Three views ship with the schema:

```sql
select * from v_session_quality;      -- triage before analysing
select * from v_participant_contrast; -- per-person A vs B difference
select * from v_trial_analysis;       -- trial-level rows
```

The headline test is a paired comparison of `ms_to_response` between interfaces
within each participant. Predictions: A costs more time and produces more
revisits (the popup closes, so best-so-far must be held in memory); B produces
more zoom and pan (the narrower map shows less at once). The gap should widen on
the hard trials.

Export regularly — the Supabase free tier has no backups.
