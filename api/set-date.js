// api/set-date.js — writes ONE video's post date back to Notion so calendar
// scheduling is shared across the team. The dashboard calendar already places cards
// by this date; this lets a drag (or the "set day" menu) set it for everyone. It
// targets the same date property the boards reader uses, and clears the date when
// `date` is null/empty (i.e. moved back to "unscheduled").
//
// POST body: { pageId, date }   date = "YYYY-MM-DD" or null/"" to clear.

const NOTION_API = "https://api.notion.com/v1";
const VERSION = process.env.NOTION_DS_VERSION || "2025-09-03";

// Same priority the boards reader (lib/boards.js byName) uses, so we write the very
// property it reads back as the post date: due date → date → post date.
const DATE_NAMES = ["due date", "date", "post date"];

async function notion(path, token, { method = "GET", body } = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only" }); return; }

  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN." }); return; }

  const guard = process.env.DASHBOARD_TOKEN;
  if (guard && req.headers["x-dashboard-token"] !== guard) {
    res.status(401).json({ ok: false, error: "Unauthorized." }); return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const pageId = body && body.pageId;
  const date = (body && body.date) ? String(body.date).slice(0, 10) : null;
  if (!pageId) { res.status(400).json({ ok: false, error: "Need pageId." }); return; }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ ok: false, error: "date must be YYYY-MM-DD or null." }); return;
  }

  try {
    // Resolve the post-date property by name priority, requiring a real date property;
    // fall back to the first date property if none of the known names are present.
    const page = await notion(`/pages/${pageId}`, token);
    const props = page.properties || {};
    const lower = {};
    for (const k in props) lower[k.toLowerCase()] = k;
    let dateKey = null;
    for (const want of DATE_NAMES) {
      const k = lower[want];
      if (k && props[k].type === "date") { dateKey = k; break; }
    }
    if (!dateKey) { for (const k in props) { if (props[k].type === "date") { dateKey = k; break; } } }
    if (!dateKey) { res.status(422).json({ ok: false, error: "No date property on this video." }); return; }

    const value = date ? { date: { start: date } } : { date: null };
    await notion(`/pages/${pageId}`, token, { method: "PATCH", body: { properties: { [dateKey]: value } } });

    res.status(200).json({ ok: true, pageId, date, property: dateKey });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
