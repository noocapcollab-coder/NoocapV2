# NOOCAP · Command Center

A live, auto-syncing dashboard over your two Notion databases. Your Notion stays the
source of truth; a tiny Vercel backend holds your token and does the talking, so the
browser never sees a secret.

## Two views, one toggle

**Pipeline** — every active (not-yet-posted) video from VIDEO PIPELINE v2, grouped into
a column per creator, each card showing its production stage and how long it's been
parked there. Anything stuck (in revisions, awaiting an editor, or sitting 2+ days)
flags itself. Click a card to open it in Notion; click a creator to open a drawer with
their shareable portal link and full active list.

**Weekly** — pick a week from the dropdown and see agency totals up top (AI videos,
normal edits, completion, personal · sponsor) computed straight from your plan's
checkboxes, with the same week laid out as creator columns below. The **+** on any
column pulls that creator's pipeline videos and copies your picks into the plan as new
checkboxes — the one and only thing the dashboard ever writes back.

## How counting works

- Every non-empty checkbox in the selected week = 1 planned video; ticked = shipped.
- Planned **is** the target — completion is shipped ÷ everything planned that week.
- Joshua / Nuel / Neul count as normal edits; everyone else as AI videos.
- Personal vs Sponsor comes from the heading above each checkbox.
- Blank checkboxes are skipped entirely.

## The "+" (add video) behavior

- Picks come from VIDEO PIPELINE v2 filtered to that creator; already-scheduled titles
  are greyed out. Multi-select, with an optional note per pick, plus a "type a title"
  fallback for creators who have no pipeline rows yet.
- Each pick is appended as a checkbox inside that creator's toggle, right after the
  matching section's last item (Personal picks land under PERSONAL, Sponsor under
  SPONSOR). **Default type is Personal** when a video has none set.
- Nothing else in Notion is ever modified — no status flips, no edits to existing rows.

## Files

```
index.html        Internal dashboard (Pipeline / Weekly toggle, drawer, + picker)
portal.html       Client-facing per-creator portal (simplified journey)
api/data.js       Reads the pipeline (holds token, caches ~15s)
api/kpis.js       Parses the weekly plan → per-creator structure + agency totals
api/creator.js    Client-safe single-creator read for portals
api/add-video.js  The only write: appends a checkbox into the weekly plan
lib/creators.js   Creator → portal-key map (rotate links here)
```

## Deploy

1. Create a Notion integration at notion.so/my-integrations and copy its token.
2. Share **VIDEO PIPELINE v2** and **NOOCAP WEEKLY KPIs** with that integration.
3. `vercel` to link the project, then add `NOTION_TOKEN` in Project → Settings → Env.
4. `vercel --prod`.

Internal dashboard: your Vercel URL. Each creator's portal: `/portal.html?k=<their-key>`
(keys live in `lib/creators.js`). The internal board is for you only — don't share it.

## Notes

- Refresh is automatic (~20s) with a manual Refresh button and a live/synced indicator.
- Opening `index.html` with no backend shows clearly-marked demo data so you can preview
  the layout before setting the token.
- To lock down writes, set `DASHBOARD_TOKEN` (see `.env.example`).
