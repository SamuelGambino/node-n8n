import { resolve } from "node:path";

import { runAudit } from "./audit.js";
import { CsvParseError } from "./csv.js";
import { describeFlightBuild, FlightBuildError } from "./flights.js";
import { DataInvariantError, describeIndexes } from "./indexes.js";
import { DataValidationError, describeInputData } from "./loaders.js";
import { describeReportComparison, ReportComparisonError } from "./report-comparison.js";
import { describeStatusResolution, StatusResolutionError } from "./statuses.js";
import { ProjectStateResolutionError } from "./temporal-state.js";

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
 * Консольный запуск общего конвейера аудита. HTTP API использует ту же функцию
 * runAudit, поэтому CSV-файлы дают одинаковый результат независимо от способа загрузки.
 */
async function main(): Promise<void> {
  const dataDirectory = getDataDirectory(process.argv.slice(2));
  const result = await runAudit(dataDirectory, process.cwd());

  console.log(`Данные загружены из: ${dataDirectory}`);
  console.log("\nЗагруженные таблицы:");
  for (const description of describeInputData(result.data)) {
    console.log(`- ${description}`);
  }

  console.log("\nПостроенные справочники:");
  for (const description of describeIndexes(result.indexes, result.clientHistories)) {
    console.log(`- ${description}`);
  }

  console.log("\nКлиентские цепочки (project_id → client_id):");
  for (const history of result.clientHistories.histories) {
    console.log(`- ${history.projectIds.join(" → ")} → client_id ${history.clientId}`);
  }

  console.log("\nВременные состояния проектов:");
  console.log(`- восстановлено состояний: ${result.projectStates.states.length}`);
  console.log(`- конфликтов справочных сроков: ${result.projectStates.issues.length}`);

  console.log("\nПериоды обслуживания и флайты:");
  for (const description of describeFlightBuild(result.flightBuild)) {
    console.log(`- ${description}`);
  }

  console.log("\nИтоговые статусы флайтов:");
  for (const description of describeStatusResolution(result.statusResolution)) {
    console.log(`- ${description}`);
  }

  console.log("\nСравнение с исходным report.csv:");
  for (const description of describeReportComparison(result.comparison)) {
    console.log(`- ${description}`);
  }
  console.log(`- исправленный отчёт: ${result.artifacts.reportFixedPath}`);
  console.log(`- детализированные расхождения: ${result.artifacts.discrepanciesPath}`);
  console.log(`- аналитика для ИИ: ${result.artifacts.analysisPath}`);
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
