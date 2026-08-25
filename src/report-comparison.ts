// Модуль строит expected report, сравнивает его с report.csv и сохраняет
// машинно-читаемые артефакты: report_fixed.csv и audit_discrepancies.json.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isMonthInRange } from "./month.js";
import type {
  AuditFlag,
  ExpectedReportRecord,
  FixedReportRecord,
  ProjectStateResult,
  ReportComparisonResult,
  ReportDiscrepancy,
  ReportRecord,
  ResolvedFlight,
  StatusResolutionResult,
} from "./types.js";

const AUDIT_FLAG_ORDER: AuditFlag[] = ["REPORT_ERROR", "DATA_CONFLICT", "NEEDS_REVIEW"];

const REPORT_FIELDS: Array<{
  key: keyof ExpectedReportRecord;
  label: string;
}> = [
  { key: "clientId", label: "client_id" },
  { key: "projectIds", label: "project_ids" },
  { key: "projectName", label: "project_name" },
  { key: "serviceType", label: "service_type" },
  { key: "termMonths", label: "term_months" },
  { key: "flightNo", label: "flight_no" },
  { key: "flightStart", label: "flight_start" },
  { key: "flightEnd", label: "flight_end" },
  { key: "lastActiveMonth", label: "last_active_month" },
  { key: "status", label: "status" },
  { key: "reportGeneratedAt", label: "report_generated_at" },
];

export class ReportComparisonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReportComparisonError";
  }
}

function displayValue(value: string | number | null): string {
  return value === null ? "" : String(value);
}

/** Ключ флайта стабилен даже при изменении атрибутов строки и нужен для честного сопоставления. */
function comparisonKey(row: Pick<ExpectedReportRecord, "clientId" | "flightNo" | "flightStart">): string {
  return `${row.clientId}::${row.flightNo}::${row.flightStart}`;
}

function sourceComparisonKey(row: ReportRecord): string {
  return `${row.clientId}::${row.flightNo}::${row.flightStart}`;
}

function expectedFromFlight(
  flight: ResolvedFlight,
  reportGeneratedAt: ExpectedReportRecord["reportGeneratedAt"],
): ExpectedReportRecord {
  return {
    clientId: flight.clientId,
    projectIds: flight.projectIds.join("|"),
    projectName: flight.projectName,
    serviceType: flight.serviceType,
    termMonths: flight.termMonths,
    flightNo: flight.flightNo,
    flightStart: flight.flightStart,
    flightEnd: flight.flightEnd,
    lastActiveMonth: flight.lastActiveMonth,
    status: flight.status,
    reportGeneratedAt,
  };
}

function reportValue(
  record: ReportRecord,
  key: keyof ExpectedReportRecord,
): string | number | null {
  switch (key) {
    case "clientId":
      return record.clientId;
    case "projectIds":
      return record.projectIds;
    case "projectName":
      return record.projectName;
    case "serviceType":
      return record.serviceType;
    case "termMonths":
      return record.termMonths;
    case "flightNo":
      return record.flightNo;
    case "flightStart":
      return record.flightStart;
    case "flightEnd":
      return record.flightEnd;
    case "lastActiveMonth":
      return record.lastActiveMonth;
    case "status":
      return record.status;
    case "reportGeneratedAt":
      return record.reportGeneratedAt;
  }
}

function createDiscrepancy(
  sequence: number,
  type: AuditFlag,
  record: ExpectedReportRecord,
  field: string,
  expectedValue: string | number | null,
  actualValue: string | number | null,
  evidence: string,
  comment: string,
): ReportDiscrepancy {
  return {
    issueId: `D${String(sequence).padStart(3, "0")}`,
    type,
    clientId: record.clientId,
    flightNo: record.flightNo,
    flightStart: record.flightStart,
    field,
    expectedValue: displayValue(expectedValue) || null,
    actualValue: displayValue(actualValue) || null,
    evidence,
    comment,
  };
}

function statusAuditDiscrepancies(
  flight: ResolvedFlight,
  record: ExpectedReportRecord,
  projectStates: ProjectStateResult,
  sequenceStart: number,
): ReportDiscrepancy[] {
  const discrepancies: ReportDiscrepancy[] = [];
  let sequence = sequenceStart;

  const dataConflicts = projectStates.issues.filter(
    (issue) =>
      flight.projectIds.includes(issue.projectId) &&
      isMonthInRange(issue.month, flight.flightStart, flight.flightEnd),
  );
  if (dataConflicts.length > 0) {
    const evidence = dataConflicts
      .map((issue) => `${issue.month}: ${issue.message}`)
      .join(" ");
    discrepancies.push(
      createDiscrepancy(
        sequence++,
        "DATA_CONFLICT",
        record,
        "term_months",
        record.termMonths,
        null,
        evidence,
        "Источники расходятся по сроку услуги; в исправленном отчёте применён срок из service_terms.csv.",
      ),
    );
  }

  if (flight.status === "NEEDS_REVIEW") {
    discrepancies.push(
      createDiscrepancy(
        sequence++,
        "NEEDS_REVIEW",
        record,
        "status",
        flight.status,
        null,
        flight.statusComment,
        "Статус не установлен предположением: требуется бизнес-уточнение для однозначной классификации.",
      ),
    );
  }

  for (const issue of flight.statusIssues) {
    discrepancies.push(
      createDiscrepancy(
        sequence++,
        "NEEDS_REVIEW",
        record,
        issue.type,
        null,
        null,
        issue.message,
        "Сохранено как контекст для аудита и последующего объяснения пользователю.",
      ),
    );
  }

  return discrepancies;
}

