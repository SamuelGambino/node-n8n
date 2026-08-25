import type {
  ClientHistory,
  ClientHistoryResult,
  InputData,
  InputIndexes,
  ProjectHistoryRecord,
  ServiceChangeRecord,
  WorkRecord,
} from "./types.js";

export class DataInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DataInvariantError";
  }
}

function addUniqueValue<T>(
  target: Map<string, T>,
  key: string,
  value: T,
  collectionName: string,
): void {
  if (target.has(key)) {
    throw new DataInvariantError(`В «${collectionName}» найден дублирующийся ключ «${key}».`);
  }
  target.set(key, value);
}

function groupByProject<T extends { projectId: string; month: string }>(
  records: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const record of records) {
    const group = grouped.get(record.projectId) ?? [];
    group.push(record);
    grouped.set(record.projectId, group);
  }

  for (const group of grouped.values()) {
    group.sort((left, right) => left.month.localeCompare(right.month));
  }

  return grouped;
}

function validateHistoryReferences(
  records: ProjectHistoryRecord[],
  projectsById: InputIndexes["projectsById"],
): void {
  const incomingProjectIds = new Set<string>();

  for (const record of records) {
    if (record.projectId === record.newProjectId) {
      throw new DataInvariantError(
        `История проекта «${record.projectId}» содержит переход проекта в самого себя.`,
      );
    }

    if (!projectsById.has(record.projectId) || !projectsById.has(record.newProjectId)) {
      throw new DataInvariantError(
        `Переход «${record.projectId} → ${record.newProjectId}» ссылается на проект, отсутствующий в projects.csv.`,
      );
    }

    if (incomingProjectIds.has(record.newProjectId)) {
      throw new DataInvariantError(
        `Проект «${record.newProjectId}» имеет несколько предшественников в projects_history.csv; цепочка клиента неоднозначна.`,
      );
    }
    incomingProjectIds.add(record.newProjectId);
  }
}

export function buildInputIndexes(data: InputData): InputIndexes {
  const projectsById = new Map<string, InputIndexes["projectsById"] extends Map<string, infer T> ? T : never>();
  for (const project of data.projects) {
    addUniqueValue(projectsById, project.projectId, project, "projects.csv");
  }

  const serviceTermsByType = new Map<string, number>();
  for (const serviceTerm of data.serviceTerms) {
    addUniqueValue(
      serviceTermsByType,
      serviceTerm.serviceType,
      serviceTerm.termMonths,
      "service_terms.csv",
    );
  }

  const historyByProject = new Map<string, ProjectHistoryRecord>();
  for (const historyRecord of data.projectsHistory) {
    addUniqueValue(historyByProject, historyRecord.projectId, historyRecord, "projects_history.csv");
  }

  const indexes: InputIndexes = {
    projectsById,
    serviceTermsByType,
    serviceChangesByProject: groupByProject<ServiceChangeRecord>(data.serviceChanges),
    historyByProject,
    worksByProject: groupByProject<WorkRecord>(data.works),
  };

  validateHistoryReferences(data.projectsHistory, indexes.projectsById);

  for (const projectId of indexes.worksByProject.keys()) {
    if (!indexes.projectsById.has(projectId)) {
      throw new DataInvariantError(
        `works.csv содержит project_id «${projectId}», отсутствующий в projects.csv.`,
      );
    }
  }

  return indexes;
}

function buildHistoryFromRoot(
  rootProjectId: string,
  historyByProject: Map<string, ProjectHistoryRecord>,
): ClientHistory {
  const projectIds: string[] = [];
  const encounteredProjectIds = new Set<string>();
  let currentProjectId: string | undefined = rootProjectId;

  while (currentProjectId) {
    if (encounteredProjectIds.has(currentProjectId)) {
      throw new DataInvariantError(
        `В projects_history.csv обнаружен цикл, включающий project_id «${currentProjectId}».`,
      );
    }

    encounteredProjectIds.add(currentProjectId);
    projectIds.push(currentProjectId);
    currentProjectId = historyByProject.get(currentProjectId)?.newProjectId;
  }

  const clientId = projectIds.at(-1);
  if (!clientId) {
    throw new DataInvariantError(`Не удалось определить client_id для «${rootProjectId}».`);
  }

  return { clientId, projectIds };
}

export function buildClientHistories(indexes: InputIndexes): ClientHistoryResult {
  const allProjectIds = [...indexes.projectsById.keys()].sort();
  const replacedProjectIds = new Set(
    [...indexes.historyByProject.values()].map((historyRecord) => historyRecord.newProjectId),
  );
  const rootProjectIds = allProjectIds.filter((projectId) => !replacedProjectIds.has(projectId));
  const histories: ClientHistory[] = [];
  const historyByProjectId = new Map<string, ClientHistory>();

  for (const rootProjectId of rootProjectIds) {
    const history = buildHistoryFromRoot(rootProjectId, indexes.historyByProject);
    histories.push(history);

    for (const projectId of history.projectIds) {
      if (historyByProjectId.has(projectId)) {
        throw new DataInvariantError(
          `project_id «${projectId}» входит более чем в одну клиентскую цепочку.`,
        );
      }
      historyByProjectId.set(projectId, history);
    }
  }

  const unassignedProjectIds = allProjectIds.filter((projectId) => !historyByProjectId.has(projectId));
  if (unassignedProjectIds.length > 0) {
    throw new DataInvariantError(
      `Не удалось построить клиентскую историю для project_id: ${unassignedProjectIds.join(", ")}. Проверьте циклы или разрывы projects_history.csv.`,
    );
  }

  return { histories, historyByProjectId };
}

export function describeIndexes(indexes: InputIndexes, histories: ClientHistoryResult): string[] {
  return [
    `projectsById: ${indexes.projectsById.size} проектов`,
    `serviceTermsByType: ${indexes.serviceTermsByType.size} услуг`,
    `serviceChangesByProject: ${indexes.serviceChangesByProject.size} проектов с изменениями услуги`,
    `historyByProject: ${indexes.historyByProject.size} переходов project_id`,
    `worksByProject: ${indexes.worksByProject.size} проектов с отгрузками`,
    `client histories: ${histories.histories.length} цепочек`,
  ];
}
