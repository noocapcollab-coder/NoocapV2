// api/kpis.js — reads the Weekly KPIs content plan and returns, per week, the full
// per-creator breakdown plus agency totals. The plan lives as nested toggles inside
// the Weekly KPIs database rows (e.g. the "JUNE - JULY" page): each week heading holds
// one toggle per creator, and inside each creator toggle the PERSONAL / SPONSOR headings
// are followed by checkbox (to_do) siblings — one per planned video.
//
// For every week we return:
//   - totals  : agency aggregates (planned = the target; shipped = ticked)
//   - creators: [{ name, blockId, anchors, items }]  where anchors give the block id to
//               append a new checkbox AFTER (so the "+" picker writes into the right spot)
//
// Counting rules:
//   - every non-empty checkbox = 1 planned video; ticked = shipped
//   - Joshua / Nuel / Neul count as "normal edits"; everyone else as "AI videos"
//   - PERSONAL vs SPONSOR comes from the heading above the checkbox
//   - BLANK checkboxes (no text) are skipped entirely

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const KPIS_DB = process.env.KPIS_DB_ID || "34e508e9-9dda-80df-acf8-d058a7bb0275";

const NORMAL_CREATORS = (process.env.NORMAL_CREATORS || "JOSHUA,NUEL,NEUL")
  .split(",").map((s) => s.trim().toUpperCase());
const KNOWN_CREATORS = (process.env.KPI_CREATORS ||
  "BRAD,CHRIS,LINDSAY,EMTECH,VALERI,DUNCAN,DYMTRO,JONATHAN,JOSHUA,NUEL,NEUL,CINDY")
  .split(",").map((s) => s.trim().toUpperCase());

const CACHE_TTL_MS = Number(process.env.KPIS_CACHE_TTL_MS || 20000);
const MAX_REQ = Number(process.env.KPIS_MAX_REQ || 120);
const MAX_PERIODS = Number(process.env.KPIS_MAX_PERIODS || 3);
let cache = null;

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

async function notion(path, token, body) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Notion ${res.status} ${path}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

const blockText = (b) => {
  const d = b[b.type];
  return d && d.rich_text ? d.rich_text.map((t) => t.plain_text).join("") : "";
};

function weekLabel(text) {
  // "JUNE 15 - JUNE 20", "JUN 1 - 6", "JUNE 29 - JULY 4"
  const m = text.match(/\b([A-Z]{3,9})\s+(\d{1,2})\s*[-–]\s*(?:([A-Z]{3,9})\s+)?(\d{1,2})\b/i);
  if (!m) return null;
  const m1 = m[1].slice(0, 3).toUpperCase(), d1 = +m[2];
  const m2 = (m[3] ? m[3].slice(0, 3) : m[1].slice(0, 3)).toUpperCase(), d2 = +m[4];
  if (!(m1 in MONTHS)) return null;
  const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
  const label = m[3]
    ? `${cap(m1)} ${d1} – ${cap(m2)} ${d2}`
    : `${cap(m1)} ${d1}–${d2}`;
  const year = new Date().getFullYear();
  return { label, sortKey: new Date(year, MONTHS[m1], d1).getTime() };
}

function creatorName(text) {
  const up = text.trim().toUpperCase();
  return KNOWN_CREATORS.find((c) => up.startsWith(c)) || null;
}

// Pull "(...)" notes out of a checkbox line so the title reads clean; notes shown small.
function splitNote(text) {
  const notes = [];
  const title = text.replace(/\(([^)]*)\)/g, (_, n) => { notes.push(n.trim()); return ""; })
    .replace(/\s{2,}/g, " ").trim();
  return { title: title || text.trim(), note: notes.filter(Boolean).join(" · ") };
}

function newWeek(label, sortKey, archived) {
  return {
    label, sortKey, archived, current: !archived,
    creators: new Map(),
    totals: { planned: 0, shipped: 0, aiPlanned: 0, aiShipped: 0,
      normalPlanned: 0, normalShipped: 0, personalShipped: 0, sponsorShipped: 0 },
  };
}

