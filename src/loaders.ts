import { resolve } from "node:path";

import { CsvParseError, readSemicolonCsv, type CsvRow } from "./csv.js";
import type {
  InputData,
  Month,
  ProjectHistoryRecord,
  ProjectRecord,
  ReportRecord,
  ServiceChangeRecord,
  ServiceTermRecord,
  WorkRecord,
} from "./types.js";

const FILES = {
  works: "works.csv",
  projects: "projects.csv",
  projectsHistory: "projects_history.csv",
  serviceChanges: "service_changes.csv",
  serviceTerms: "service_terms.csv",
  report: "report.csv",
} as const;

export class DataValidationError extends Error {
  public constructor(
    message: string,
    public readonly source: string,
    public readonly row: number,
  ) {
    super(message);
    this.name = "DataValidationError";
  }
}

function rowSource(filePath: string, rowIndex: number): string {
  return `${filePath}, строка ${rowIndex + 2}`;
}

function requireValue(row: CsvRow, key: string, filePath: string, rowIndex: number): string {
  const value = row[key]?.trim();
  if (!value) {
    throw new DataValidationError(
      `Поле «${key}» обязательно для заполнения.`,
      filePath,
      rowIndex + 2,
    );
  }
  return value;
}

function optionalValue(row: CsvRow, key: string): string | null {
  const value = row[key]?.trim();
  return value ? value : null;
}

function parsePositiveInteger(
  value: string,
  field: string,
  filePath: string,
  rowIndex: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DataValidationError(
      `Поле «${field}» должно быть положительным целым числом; получено «${value}».`,
      filePath,
      rowIndex + 2,
    );
  }
  return parsed;
}

function parseAmount(value: string, filePath: string, rowIndex: number): number {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    throw new DataValidationError(
      `Поле «amount» должно быть числом; получено «${value}».`,
      filePath,
      rowIndex + 2,
    );
  }
  return parsed;
}

function parseMonth(value: string, field: string, filePath: string, rowIndex: number): Month {
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)) {
    throw new DataValidationError(
      `Поле «${field}» должно иметь формат YYYY-MM-01; получено «${value}».`,
      filePath,
      rowIndex + 2,
    );
  }
  return value as Month;
}

function parseOptionalMonth(
  value: string | null,
  field: string,
  filePath: string,
  rowIndex: number,
): Month | null {
  return value === null ? null : parseMonth(value, field, filePath, rowIndex);
}

function normalizeWorks(rows: CsvRow[], filePath: string): WorkRecord[] {
  return rows.map((row, index) => ({
    projectId: requireValue(row, "project_id", filePath, index),
    month: parseMonth(requireValue(row, "month", filePath, index), "month", filePath, index),
    amount: parseAmount(requireValue(row, "amount", filePath, index), filePath, index),
    label: optionalValue(row, "label"),
    part: optionalValue(row, "part"),
  }));
}

function normalizeProjects(rows: CsvRow[], filePath: string): ProjectRecord[] {
  return rows.map((row, index) => ({
    projectId: requireValue(row, "project_id", filePath, index),
    projectName: requireValue(row, "project_name", filePath, index),
    serviceType: requireValue(row, "service_type", filePath, index),
    projectType: requireValue(row, "project_type", filePath, index),
    termMonths: parsePositiveInteger(
      requireValue(row, "term_months", filePath, index),
      "term_months",
      filePath,
      index,
    ),
  }));
}

function normalizeProjectsHistory(rows: CsvRow[], filePath: string): ProjectHistoryRecord[] {
  return rows.map((row, index) => ({
    projectId: requireValue(row, "project_id", filePath, index),
    projectName: requireValue(row, "project_name", filePath, index),
    newProjectId: requireValue(row, "new_project_id", filePath, index),
    newProjectName: requireValue(row, "new_project_name", filePath, index),
    month: parseMonth(requireValue(row, "month", filePath, index), "month", filePath, index),
  }));
}

