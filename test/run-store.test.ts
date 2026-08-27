import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { FileRunStore } from "../src/run-store.js";

test("FileRunStore создаёт, завершает и читает временный запуск", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "node-n8n-run-store-test-"));
  const now = new Date("2026-08-27T10:00:00.000Z");
  const store = new FileRunStore({ directory, ttlMs: 60_000, now: () => now });
  try {
    const created = await store.create({ marker: "deterministic-audit" });
    assert.equal(created.status, "processing");
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.ok(created.viewToken.length >= 32);

    const completed = await store.complete(created.id, { final_report_csv: "client_id;\n1;", audit_md: "# AUDIT" });
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.n8nResult, { final_report_csv: "client_id;\n1;", audit_md: "# AUDIT" });

    const reread = await store.read(created.id);
    assert.equal(reread?.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileRunStore удаляет истёкшие записи при следующем обращении", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "node-n8n-run-store-test-"));
  let current = new Date("2026-08-27T10:00:00.000Z");
  const store = new FileRunStore({ directory, ttlMs: 1_000, now: () => current });
  try {
    const created = await store.create({ marker: "will-expire" });
    current = new Date("2026-08-27T10:00:01.001Z");

    assert.equal(await store.read(created.id), undefined);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
