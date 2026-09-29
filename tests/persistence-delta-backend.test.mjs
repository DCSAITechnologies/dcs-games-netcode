// tests/persistence-delta-backend.test.mjs
// The backend /persistence/delta module (backend/persistence-delta/index.mjs),
// mounted on a bare node:http host the way server.mts will mount it: the host
// calls the ONE registered handler first and answers 404 itself otherwise.
//
// Proves: flag OFF / no token / no permission check → handler serves nothing
// (host 404); service-token auth; method guard; envelope validation;
// Idempotency-Key binding; world permission (404/403/503); idempotent append;
// same-id-different-content 409; body cap 413; per-world cap 422; replay
// paging; file-backed log survives a restart and skips a torn tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { registerPersistenceDelta } from "../backend/persistence-delta/index.mjs";

const TOKEN = "ingest-token-0123456789abcdef0123456789";
const ON = { DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: TOKEN };
const quiet = { warn() {}, error() {} };
const WORLDS = { "world-pub": "ok", "world-private": "forbidden" };
const accessWorld = async (w, _u) => WORLDS[w] ?? "not_found";

async function host(handler) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    if (await handler(req, res, url, req.method || "GET")) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

function delta(over = {}) {
  const id = over.delta_id ?? crypto.randomUUID();
  return {
    delta_id: id, op: "place", session_id: crypto.randomUUID(), world_id: "world-pub",
    actor_entity_id: "e_0123456789ab", actor_user_id: "alice", tick: 3,
    payload: { entity_id: crypto.randomUUID(), object_type: "house", position: { x: 1, y: 0, z: 2 }, rotation: { yaw: 0.5 } },
    ts: new Date().toISOString(), ...over,
  };
}

