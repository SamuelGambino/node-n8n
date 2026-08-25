import { addMonths, isMonthInRange } from "./month.js";
import type {
  ClientHistoryResult,
  Flight,
  FlightBuildResult,
  FlightStatus,
  InputData,
  Month,
  ResolvedFlight,
  StatusIssue,
  StatusResolutionResult,
} from "./types.js";

export interface StatusResolutionOptions {
  recentEndGraceMonths?: number;
}

export class StatusResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StatusResolutionError";
  }
}

function resolveReportGeneratedAt(data: InputData): Month {
  const reportDates = [...new Set(data.report.map((row) => row.reportGeneratedAt))];
  if (reportDates.length === 0) {
    throw new StatusResolutionError(
      "Невозможно рассчитать статусы: report.csv не содержит report_generated_at.",
    );
  }
  if (reportDates.length > 1) {
    throw new StatusResolutionError(
      `report.csv содержит несколько report_generated_at: ${reportDates.join(", ")}. Требуется единая дата среза.`,
    );
  }

  const reportGeneratedAt = reportDates[0];
  if (!reportGeneratedAt) {
    throw new StatusResolutionError("Невозможно определить report_generated_at.");
  }
  return reportGeneratedAt;
}

function hasStop(flight: Flight): boolean {
  return flight.stopMonth !== null;
}

function isFinalProjectType(flight: Flight): boolean {
  const normalizedProjectType = flight.projectType.trim().toLocaleLowerCase("ru-RU");
  return normalizedProjectType === "разовый" || normalizedProjectType === "сезонный";
}

function clientWorksInRange(
  clientId: string,
  start: Month,
  end: Month,
  data: InputData,
  histories: ClientHistoryResult,
): Month[] {
  return [...new Set(
    data.works
      .filter((work) => {
        const history = histories.historyByProjectId.get(work.projectId);
        return (
          history?.clientId === clientId &&
          work.amount > 0 &&
          isMonthInRange(work.month, start, end)
        );
      })
      .map((work) => work.month),
  )].sort();
}

function lastActiveMonthAtReportDate(
  flight: Flight,
  reportGeneratedAt: Month,
  data: InputData,
  histories: ClientHistoryResult,
): Month | null {
  const observedEnd = flight.flightEnd < reportGeneratedAt ? flight.flightEnd : reportGeneratedAt;
  return clientWorksInRange(flight.clientId, flight.flightStart, observedEnd, data, histories).at(-1) ?? null;
}

function missingActivityMonths(
  flight: Flight,
  reportGeneratedAt: Month,
  data: InputData,
  histories: ClientHistoryResult,
): Month[] {
  const observedEnd = flight.flightEnd < reportGeneratedAt ? flight.flightEnd : reportGeneratedAt;
  const activeMonths = new Set(
    clientWorksInRange(flight.clientId, flight.flightStart, observedEnd, data, histories),
  );
  const missingMonths: Month[] = [];

  for (let month = flight.flightStart; month <= observedEnd; month = addMonths(month, 1)) {
    if (!activeMonths.has(month)) {
      missingMonths.push(month);
    }
  }

  return missingMonths;
}

function activityAfterReportDate(
  flight: Flight,
  reportGeneratedAt: Month,
  data: InputData,
  histories: ClientHistoryResult,
): Month[] {
  return [...new Set(
    data.works
      .filter((work) => {
        const history = histories.historyByProjectId.get(work.projectId);
        return (
          history?.clientId === flight.clientId &&
          work.amount > 0 &&
          work.month > reportGeneratedAt &&
          isMonthInRange(work.month, flight.flightStart, flight.flightEnd)
        );
      })
      .map((work) => work.month),
  )].sort();
}

function nextEligibleFlight(
  currentFlight: Flight,
  flights: Flight[],
  reportGeneratedAt: Month,
): Flight | null {
  return flights.find(
    (candidate) =>
      candidate.clientId === currentFlight.clientId &&
      candidate.flightNo > currentFlight.flightNo &&
      candidate.flightStart <= reportGeneratedAt,
  ) ?? null;
}

function createStatusIssue(
  flight: Flight,
  type: StatusIssue["type"],
  month: Month | null,
  message: string,
): StatusIssue {
  return {
    type,
    clientId: flight.clientId,
    projectIds: flight.projectIds,
    flightNo: flight.flightNo,
    month,
    message,
  };
}

