import { isMonthInRange, isNextMonth, addMonths } from "./month.js";
import { projectStateKey } from "./temporal-state.js";
import type {
  ClientHistoryResult,
  Flight,
  FlightBuildResult,
  FlightIssue,
  InputData,
  InputIndexes,
  Month,
  ProjectStateResult,
  ServicePeriod,
} from "./types.js";

interface ClientMonthActivity {
  clientId: string;
  month: Month;
  projectIds: Set<string>;
  hasPositiveAmount: boolean;
  hasStop: boolean;
}

export class FlightBuildError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FlightBuildError";
  }
}

function normalizeLabel(label: string | null): string | null {
  return label?.trim().toLocaleLowerCase("ru-RU") || null;
}

function isStopLabel(label: string | null): boolean {
  const normalized = normalizeLabel(label);
  return normalized === "стоп" || normalized === "stop";
}

function orderedProjectIds(projectIds: Set<string>, clientProjectIds: string[]): string[] {
  return clientProjectIds.filter((projectId) => projectIds.has(projectId));
}

function getClientMonthActivities(
  data: InputData,
  histories: ClientHistoryResult,
): Map<string, ClientMonthActivity[]> {
  const activitiesByClientAndMonth = new Map<string, ClientMonthActivity>();

  for (const work of data.works) {
    const history = histories.historyByProjectId.get(work.projectId);
    if (!history) {
      throw new FlightBuildError(
        `Для project_id «${work.projectId}» отсутствует клиентская цепочка.`,
      );
    }

    const key = `${history.clientId}::${work.month}`;
    const activity = activitiesByClientAndMonth.get(key) ?? {
      clientId: history.clientId,
      month: work.month,
      projectIds: new Set<string>(),
      hasPositiveAmount: false,
      hasStop: false,
    };

    activity.projectIds.add(work.projectId);
    activity.hasPositiveAmount ||= work.amount > 0;
    activity.hasStop ||= isStopLabel(work.label);
    activitiesByClientAndMonth.set(key, activity);
  }

  const result = new Map<string, ClientMonthActivity[]>();
  for (const activity of activitiesByClientAndMonth.values()) {
    const clientActivities = result.get(activity.clientId) ?? [];
    clientActivities.push(activity);
    result.set(activity.clientId, clientActivities);
  }

  for (const clientActivities of result.values()) {
    clientActivities.sort((left, right) => left.month.localeCompare(right.month));
  }

  return result;
}

function finalizePeriod(
  clientId: string,
  activities: ClientMonthActivity[],
  clientProjectIds: string[],
  initialIssues: FlightIssue[] = [],
): ServicePeriod {
  const firstActivity = activities[0];
  const lastActivity = activities.at(-1);
  if (!firstActivity || !lastActivity) {
    throw new FlightBuildError(`Невозможно сформировать пустой период клиента «${clientId}».`);
  }

  const projectIds = new Set(activities.flatMap((activity) => [...activity.projectIds]));
  const stopActivity = activities.find((activity) => activity.hasStop);
  const issues = [...initialIssues];

  if (stopActivity) {
    issues.push({
      type: "STOP_EVENT",
      clientId,
      projectIds: orderedProjectIds(stopActivity.projectIds, clientProjectIds),
      month: stopActivity.month,
      message: `Зафиксировано событие STOP в ${stopActivity.month}; флайт, содержащий этот месяц, должен завершиться досрочно.`,
    });

    const firstActivityAfterStop = activities.find((activity) => activity.month > stopActivity.month);
    if (firstActivityAfterStop) {
      issues.push({
        type: "POST_STOP_CONTINUATION",
        clientId,
        projectIds: orderedProjectIds(firstActivityAfterStop.projectIds, clientProjectIds),
        month: firstActivityAfterStop.month,
        message:
          `После STOP в ${stopActivity.month} найдена новая активность с ${firstActivityAfterStop.month}. ` +
          "Продолжение после досрочного завершения требует отдельной бизнес-трактовки.",
      });
    }
  }

  return {
    clientId,
    startMonth: firstActivity.month,
    endMonth: lastActivity.month,
    projectIds: orderedProjectIds(projectIds, clientProjectIds),
    activeMonths: activities.map((activity) => activity.month),
    stopMonth: stopActivity?.month ?? null,
    issues,
  };
}

