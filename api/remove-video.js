// api/remove-video.js — removes one planned video from the weekly plan by
// archiving its checkbox (to_do) block in Notion. This is the only delete the
// dashboard performs; every other write is an append (add-video) or a status
// patch (set-status), and everything else is read-only.
//
// Body (POST JSON): { blockId }
// Optional guard: set DASHBOARD_TOKEN in env and send it as the x-dashboard-token
// header so only your dashboard can remove rows.

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.status(405).json({ ok: false, error: "Use POST." });
    return;
  }

  const guard = process.env.DASHBOARD_TOKEN;
  if (guard && (req.headers["x-dashboard-token"] || "") !== guard) {
    res.status(401).json({ ok: false, error: "Not authorized." });
    return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." }); return; }

  let body;
  try { body = await readBody(req); } catch { res.status(400).json({ ok: false, error: "Bad JSON body." }); return; }

  const blockId = body.blockId;
  if (!blockId) { res.status(400).json({ ok: false, error: "blockId is required." }); return; }

  try {
    const r = await fetch(`${NOTION_API}/blocks/${blockId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ ok: false, error: `Notion ${r.status}: ${text.slice(0, 240)}` });
      return;
    }
    res.status(200).json({ ok: true, blockId });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
