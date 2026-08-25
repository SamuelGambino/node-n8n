import { resolve } from "node:path";

import { CsvParseError } from "./csv.js";
import {
  buildClientHistories,
  buildInputIndexes,
  DataInvariantError,
  describeIndexes,
} from "./indexes.js";
import { DataValidationError, describeInputData, loadInputData } from "./loaders.js";

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

async function main(): Promise<void> {
  const dataDirectory = getDataDirectory(process.argv.slice(2));
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const clientHistories = buildClientHistories(indexes);

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
}

main().catch((error: unknown) => {
  if (
    error instanceof CsvParseError ||
    error instanceof DataValidationError ||
    error instanceof DataInvariantError
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