function resolveStatus(
  flight: Flight,
  allFlights: Flight[],
  reportGeneratedAt: Month,
  recentEndGraceMonths: number,
  data: InputData,
  histories: ClientHistoryResult,
): { status: FlightStatus; comment: string; issues: StatusIssue[]; lastActiveMonth: Month | null } {
  const statusIssues: StatusIssue[] = [];
  const lastActiveMonth = lastActiveMonthAtReportDate(flight, reportGeneratedAt, data, histories);
  const laterActivity = activityAfterReportDate(flight, reportGeneratedAt, data, histories);
  if (laterActivity.length > 0) {
    statusIssues.push(
      createStatusIssue(
        flight,
        "ACTIVITY_AFTER_REPORT_DATE",
        laterActivity[0] ?? null,
        `В актуальных works.csv есть активность после даты построения отчёта (${laterActivity.join(", ")}); она не использована для исторического статуса.`,
      ),
    );
  }

  if (isFinalProjectType(flight)) {
    return {
      status: "завершился (разовые работы)",
      comment: `Проект имеет тип «${flight.projectType}», поэтому флайт завершён без оценки продления.`,
      issues: statusIssues,
      lastActiveMonth,
    };
  }

  if (hasStop(flight)) {
    return {
      status: "отвал",
      comment: `Флайт досрочно завершён событием STOP в ${flight.stopMonth}. Причина события в исходных данных не раскрыта.`,
      issues: statusIssues,
      lastActiveMonth,
    };
  }

  const blockingFlightIssue = flight.issues.find(
    (issue) =>
      issue.type === "POST_STOP_CONTINUATION" ||
      issue.type === "SERVICE_CHANGE_IN_FLIGHT",
  );
  if (blockingFlightIssue) {
    return {
      status: "NEEDS_REVIEW",
      comment: blockingFlightIssue.message,
      issues: statusIssues,
      lastActiveMonth,
    };
  }

  const gaps = missingActivityMonths(flight, reportGeneratedAt, data, histories);
  if (gaps.length > 0) {
    const issue = createStatusIssue(
      flight,
      "IRREGULAR_ACTIVITY",
      gaps[0] ?? null,
      `В подтверждённом периоде флайта отсутствует активность в месяцах: ${gaps.join(", ")}. ` +
        "Данных недостаточно, чтобы автоматически трактовать это как уход или обычное непродление.",
    );
    return {
      status: "NEEDS_REVIEW",
      comment: issue.message,
      issues: [...statusIssues, issue],
      lastActiveMonth,
    };
  }

  const nextFlight = nextEligibleFlight(flight, allFlights, reportGeneratedAt);
  if (nextFlight) {
    const expectedNextMonth = addMonths(flight.flightEnd, 1);
    if (nextFlight.flightStart === expectedNextMonth) {
      return {
        status: "пролонгировано",
        comment: `Следующий флайт начался непрерывно в ${nextFlight.flightStart}.`,
        issues: statusIssues,
        lastActiveMonth,
      };
    }

    const issue = createStatusIssue(
      flight,
      "DELAYED_RENEWAL",
      nextFlight.flightStart,
      `Следующий флайт начался в ${nextFlight.flightStart} после перерыва; ожидалось продолжение с ${expectedNextMonth}. ` +
        "Нужно уточнить, считать ли это поздним продлением, новым контрактом или отдельной услугой.",
    );
    return {
      status: "NEEDS_REVIEW",
      comment: issue.message,
      issues: [...statusIssues, issue],
      lastActiveMonth,
    };
  }

  if (flight.flightEnd > reportGeneratedAt) {
    return {
      status: "неизвестно",
      comment: `Флайт ещё не завершился на дату построения отчёта ${reportGeneratedAt}.`,
      issues: statusIssues,
      lastActiveMonth,
    };
  }

  if (addMonths(flight.flightEnd, recentEndGraceMonths) >= reportGeneratedAt) {
    return {
      status: "неизвестно",
      comment:
        `После окончания флайта в ${flight.flightEnd} прошло недостаточно времени до даты отчёта ${reportGeneratedAt}, ` +
        "чтобы надёжно определить продление.",
      issues: statusIssues,
      lastActiveMonth,
    };
  }

  return {
    status: "непролонгировано",
    comment:
      `После окончания флайта в ${flight.flightEnd} до даты отчёта ${reportGeneratedAt} не найден непрерывный следующий флайт.`,
    issues: statusIssues,
    lastActiveMonth,
  };
}

export function resolveFlightStatuses(
  data: InputData,
  histories: ClientHistoryResult,
  flightBuild: FlightBuildResult,
  options: StatusResolutionOptions = {},
): StatusResolutionResult {
  const reportGeneratedAt = resolveReportGeneratedAt(data);
  const recentEndGraceMonths = options.recentEndGraceMonths ?? 1;
  if (!Number.isInteger(recentEndGraceMonths) || recentEndGraceMonths < 0) {
    throw new StatusResolutionError("recentEndGraceMonths должен быть неотрицательным целым числом.");
  }

  const eligibleFlights = flightBuild.flights.filter(
    (flight) => flight.flightStart <= reportGeneratedAt,
  );
  const resolvedFlights: ResolvedFlight[] = [];
  const issues: StatusIssue[] = [];

  for (const flight of eligibleFlights) {
    const resolution = resolveStatus(
      flight,
      eligibleFlights,
      reportGeneratedAt,
      recentEndGraceMonths,
      data,
      histories,
    );
    const resolvedFlight: ResolvedFlight = {
      ...flight,
      lastActiveMonth: resolution.lastActiveMonth,
      status: resolution.status,
      statusComment: resolution.comment,
      statusIssues: resolution.issues,
    };
    resolvedFlights.push(resolvedFlight);
    issues.push(...resolution.issues);
  }

  return { reportGeneratedAt, flights: resolvedFlights, issues };
}

export function describeStatusResolution(result: StatusResolutionResult): string[] {
  const countByStatus = new Map<FlightStatus, number>();
  for (const flight of result.flights) {
    countByStatus.set(flight.status, (countByStatus.get(flight.status) ?? 0) + 1);
  }

  const statusSummary = [...countByStatus.entries()]
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
  return [
    `дата среза отчёта: ${result.reportGeneratedAt}`,
    `флайтов в историческом срезе: ${result.flights.length}`,
    `распределение статусов: ${statusSummary}`,
    `замечаний по статусам: ${result.issues.length}`,
  ];
}
