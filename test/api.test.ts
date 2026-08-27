import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { buildAuditApi } from "../src/api.js";

const dataDirectory = resolve(process.cwd(), "data");
const uploadedFiles = [
  { fieldName: "monthly-data", sourceFile: "works.csv" },
  { fieldName: "project-catalog", sourceFile: "projects.csv" },
  { fieldName: "project-timeline", sourceFile: "projects_history.csv" },
  { fieldName: "service-timeline", sourceFile: "service_changes.csv" },
  { fieldName: "terms-catalog", sourceFile: "service_terms.csv" },
  { fieldName: "previous-report", sourceFile: "report.csv" },
] as const;

const metadata = [{
  submittedAt: "2026-08-26T11:30:37.227Z",
  formMode: "instanceAi",
  checked_report: "previous-report",
  raw_monthly_shipments: "monthly-data",
  projects_directory: "project-catalog",
  projects_change_history: "project-timeline",
  service_changes: "service-timeline",
  flight_length: "terms-catalog",
}];

async function multipartPayload(options: {
  includeMetadata?: boolean;
  files?: readonly { fieldName: string; sourceFile: string }[];
} = {}): Promise<{ boundary: string; payload: Buffer }> {
  const boundary = "----node-n8n-audit-test-boundary";
  const chunks: Buffer[] = [];

  if (options.includeMetadata !== false) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"metadata\"\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n`,
    ));
  }

  for (const { fieldName, sourceFile } of options.files ?? uploadedFiles) {
    const content = await readFile(resolve(dataDirectory, sourceFile));
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${sourceFile}"\r\n` +
      "Content-Type: text/csv\r\n\r\n",
    ));
    chunks.push(content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

async function createTestServer(options: {
  n8nLauncher?: (payload: { run_id: string; callback_url: string; audit: { files: { report_fixed_csv: string } } }) => Promise<void>;
  accessToken?: string;
} = {}) {
  const storeDirectory = await mkdtemp(resolve(tmpdir(), "node-n8n-run-store-test-"));
  const server = await buildAuditApi({
    accessToken: options.accessToken,
    publicBaseUrl: "https://audit.example.test",
    n8nCallbackToken: "callback-test-token",
    n8nLauncher: options.n8nLauncher,
    runStoreDirectory: storeDirectory,
    runTtlMs: 60_000,
  });

  return {
    server,
    storeDirectory,
    async close(): Promise<void> {
      await server.close();
      await rm(storeDirectory, { recursive: true, force: true });
    },
  };
}

function runLocation(response: { headers: Record<string, string | string[] | undefined> }): string {
  const location = response.headers.location;
  assert.equal(typeof location, "string");
  return location;
}

test("страница загрузки запускает асинхронный endpoint /v1/runs", async () => {
  const context = await createTestServer({ n8nLauncher: async () => {} });
  try {
    const response = await context.server.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/html/);
    assert.match(response.body, /action="\/v1\/runs"/);
    assert.match(response.body, /name="checked_report"/);
    assert.match(response.body, /name="flight_length"/);
  } finally {
    await context.close();
  }
});

test("API отклоняет multipart-запрос без metadata", async () => {
  const context = await createTestServer({ n8nLauncher: async () => {} });
  try {
    const { boundary, payload } = await multipartPayload({ includeMetadata: false });
    const response = await context.server.inject({
      method: "POST",
      url: "/v1/audit",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { code: string }).code, "MISSING_METADATA");
  } finally {
    await context.close();
  }
});

test("API принимает шесть CSV с произвольными именами и возвращает analysis и files.report_fixed_csv", async () => {
  const context = await createTestServer({ accessToken: "integration-test-token", n8nLauncher: async () => {} });
  try {
    const { boundary, payload } = await multipartPayload();
    const response = await context.server.inject({
      method: "POST",
      url: "/v1/audit",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        authorization: "Bearer integration-test-token",
      },
      payload,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      status: string;
      request: typeof metadata[number];
      summary: { uniqueClients: number; issues: number; questions: number };
      analysis: { Issues: unknown[]; Questions: unknown[] };
      files: { report_fixed_csv: string; audit_discrepancies_json: { discrepancies: unknown[] } };
    };

    assert.equal(body.status, "completed");
    assert.equal(body.request.checked_report, "previous-report");
    assert.equal(body.summary.uniqueClients, 11);
    assert.ok(body.summary.issues > 0);
    assert.ok(body.summary.questions > 0);
    assert.match(body.files.report_fixed_csv, /report_generated_at/);
    assert.ok(body.files.audit_discrepancies_json.discrepancies.length > 0);
    assert.ok(body.analysis.Issues.length > 0);
    assert.ok(body.analysis.Questions.length > 0);
  } finally {
    await context.close();
  }
});

