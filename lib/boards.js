// lib/boards.js — reads the per-creator REELS / content boards directly from their
// SOURCE data sources (not the "View of…" linked copies on the Agency View, which
// the Notion API won't serve). Each creator's board has slightly different columns
// and status wording, so the reader is deliberately tolerant: it finds the title /
// status / type columns by name case-insensitively, accepts select, status, or
// multi-select, and collapses every board's stage wording into one clean set.

const NOTION_API = "https://api.notion.com/v1";
const VERSION = process.env.NOTION_DS_VERSION || "2025-09-03";

// creator → real source data-source id (collection). Override via env BOARD_SOURCES
// as JSON: [{"creator":"Brad","ds":"<id>"}, ...]
const DEFAULT_SOURCES = [
  { creator: "Brad",     ds: "28b508e9-9dda-81ba-8d7f-000b84b83fbd" },
  { creator: "Chris",    ds: "2a1508e9-9dda-8125-bd63-000bb75578dd" },
  { creator: "Lindsay",  ds: "301508e9-9dda-811b-83c7-000b46be09b1" },
  { creator: "Emtech",   ds: "328508e9-9dda-8000-b3c9-000b0d791507" },
  { creator: "Duncan",   ds: "328508e9-9dda-8186-b4ca-000bd212e84b" },
  { creator: "Valeri",   ds: "f0dbec00-505d-4e16-8e51-b2fcfea21445" },
  { creator: "Dymtro",   ds: "36b508e9-9dda-8004-a37f-000b460c8c46" },
  { creator: "Jonathan", ds: "370508e9-9dda-807b-9554-000ba747fde7" },
];
export const SOURCES = (() => {
  if (process.env.BOARD_SOURCES) { try { return JSON.parse(process.env.BOARD_SOURCES); } catch {} }
  return DEFAULT_SOURCES;
})();

async function notion(path, token, { method = "GET", body } = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

// --- status → simplified pipeline stage (works for numbered + worded flows) -----
const STAGES = ["Idea", "Scripting", "Filming", "Editing", "Review", "Approved", "Ready"];
export function mapStage(raw) {
  const s = (raw || "").toLowerCase();
  const m = s.match(/(\d{1,2})\s*-/);
  const n = m ? +m[1] : null;
  if (/posted/.test(s) || n === 12) return { stage: "Posted", active: false, posted: true, order: 9 };
  if (/archiv|repost/.test(s) || n === 13) return { stage: "Archived", active: false, posted: false, order: 9 };
  if (/scheduled|ready|to post/.test(s) || n === 10 || n === 11) return { stage: "Ready", active: true, posted: false, order: 6 };
  if (/approval/.test(s) || n === 9) return { stage: "Approved", active: true, posted: false, order: 5 };
  if (/change/.test(s) || n === 8) return { stage: "Review", active: true, posted: false, order: 4 };
  if (/edit/.test(s) || n === 7) return { stage: "Editing", active: true, posted: false, order: 3 };
  if (/film/.test(s) || n === 6) return { stage: "Filming", active: true, posted: false, order: 2 };
  if (/idea bank|not started/.test(s)) return { stage: "Idea", active: true, posted: false, order: 0 };
  if (/idea|brief|transcript|script/.test(s) || (n >= 1 && n <= 5)) return { stage: "Scripting", active: true, posted: false, order: 1 };
  if (/in progress/.test(s)) return { stage: "Editing", active: true, posted: false, order: 3 };
  if (!s) return { stage: "Idea", active: true, posted: false, order: 0 };
  return { stage: "Scripting", active: true, posted: false, order: 1 };
}
export { STAGES };

// --- schema-tolerant property readers (case-insensitive names) ------------------
const plain = (rt) => (Array.isArray(rt) ? rt.map((t) => t.plain_text).join("") : "");
function titleOf(props) {
  for (const k in props) if (props[k] && props[k].type === "title") return plain(props[k].title) || "Untitled";
  return "Untitled";
}
function byName(props, names) {
  const lower = {};
  for (const k in props) lower[k.toLowerCase()] = props[k];
  for (const n of names) { const hit = lower[n.toLowerCase()]; if (hit) return hit; }
  return null;
}
function selName(p) {
  if (!p) return null;
  if (p.type === "select") return p.select ? p.select.name : null;
  if (p.type === "status") return p.status ? p.status.name : null;
  if (p.type === "multi_select") return (p.multi_select && p.multi_select[0]) ? p.multi_select[0].name : null;
  return null;
}
function urlByKey(props, re) {
  for (const k in props) { const p = props[k]; if (p && p.type === "url" && p.url && re.test(k)) return p.url; }
  return null;
}
function dateStart(p) { return p && p.type === "date" && p.date ? p.date.start : null; }

function normalize(row, creator) {
  const p = row.properties || {};
  const rawStatus = selName(byName(p, ["Status"]));
  const st = mapStage(rawStatus);
  const typeRaw = selName(byName(p, ["TYPE", "Type"]));
  const type = /sponsor/i.test(typeRaw || "") ? "Sponsor" : (typeRaw ? "Personal" : null);
  const editor = selName(byName(p, ["EDITOR", "Editor"]));
  const due = dateStart(byName(p, ["DUE DATE", "Due Date", "Date", "Post Date", "POST DATE"]));
  const editedLink = urlByKey(p, /edited/i);
  const postedLink = urlByKey(p, /posted|video link|^url$|url 1|site link/i);
  const updated = row.last_edited_time || null;
  const daysInStage = updated ? (Date.now() - new Date(updated).getTime()) / 86400000 : null;
  return {
    id: row.id, url: row.url, title: titleOf(p), creator,
    status: st.stage, rawStatus: rawStatus || null, posted: st.posted, stageOrder: st.order,
    type, editor, dueDate: due, editedLink, postedLink, daysInStage, updated,
  };
}

async function queryDataSource(dsId, token) {
  let out = [], cursor, pages = 0;
  const MAX_PAGES = Number(process.env.BOARD_MAX_PAGES || 2);
  do {
    const json = await notion(`/data_sources/${dsId}/query`, token, {
      method: "POST",
      body: { sorts: [{ timestamp: "last_edited_time", direction: "descending" }], page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out = out.concat(json.results || []);
    cursor = json.has_more ? json.next_cursor : undefined;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return out;
}

// Query each creator's source data source directly. Returns { rows, boards, errors }.
export async function readBoards(token, { creatorFilter } = {}) {
  const rows = [], boards = [], errors = [];
  for (const { creator, ds } of SOURCES) {
    if (creatorFilter && creator.toLowerCase() !== creatorFilter.toLowerCase()) continue;
    try {
      const raw = await queryDataSource(ds, token);
      for (const r of raw) rows.push(normalize(r, creator));
      boards.push({ creator, ds, count: raw.length });
    } catch (e) {
      errors.push({ creator, ds, error: String(e.message || e) });
    }
  }
  return { rows, boards, errors };
}
