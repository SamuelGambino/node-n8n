import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  AnalysisDocument,
  AnalysisIssue,
  AnalysisQuestion,
  AuditFlag,
  ExpectedReportRecord,
  InputData,
  ProjectStateResult,
  ReportComparisonResult,
  ReportDiscrepancy,
  ReportRecord,
  ResolvedFlight,
  StatusResolutionResult,
} from "./types.js";

/**
 * analysis.json — контракт между детерминированным аудитом и ИИ в n8n.
 * В файл передаются факты, расчёты и открытые вопросы; модель не должна
 * самостоятельно искать ошибки в CSV, а только объясняет готовый анализ.
 */
export class AnalysisBuildError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnalysisBuildError";
  }
}

function reportKey(row: Pick<ExpectedReportRecord, "clientId" | "flightNo" | "flightStart">): string {
  return `${row.clientId}::${row.flightNo}::${row.flightStart}`;
}

function sourceKey(row: ReportRecord): string {
  return `${row.clientId}::${row.flightNo}::${row.flightStart}`;
}

function parseProjectIds(projectIds: string): string[] {
  return projectIds.split("|").map((projectId) => projectId.trim()).filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function summaryForRow(row: ExpectedReportRecord | ReportRecord | null): string | null {
  if (!row) {
    return null;
  }
  return [
    `client_id=${row.clientId}`,
    `project_ids=${row.projectIds}`,
    `flight_no=${row.flightNo}`,
    `flight_start=${row.flightStart}`,
    `flight_end=${row.flightEnd}`,
    `status=${row.status}`,
  ].join(", ");
}

function buildEvidence(
  data: InputData,
  projectStates: ProjectStateResult,
  statusResolution: StatusResolutionResult,
  expectedRecord: ExpectedReportRecord | null,
  oldReportRow: ReportRecord | null,
): Record<string, unknown> {
  const reference = expectedRecord ?? oldReportRow;
  if (!reference) {
    throw new AnalysisBuildError("Для расхождения невозможно определить контекст строки отчёта.");
  }

  const projectIds = parseProjectIds(reference.projectIds);
  const resolvedFlight = statusResolution.flights.find(
    (flight) =>
      flight.clientId === reference.clientId &&
      flight.flightNo === reference.flightNo &&
      flight.flightStart === reference.flightStart,
  );
  const start = resolvedFlight?.flightStart ?? reference.flightStart;
  const end = resolvedFlight?.flightEnd ?? reference.flightEnd;
  const involvedProjectIds = unique([
    ...projectIds,
    ...(resolvedFlight?.projectIds ?? []),
  ]);

  return {
    comparisonContext: {
      oldReportRow,
      expectedReportRow: expectedRecord,
      historicalReportCutoff: statusResolution.reportGeneratedAt,
    },
    reconstructedFlight: resolvedFlight ?? null,
    sourceRows: {
      works: data.works.filter(
        (work) =>
          involvedProjectIds.includes(work.projectId) &&
          work.month >= start &&
          work.month <= end,
      ),
      projects: data.projects.filter((project) => involvedProjectIds.includes(project.projectId)),
      projectsHistory: data.projectsHistory.filter(
        (history) =>
          involvedProjectIds.includes(history.projectId) ||
          involvedProjectIds.includes(history.newProjectId),
      ),
      serviceChanges: data.serviceChanges.filter((change) =>
        involvedProjectIds.includes(change.projectId),
      ),
      serviceTerms: data.serviceTerms.filter(
        (term) =>
          term.serviceType === expectedRecord?.serviceType ||
          term.serviceType === oldReportRow?.serviceType,
      ),
      projectStateConflicts: projectStates.issues.filter((issue) =>
        involvedProjectIds.includes(issue.projectId),
      ),
    },
  };
}

function issueTitle(categories: AuditFlag[], discrepancies: ReportDiscrepancy[]): string {
  if (categories.includes("DATA_CONFLICT") && categories.includes("NEEDS_REVIEW")) {
    return "Ошибка отчёта на фоне противоречивых и неоднозначных исходных данных";
  }
  if (categories.includes("DATA_CONFLICT")) {
    return "Противоречие между справочниками влияет на строку отчёта";
  }
  if (categories.includes("NEEDS_REVIEW")) {
    return "Строка отчёта требует бизнес-уточнения";
  }
  if (discrepancies.some((discrepancy) => discrepancy.field === "report_row")) {
    return "Структура исходного отчёта не соответствует восстановленным флайтам";
  }
  return "Значения исходного отчёта расходятся с восстановленным расчётом";
}

function severityFor(categories: AuditFlag[]): AnalysisIssue["severity"] {
  if (categories.includes("DATA_CONFLICT") || categories.includes("REPORT_ERROR")) {
    return "high";
  }
  return "medium";
}

function argumentsForIssue(
  categories: AuditFlag[],
  discrepancies: ReportDiscrepancy[],
  oldReportRow: ReportRecord | null,
  expectedRecord: ExpectedReportRecord | null,
): AnalysisIssue["arguments"] {
  const ruleApplied = [
    "Expected report строится из клиентских цепочек, исторических атрибутов, service_terms.csv, помесячных works.csv и decision tree статусов.",
    "Для проверки старого отчёта учитывается только активность не позднее его исходного report_generated_at.",
  ];
  if (categories.includes("DATA_CONFLICT")) {
    ruleApplied.push(
      "При расхождении projects.term_months и service_terms.csv срок из service_terms.csv применяется для расчёта, а конфликт не скрывается.",
    );
  }
  if (categories.includes("NEEDS_REVIEW")) {
    ruleApplied.push(
      "Если данные не доказывают единственный бизнес-вывод, программа устанавливает NEEDS_REVIEW и формирует вопрос, а не делает предположение.",
    );
  }

  const facts = [
    `Исходная строка: ${summaryForRow(oldReportRow) ?? "отсутствует"}.`,
    `Восстановленная строка: ${summaryForRow(expectedRecord) ?? "отсутствует"}.`,
    ...discrepancies.map(
      (discrepancy) =>
        `Поле «${discrepancy.field}»: ожидалось «${discrepancy.expectedValue ?? "пусто"}», ` +
        `в старом отчёте «${discrepancy.actualValue ?? "пусто"}». ${discrepancy.evidence}`,
    ),
  ];

  return {
    ruleApplied,
    facts,
    conclusion: categories.includes("NEEDS_REVIEW")
      ? "Строка исправлена детерминированными фактами, но окончательная бизнес-интерпретация помечена для уточнения."
      : "Строка исправлена на значение, непосредственно полученное из правил и исходных CSV.",
  };
}

function questionFromIssue(issue: AnalysisIssue): AnalysisQuestion[] {
  const reconstructedFlight = issue.evidence.reconstructedFlight as ResolvedFlight | null;
  const flightIssueTypes = new Set(reconstructedFlight?.issues.map((item) => item.type) ?? []);
  const discrepancyFields = new Set(issue.fieldDifferences.map((item) => item.field));
  const questions: AnalysisQuestion[] = [];

  const context = {
    target: issue.target,
    title: issue.title,
    oldReportRow: issue.oldReportRow,
    expectedReportRow: issue.expectedReportRow,
    arguments: issue.arguments,
    evidence: issue.evidence,
  };

  if (issue.categories.includes("DATA_CONFLICT")) {
    questions.push({
      id: `${issue.id}-Q1`,
      priority: "high",
      question:
        "Какой источник срока услуги является нормативным при расхождении projects.term_months и service_terms.csv?",
      reason: "Для затронутого флайта два справочника задают разные длины обслуживания.",
      requiredAnswer:
        "Нужно подтвердить приоритет источника и, при необходимости, исправить справочник или правило расчёта.",
      decisionImpact:
        "Ответ может изменить границы флайта, статус и показатели удержания по затронутому клиенту.",
      automaticHandling:
        "Сейчас программа использует service_terms.csv как источник срока и оставляет DATA_CONFLICT в audit_flags.",
      context,
    });
  }

  if (!issue.categories.includes("NEEDS_REVIEW")) {
    return questions;
  }

  if (flightIssueTypes.has("SERVICE_CHANGE_IN_FLIGHT")) {
    questions.push({
      id: `${issue.id}-Q2`,
      priority: "high",
      question:
        "Следует ли при смене услуги внутри уже начатого флайта закрывать текущий флайт в месяц изменения или сохранять первоначальные границы?",
      reason: "Изменение услуги влияет на term_months, но правила не задают однозначный пересчёт уже начатого периода.",
      requiredAnswer: "Нужно бизнес-правило для смены service_type внутри активного флайта.",
      decisionImpact: "Ответ определяет границы флайта, его статус и последующие точки продления.",
      automaticHandling:
        "Программа не пересчитывает прошлые месяцы задним числом и ставит статус NEEDS_REVIEW.",
      context,
    });
    return questions;
  }

  if (flightIssueTypes.has("POST_STOP_CONTINUATION")) {
    questions.push({
      id: `${issue.id}-Q2`,
      priority: "high",
      question:
        "Как трактовать новую активность сразу после события STOP: как восстановление прежнего клиента, новый договор или отдельную услугу?",
      reason: "STOP завершает текущий флайт досрочно, но исходные данные фиксируют последующую активность без договора или пояснения.",
      requiredAnswer: "Нужно правило классификации продолжения обслуживания после STOP.",
      decisionImpact: "Ответ определяет номер нового флайта, статус ухода и корректность метрик оттока.",
      automaticHandling:
        "STOP получает статус «отвал», а следующий период сохраняется в отчёте с NEEDS_REVIEW.",
      context,
    });
    return questions;
  }

  if (discrepancyFields.has("DELAYED_RENEWAL")) {
    questions.push({
      id: `${issue.id}-Q2`,
      priority: "medium",
      question:
        "Считать ли возобновление обслуживания после нескольких месяцев без отгрузок поздним продлением, новым контрактом или отдельной услугой?",
      reason: "В данных есть следующий флайт, но он начался после календарного разрыва.",
      requiredAnswer: "Нужно правило классификации отложенного продления и определения flight_no.",
      decisionImpact: "Ответ влияет на статус предыдущего флайта и расчёт пролонгации/оттока.",
      automaticHandling:
        "Программа создаёт новый флайт по факту активности, а предыдущему присваивает NEEDS_REVIEW.",
      context,
    });
    return questions;
  }

  if (discrepancyFields.has("IRREGULAR_ACTIVITY")) {
    questions.push({
      id: `${issue.id}-Q2`,
      priority: "medium",
      question:
        "Чем объясняются пропуски ежемесячных отгрузок внутри подтверждённого флайта: паузой, ошибкой выгрузки или особым графиком услуги?",
      reason: "Внутри границ флайта отсутствуют месяцы с amount > 0, а исходные данные не содержат причины.",
      requiredAnswer: "Нужны подтверждение факта оказания услуги и правило обработки таких пропусков.",
      decisionImpact: "Ответ может изменить статус флайта с NEEDS_REVIEW на конкретный бизнес-статус.",
      automaticHandling:
        "Программа не считает пропуск автоматическим уходом и помечает строку NEEDS_REVIEW.",
      context,
    });
    return questions;
  }

  questions.push({
    id: `${issue.id}-Q2`,
    priority: "medium",
    question: "Какое бизнес-правило следует применить к этому неоднозначному флайту?",
    reason: "Данные фиксируют ситуацию, для которой правила расчёта не дают единственной трактовки.",
    requiredAnswer: "Нужен ожидаемый статус и правило его определения.",
    decisionImpact: "Ответ позволит заменить NEEDS_REVIEW на окончательный статус.",
    automaticHandling: "Программа сохранила расчётные факты и не делает неподтверждённого вывода.",
    context,
  });
  return questions;
}

function sourceDataSummary(data: InputData, statusResolution: StatusResolutionResult): Record<string, unknown> {
  const workMonths = data.works.map((work) => work.month).sort();
  return {
    files: {
      "works.csv": {
        records: data.works.length,
        monthRange: { from: workMonths[0] ?? null, to: workMonths.at(-1) ?? null },
        positiveAmountRecords: data.works.filter((work) => work.amount > 0).length,
        eventLabels: unique(data.works.flatMap((work) => work.label ? [work.label] : [])).sort(),
      },
      "projects.csv": { records: data.projects.length },
      "projects_history.csv": { records: data.projectsHistory.length },
      "service_changes.csv": { records: data.serviceChanges.length },
      "service_terms.csv": { records: data.serviceTerms.length },
      "report.csv": {
        records: data.report.length,
        historicalReportCutoff: statusResolution.reportGeneratedAt,
        uniqueClientIds: unique(data.report.map((row) => row.clientId)).sort(),
      },
    },
    reconstructed: {
      uniqueClients: unique(statusResolution.flights.map((flight) => flight.clientId)).sort(),
      flightsInHistoricalCutoff: statusResolution.flights.length,
    },
  };
}

/** Строит полный фактический контекст для последующей текстовой интерпретации ИИ. */
export function buildAnalysisDocument(
  data: InputData,
  projectStates: ProjectStateResult,
  statusResolution: StatusResolutionResult,
  comparison: ReportComparisonResult,
  generatedAt: AnalysisDocument["metadata"]["generatedAt"],
): AnalysisDocument {
  const expectedByKey = new Map(comparison.expectedRecords.map((row) => [reportKey(row), row]));
  const sourceByKey = new Map(data.report.map((row) => [sourceKey(row), row]));
  const discrepanciesByKey = new Map<string, ReportDiscrepancy[]>();

  for (const discrepancy of comparison.discrepancies) {
    const key = reportKey(discrepancy);
    const group = discrepanciesByKey.get(key) ?? [];
    group.push(discrepancy);
    discrepanciesByKey.set(key, group);
  }

  const Issues: AnalysisIssue[] = [];
  const Questions: AnalysisQuestion[] = [];
  let issueNumber = 1;

  for (const [key, discrepancies] of [...discrepanciesByKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const expectedRecord = expectedByKey.get(key) ?? null;
    const oldReportRow = sourceByKey.get(key) ?? null;
    const reference = expectedRecord ?? oldReportRow;
    if (!reference) {
      throw new AnalysisBuildError(`Не найден контекст для группы расхождений «${key}».`);
    }

    const categories = unique(discrepancies.map((discrepancy) => discrepancy.type));
    const issue: AnalysisIssue = {
      id: `ISSUE-${String(issueNumber).padStart(3, "0")}`,
      categories,
      severity: severityFor(categories),
      title: issueTitle(categories, discrepancies),
      target: {
        clientId: reference.clientId,
        flightNo: reference.flightNo,
        flightStart: reference.flightStart,
        comparisonKey: key,
      },
      oldReportRow,
      expectedReportRow: expectedRecord,
      fieldDifferences: discrepancies,
      arguments: argumentsForIssue(categories, discrepancies, oldReportRow, expectedRecord),
      evidence: buildEvidence(data, projectStates, statusResolution, expectedRecord, oldReportRow),
    };
    Issues.push(issue);
    Questions.push(...questionFromIssue(issue));
    issueNumber += 1;
  }

  const statusDistribution = Object.fromEntries(
    statusResolution.flights.reduce<Map<string, number>>((counts, flight) => {
      counts.set(flight.status, (counts.get(flight.status) ?? 0) + 1);
      return counts;
    }, new Map()),
  );
  const discrepancyDistribution = Object.fromEntries(
    comparison.discrepancies.reduce<Map<string, number>>((counts, discrepancy) => {
      counts.set(discrepancy.type, (counts.get(discrepancy.type) ?? 0) + 1);
      return counts;
    }, new Map()),
  );

  return {
    metadata: {
      schemaVersion: "1.0",
      generatedAt,
      historicalReportCutoff: statusResolution.reportGeneratedAt,
      purpose:
        "Передать в n8n готовые факты аудита. ИИ должен объяснять эти факты человеческим языком, а не искать ошибки самостоятельно.",
    },
    sourceDataSummary: sourceDataSummary(data, statusResolution),
    methodology: [
      "Исходные CSV нормализуются; project_id обрабатываются как строки, а месяцы — как YYYY-MM-01.",
      "projects_history.csv объединяет старые и новые project_id в клиентские цепочки.",
      "Исторические project_name и service_type восстанавливаются на каждый месяц; срок берётся из service_terms.csv.",
      "Флайты строятся по непрерывной активности, STOP сокращает флайт, а пропуски и сложные смены помечаются без предположений.",
      "Статусы рассчитаны на историческую дату среза исходного report.csv; активность после неё передаётся только как дополнительный факт.",
      "В report_fixed.csv дата формирования отражает текущую дату запуска, а не исторический срез расчёта статуса.",
    ],
    Issues,
    Questions,
    statistics: {
      issueCount: Issues.length,
      questionCount: Questions.length,
      discrepancyDistribution,
      statusDistribution,
      uniqueReconstructedClients: unique(statusResolution.flights.map((flight) => flight.clientId)).length,
      uniqueClientsInOldReport: unique(data.report.map((row) => row.clientId)).length,
    },
  };
}

export async function writeAnalysisDocument(
  document: AnalysisDocument,
  outputDirectory: string,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, "analysis.json");
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return outputPath;
}
