import { resolve } from "node:path";

import { buildAnalysisDocument, writeAnalysisDocument } from "./analysis.js";
import { CsvParseError } from "./csv.js";
import { buildFlights, describeFlightBuild, FlightBuildError } from "./flights.js";
import {
  buildClientHistories,
  buildInputIndexes,
  DataInvariantError,
  describeIndexes,
} from "./indexes.js";
import { DataValidationError, describeInputData, loadInputData } from "./loaders.js";
import { currentReportDate } from "./month.js";
import {
  compareReport,
  describeReportComparison,
  ReportComparisonError,
  writeReportArtifacts,
} from "./report-comparison.js";
import { describeStatusResolution, resolveFlightStatuses, StatusResolutionError } from "./statuses.js";
import { buildProjectStates, ProjectStateResolutionError } from "./temporal-state.js";

function getDataDirectory(args: string[]): string {
  const dataDirectoryFlagIndex = args.indexOf("--data-dir");
  if (dataDirectoryFlagIndex === -1) {
    return resolve(process.cwd(), "data");
  }

  const value = args[dataDirectoryFlagIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("После параметра --data-dir необходимо указать путь к папке с CSV-файлами.");
  }

  return resolve(process.cwd(), value);
}

/**
 * Оркестратор детерминированного аудита. Каждый этап получает только результат
 * предыдущего, поэтому итоговые CSV и JSON можно воспроизвести из той же папки data.
 */
async function main(): Promise<void> {
  const dataDirectory = getDataDirectory(process.argv.slice(2));
  const outputReportGeneratedAt = currentReportDate();
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const clientHistories = buildClientHistories(indexes);
  const projectStates = buildProjectStates(data, indexes);
  const flightBuild = buildFlights(data, indexes, clientHistories, projectStates);
  const statusResolution = resolveFlightStatuses(data, clientHistories, flightBuild);
  const comparison = compareReport(
    data,
    statusResolution,
    projectStates,
    outputReportGeneratedAt,
  );
  const reportArtifacts = await writeReportArtifacts(comparison, process.cwd());
  const analysisDocument = buildAnalysisDocument(
    data,
    projectStates,
    statusResolution,
    comparison,
    outputReportGeneratedAt,
  );
  const analysisPath = await writeAnalysisDocument(analysisDocument, process.cwd());

  console.log(`Данные загружены из: ${dataDirectory}`);
  console.log("\nЗагруженные таблицы:");
  for (const description of describeInputData(data)) {
    console.log(`- ${description}`);
  }

  console.log("\nПостроенные справочники:");
  for (const description of describeIndexes(indexes, clientHistories)) {
    console.log(`- ${description}`);
  }

  console.log("\nКлиентские цепочки (project_id → client_id):");
  for (const history of clientHistories.histories) {
    console.log(`- ${history.projectIds.join(" → ")} → client_id ${history.clientId}`);
  }

  console.log("\nВременные состояния проектов:");
  console.log(`- восстановлено состояний: ${projectStates.states.length}`);
  console.log(`- конфликтов справочных сроков: ${projectStates.issues.length}`);

  console.log("\nПериоды обслуживания и флайты:");
  for (const description of describeFlightBuild(flightBuild)) {
    console.log(`- ${description}`);
  }

  console.log("\nИтоговые статусы флайтов:");
  for (const description of describeStatusResolution(statusResolution)) {
    console.log(`- ${description}`);
  }

  console.log("\nСравнение с исходным report.csv:");
  for (const description of describeReportComparison(comparison)) {
    console.log(`- ${description}`);
  }
  console.log(`- исправленный отчёт: ${reportArtifacts.reportFixedPath}`);
  console.log(`- детализированные расхождения: ${reportArtifacts.discrepanciesPath}`);
  console.log(`- аналитика для ИИ: ${analysisPath}`);
}

main().catch((error: unknown) => {
  if (
    error instanceof CsvParseError ||
    error instanceof DataValidationError ||
    error instanceof DataInvariantError ||
    error instanceof ProjectStateResolutionError ||
    error instanceof FlightBuildError ||
    error instanceof StatusResolutionError ||
    error instanceof ReportComparisonError
  ) {
    const location = "source" in error && "row" in error && error.row
      ? ` (${error.source}, строка ${error.row})`
      : "";
    console.error(`Ошибка входных данных${location}: ${error.message}`);
  } else {
    console.error(`Ошибка запуска: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
