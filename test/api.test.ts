import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("API отклоняет multipart-запрос без metadata", async () => {
  const server = await buildAuditApi();
  try {
    const { boundary, payload } = await multipartPayload({ includeMetadata: false });
    const response = await server.inject({
      method: "POST",
      url: "/v1/audit",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { code: string }).code, "MISSING_METADATA");
  } finally {
    await server.close();
  }
});

test("API принимает шесть CSV с произвольными именами и возвращает analysis и files.report_fixed_csv", async () => {
  const server = await buildAuditApi({ accessToken: "integration-test-token" });
  try {
    const { boundary, payload } = await multipartPayload();
    const response = await server.inject({
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
    await server.close();
  }
});

test("API требует Bearer-токен, если он настроен", async () => {
  const server = await buildAuditApi({ accessToken: "integration-test-token" });
  try {
    const response = await server.inject({ method: "POST", url: "/v1/audit" });
    assert.equal(response.statusCode, 401);
    assert.equal((response.json() as { code: string }).code, "UNAUTHORIZED");
  } finally {
    await server.close();
  }
});
