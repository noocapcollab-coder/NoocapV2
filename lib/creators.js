// lib/creators.js — single source of truth for creator portal access.
// Each creator gets an unguessable key; the share link is /portal.html?k=<key>.
// This is link-based access (like a Notion "anyone with link" URL), not a login.
// To rotate a creator's link, change their key here (or override via the
// CREATOR_KEYS env var as JSON: {"Duncan":"duncan-newkey", ...}) and redeploy.

const DEFAULT_CREATORS = [
  { name: "Brad",    key: "brad-8103212a67d23310" },
  { name: "Lindsay", key: "lindsay-2fd26f3e7a617439" },
  { name: "Cindy",   key: "cindy-7dc96184bcddd6a1" },
  { name: "Chris",   key: "chris-29d41aae7db6489d" },
  { name: "Duncan",  key: "duncan-650480c11f28e5bf" },
  { name: "Joshua",  key: "joshua-9740c5a03cff580e" },
  { name: "Valeri",  key: "valeri-997a4f8fc91e8db3" },
  { name: "Emtech",  key: "emtech-47434656f30f6b20" },
];

function loadCreators() {
  if (process.env.CREATOR_KEYS) {
    try {
      const map = JSON.parse(process.env.CREATOR_KEYS);
      return Object.entries(map).map(([name, key]) => ({ name, key }));
    } catch { /* fall through to defaults */ }
  }
  return DEFAULT_CREATORS;
}

export const CREATORS = loadCreators();
export const KEY_TO_NAME = Object.fromEntries(CREATORS.map((c) => [c.key, c.name]));
export const NAME_TO_KEY = Object.fromEntries(CREATORS.map((c) => [c.name, c.key]));
