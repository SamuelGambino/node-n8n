import type {
  InputData,
  InputIndexes,
  Month,
  ProjectState,
  ProjectStateIssue,
  ProjectStateResult,
} from "./types.js";

export class ProjectStateResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectStateResolutionError";
  }
}

export function projectStateKey(projectId: string, month: Month): string {
  return `${projectId}::${month}`;
}

function resolveHistoricalProjectName(
  projectId: string,
  month: Month,
  indexes: InputIndexes,
): string {
  const project = indexes.projectsById.get(projectId);
  if (!project) {
    throw new ProjectStateResolutionError(
      `Невозможно определить название: project_id «${projectId}» отсутствует в projects.csv.`,
    );
  }

  const outgoingHistory = indexes.historyByProject.get(projectId);
  if (outgoingHistory && month < outgoingHistory.month) {
    return outgoingHistory.projectName;
  }

  const incomingHistory = [...indexes.historyByProject.values()].find(
    (historyRecord) => historyRecord.newProjectId === projectId && month >= historyRecord.month,
  );
  if (incomingHistory) {
    return incomingHistory.newProjectName;
  }

  return project.projectName;
}

function resolveHistoricalServiceType(
  projectId: string,
  month: Month,
  indexes: InputIndexes,
): string {
  const project = indexes.projectsById.get(projectId);
  if (!project) {
    throw new ProjectStateResolutionError(
      `Невозможно определить услугу: project_id «${projectId}» отсутствует в projects.csv.`,
    );
  }

  const serviceChanges = indexes.serviceChangesByProject.get(projectId);
  if (!serviceChanges || serviceChanges.length === 0) {
    return project.serviceType;
  }

  let serviceType = serviceChanges[0]?.oldServiceType;
  if (!serviceType) {
    throw new ProjectStateResolutionError(
      `Для project_id «${projectId}» не удалось определить услугу до первого изменения.`,
    );
  }

  for (const serviceChange of serviceChanges) {
    if (month < serviceChange.month) {
      break;
    }
    serviceType = serviceChange.newServiceType;
  }

  return serviceType;
}

function resolveTermMonths(
  projectId: string,
  month: Month,
  serviceType: string,
  indexes: InputIndexes,
): { termMonths: number; issues: ProjectStateIssue[] } {
  const project = indexes.projectsById.get(projectId);
  if (!project) {
    throw new ProjectStateResolutionError(
      `Невозможно определить срок: project_id «${projectId}» отсутствует в projects.csv.`,
    );
  }

  const termMonths = indexes.serviceTermsByType.get(serviceType);
  if (termMonths === undefined) {
    throw new ProjectStateResolutionError(
      `В service_terms.csv отсутствует срок флайта для услуги «${serviceType}» (project_id «${projectId}», месяц «${month}»).`,
    );
  }

  const issues: ProjectStateIssue[] = [];
  if (project.termMonths !== termMonths) {
    issues.push({
      type: "DATA_CONFLICT",
      projectId,
      month,
      field: "term_months",
      message:
        `Срок ${project.termMonths} мес. из projects.csv не соответствует сроку ${termMonths} мес. ` +
        `для исторической услуги «${serviceType}» из service_terms.csv. ` +
        "Для расчёта используется service_terms.csv согласно main_rules.txt.",
    });
  }

  return { termMonths, issues };
}

export function resolveProjectState(
  projectId: string,
  month: Month,
  indexes: InputIndexes,
): { state: ProjectState; issues: ProjectStateIssue[] } {
  const project = indexes.projectsById.get(projectId);
  if (!project) {
    throw new ProjectStateResolutionError(
      `Невозможно восстановить состояние: project_id «${projectId}» отсутствует в projects.csv.`,
    );
  }

  const projectName = resolveHistoricalProjectName(projectId, month, indexes);
  const serviceType = resolveHistoricalServiceType(projectId, month, indexes);
  const { termMonths, issues } = resolveTermMonths(projectId, month, serviceType, indexes);

  return {
    state: {
      projectId,
      month,
      projectName,
      serviceType,
      termMonths,
      projectType: project.projectType,
    },
    issues,
  };
}

export function buildProjectStates(data: InputData, indexes: InputIndexes): ProjectStateResult {
  const stateByProjectAndMonth = new Map<string, ProjectState>();
  const issues: ProjectStateIssue[] = [];

  for (const [projectId, workRecords] of indexes.worksByProject) {
    const months = [...new Set(workRecords.map((workRecord) => workRecord.month))].sort();

    for (const month of months) {
      const resolution = resolveProjectState(projectId, month, indexes);
      const key = projectStateKey(projectId, month);
      if (stateByProjectAndMonth.has(key)) {
        throw new ProjectStateResolutionError(
          `Для project_id «${projectId}» и месяца «${month}» рассчитано более одного состояния.`,
        );
      }
      stateByProjectAndMonth.set(key, resolution.state);
      issues.push(...resolution.issues);
    }
  }

  return {
    states: [...stateByProjectAndMonth.values()].sort((left, right) => {
      const byProject = left.projectId.localeCompare(right.projectId);
      return byProject === 0 ? left.month.localeCompare(right.month) : byProject;
    }),
    stateByProjectAndMonth,
    issues,
  };
}