export function buildServicePeriods(
  data: InputData,
  histories: ClientHistoryResult,
): ServicePeriod[] {
  const activitiesByClient = getClientMonthActivities(data, histories);
  const periods: ServicePeriod[] = [];

  for (const history of histories.histories) {
    const activities = activitiesByClient.get(history.clientId) ?? [];
    if (activities.length === 0) {
      continue;
    }

    let currentPeriodActivities: ClientMonthActivity[] = [];
    let pendingIssues: FlightIssue[] = [];

    for (const activity of activities) {
      const previousActivity = currentPeriodActivities.at(-1);
      if (!previousActivity || isNextMonth(previousActivity.month, activity.month)) {
        currentPeriodActivities.push(activity);
        continue;
      }

      periods.push(
        finalizePeriod(history.clientId, currentPeriodActivities, history.projectIds, pendingIssues),
      );
      pendingIssues = [{
        type: "ACTIVITY_GAP",
        clientId: history.clientId,
        projectIds: orderedProjectIds(activity.projectIds, history.projectIds),
        month: activity.month,
        message:
          `После активности в ${previousActivity.month} отсутствуют помесячные отгрузки до ${activity.month}. ` +
          "Новый период начинается после разрыва и требует проверки причины паузы.",
      }];
      currentPeriodActivities = [activity];
    }

    periods.push(
      finalizePeriod(history.clientId, currentPeriodActivities, history.projectIds, pendingIssues),
    );
  }

  return periods.sort((left, right) => {
    const byClient = left.clientId.localeCompare(right.clientId);
    return byClient === 0 ? left.startMonth.localeCompare(right.startMonth) : byClient;
  });
}

function projectIdsInFlight(
  clientId: string,
  start: Month,
  end: Month,
  data: InputData,
  histories: ClientHistoryResult,
): string[] {
  const history = histories.histories.find((item) => item.clientId === clientId);
  if (!history) {
    throw new FlightBuildError(`Не найдена цепочка client_id «${clientId}».`);
  }

  const usedProjectIds = new Set(
    data.works
      .filter((work) => {
        const workHistory = histories.historyByProjectId.get(work.projectId);
        return workHistory?.clientId === clientId && isMonthInRange(work.month, start, end);
      })
      .map((work) => work.projectId),
  );

  return orderedProjectIds(usedProjectIds, history.projectIds);
}

function appendStateIssues(
  flight: Omit<Flight, "issues">,
  projectStates: ProjectStateResult,
): FlightIssue[] {
  const issues: FlightIssue[] = [];
  const serviceTypeByMonth = new Map<Month, string>();

  for (const projectId of flight.projectIds) {
    for (const [key, state] of projectStates.stateByProjectAndMonth) {
      if (
        key.startsWith(`${projectId}::`) &&
        isMonthInRange(state.month, flight.flightStart, flight.flightEnd)
      ) {
        serviceTypeByMonth.set(state.month, state.serviceType);
      }
    }
  }

  const distinctServiceTypes = new Set(serviceTypeByMonth.values());
  if (distinctServiceTypes.size > 1) {
    const changedMonth = [...serviceTypeByMonth.entries()].find(
      ([, serviceType]) => serviceType !== flight.serviceType,
    )?.[0];
    if (changedMonth) {
      issues.push({
        type: "SERVICE_CHANGE_IN_FLIGHT",
        clientId: flight.clientId,
        projectIds: flight.projectIds,
        month: changedMonth,
        message:
          `Внутри флайта ${flight.flightStart}—${flight.flightEnd} услуга изменилась ` +
          `с «${flight.serviceType}» на «${serviceTypeByMonth.get(changedMonth)}». ` +
          "Границы уже начавшегося флайта не пересчитываются автоматически; требуется проверка.",
      });
    }
  }

  return issues;
}

