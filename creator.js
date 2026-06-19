// api/creator.js — client-facing endpoint for a single creator's portal.
// Takes a creator key (?k=...), maps it to a creator name SERVER-SIDE, and
// returns ONLY that creator's videos with creator-safe fields. It never returns
// other creators, KPIs, tasks, editor identities, briefs, or internal metrics —
// so the key can't be tampered with to reveal anything internal.

import { KEY_TO_NAME } from "../lib/creators.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PIPELINE_DB = process.env.PIPELINE_DB_ID || "361508e9-9dda-8071-8f7a-e9a2c32ec1db";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000);
const cache = {}; // { creatorName: { at, data } }

// Simplified, client-friendly journey. Real status shown on hover in the UI.
const JOURNEY = [
  { stage: "Filming",    statuses: ["Ready to Film"] },
  { stage: "Production", statuses: ["Awaiting Editor Assignment", "Ready for Editing", "Editing in Progress"] },
  { stage: "Review",     statuses: ["Awaiting Review", "Revisions Requested", "Revisions Complete"] },
  { stage: "Approved",   statuses: ["Green Light"] },
  { stage: "Published",  statuses: ["Posted"] },
];
const stageFor = (status) => {
  const hit = JOURNEY.find((j) => j.statuses.includes(status));
  return hit ? hit.stage : "Production";
};

async function queryCreator(creator, token) {
  let results = [], cursor, pages = 0;
  do {
    const res = await fetch(`${NOTION_API}/databases/${PIPELINE_DB}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Creator", select: { equals: creator } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    results = results.concat(json.results || []);
    cursor = json.has_more ? json.next_cursor : undefined;
    pages++;
  } while (cursor && pages < 8);
  return results;
}

const sel = (p, n) => (p[n] && p[n].select ? p[n].select.name : null);
const title = (p, n) => (p[n] && p[n].title ? p[n].title.map((t) => t.plain_text).join("") : "");
const url = (p, n) => (p[n] ? p[n].url || null : null);
const date = (p, n) => (p[n] && p[n].date ? p[n].date.start : null);

function toSafe(rows) {
  return rows.map((r) => {
    const p = r.properties || {};
    const status = sel(p, "Status");
    return {
      title: title(p, "Video Title") || "Untitled",
      type: sel(p, "Type"),                 // Personal / Sponsor
      stage: stageFor(status),              // simplified
      realStatus: status,                   // shown on hover only
      targetPostDate: date(p, "Target Post Date"),
      postedAt: date(p, "Posted At"),
      postedLink: url(p, "Posted Link"),    // their published video
      updated: r.last_edited_time || null,
    };
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = (req.query && (req.query.k || req.query.key)) || "";
  const creator = KEY_TO_NAME[key];
  if (!creator) {
    res.status(404).json({ ok: false, error: "This portal link isn't active. Check with NOOCAP." });
    return;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." });
    return;
  }
  try {
    const now = Date.now();
    let videos;
    if (cache[creator] && now - cache[creator].at < CACHE_TTL_MS) {
      videos = cache[creator].data;
    } else {
      videos = toSafe(await queryCreator(creator, token));
      cache[creator] = { at: now, data: videos };
    }
    res.status(200).json({ ok: true, creator, fetchedAt: new Date().toISOString(), videos });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
