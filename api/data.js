// api/data.js — pipeline feed for the internal dashboard.
// Reads the per-creator REELS boards (see lib/boards.js), keeps only the active
// (not-yet-posted) videos, and returns them grouped-ready for the board view.
// Holds your Notion token server-side and caches briefly so polling is cheap.

import { readBoards } from "../lib/boards.js";
import { NAME_TO_KEY } from "../lib/creators.js";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 20000);
let cache = null;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." }); return; }
  try {
    const now = Date.now();
    if (!cache || now - cache.at >= CACHE_TTL_MS) {
      const { rows, boards, errors } = await readBoards(token);
      const pipeline = rows
        .filter((r) => !r.posted && r.status !== "Archived")
        .map((r) => ({
          id: r.id, url: r.url, title: r.title, creator: r.creator,
          status: r.status, rawStatus: r.rawStatus, type: r.type, editor: r.editor,
          daysInStage: r.daysInStage, dueDate: r.dueDate, editedLink: r.editedLink,
          postedLink: r.postedLink, lastEdited: r.updated,
        }));
      cache = { at: now, data: { pipeline, boards, errors } };
    }
    const { pipeline, boards, errors } = cache.data;
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      creatorKeys: NAME_TO_KEY,
      counts: { pipeline: pipeline.length, boards: boards.length },
      boards, errors, pipeline,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