function normalizeServiceChanges(rows: CsvRow[], filePath: string): ServiceChangeRecord[] {
  return rows.map((row, index) => ({
    projectId: requireValue(row, "project_id", filePath, index),
    month: parseMonth(requireValue(row, "month", filePath, index), "month", filePath, index),
    oldServiceType: requireValue(row, "old_service_type", filePath, index),
    newServiceType: requireValue(row, "new_service_type", filePath, index),
  }));
}

function normalizeServiceTerms(rows: CsvRow[], filePath: string): ServiceTermRecord[] {
  return rows.map((row, index) => ({
    serviceType: requireValue(row, "service_type", filePath, index),
    termMonths: parsePositiveInteger(
      requireValue(row, "term_months", filePath, index),
      "term_months",
      filePath,
      index,
    ),
  }));
}

function normalizeReport(rows: CsvRow[], filePath: string): ReportRecord[] {
  return rows.map((row, index) => ({
    clientId: requireValue(row, "client_id", filePath, index),
    projectIds: requireValue(row, "project_ids", filePath, index),
    projectName: requireValue(row, "project_name", filePath, index),
    serviceType: requireValue(row, "service_type", filePath, index),
    termMonths: parsePositiveInteger(
      requireValue(row, "term_months", filePath, index),
      "term_months",
      filePath,
      index,
    ),
    flightNo: parsePositiveInteger(
      requireValue(row, "flight_no", filePath, index),
      "flight_no",
      filePath,
      index,
    ),
    flightStart: parseMonth(
      requireValue(row, "flight_start", filePath, index),
      "flight_start",
      filePath,
      index,
    ),
    flightEnd: parseMonth(
      requireValue(row, "flight_end", filePath, index),
      "flight_end",
      filePath,
      index,
    ),
    lastActiveMonth: parseOptionalMonth(optionalValue(row, "last_active_month"), "last_active_month", filePath, index),
    status: requireValue(row, "status", filePath, index),
    reportGeneratedAt: parseMonth(
      requireValue(row, "report_generated_at", filePath, index),
      "report_generated_at",
      filePath,
      index,
    ),
  }));
}

async function loadRows(
  dataDirectory: string,
  fileName: string,
  headers: readonly string[],
): Promise<{ rows: CsvRow[]; filePath: string }> {
  const filePath = resolve(dataDirectory, fileName);
  try {
    return { rows: await readSemicolonCsv(filePath, headers), filePath };
  } catch (error) {
    if (error instanceof CsvParseError) {
      throw error;
    }
    throw new Error(`Не удалось загрузить ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadInputData(dataDirectory: string): Promise<InputData> {
  const [works, projects, projectsHistory, serviceChanges, serviceTerms, report] = await Promise.all([
    loadRows(dataDirectory, FILES.works, ["project_id", "month", "amount", "label", "part"]),
    loadRows(dataDirectory, FILES.projects, ["project_id", "project_name", "service_type", "project_type", "term_months"]),
    loadRows(dataDirectory, FILES.projectsHistory, ["project_id", "project_name", "new_project_id", "new_project_name", "month"]),
    loadRows(dataDirectory, FILES.serviceChanges, ["project_id", "month", "old_service_type", "new_service_type"]),
    loadRows(dataDirectory, FILES.serviceTerms, ["service_type", "term_months"]),
    loadRows(dataDirectory, FILES.report, [
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
    ]),
  ]);

  return {
    works: normalizeWorks(works.rows, works.filePath),
    projects: normalizeProjects(projects.rows, projects.filePath),
    projectsHistory: normalizeProjectsHistory(projectsHistory.rows, projectsHistory.filePath),
    serviceChanges: normalizeServiceChanges(serviceChanges.rows, serviceChanges.filePath),
    serviceTerms: normalizeServiceTerms(serviceTerms.rows, serviceTerms.filePath),
    report: normalizeReport(report.rows, report.filePath),
  };
}

export function describeInputData(data: InputData): string[] {
  return [
    `works.csv: ${data.works.length} строк`,
    `projects.csv: ${data.projects.length} строк`,
    `projects_history.csv: ${data.projectsHistory.length} строк`,
    `service_changes.csv: ${data.serviceChanges.length} строк`,
    `service_terms.csv: ${data.serviceTerms.length} строк`,
    `report.csv: ${data.report.length} строк`,
  ];
}
