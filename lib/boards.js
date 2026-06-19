// lib/boards.js — reads the per-creator REELS boards that live on the Agency View.
// Each board is its own Notion database with its own columns and a numbered status
// flow (idea → script → film → edit → review → post). This module resolves each
// board id to its data source, figures out the creator from the board title, queries
// the rows, and normalizes them into one clean shape the dashboard understands —
// so the small schema differences between creators are smoothed over here.

const NOTION_API = "https://api.notion.com/v1";
// Data-source-aware API version: lets us query each board by its data source id,
// which is how we cope with linked "View of ..." boards on the Agency View.
const VERSION = process.env.NOTION_DS_VERSION || "2025-09-03";

// The nine boards stacked under VIDEO PIPELINE on the Agency View page.
// Override with BOARD_IDS (comma-separated) if you add/remove a creator board.
const DEFAULT_BOARD_IDS = [
  "37f508e9-9dda-801a-9ef7-c9d581f1ffbd",
  "34e508e9-9dda-80ef-9f50-d44c98232f78",
  "34e508e9-9dda-80be-9353-e208d970de87",
  "34e508e9-9dda-80bb-b4b8-d80252a03ea9",
  "34e508e9-9dda-8074-a283-d23db861c36e",
  "34e508e9-9dda-80a9-8369-fe7b8e533c83",
  "37e508e9-9dda-80fe-b0fb-deead480fe04",
  "37e508e9-9dda-8019-bad2-e327cf1fea2f",
  "34e508e9-9dda-8049-8941-d4ab6d9612bc",
];
export const BOARD_IDS = (process.env.BOARD_IDS
  ? process.env.BOARD_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_BOARD_IDS);

const CREATOR_ALIASES = [
  ["Brad", ["BRAD"]], ["Chris", ["CHRIS"]], ["Lindsay", ["LINDSAY"]], ["Cindy", ["CINDY"]],
  ["Duncan", ["DUNCAN"]], ["Joshua", ["JOSHUA", "JOSH"]], ["Valeri", ["VALERI", "VALERIE"]],
  ["Emtech", ["EMTECH", "EM TECH"]], ["Dymtro", ["DYMTRO", "DMYTRO", "DYMTRYO"]],
  ["Jonathan", ["JONATHAN"]], ["Nuel", ["NUEL", "NEUL"]],
];
export function creatorFromTitle(title) {
  const up = (title || "").toUpperCase();
  for (const [name, aliases] of CREATOR_ALIASES) if (aliases.some((a) => up.includes(a))) return name;
  return null;
}

async function notion(path, token, { method = "GET", body } = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Notion ${res.status} ${path}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

// --- status → simplified pipeline stage -------------------------------------
const STAGES = ["Idea", "Scripting", "Filming", "Editing", "Review", "Ready"];
export function mapStage(raw) {
  const s = (raw || "").toLowerCase();
  const m = s.match(/(\d{1,2})\s*-/);
  const n = m ? +m[1] : null;
  if (/posted/.test(s) || n === 12) return { stage: "Posted", active: false, posted: true, order: 9 };
  if (/archiv|repost/.test(s) || n === 13) return { stage: "Archived", active: false, posted: false, order: 9 };
  if (/scheduled|ready|to post/.test(s) || n === 10 || n === 11) return { stage: "Ready", active: true, posted: false, order: 5 };
  if (/change|approval/.test(s) || n === 8 || n === 9) return { stage: "Review", active: true, posted: false, order: 4 };
  if (/edit/.test(s) || n === 7) return { stage: "Editing", active: true, posted: false, order: 3 };
  if (/film/.test(s) || n === 6) return { stage: "Filming", active: true, posted: false, order: 2 };
  if (/idea bank/.test(s)) return { stage: "Idea", active: true, posted: false, order: 0 };
  if (/idea|brief|transcript|script/.test(s) || (n >= 1 && n <= 5)) return { stage: "Scripting", active: true, posted: false, order: 1 };
  if (!s) return { stage: "Idea", active: true, posted: false, order: 0 };
  return { stage: "Scripting", active: true, posted: false, order: 1 };
}
export { STAGES };

// --- schema-tolerant property readers ---------------------------------------
const plain = (rt) => (Array.isArray(rt) ? rt.map((t) => t.plain_text).join("") : "");
function titleOf(props) {
  for (const k in props) if (props[k] && props[k].type === "title") return plain(props[k].title);
  return "Untitled";
}
function selName(p) {
  if (!p) return null;
  if (p.type === "select") return p.select ? p.select.name : null;
  if (p.type === "status") return p.status ? p.status.name : null;
  return null;
}
function find(props, names) { for (const n of names) if (props[n]) return props[n]; return null; }
function urlLike(props, re) {
  for (const k in props) { const p = props[k]; if (p && p.type === "url" && p.url && re.test(k)) return p.url; }
  return null;
}
function dateStart(p) { return p && p.type === "date" && p.date ? p.date.start : null; }

function normalize(row, creator) {
  const p = row.properties || {};
  const rawStatus = selName(find(p, ["Status"]));
  const st = mapStage(rawStatus);
  const typeRaw = selName(find(p, ["TYPE", "Type", "type"]));
  const type = /sponsor/i.test(typeRaw || "") ? "Sponsor" : typeRaw ? "Personal" : null;
  const editor = selName(find(p, ["EDITOR", "Editor"]));
  const due = dateStart(find(p, ["DUE DATE", "Due Date", "Date", "DA"]));
  const editedLink = urlLike(p, /edited/i) || (find(p, ["Edited Video", "Edited Vid"]) || {}).url || null;
  const postedLink = urlLike(p, /url 1|video link|posted|asset|site link/i);
  const updated = row.last_edited_time || null;
  const daysInStage = updated ? (Date.now() - new Date(updated).getTime()) / 86400000 : null;
  return {
    id: row.id, url: row.url, title: titleOf(p) || "Untitled", creator,
    status: st.stage, rawStatus: rawStatus || null, stageOrder: st.order, posted: st.posted,
    type, editor, dueDate: due, editedLink, postedLink, daysInStage, updated,
  };
}

async function queryDataSource(dsId, token) {
  let out = [], cursor, pages = 0;
  const MAX_PAGES = Number(process.env.BOARD_MAX_PAGES || 2); // newest ~200 rows per board
  do {
    const json = await notion(`/data_sources/${dsId}/query`, token, {
      method: "POST",
      body: {
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    out = out.concat(json.results || []);
    cursor = json.has_more ? json.next_cursor : undefined;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return out;
}

// Resolve each board id → its data source + creator, then query + normalize.
// Returns { rows, boards, errors } so the caller can report which boards failed
// (usually because the integration hasn't been connected to that board yet).
export async function readBoards(token, { creatorFilter } = {}) {
  const rows = [], boards = [], errors = [];
  for (const id of BOARD_IDS) {
    try {
      const db = await notion(`/databases/${id}`, token);
      const title = plain(db.title);
      const creator = creatorFromTitle(title) || title;
      if (creatorFilter && creator.toLowerCase() !== creatorFilter.toLowerCase()) continue;
      const sources = db.data_sources || [];
      if (!sources.length) { errors.push({ id, title, error: "no data source" }); continue; }
      let count = 0;
      for (const ds of sources) {
        const raw = await queryDataSource(ds.id, token);
        for (const r of raw) { rows.push(normalize(r, creator)); count++; }
      }
      boards.push({ id, creator, title, count });
    } catch (e) {
      errors.push({ id, error: String(e.message || e) });
    }
  }
  return { rows, boards, errors };
}
