// api/set-status.js — writes ONE video's Status back to Notion. Used both by the
// Pipeline drag-and-drop (Film/Edit/Changes/Ready) and by the Weekly status chip,
// which can set any stage in the flow. It patches the Status of a single page to
// one known option label and does nothing else.
//
// POST body: { pageId, stage }
// stage ∈ Idea | Scripting | Filming (Film) | Editing (Edit) | Changes | Approved | Ready | Posted
// It detects whether that board's Status is a select- or status-type property and
// writes accordingly, and it refuses any stage it doesn't recognise.

const NOTION_API = "https://api.notion.com/v1";
const VERSION = process.env.NOTION_DS_VERSION || "2025-09-03";

// dashboard stage -> exact Notion option label (the standard numbered flow on every board)
const STAGE_TO_LABEL = {
  Idea: "1- Idea Assigned",
  Scripting: "4- Script Draft",
  Filming: "6- To Film",
  Film: "6- To Film",
  Editing: "7- In Edit",
  Edit: "7- In Edit",
  Changes: "8- Changes",
  Approved: "9- Approval Brand/Creator",
  Ready: "11- Ready",
  Posted: "12- Posted",
};

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

  // Optional guard: only enforced if DASHBOARD_TOKEN is set in the environment.
  const guard = process.env.DASHBOARD_TOKEN;
  if (guard && req.headers["x-dashboard-token"] !== guard) {
    res.status(401).json({ ok: false, error: "Unauthorized." }); return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { pageId, stage } = body || {};
  const label = STAGE_TO_LABEL[stage];
  if (!pageId || !label) {
    res.status(400).json({ ok: false, error: "Need pageId and a known stage." });
    return;
  }

  try {
    // Find out whether this page's "Status" is a select or a status property.
    const page = await notion(`/pages/${pageId}`, token);
    const props = page.properties || {};
    let statusKey = null, statusType = null;
    for (const k in props) {
      if (k.toLowerCase() === "status" && (props[k].type === "select" || props[k].type === "status")) {
        statusKey = k; statusType = props[k].type; break;
      }
    }
    if (!statusKey) { res.status(422).json({ ok: false, error: "No Status property on this video." }); return; }

    const value = statusType === "status" ? { status: { name: label } } : { select: { name: label } };
    await notion(`/pages/${pageId}`, token, { method: "PATCH", body: { properties: { [statusKey]: value } } });

    res.status(200).json({ ok: true, pageId, stage, label });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
}
