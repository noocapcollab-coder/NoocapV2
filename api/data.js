// api/data.js — NOOCAP Command Center data proxy (pipeline only)
// Runs as a Vercel serverless function. Holds your Notion token server-side
// (never exposed to the browser) and returns the Video Pipeline as clean JSON.
// Zero dependencies — uses native fetch (Node 18+).

import { NAME_TO_KEY } from "../lib/creators.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PIPELINE_DB = process.env.PIPELINE_DB_ID || "361508e9-9dda-8071-8f7a-e9a2c32ec1db";

// Cache Notion responses briefly so frequent UI polls don't hit rate limits.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000);
let cache = null; // { at, data }

async function notionQuery(dbId, token) {
  let results = [], cursor, pages = 0;
  do {
    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion ${res.status} for ${dbId}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    results = results.concat(json.results || []);
    cursor = json.has_more ? json.next_cursor : undefined;
    pages++;
  } while (cursor && pages < 12);
  return results;
}

// --- property readers ---
const P = (row) => row.properties || {};
const sel = (p, n) => (p[n] && p[n].select ? p[n].select.name : null);
const title = (p, n) => (p[n] && p[n].title ? p[n].title.map((t) => t.plain_text).join("") : "");
const num = (p, n) => (p[n] && typeof p[n].number === "number" ? p[n].number : null);
const url = (p, n) => (p[n] ? p[n].url || null : null);
const date = (p, n) => (p[n] && p[n].date ? p[n].date.start : null);
const formulaNum = (p, n) => {
  const f = p[n] && p[n].formula;
  if (!f) return null;
  if (f.type === "number") return f.number;
  if (f.type === "string" && !isNaN(parseFloat(f.string))) return parseFloat(f.string);
  return null;
};

const mapPipeline = (rows) => rows.map((r) => { const p = P(r); return {
  id: r.id, url: r.url,
  title: title(p, "Video Title") || "Untitled",
  creator: sel(p, "Creator"),
  status: sel(p, "Status"),
  type: sel(p, "Type"),
  targetPostDate: date(p, "Target Post Date"),
  postedAt: date(p, "Posted At"),
  revisionCount: num(p, "Revision Count"),
  daysInStage: formulaNum(p, "Days in Current Stage"),
  editedLink: url(p, "Edited Video Link"),
  postedLink: url(p, "Posted Link"),
  lastEdited: r.last_edited_time || null,
};});

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." });
    return;
  }
  try {
    const now = Date.now();
    let pipeline;
    if (cache && now - cache.at < CACHE_TTL_MS) {
      pipeline = cache.data;
    } else {
      pipeline = mapPipeline(await notionQuery(PIPELINE_DB, token));
      cache = { at: now, data: pipeline };
    }
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      creatorKeys: NAME_TO_KEY,
      counts: { pipeline: pipeline.length },
      pipeline,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
