import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { buildAnalysisDocument, writeAnalysisDocument } from "../src/analysis.js";
import { buildFlights } from "../src/flights.js";
import { buildClientHistories, buildInputIndexes } from "../src/indexes.js";
import { loadInputData } from "../src/loaders.js";
import { compareReport } from "../src/report-comparison.js";
import { resolveFlightStatuses } from "../src/statuses.js";
import { buildProjectStates } from "../src/temporal-state.js";

const dataDirectory = resolve(process.cwd(), "data");

test("формирует analysis.json с фактами для ИИ и вопросами без самостоятельного поиска ошибок", async () => {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const histories = buildClientHistories(indexes);
  const projectStates = buildProjectStates(data, indexes);
  const flightBuild = buildFlights(data, indexes, histories, projectStates);
  const statusResolution = resolveFlightStatuses(data, histories, flightBuild);
  const comparison = compareReport(data, statusResolution, projectStates, "2026-08-25");
  const document = buildAnalysisDocument(
    data,
    projectStates,
    statusResolution,
    comparison,
    "2026-08-25",
  );

  assert.equal(document.metadata.generatedAt, "2026-08-25");
  assert.equal(document.metadata.historicalReportCutoff, "2025-09-01");
  assert.ok(document.Issues.length > 0);
  assert.ok(document.Questions.length > 0);
  assert.equal(document.statistics.uniqueReconstructedClients, 11);
  assert.equal(document.statistics.uniqueClientsInOldReport, 11);

  const dataConflictIssue = document.Issues.find((issue) =>
    issue.categories.includes("DATA_CONFLICT"),
  );
  assert.ok(dataConflictIssue);
  assert.ok(dataConflictIssue.arguments.ruleApplied.length > 0);
  assert.ok(dataConflictIssue.arguments.facts.length > 0);
  assert.ok(Object.keys(dataConflictIssue.evidence).length > 0);

  const question = document.Questions.find((item) =>
    item.question.includes("нормативным при расхождении"),
  );
  assert.ok(question);
  assert.ok(question.reason.length > 0);
  assert.ok(question.decisionImpact.length > 0);
  assert.ok(Object.keys(question.context).length > 0);

  const outputDirectory = await mkdtemp(resolve(tmpdir(), "node-n8n-analysis-"));
  try {
    const analysisPath = await writeAnalysisDocument(document, outputDirectory);
    const parsed = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;

    assert.ok(Array.isArray(parsed.Issues));
    assert.ok(Array.isArray(parsed.Questions));
    assert.ok(parsed.sourceDataSummary);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
