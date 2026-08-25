import { resolve } from "node:path";

import { CsvParseError } from "./csv.js";
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

  console.log(`Данные загружены из: ${dataDirectory}`);
  for (const description of describeInputData(data)) {
    console.log(`- ${description}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof CsvParseError || error instanceof DataValidationError) {
    const location = error.row ? ` (${error.source}, строка ${error.row})` : ` (${error.source})`;
    console.error(`Ошибка входных данных${location}: ${error.message}`);
  } else {
    console.error(`Ошибка запуска: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