function periodIssuesForFlight(period: ServicePeriod, start: Month, end: Month): FlightIssue[] {
  return period.issues.filter((issue) => isMonthInRange(issue.month, start, end));
}

function getFlightStartState(
  clientId: string,
  start: Month,
  data: InputData,
  histories: ClientHistoryResult,
  projectStates: ProjectStateResult,
) {
  const projectIds = projectIdsInFlight(clientId, start, start, data, histories);
  const projectId = projectIds[0];
  if (!projectId) {
    throw new FlightBuildError(
      `Для client_id «${clientId}» нет отгрузки в начальном месяце флайта «${start}».`,
    );
  }

  const state = projectStates.stateByProjectAndMonth.get(projectStateKey(projectId, start));
  if (!state) {
    throw new FlightBuildError(
      `Не найдено временное состояние project_id «${projectId}» за ${start}.`,
    );
  }

  return state;
}

function lastActiveMonth(
  clientId: string,
  start: Month,
  end: Month,
  data: InputData,
  histories: ClientHistoryResult,
): Month | null {
  const activeMonths = data.works
    .filter((work) => {
      const history = histories.historyByProjectId.get(work.projectId);
      return history?.clientId === clientId && work.amount > 0 && isMonthInRange(work.month, start, end);
    })
    .map((work) => work.month)
    .sort();

  return activeMonths.at(-1) ?? null;
}

export function buildFlights(
  data: InputData,
  indexes: InputIndexes,
  histories: ClientHistoryResult,
  projectStates: ProjectStateResult,
): FlightBuildResult {
  const periods = buildServicePeriods(data, histories);
  const flights: Flight[] = [];
  const issues: FlightIssue[] = [];
  const flightNumberByClient = new Map<string, number>();

  for (const period of periods) {
    let flightStart = period.startMonth;

    while (flightStart <= period.endMonth) {
      const startState = getFlightStartState(
        period.clientId,
        flightStart,
        data,
        histories,
        projectStates,
      );
      const plannedFlightEnd = addMonths(flightStart, startState.termMonths - 1);
      const stopMonth = period.stopMonth && isMonthInRange(period.stopMonth, flightStart, plannedFlightEnd)
        ? period.stopMonth
        : null;
      const flightEnd = stopMonth ?? plannedFlightEnd;
      const projectIds = projectIdsInFlight(
        period.clientId,
        flightStart,
        flightEnd,
        data,
        histories,
      );
      const flightNo = (flightNumberByClient.get(period.clientId) ?? 0) + 1;
      const draftFlight = {
        clientId: period.clientId,
        projectIds,
        projectId: startState.projectId,
        projectName: startState.projectName,
        serviceType: startState.serviceType,
        projectType: startState.projectType,
        termMonths: startState.termMonths,
        flightNo,
        flightStart,
        plannedFlightEnd,
        flightEnd,
        lastActiveMonth: lastActiveMonth(
          period.clientId,
          flightStart,
          flightEnd,
          data,
          histories,
        ),
        stopMonth,
        sourcePeriodStart: period.startMonth,
        sourcePeriodEnd: period.endMonth,
      };

      const flightIssues = [
        ...periodIssuesForFlight(period, flightStart, flightEnd),
        ...appendStateIssues(draftFlight, projectStates),
      ];
      const flight: Flight = { ...draftFlight, issues: flightIssues };
      flights.push(flight);
      issues.push(...flightIssues);
      flightNumberByClient.set(period.clientId, flightNo);

      if (stopMonth) {
        flightStart = addMonths(stopMonth, 1);
      } else {
        flightStart = addMonths(plannedFlightEnd, 1);
      }
    }
  }

  return { periods, flights, issues };
}

export function describeFlightBuild(result: FlightBuildResult): string[] {
  const uniqueIssueCount = result.issues.length;
  return [
    `непрерывных периодов обслуживания: ${result.periods.length}`,
    `сформированных флайтов: ${result.flights.length}`,
    `замечаний по периодам и флайтам: ${uniqueIssueCount}`,
  ];
}
