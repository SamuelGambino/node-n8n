import assert from "node:assert/strict";
import test from "node:test";

import { parseDashboardInput, renderDashboard } from "../src/dashboard.js";

const validCsv = [
  "client_id;project_ids;status;comments",
  "301;301;пролонгировано;Понятный комментарий ИИ",
].join("\n");

test("извлекает CSV и Markdown из сериализованной parts/text обёртки ИИ", () => {
  const input = [{
    final_report_csv: JSON.stringify({
      parts: [{ text: validCsv, thoughtSignature: "служебное-поле" }],
    }),
    audit_md: JSON.stringify({
      parts: [{ text: "# AUDIT\n\nГотовый аудит." }],
    }),
  }];

  const parsed = parseDashboardInput(input);
  assert.equal(parsed.finalReportCsv, validCsv);
  assert.equal(parsed.auditMarkdown, "# AUDIT\n\nГотовый аудит.");
  assert.match(renderDashboard(parsed), /Понятный комментарий ИИ/);
});

test("отклоняет обрезанный CSV из ответа ИИ с понятным объяснением", () => {
  const truncated = JSON.stringify({
    parts: [{ text: "client_id;project_ids;status\n301;301" }],
  });

  assert.throws(
    () => parseDashboardInput({ final_report_csv: truncated, audit_md: "# AUDIT" }),
    /неполный или некорректный final_report_csv/,
  );
});
