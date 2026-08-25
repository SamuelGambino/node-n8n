import { readFile } from "node:fs/promises";

export type CsvRow = Record<string, string>;

export class CsvParseError extends Error {
  public constructor(
    message: string,
    public readonly source: string,
    public readonly row?: number,
  ) {
    super(message);
    this.name = "CsvParseError";
  }
}

function parseRecords(content: string, source: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let row = 1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0) {
        throw new CsvParseError("Кавычка должна открывать поле CSV.", source, row);
      }
      inQuotes = true;
      continue;
    }

    if (char === ";") {
      record.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      row += 1;
      continue;
    }

    if (char !== "\r") {
      field += char;
    }
  }

  if (inQuotes) {
    throw new CsvParseError("CSV содержит незакрытую кавычку.", source, row);
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records.filter((record) => record.some((field) => field.trim() !== ""));
}

export function parseSemicolonCsv(content: string, source: string): CsvRow[] {
  const records = parseRecords(content.replace(/^\uFEFF/, ""), source);
  const [headerRow, ...dataRows] = records;

  if (!headerRow || headerRow.length === 0) {
    throw new CsvParseError("CSV не содержит строку заголовков.", source, 1);
  }

  const headers = headerRow.map((header) => header.trim());
  const duplicateHeader = headers.find((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeader) {
    throw new CsvParseError(`Повторяющийся заголовок «${duplicateHeader}».`, source, 1);
  }

  return dataRows.map((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== headers.length) {
      throw new CsvParseError(
        `Ожидалось ${headers.length} полей, получено ${record.length}.`,
        source,
        rowNumber,
      );
    }

    return Object.fromEntries(headers.map((header, column) => [header, record[column]?.trim() ?? ""]));
  });
}

export async function readSemicolonCsv(
  filePath: string,
  requiredHeaders: readonly string[],
): Promise<CsvRow[]> {
  const content = await readFile(filePath, "utf8");
  const rows = parseSemicolonCsv(content, filePath);
  const headers = Object.keys(rows[0] ?? {});

  if (rows.length === 0) {
    const headerLine = parseRecords(content.replace(/^\uFEFF/, ""), filePath)[0] ?? [];
    headers.push(...headerLine.map((header) => header.trim()));
  }

  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new CsvParseError(
      `Отсутствуют обязательные заголовки: ${missingHeaders.join(", ")}.`,
      filePath,
      1,
    );
  }

  return rows;
}