function appendExpectedAndSourceDiscrepancies(
  expectedRecords: ExpectedReportRecord[],
  sourceRecords: ReportRecord[],
  historicalReportCutoff: ExpectedReportRecord["reportGeneratedAt"],
): ReportDiscrepancy[] {
  const discrepancies: ReportDiscrepancy[] = [];
  const sourceByKey = new Map<string, ReportRecord>();
  const duplicateSourceKeys = new Set<string>();
  let sequence = 1;

  for (const sourceRecord of sourceRecords) {
    const key = sourceComparisonKey(sourceRecord);
    if (sourceByKey.has(key)) {
      duplicateSourceKeys.add(key);
    } else {
      sourceByKey.set(key, sourceRecord);
    }
  }

  const expectedKeys = new Set<string>();
  for (const expectedRecord of expectedRecords) {
    const key = comparisonKey(expectedRecord);
    expectedKeys.add(key);
    const sourceRecord = sourceByKey.get(key);

    if (!sourceRecord) {
      discrepancies.push(
        createDiscrepancy(
          sequence++,
          "REPORT_ERROR",
          expectedRecord,
          "report_row",
          `строка ${key}`,
          null,
          "В исходном report.csv отсутствует строка с тем же client_id, flight_no и flight_start.",
          "В исправленный отчёт добавлена ожидаемая строка, восстановленная из сырых данных.",
        ),
      );
      continue;
    }

    if (duplicateSourceKeys.has(key)) {
      discrepancies.push(
        createDiscrepancy(
          sequence++,
          "REPORT_ERROR",
          expectedRecord,
          "report_row",
          `одна строка ${key}`,
          "несколько строк с одинаковым ключом",
          "В report.csv найден неуникальный ключ client_id + flight_no + flight_start.",
          "Неуникальная строка отчёта требует исправления; сравнение выполнено с первой найденной строкой.",
        ),
      );
    }

    for (const field of REPORT_FIELDS) {
      // Дата в исходном отчёте — исторический срез для аудита, а в новом файле
      // должна быть дата запуска. Поэтому сравниваем source с историческим срезом,
      // но сохраняем в report_fixed.csv актуальную дату формирования.
      const expectedValue = field.key === "reportGeneratedAt"
        ? historicalReportCutoff
        : expectedRecord[field.key];
      const actualValue = reportValue(sourceRecord, field.key);
      if (displayValue(expectedValue) !== displayValue(actualValue)) {
        discrepancies.push(
          createDiscrepancy(
            sequence++,
            "REPORT_ERROR",
            expectedRecord,
            field.label,
            expectedValue,
            actualValue,
            `Флайт восстановлен по помесячным отгрузкам, истории project_id, изменениям услуги и service_terms.csv.`,
            `Поле «${field.label}» заменено значением, рассчитанным программой.`,
          ),
        );
      }
    }
  }

  for (const sourceRecord of sourceRecords) {
    const key = sourceComparisonKey(sourceRecord);
    if (!expectedKeys.has(key)) {
      const record: ExpectedReportRecord = {
        clientId: sourceRecord.clientId,
        projectIds: sourceRecord.projectIds,
        projectName: sourceRecord.projectName,
        serviceType: sourceRecord.serviceType,
        termMonths: sourceRecord.termMonths,
        flightNo: sourceRecord.flightNo,
        flightStart: sourceRecord.flightStart,
        flightEnd: sourceRecord.flightEnd,
        lastActiveMonth: sourceRecord.lastActiveMonth,
        status: sourceRecord.status as ExpectedReportRecord["status"],
        reportGeneratedAt: sourceRecord.reportGeneratedAt,
      };
      discrepancies.push(
        createDiscrepancy(
          sequence++,
          "REPORT_ERROR",
          record,
          "report_row",
          null,
          `строка ${key}`,
          "Восстановленный expected report не содержит строку с этим ключом.",
          "Строка исключена из report_fixed.csv как не соответствующая восстановленным флайтам.",
        ),
      );
    }
  }

  return discrepancies;
}

function nextIssueSequence(discrepancies: ReportDiscrepancy[]): number {
  return discrepancies.length + 1;
}

function auditFlagsForRecord(
  record: ExpectedReportRecord,
  discrepancies: ReportDiscrepancy[],
): AuditFlag[] {
  const flags = new Set(
    discrepancies
      .filter(
        (discrepancy) =>
          discrepancy.clientId === record.clientId &&
          discrepancy.flightNo === record.flightNo &&
          discrepancy.flightStart === record.flightStart,
      )
      .map((discrepancy) => discrepancy.type),
  );
  return AUDIT_FLAG_ORDER.filter((flag) => flags.has(flag));
}