function getCreator(week, name, blockId) {
  let c = week.creators.get(name);
  if (!c) {
    c = { name, blockId, anchors: { PERSONAL: null, SPONSOR: null, NONE: null }, items: [], planned: 0, shipped: 0 };
    week.creators.set(name, c);
  }
  if (blockId) c.blockId = blockId;
  return c;
}

async function walk(blockId, ctx, archived, token) {
  let cursor;
  do {
    if (ctx.req >= MAX_REQ) return;
    ctx.req++;
    const data = await notion(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, token);
    for (const b of data.results || []) {
      const text = blockText(b).trim();
      const archHere = archived || /NON\s*ACTIVE/i.test(text);

      const wk = weekLabel(text);
      if (wk) {
        if (!ctx.weeks.has(wk.label)) ctx.weeks.set(wk.label, newWeek(wk.label, wk.sortKey, archived));
        ctx.week = ctx.weeks.get(wk.label);
        ctx.creator = null; ctx.section = "NONE";
      } else if (ctx.week) {
        const cr = creatorName(text);
        if (cr) {
          ctx.creator = getCreator(ctx.week, cr, b.id);
          ctx.section = "NONE";
        } else if (/^PERSONAL\b/i.test(text)) {
          ctx.section = "PERSONAL";
          if (ctx.creator && !ctx.creator.anchors.PERSONAL) ctx.creator.anchors.PERSONAL = b.id;
        } else if (/^SPONSOR\b/i.test(text)) {
          ctx.section = "SPONSOR";
          if (ctx.creator && !ctx.creator.anchors.SPONSOR) ctx.creator.anchors.SPONSOR = b.id;
        }
      }

      if (b.type === "to_do" && ctx.week && ctx.creator) {
        const { title, note } = splitNote(text);
        if (title) {
          const checked = !!(b.to_do && b.to_do.checked);
          const sec = ctx.section;
          const type = sec === "PERSONAL" ? "Personal" : sec === "SPONSOR" ? "Sponsor" : null;
          ctx.creator.items.push({ title, note, checked, type, blockId: b.id });
          ctx.creator.anchors[sec] = b.id; // append-after anchor = last item in this section
          ctx.creator.planned++; if (checked) ctx.creator.shipped++;

          const t = ctx.week.totals;
          const isNormal = NORMAL_CREATORS.includes(ctx.creator.name);
          t.planned++; if (checked) t.shipped++;
          if (isNormal) { t.normalPlanned++; if (checked) t.normalShipped++; }
          else { t.aiPlanned++; if (checked) t.aiShipped++; }
          if (sec === "SPONSOR") { if (checked) t.sponsorShipped++; }
          else if (checked) t.personalShipped++;
        }
      }

      if (b.has_children) await walk(b.id, ctx, archHere, token);
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." }); return; }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) { res.status(200).json(cache.data); return; }

  try {
    const db = await notion(`/databases/${KPIS_DB}/query`, token, { page_size: 20 });
    const periods = (db.results || [])
      .sort((a, b) => new Date(b.last_edited_time || 0) - new Date(a.last_edited_time || 0))
      .slice(0, MAX_PERIODS);

    const ctx = { weeks: new Map(), req: 0, week: null, creator: null, section: "NONE" };
    for (const p of periods) {
      if (ctx.req >= MAX_REQ) break;
      await walk(p.id, ctx, false, token);
    }

    // Keep weeks that have any structure (planned videos OR creator toggles to plan into).
    const weeks = [...ctx.weeks.values()]
      .filter((w) => w.creators.size > 0)
      .sort((a, b) => b.sortKey - a.sortKey)
      .map((w) => ({
        label: w.label, sortKey: w.sortKey, archived: w.archived, current: w.current,
        totals: w.totals,
        creators: [...w.creators.values()].map((c) => ({
          name: c.name, blockId: c.blockId, anchors: c.anchors,
          planned: c.planned, shipped: c.shipped, items: c.items,
        })),
      }));

    const payload = { ok: true, fetchedAt: new Date().toISOString(), weeks };
    cache = { at: Date.now(), data: payload };
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
