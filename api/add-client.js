// api/add-client.js — adds a new creator/client from the dashboard.
// POST { name, url, ds? }. Resolves the client's Short-Form board from their
// dashboard link (or uses ds directly if the link can't be read), then saves them
// as a row in the NOOCAP CLIENTS database so the roster picks them up with no redeploy.
// Optional guard: set DASHBOARD_TOKEN in env and send it as x-dashboard-token.
import { resolveBoardDs } from "../lib/boards.js";

const NOTION_API = "https://api.notion.com/v1";
const VERSION = process.env.NOTION_DS_VERSION || "2025-09-03";
const CLIENTS_DS = process.env.NOOCAP_CLIENTS_DS || "bcba49cf-fd52-4fe8-9c11-dfd68008d3e3";

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
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Use POST." }); return; }

  const guard = process.env.DASHBOARD_TOKEN;
  if (guard && (req.headers["x-dashboard-token"] || "") !== guard) {
    res.status(401).json({ ok: false, error: "Not authorized." }); return;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Missing NOTION_TOKEN environment variable." }); return; }

  let body;
  try { body = await readBody(req); } catch { res.status(400).json({ ok: false, error: "Bad JSON." }); return; }
  const name = String(body.name || "").trim().slice(0, 60);
  const url = String(body.url || "").trim();
  let ds = String(body.ds || "").trim();
  if (!name) { res.status(400).json({ ok: false, error: "Add a client name." }); return; }
  if (!ds && !url) { res.status(400).json({ ok: false, error: "Paste the client's dashboard link." }); return; }

  // Resolve the board from the dashboard link unless a data-source id was given directly.
  if (!ds) {
    const r = await resolveBoardDs(token, url);
    if (r.error) { res.status(422).json({ ok: false, error: r.error }); return; }
    ds = r.ds;
  }

  const properties = {
    "Name": { title: [{ text: { content: name } }] },
    "Data Source": { rich_text: [{ text: { content: ds } }] },
    "Active": { checkbox: true },
  };
  if (url) properties["Dashboard URL"] = { url };

  try {
    const resp = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { type: "data_source_id", data_source_id: CLIENTS_DS }, properties }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      res.status(resp.status).json({ ok: false, error: `Couldn't save the client: ${t.slice(0, 150)}` });
      return;
    }
    res.status(200).json({ ok: true, creator: name, ds });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