async function post(base, body, { token = TOKEN, idem } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const key = idem ?? (typeof body === "object" ? body.delta_id : undefined);
  if (key) headers["idempotency-key"] = key;
  const r = await fetch(`${base}/persistence/delta`, { method: "POST", headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function replay(base, q, token = TOKEN) {
  const r = await fetch(`${base}/persistence/delta/replay?${new URLSearchParams(q)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("flag OFF: nothing is registered — both routes are the host's 404", async () => {
  for (const env of [{}, { DCS_MULTIPLAYER_ENABLED: "0", DCS_NETCODE_INGEST_TOKEN: TOKEN }, { DCS_NETCODE_INGEST_TOKEN: TOKEN }]) {
    const h = registerPersistenceDelta({ env, accessWorld, log: quiet });
    assert.equal(h.status.enabled, false);
    assert.equal(h.status.reason, "flag_off");
    const s = await host(h);
    try {
      assert.equal((await post(s.base, delta())).status, 404);
      assert.equal((await replay(s.base, { world_id: "world-pub" })).status, 404);
    } finally { await s.close(); }
  }
});

test("fail closed: flag ON but no/short token or no permission check → not registered", async () => {
  assert.equal(registerPersistenceDelta({ env: { DCS_MULTIPLAYER_ENABLED: "1" }, accessWorld, log: quiet }).status.reason, "token_unset");
  assert.equal(registerPersistenceDelta({ env: { DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: "short" }, accessWorld, log: quiet }).status.reason, "token_unset");
  assert.equal(registerPersistenceDelta({ env: ON, log: quiet }).status.reason, "no_access_check");
  const h = registerPersistenceDelta({ env: ON, accessWorld, log: quiet });
  assert.equal(h.status.enabled, true);
  assert.equal(h.status.store, "memory");
});

test("ingest: auth, method, validation, permission, idempotency, conflict, caps", async () => {
  const h = registerPersistenceDelta({ env: { ...ON, DCS_PERSISTENCE_DELTA_MAX_BYTES: "2048", DCS_PERSISTENCE_DELTA_MAX_PER_WORLD: "3" }, accessWorld, log: quiet });
  const s = await host(h);
  try {
    // unrelated paths fall through to the host
    assert.equal((await fetch(`${s.base}/persistence/other`)).status, 404);
    // auth
    assert.equal((await post(s.base, delta(), { token: null })).status, 401);
    assert.equal((await post(s.base, delta(), { token: TOKEN + "x" })).status, 401);
    assert.equal((await replay(s.base, { world_id: "world-pub" }, "nope")).status, 401);
    // method
    assert.equal((await fetch(`${s.base}/persistence/delta`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.equal((await fetch(`${s.base}/persistence/delta/replay`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    // validation
    assert.equal((await post(s.base, "{not json", { idem: "x" })).status, 400);
    for (const bad of [
      delta({ world_id: "../etc/passwd" }),
      delta({ op: "mutate" }),
      delta({ actor_user_id: undefined }),
      delta({ tick: -1 }),
      delta({ ts: "yesterday" }),
      delta({ payload: { entity_id: "x1", object_type: "house", position: { x: Infinity, y: 0, z: 0 }, rotation: { yaw: 0 } } }),
      delta({ op: "inventory", payload: { action: "steal", item_id: "i1", slot: 0 } }),
      delta({ op: "inventory", payload: { action: "move", item_id: "i1", slot: 99 } }),
      delta({ op: "inventory", payload: { action: "grant", item_id: "i1", slot: null } }),
    ]) assert.equal((await post(s.base, bad)).status, 400, JSON.stringify(bad).slice(0, 120));
    // Idempotency-Key must equal delta_id
    assert.equal((await post(s.base, delta(), { idem: crypto.randomUUID() })).status, 400);
    // world permission
    assert.equal((await post(s.base, delta({ world_id: "world-none" }))).status, 404);
    assert.equal((await post(s.base, delta({ world_id: "world-private" }))).status, 403);
    // stored, then idempotent
    const d1 = delta();
    const a = await post(s.base, d1);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ok: true, seq: 1, duplicate: false });
    const again = await post(s.base, d1);
    assert.deepEqual(again.body, { ok: true, seq: 1, duplicate: true });
    // unknown keys are dropped before hashing, so they do not conflict
    assert.equal((await post(s.base, { ...d1, extra: "ignored" })).body.duplicate, true);
    // same id, different content → 409
    assert.equal((await post(s.base, { ...d1, tick: 99 })).status, 409);
    // body cap
    const big = delta({ payload: { entity_id: "x1", object_type: "house", position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 }, pad: "p".repeat(4000) } });
    assert.equal((await post(s.base, big)).status, 413);
    // per-world cap (3)
    assert.equal((await post(s.base, delta({ op: "remove", payload: { entity_id: "x1" } }))).status, 200);
    assert.equal((await post(s.base, delta({ op: "inventory", payload: { action: "grant", item_id: "i1", slot: 0, object_type: "crate" } }))).status, 200);
    const full = await post(s.base, delta());
    assert.equal(full.status, 422);
    assert.equal(full.body.error, "world_log_full");
  } finally { await s.close(); }
});

test("a permission check that throws is 503 (the netcode retries), never a silent accept", async () => {
  const h = registerPersistenceDelta({ env: ON, accessWorld: async () => { throw new Error("db down"); }, log: quiet });
  const s = await host(h);
  try { assert.equal((await post(s.base, delta())).status, 503); } finally { await s.close(); }
});

test("replay: ordered pages, cursor, complete flag, bad world_id", async () => {
  const h = registerPersistenceDelta({ env: ON, accessWorld, log: quiet });
  const s = await host(h);
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) { const d = delta({ tick: i }); ids.push(d.delta_id); assert.equal((await post(s.base, d)).status, 200); }
    assert.equal((await replay(s.base, { world_id: "bad world" })).status, 400);
    const p1 = await replay(s.base, { world_id: "world-pub", since: "0", limit: "2" });
    assert.equal(p1.status, 200);
    assert.deepEqual(p1.body.deltas.map((d) => d.delta_id), ids.slice(0, 2));
    assert.equal(p1.body.next_since, 2);
    assert.equal(p1.body.complete, false);
    const p2 = await replay(s.base, { world_id: "world-pub", since: "2", limit: "1000" });
    assert.deepEqual(p2.body.deltas.map((d) => d.seq), [3, 4, 5]);
    assert.equal(p2.body.complete, true);
    const empty = await replay(s.base, { world_id: "world-unknown" });
    assert.deepEqual([empty.body.deltas.length, empty.body.complete], [0, true]);
  } finally { await s.close(); }
});

test("file store: the log survives a restart, dedupes after it, and skips a torn tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdelta-"));
  try {
    const d1 = delta(), d2 = delta({ op: "remove", payload: { entity_id: "x1" } }), d3 = delta({ tick: 7 });
    let h = registerPersistenceDelta({ env: ON, accessWorld, dataDir: dir, log: quiet });
    assert.equal(h.status.store, "file");
    let s = await host(h);
    assert.equal((await post(s.base, d1)).status, 200);
    assert.equal((await post(s.base, d2)).status, 200);
    await s.close();
    // crash mid-write: a torn last line
    const [file] = await fs.readdir(dir);
    await fs.appendFile(path.join(dir, file), '{"delta_id":"torn', "utf8");
    h = registerPersistenceDelta({ env: ON, accessWorld, dataDir: dir, log: quiet });
    s = await host(h);
    try {
      const r = await replay(s.base, { world_id: "world-pub" });
      assert.deepEqual(r.body.deltas.map((d) => d.delta_id), [d1.delta_id, d2.delta_id]);
      assert.equal((await post(s.base, d1)).body.duplicate, true);
      assert.equal((await post(s.base, d3)).status, 200);
    } finally { await s.close(); }
    // the record written after the torn tail is intact on the next restart
    h = registerPersistenceDelta({ env: ON, accessWorld, dataDir: dir, log: quiet });
    s = await host(h);
    try {
      const r = await replay(s.base, { world_id: "world-pub" });
      assert.deepEqual(r.body.deltas.map((d) => d.delta_id), [d1.delta_id, d2.delta_id, d3.delta_id]);
    } finally { await s.close(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("REGISTRATION.patch ships this exact module (no drift between the patch and the file)", async () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "backend", "persistence-delta");
  const patch = await fs.readFile(path.join(dir, "REGISTRATION.patch"), "utf8");
  const module = await fs.readFile(path.join(dir, "index.mjs"), "utf8");
  const part = patch.split("diff --git a/src/v3/gamesc/persistence-delta/index.mjs")[1];
  assert.ok(part, "patch adds src/v3/gamesc/persistence-delta/index.mjs");
  const added = part.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") + "\n";
  assert.equal(added, module);
  // and the server.mts hunk registers exactly one handler, before whoOrNull
  const srv = patch.split("diff --git a/server.mts")[1].split("diff --git")[0];
  assert.equal((srv.match(/^\+.*registerPersistenceDelta\(/gm) || []).length, 1);
  assert.match(srv, /\+    if \(await persistenceDelta\(req, res, url, method\)\) return;\n\+\n     \/\/ A1: resolve once/);
});
