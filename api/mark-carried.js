// api/mark-carried.js — tags an existing weekly checkbox as a carry-over from a
// previous week by appending a small "(⤴)" marker to its text. The dashboard
// reads that marker to keep carried videos on the board while leaving them out
// of the week's planned target. One-time use: the automatic carry-over writes
// the marker itself, so this only back-fills items that were rolled over before
// the marker existed.
//
// Body (POST JSON): { blockId }

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MARK = "⤴";

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function plain(richText) {
  return (richText || []).map((r) => (r.plain_text != null ? r.plain_text : (r.text && r.text.content) || "")).join("");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Use POST." }); return; }

  const guard = process.env.DASHBOARD_TOKEN;
  if (guard && (req.headers["x-dashboard-token"] || "") !== guard) {
    res.status(401).json({ ok: false, error: "Not authorized." }); return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." }); return; }

  let body;
  try { body = await readBody(req); } catch { res.status(400).json({ ok: false, error: "Bad JSON body." }); return; }
  const blockId = body.blockId;
  if (!blockId) { res.status(400).json({ ok: false, error: "blockId is required." }); return; }

  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

  try {
    const gr = await fetch(`${NOTION_API}/blocks/${blockId}`, { headers });
    if (!gr.ok) { res.status(502).json({ ok: false, error: `Notion ${gr.status}` }); return; }
    const block = await gr.json();
    if (block.type !== "to_do") { res.status(400).json({ ok: false, error: "Not a checkbox block." }); return; }

    const text = plain(block.to_do && block.to_do.rich_text);
    if (text.includes(MARK)) { res.status(200).json({ ok: true, already: true }); return; }

    const next = `${text} (${MARK})`.slice(0, 2000);
    const pr = await fetch(`${NOTION_API}/blocks/${blockId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ to_do: { rich_text: [{ type: "text", text: { content: next } }], checked: !!(block.to_do && block.to_do.checked) } }),
    });
    if (!pr.ok) { const t = await pr.text(); res.status(502).json({ ok: false, error: `Notion ${pr.status}: ${t.slice(0, 200)}` }); return; }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
