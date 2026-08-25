import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildFlights } from "../src/flights.js";
import { buildClientHistories, buildInputIndexes } from "../src/indexes.js";
import { loadInputData } from "../src/loaders.js";
import {
  compareReport,
  writeReportArtifacts,
} from "../src/report-comparison.js";
import { resolveFlightStatuses } from "../src/statuses.js";
import { buildProjectStates } from "../src/temporal-state.js";

const dataDirectory = resolve(process.cwd(), "data");

test("формирует исправленный отчёт и детализирует расхождения с исходным report.csv", async () => {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const histories = buildClientHistories(indexes);
  const projectStates = buildProjectStates(data, indexes);
  const flightBuild = buildFlights(data, indexes, histories, projectStates);
  const statusResolution = resolveFlightStatuses(data, histories, flightBuild);
  const comparison = compareReport(data, statusResolution, projectStates);

  assert.equal(comparison.expectedRecords.length, 17);
  assert.equal(comparison.fixedRecords.length, 17);
  assert.ok(comparison.discrepancies.length > 20);

  const gammaFirstFlight = comparison.fixedRecords.find(
    (record) => record.clientId === "311" && record.flightNo === 1 && record.flightStart === "2024-01-01",
  );
  assert.equal(gammaFirstFlight?.projectIds, "310");
  assert.equal(gammaFirstFlight?.projectName, "Гамма Ритейл");
  assert.match(gammaFirstFlight?.auditFlags ?? "", /REPORT_ERROR/);

  const quartzFirstFlight = comparison.fixedRecords.find(
    (record) => record.clientId === "330" && record.flightNo === 1,
  );
  assert.equal(quartzFirstFlight?.serviceType, "Крауд-маркетинг");
  assert.equal(quartzFirstFlight?.termMonths, 6);
  assert.match(quartzFirstFlight?.auditFlags ?? "", /DATA_CONFLICT/);
  assert.match(quartzFirstFlight?.auditFlags ?? "", /NEEDS_REVIEW/);

  assert.ok(
    comparison.discrepancies.some(
      (discrepancy) =>
        discrepancy.clientId === "303" &&
        discrepancy.field === "flight_end" &&
        discrepancy.expectedValue === "2024-07-01" &&
        discrepancy.actualValue === "2024-08-01",
    ),
  );
  assert.ok(
    comparison.discrepancies.some(
      (discrepancy) =>
        discrepancy.clientId === "340" &&
        discrepancy.field === "report_row" &&
        discrepancy.type === "REPORT_ERROR",
    ),
  );

  const outputDirectory = await mkdtemp(resolve(tmpdir(), "node-n8n-report-"));
  try {
    const paths = await writeReportArtifacts(comparison, outputDirectory);
    const fixedCsv = await readFile(paths.reportFixedPath, "utf8");
    const discrepanciesJson = await readFile(paths.discrepanciesPath, "utf8");

    assert.match(fixedCsv, /^\uFEFFclient_id;project_ids;project_name;/);
    assert.match(fixedCsv, /audit_flags;audit_comment/);
    assert.match(discrepanciesJson, /"issueId": "D001"/);
    assert.match(discrepanciesJson, /"type": "REPORT_ERROR"/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
