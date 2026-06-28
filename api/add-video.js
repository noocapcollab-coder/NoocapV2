// api/add-video.js — the ONLY endpoint that writes to Notion.
// The "+" on a weekly column calls this to copy a video from the pipeline into the
// weekly plan as a new checkbox. It appends a to_do block inside the creator's toggle,
// positioned right after that section's last checkbox (the `after` anchor), so a
// Personal pick lands under PERSONAL and a Sponsor pick under SPONSOR.
//
// It writes nothing else: no status changes, no edits to existing rows. Everything
// else in the dashboard is read-only.
//
// Body (POST JSON): { parentBlockId, afterBlockId?, title, note?, checked?, videoUrl?, videoId? }
// When videoUrl is present (the pick came from a real pipeline video), the title is
// written as a link to that video's Notion page. The dashboard reads that link back
// to match the card to the live video by id, so renaming the video later updates the
// card on its own instead of going stale.
// Optional guard: set DASHBOARD_TOKEN in env and send it as the x-dashboard-token
// header to stop anyone but your dashboard from posting.

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
  if (req.method !== "POST") {
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

  const parentBlockId = body.parentBlockId;
  const afterBlockId = body.afterBlockId || undefined;
  const rawTitle = (body.title || "").trim();
  const note = (body.note || "").trim();
  const checked = !!body.checked;

  if (!parentBlockId || (!rawTitle && !body.heading && !body.sectionTitle)) {
    res.status(400).json({ ok: false, error: "parentBlockId and title are required." });
    return;
  }

  const content = note ? `${rawTitle} (${note})` : rawTitle;
  const videoUrl = (body.videoUrl || "").trim() || null;

  // Optional: create a section heading (PERSONAL / SPONSOR) instead of a checkbox.
  // Used by the weekly carry-over to build the section in an empty upcoming week
  // so Personal/Sponsor grouping survives a reload.
  const heading = body.heading ? (String(body.heading).toUpperCase() === "SPONSOR" ? "SPONSOR" : "PERSONAL") : null;
  // A free-text heading_3 used to create a creator's section (e.g. "JONATHAN") in a week
  // that doesn't have it yet, so a column can be planned into without hand-editing Notion.
  const sectionTitle = body.sectionTitle ? String(body.sectionTitle).slice(0, 80) : null;

  // When the pick came from a pipeline video, link the title to that video's page.
  // The note (if any) is kept as a separate, unlinked run so the plain text still
  // reads "Title (note)" exactly as before.
  let todoRichText;
  if (videoUrl) {
    todoRichText = [{ type: "text", text: { content: rawTitle.slice(0, 2000), link: { url: videoUrl } } }];
    if (note) todoRichText.push({ type: "text", text: { content: ` (${note})`.slice(0, 200) } });
  } else {
    todoRichText = [{ type: "text", text: { content: content.slice(0, 2000) } }];
  }

  const childBlock = sectionTitle
    ? { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: sectionTitle } }], is_toggleable: true } }
    : heading
    ? { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: heading } }] } }
    : { object: "block", type: "to_do", to_do: { rich_text: todoRichText, checked } };

  const payload = {
    children: [childBlock],
    ...(afterBlockId ? { after: afterBlockId } : {}),
  };

  try {
    const r = await fetch(`${NOTION_API}/blocks/${parentBlockId}/children`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ ok: false, error: `Notion ${r.status}: ${text.slice(0, 240)}` });
      return;
    }
    const json = await r.json();
    const block = (json.results && json.results[0]) || null;
    res.status(200).json({ ok: true, blockId: block ? block.id : null, content });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
