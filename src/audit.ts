import { loadInputData } from "./loaders.js";
import { currentReportDate } from "./month.js";
import { buildFlights } from "./flights.js";
import { buildClientHistories, buildInputIndexes } from "./indexes.js";
import { compareReport, writeReportArtifacts } from "./report-comparison.js";
import { resolveFlightStatuses } from "./statuses.js";
import { buildProjectStates } from "./temporal-state.js";
import { buildAnalysisDocument, writeAnalysisDocument } from "./analysis.js";
import type {
  AnalysisDocument,
  ClientHistoryResult,
  FlightBuildResult,
  InputData,
  InputIndexes,
  ProjectStateResult,
  ReportComparisonResult,
  StatusResolutionResult,
} from "./types.js";

/**
 * Результат одного изолированного запуска аудита. API создаёт новый экземпляр
 * для каждой загрузки, поэтому файлы разных вызовов не смешиваются между собой.
 */
export interface AuditRunResult {
  data: InputData;
  indexes: InputIndexes;
  clientHistories: ClientHistoryResult;
  projectStates: ProjectStateResult;
  flightBuild: FlightBuildResult;
  statusResolution: StatusResolutionResult;
  comparison: ReportComparisonResult;
  analysis: AnalysisDocument;
  artifacts: {
    reportFixedPath: string;
    discrepanciesPath: string;
    analysisPath: string;
  };
}

/**
 * Последовательно запускает весь аудит на переданной папке CSV и сохраняет
 * результаты только в заданный выходной каталог.
 */
export async function runAudit(
  dataDirectory: string,
  outputDirectory: string,
): Promise<AuditRunResult> {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const clientHistories = buildClientHistories(indexes);
  const projectStates = buildProjectStates(data, indexes);
  const flightBuild = buildFlights(data, indexes, clientHistories, projectStates);
  const statusResolution = resolveFlightStatuses(data, clientHistories, flightBuild);
  const outputReportGeneratedAt = currentReportDate();
  const comparison = compareReport(
    data,
    statusResolution,
    projectStates,
    outputReportGeneratedAt,
  );
  const reportArtifacts = await writeReportArtifacts(comparison, outputDirectory);
  const analysis = buildAnalysisDocument(
    data,
    projectStates,
    statusResolution,
    comparison,
    outputReportGeneratedAt,
  );
  const analysisPath = await writeAnalysisDocument(analysis, outputDirectory);

  return {
    data,
    indexes,
    clientHistories,
    projectStates,
    flightBuild,
    statusResolution,
    comparison,
    analysis,
    artifacts: {
      ...reportArtifacts,
      analysisPath,
    },
  };
}
