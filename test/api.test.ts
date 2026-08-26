import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { buildAuditApi } from "../src/api.js";

const dataDirectory = resolve(process.cwd(), "data");
const requiredFiles = [
  "works.csv",
  "projects.csv",
  "projects_history.csv",
  "service_changes.csv",
  "service_terms.csv",
  "report.csv",
] as const;

async function multipartPayload(fileNames: readonly string[]): Promise<{
  boundary: string;
  payload: Buffer;
}> {
  const boundary = "----node-n8n-audit-test-boundary";
  const chunks: Buffer[] = [];

  for (const fileName of fileNames) {
    const content = await readFile(resolve(dataDirectory, fileName));
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileName}"; filename="${fileName}"\r\n` +
      "Content-Type: text/csv\r\n\r\n",
    ));
    chunks.push(content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

test("API отклоняет multipart-запрос без обязательных CSV", async () => {
  const server = await buildAuditApi();
  try {
    const { boundary, payload } = await multipartPayload(["works.csv"]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/audit",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    assert.equal(response.statusCode, 400);
    const body = response.json() as { code: string; message: string };
    assert.equal(body.code, "MISSING_FILES");
    assert.match(body.message, /projects\.csv/);
  } finally {
    await server.close();
  }
});

test("API принимает шесть CSV и возвращает report_fixed.csv вместе с analysis.json", async () => {
  const server = await buildAuditApi({ accessToken: "integration-test-token" });
  try {
    const { boundary, payload } = await multipartPayload(requiredFiles);
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
      receivedFiles: string[];
      summary: { output: { uniqueClients: number; issues: number; questions: number } };
      results: {
        reportFixedCsv: string;
        analysis: { Issues: unknown[]; Questions: unknown[] };
      };
    };

    assert.equal(body.status, "completed");
    assert.deepEqual(body.receivedFiles, requiredFiles);
    assert.equal(body.summary.output.uniqueClients, 11);
    assert.ok(body.summary.output.issues > 0);
    assert.ok(body.summary.output.questions > 0);
    assert.match(body.results.reportFixedCsv, /report_generated_at/);
    assert.ok(body.results.analysis.Issues.length > 0);
    assert.ok(body.results.analysis.Questions.length > 0);
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
