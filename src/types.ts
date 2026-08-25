export type Month = `${number}-${string}`;

export interface WorkRecord {
  projectId: string;
  month: Month;
  amount: number;
  label: string | null;
  part: string | null;
}

export interface ProjectRecord {
  projectId: string;
  projectName: string;
  serviceType: string;
  projectType: string;
  termMonths: number;
}

export interface ProjectHistoryRecord {
  projectId: string;
  projectName: string;
  newProjectId: string;
  newProjectName: string;
  month: Month;
}

export interface ServiceChangeRecord {
  projectId: string;
  month: Month;
  oldServiceType: string;
  newServiceType: string;
}

export interface ServiceTermRecord {
  serviceType: string;
  termMonths: number;
}

export interface ReportRecord {
  clientId: string;
  projectIds: string;
  projectName: string;
  serviceType: string;
  termMonths: number;
  flightNo: number;
  flightStart: Month;
  flightEnd: Month;
  lastActiveMonth: Month | null;
  status: string;
  reportGeneratedAt: Month;
}

export interface InputData {
  works: WorkRecord[];
  projects: ProjectRecord[];
  projectsHistory: ProjectHistoryRecord[];
  serviceChanges: ServiceChangeRecord[];
  serviceTerms: ServiceTermRecord[];
  report: ReportRecord[];
}