function commentForRecord(
  record: ExpectedReportRecord,
  discrepancies: ReportDiscrepancy[],
): string {
  const related = discrepancies.filter(
    (discrepancy) =>
      discrepancy.clientId === record.clientId &&
      discrepancy.flightNo === record.flightNo &&
      discrepancy.flightStart === record.flightStart,
  );
  if (related.length === 0) {
    return "Проверено: строка совпадает с восстановленным расчётом.";
  }

  return related
    .map((discrepancy) => `[${discrepancy.type}] ${discrepancy.comment} ${discrepancy.evidence}`)
    .join(" ");
}

/**
 * Сравнивает ожидаемые строки с исходными и не скрывает ни ошибки отчёта,
 * ни противоречия источников, ни случаи NEEDS_REVIEW.
 */
export function compareReport(
  data: { report: ReportRecord[] },
  statusResolution: StatusResolutionResult,
  projectStates: ProjectStateResult,
  outputReportGeneratedAt: ExpectedReportRecord["reportGeneratedAt"],
): ReportComparisonResult {
  // Новый файл получает дату его фактического формирования, а не дату старого отчёта.
  const expectedRecords = statusResolution.flights.map((flight) =>
    expectedFromFlight(flight, outputReportGeneratedAt),
  );
  const discrepancies = appendExpectedAndSourceDiscrepancies(
    expectedRecords,
    data.report,
    statusResolution.reportGeneratedAt,
  );
  let sequence = nextIssueSequence(discrepancies);

  for (let index = 0; index < statusResolution.flights.length; index += 1) {
    const flight = statusResolution.flights[index];
    const expectedRecord = expectedRecords[index];
    if (!flight || !expectedRecord) {
      throw new ReportComparisonError("Нарушено соответствие флайтов и ожидаемых строк отчёта.");
    }
    const contextualDiscrepancies = statusAuditDiscrepancies(
      flight,
      expectedRecord,
      projectStates,
      sequence,
    );
    discrepancies.push(...contextualDiscrepancies);
    sequence = nextIssueSequence(discrepancies);
  }

  const fixedRecords = expectedRecords.map((record) => {
    const flags = auditFlagsForRecord(record, discrepancies);
    return {
      ...record,
      auditFlags: flags.join("|"),
      auditComment: commentForRecord(record, discrepancies),
    };
  });

  return { expectedRecords, fixedRecords, discrepancies };
}

function escapeCsvValue(value: string | number | null): string {
  const text = displayValue(value);
  return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeFixedReport(records: FixedReportRecord[]): string {
  const header = [
    "client_id",
    "project_ids",
    "project_name",
    "service_type",
    "term_months",
    "flight_no",
    "flight_start",
    "flight_end",
    "last_active_month",
    "status",
    "report_generated_at",
    "audit_flags",
    "audit_comment",
  ];
  const rows = records.map((record) => [
    record.clientId,
    record.projectIds,
    record.projectName,
    record.serviceType,
    record.termMonths,
    record.flightNo,
    record.flightStart,
    record.flightEnd,
    record.lastActiveMonth,
    record.status,
    record.reportGeneratedAt,
    record.auditFlags,
    record.auditComment,
  ].map(escapeCsvValue).join(";"));

  // BOM сохраняет корректное отображение русских заголовков и комментариев в Excel.
  return `\uFEFF${[header.join(";"), ...rows].join("\n")}\n`;
}

/** Сериализует удобный для Excel CSV и подробный JSON с каждым расхождением. */
export async function writeReportArtifacts(
  comparison: ReportComparisonResult,
  outputDirectory: string,
): Promise<{ reportFixedPath: string; discrepanciesPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const reportFixedPath = resolve(outputDirectory, "report_fixed.csv");
  const discrepanciesPath = resolve(outputDirectory, "audit_discrepancies.json");

  await Promise.all([
    writeFile(reportFixedPath, serializeFixedReport(comparison.fixedRecords), "utf8"),
    writeFile(
      discrepanciesPath,
      `${JSON.stringify({ discrepancies: comparison.discrepancies }, null, 2)}\n`,
      "utf8",
    ),
  ]);

  return { reportFixedPath, discrepanciesPath };
}

export function describeReportComparison(comparison: ReportComparisonResult): string[] {
  const countByType = new Map<AuditFlag, number>();
  for (const discrepancy of comparison.discrepancies) {
    countByType.set(discrepancy.type, (countByType.get(discrepancy.type) ?? 0) + 1);
  }

  const distribution = AUDIT_FLAG_ORDER
    .filter((type) => countByType.has(type))
    .map((type) => `${type}: ${countByType.get(type)}`)
    .join(", ");
  return [
    `ожидаемых строк: ${comparison.expectedRecords.length}`,
    `строк в report_fixed.csv: ${comparison.fixedRecords.length}`,
    `детализированных расхождений: ${comparison.discrepancies.length}`,
    `распределение расхождений: ${distribution || "нет"}`,
  ];
}