test("асинхронный browser-first сценарий создаёт run, принимает callback и отображает dashboard", async () => {
  let startPayload: { run_id: string; callback_url: string; audit: { files: { report_fixed_csv: string } } } | undefined;
  const context = await createTestServer({
    n8nLauncher: async (payload) => { startPayload = payload; },
  });

  try {
    const { boundary, payload } = await multipartPayload();
    const start = await context.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    assert.equal(start.statusCode, 303);
    assert.ok(startPayload);
    assert.match(startPayload.callback_url, new RegExp(`/v1/runs/${startPayload.run_id}/result$`));
    const location = runLocation(start);
    assert.match(location, new RegExp(`^/runs/${startPayload.run_id}\\?token=`));

    const waiting = await context.server.inject({ method: "GET", url: location });
    assert.equal(waiting.statusCode, 200);
    assert.match(waiting.body, /n8n продолжает обработку/);

    const callbackPath = new URL(startPayload.callback_url).pathname;
    const callback = await context.server.inject({
      method: "POST",
      url: callbackPath,
      headers: { authorization: "Bearer callback-test-token" },
      payload: {
        final_report_csv: startPayload.audit.files.report_fixed_csv,
        audit_md: "# AUDIT\n\nИтог сформирован вторым ИИ-вызовом.",
      },
    });
    assert.equal(callback.statusCode, 200);
    assert.equal((callback.json() as { status: string }).status, "completed");

    const statusPath = location.replace("/runs/", "/v1/runs/").replace("?", "/status?");
    const status = await context.server.inject({ method: "GET", url: statusPath });
    assert.equal((status.json() as { status: string }).status, "completed");

    const dashboard = await context.server.inject({ method: "GET", url: location });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.headers["content-type"] ?? "", /text\/html/);
    assert.match(dashboard.body, /Результат аудита отчёта/);
    assert.match(dashboard.body, /Итог сформирован вторым ИИ-вызовом/);
    assert.match(dashboard.body, /Аврора Клиник/);
    assert.match(dashboard.body, /id="download-report"/);
    assert.match(dashboard.body, /id="download-audit"/);
  } finally {
    await context.close();
  }
});

test("ошибка запуска n8n сохраняется во временном run и показывается пользователю", async () => {
  const context = await createTestServer({
    n8nLauncher: async () => { throw new Error("Webhook временно недоступен"); },
  });
  try {
    const { boundary, payload } = await multipartPayload();
    const start = await context.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    const page = await context.server.inject({ method: "GET", url: runLocation(start) });
    assert.equal(page.statusCode, 502);
    assert.match(page.body, /Webhook временно недоступен/);
  } finally {
    await context.close();
  }
});

test("callback запуска требует отдельный Bearer-токен", async () => {
  let startPayload: { run_id: string; callback_url: string; audit: { files: { report_fixed_csv: string } } } | undefined;
  const context = await createTestServer({ n8nLauncher: async (payload) => { startPayload = payload; } });
  try {
    const { boundary, payload } = await multipartPayload();
    await context.server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.ok(startPayload);
    const response = await context.server.inject({
      method: "POST",
      url: new URL(startPayload.callback_url).pathname,
      payload: { final_report_csv: startPayload.audit.files.report_fixed_csv, audit_md: "# AUDIT" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal((response.json() as { code: string }).code, "UNAUTHORIZED");
  } finally {
    await context.close();
  }
});

test("API требует Bearer-токен для прямого детерминированного endpoint", async () => {
  const context = await createTestServer({ accessToken: "integration-test-token", n8nLauncher: async () => {} });
  try {
    const response = await context.server.inject({ method: "POST", url: "/v1/audit" });
    assert.equal(response.statusCode, 401);
    assert.equal((response.json() as { code: string }).code, "UNAUTHORIZED");
  } finally {
    await context.close();
  }
});
