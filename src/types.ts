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

export interface ClientHistory {
  clientId: string;
  projectIds: string[];
}

export interface InputIndexes {
  projectsById: Map<string, ProjectRecord>;
  serviceTermsByType: Map<string, number>;
  serviceChangesByProject: Map<string, ServiceChangeRecord[]>;
  historyByProject: Map<string, ProjectHistoryRecord>;
  worksByProject: Map<string, WorkRecord[]>;
}

export interface ClientHistoryResult {
  histories: ClientHistory[];
  historyByProjectId: Map<string, ClientHistory>;
}

export interface ProjectState {
  projectId: string;
  month: Month;
  projectName: string;
  serviceType: string;
  termMonths: number;
  projectType: string;
}

export type ProjectStateIssueType = "DATA_CONFLICT" | "NEEDS_REVIEW";

export interface ProjectStateIssue {
  type: ProjectStateIssueType;
  projectId: string;
  month: Month;
  field: "project_name" | "service_type" | "term_months";
  message: string;
}

export interface ProjectStateResult {
  states: ProjectState[];
  stateByProjectAndMonth: Map<string, ProjectState>;
  issues: ProjectStateIssue[];
}

export type FlightIssueType =
  | "STOP_EVENT"
  | "ACTIVITY_GAP"
  | "POST_STOP_CONTINUATION"
  | "SERVICE_CHANGE_IN_FLIGHT"
  | "MULTIPLE_PROJECT_STATES";

export interface FlightIssue {
  type: FlightIssueType;
  clientId: string;
  projectIds: string[];
  month: Month;
  message: string;
}

export interface ServicePeriod {
  clientId: string;
  startMonth: Month;
  endMonth: Month;
  projectIds: string[];
  activeMonths: Month[];
  stopMonth: Month | null;
  issues: FlightIssue[];
}

export interface Flight {
  clientId: string;
  projectIds: string[];
  projectId: string;
  projectName: string;
  serviceType: string;
  projectType: string;
  termMonths: number;
  flightNo: number;
  flightStart: Month;
  plannedFlightEnd: Month;
  flightEnd: Month;
  lastActiveMonth: Month | null;
  stopMonth: Month | null;
  sourcePeriodStart: Month;
  sourcePeriodEnd: Month;
  issues: FlightIssue[];
}

export interface FlightBuildResult {
  periods: ServicePeriod[];
  flights: Flight[];
  issues: FlightIssue[];
}

export type FlightStatus =
  | "завершился (разовые работы)"
  | "отвал"
  | "пролонгировано"
  | "непролонгировано"
  | "неизвестно"
  | "NEEDS_REVIEW";

export type StatusIssueType =
  | "ACTIVITY_AFTER_REPORT_DATE"
  | "DELAYED_RENEWAL"
  | "IRREGULAR_ACTIVITY"
  | "MISSING_REPORT_GENERATED_AT";

export interface StatusIssue {
  type: StatusIssueType;
  clientId: string;
  projectIds: string[];
  flightNo: number;
  month: Month | null;
  message: string;
}

export interface ResolvedFlight extends Flight {
  status: FlightStatus;
  statusComment: string;
  statusIssues: StatusIssue[];
}

export interface StatusResolutionResult {
  reportGeneratedAt: Month;
  flights: ResolvedFlight[];
  issues: StatusIssue[];
}
