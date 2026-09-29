// Boots the PATCHED backend (acb8270 + registration.patch) twice and hits the routes.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const here = path.dirname(new URL(import.meta.url).pathname);
const TOKEN = "backend-ingest-token-0123456789abcdef0123456789";
const data = path.join(here, "data");
fs.rmSync(data, { recursive: true, force: true });
process.env.DCS_DATA_DIR = data;
const { createWorldRepository } = await import(path.join(here, "src/core/worldstore.mjs"));
const repo = createWorldRepository();
await repo.upsert({ worldId: "world-pub", ownerId: "owner-1", manifest: { title: "pub" }, state: "published" });
await repo.upsert({ worldId: "world-draft", ownerId: "owner-1", manifest: { title: "draft" }, state: "draft" });
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "✅ " : "❌ ") + n + (c || !x ? "" : "  — " + x)); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function boot(extra) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DCS_DATA_DIR: data, DCS_PROVIDERS_OFFLINE: "1", DCS_AUTH_SECRET: "drive-auth-secret-0123456789abcdef0123456789", CEREBRAS_API_KEY: "", ...extra };
  for (const k of ["DCS_MULTIPLAYER_ENABLED", "DCS_NETCODE_INGEST_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!(k in extra)) delete env[k];
  const child = spawn(path.join(here, "node_modules/.bin/tsx"), ["server.mts"], { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("no boot: " + out.slice(-2000))), 90000);
    child.stdout.on("data", (d) => { out += d; if (out.includes("DCS Games Core API v3 on :")) { clearTimeout(t); res(); } });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (c) => { clearTimeout(t); rej(new Error("exit " + c + out.slice(-2000))); });
  });
  return { base: `http://127.0.0.1:${port}`, child, out: () => out };
}
const delta = (over = {}) => ({ delta_id: crypto.randomUUID(), op: "place", session_id: crypto.randomUUID(), world_id: "world-pub", actor_entity_id: "e_0123456789ab", actor_user_id: "player-2", tick: 1, payload: { entity_id: crypto.randomUUID(), object_type: "house", position: { x: 1, y: 0, z: 1 }, rotation: { yaw: 0 } }, ts: new Date().toISOString(), ...over });
const post = async (base, d, token = TOKEN) => { const r = await fetch(`${base}/persistence/delta`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": d.delta_id, "content-type": "application/json" }, body: JSON.stringify(d) }); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  const off = await boot({});
  check("OFF: POST /persistence/delta (no credential) → 404", (await fetch(`${off.base}/persistence/delta`, { method: "POST", body: JSON.stringify(delta()) })).status === 404);
  const offTok = await post(off.base, delta());
  check("OFF: POST with the service token → host auth 401 (never served; nothing stored)", offTok.status === 401 && !fs.existsSync(path.join(data, "persistence-delta")), JSON.stringify(offTok));
  check("OFF: POST /api/persistence/delta → 404", (await fetch(`${off.base}/api/persistence/delta`, { method: "POST", body: "{}" })).status === 404);
  check("OFF: GET /persistence/delta/replay (no credential) → 404", (await fetch(`${off.base}/persistence/delta/replay?world_id=world-pub`)).status === 404);
  check("OFF: /health still 200", (await fetch(`${off.base}/health`)).status === 200);
  off.child.kill("SIGKILL");
  const on = await boot({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: TOKEN });
  const a = await post(on.base, delta());
  check("ON: service token (not a user JWT) reaches the module — no whoOrNull 401; published world, non-owner player → 200", a.status === 200 && a.body?.seq === 1, JSON.stringify(a));
  const b = await post(on.base, delta({ world_id: "world-draft", actor_user_id: "player-2" }));
  check("ON: another creator's DRAFT → 404 (repo read rule, no existence oracle)", b.status === 404 && b.body?.error === "world_not_found", JSON.stringify(b));
  const c = await post(on.base, delta({ world_id: "world-draft", actor_user_id: "owner-1" }));
  check("ON: owner's own draft → 200", c.status === 200, JSON.stringify(c));
  check("ON: unknown world → 404", (await post(on.base, delta({ world_id: "world-none" }))).status === 404);
  check("ON: wrong service token → 401", (await post(on.base, delta(), "wrong-token-0123456789abcdef0123456789")).status === 401);
  const rp = await fetch(`${on.base}/api/persistence/delta/replay?world_id=world-pub`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const rb = await rp.json();
  check("ON: replay (via the /api/ prefix too) returns the stored delta", rp.status === 200 && rb.deltas?.length === 1 && rb.complete === true, JSON.stringify(rb).slice(0, 200));
  check("ON: log is on disk under DCS_DATA_DIR/persistence-delta", fs.readdirSync(path.join(data, "persistence-delta")).length === 2);
  on.child.kill("SIGKILL");
} catch (e) { fail++; console.error(e.message); }
console.log(`PATCHED-BACKEND: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
