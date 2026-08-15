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
  { creator: "Nicole",   ds: "25b449d2-35ba-4026-992e-39af9974b158" },
  { creator: "David",    ds: "898508e9-9dda-8383-ad90-070f01618f5a" },
];
export const SOURCES = (() => {
  if (process.env.BOARD_SOURCES) { try { return JSON.parse(process.env.BOARD_SOURCES); } catch {} }
  return DEFAULT_SOURCES;
})();

// --- dynamic client roster: built-ins + clients added through the dashboard -------
// Added clients live as rows in the NOOCAP CLIENTS database, so a new client shows up
// with no redeploy. The roster is cached briefly so the db isn't queried every read.
const CLIENTS_DS = process.env.NOOCAP_CLIENTS_DS || "bcba49cf-fd52-4fe8-9c11-dfd68008d3e3";
const ROSTER_TTL_MS = Number(process.env.ROSTER_TTL_MS || 300000);
let _roster = { at: 0, sources: null };
const rtText = (rt) => (Array.isArray(rt) ? rt.map((t) => t.plain_text).join("") : "");

async function clientRows(token) {
  const rows = [];
  try {
    let cursor;
    do {
      const json = await notion(`/data_sources/${CLIENTS_DS}/query`, token, {
        method: "POST",
        body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      });
      for (const r of json.results || []) {
        const p = r.properties || {};
        const name = rtText(p.Name && p.Name.title).trim();
        const ds = rtText(p["Data Source"] && p["Data Source"].rich_text).trim();
        const active = p.Active ? p.Active.checkbox !== false : true;
        if (name && ds && active) rows.push({ creator: name, ds });
      }
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor);
  } catch { /* roster unreadable → fall back to built-ins only */ }
  return rows;
}

export async function getSources(token) {
  if (_roster.sources && Date.now() - _roster.at < ROSTER_TTL_MS) return _roster.sources;
  const extra = await clientRows(token);
  const byName = new Map();
  for (const s of SOURCES) byName.set(s.creator.toLowerCase(), s);
  for (const s of extra) byName.set(s.creator.toLowerCase(), s); // dashboard-added win on name
  const sources = [...byName.values()];
  _roster = { at: Date.now(), sources };
  return sources;
}

// Resolve a client's dashboard link to their Short-Form board's source data-source id.
// Returns { ds } on success or { error } with a plain-English reason.
export async function resolveBoardDs(token, url) {
  const ids = String(url || "").replace(/-/g, "").match(/[0-9a-f]{32}/gi);
  if (!ids || !ids.length) return { error: "That doesn't look like a Notion page link." };
  const pageId = ids[ids.length - 1];
  let top;
  try { top = await notion(`/blocks/${pageId}/children?page_size=100`, token); }
  catch { return { error: "Couldn't open that page — check it's shared with the integration." }; }

  const isDb = (b) => b && b.type === "child_database";
  const dbTitle = (b) => (b.child_database && b.child_database.title) || "";
  const headingShort = (b) => /heading/.test(b.type) && /short.?form/i.test(rtText(b[b.type] && b[b.type].rich_text));
  const skip = (t) => /brainstorm|long.?form|competitor|voice|caption|lead/i.test(t);

  let shortDb = null, anyDb = null;
  const consider = (b, sectionShort) => {
    if (!isDb(b)) return;
    const t = dbTitle(b);
    if (!anyDb && !skip(t)) anyDb = b.id;
    if (!shortDb && (sectionShort || /short/i.test(t))) shortDb = b.id;
  };
  for (const b of top.results || []) {
    consider(b, false);
    if (b.has_children && !isDb(b)) {
      let sub;
      try { sub = await notion(`/blocks/${b.id}/children?page_size=50`, token); } catch { continue; }
      const kids = sub.results || [];
      const sectionShort = /short.?form/i.test(rtText(b.callout && b.callout.rich_text)) || kids.some(headingShort);
      for (const c of kids) consider(c, sectionShort);
    }
  }
  const dbId = shortDb || anyDb;
  if (!dbId) return { error: "Couldn't find a Short-Form board on that page." };
  let db;
  try { db = await notion(`/databases/${dbId}`, token); }
  catch { return { error: "Found the board but couldn't read its data source." }; }
  const ds = db.data_sources && db.data_sources[0] && db.data_sources[0].id;
  if (!ds) return { error: "That board has no readable data source." };
  return { ds };
}

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
  if (/script approval/.test(s) || n === 5) return { stage: "ScriptApproval", active: true, posted: false, order: 1 };
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
  const fmtRaw = selName(byName(p, ["FORMAT", "Format"]));
  const format = /long/i.test(fmtRaw || "") ? "Long Form" : /short/i.test(fmtRaw || "") ? "Short Form" : null;
  const due = dateStart(byName(p, ["DUE DATE", "Due Date", "Date", "Post Date", "POST DATE"]));
  const editedLink = urlByKey(p, /edited/i);
  const postedLink = urlByKey(p, /posted|video link|^url$|url 1|site link/i);
  const updated = row.last_edited_time || null;
  const daysInStage = updated ? (Date.now() - new Date(updated).getTime()) / 86400000 : null;
  return {
    id: row.id, url: row.url, title: titleOf(p), creator,
    status: st.stage, rawStatus: rawStatus || null, posted: st.posted, stageOrder: st.order,
    type, editor, format, dueDate: due, editedLink, postedLink, daysInStage, updated,
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
  const sources = await getSources(token);
  for (const { creator, ds } of sources) {
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
