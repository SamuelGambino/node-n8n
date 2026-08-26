import "dotenv/config";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import { runAudit } from "./audit.js";

const FILE_ROLE_TO_INTERNAL_NAME = {
  checked_report: "report.csv",
  raw_monthly_shipments: "works.csv",
  projects_directory: "projects.csv",
  projects_change_history: "projects_history.csv",
  service_changes: "service_changes.csv",
  flight_length: "service_terms.csv",
} as const;

type FileRole = keyof typeof FILE_ROLE_TO_INTERNAL_NAME;
type InternalCsvName = typeof FILE_ROLE_TO_INTERNAL_NAME[FileRole];

const REQUIRED_FILE_ROLES = Object.keys(FILE_ROLE_TO_INTERNAL_NAME) as FileRole[];
const REQUIRED_INTERNAL_NAMES = Object.values(FILE_ROLE_TO_INTERNAL_NAME) as InternalCsvName[];

/** Метаданные одного n8n-элемента: роль CSV указывает на имя бинарного multipart-поля. */
interface UploadMetadata {
  submittedAt: string;
  formMode: string;
  checked_report: string;
  raw_monthly_shipments: string;
  projects_directory: string;
  projects_change_history: string;
  service_changes: string;
  flight_length: string;
}

interface AuditApiOptions {
  accessToken?: string;
}

/** Ошибка запроса, которую API безопасно возвращает вызывающему n8n-сценарию. */
class AuditApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuditApiError";
  }
}

function parseMetadata(value: string | undefined): UploadMetadata {
  if (!value) {
    throw new AuditApiError(
      400,
      "MISSING_METADATA",
      "Добавьте текстовое multipart-поле metadata с массивом из одного объекта ролей файлов.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuditApiError(400, "INVALID_METADATA", "Поле metadata должно содержать корректный JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new AuditApiError(
      400,
      "INVALID_METADATA",
      "Поле metadata должно быть массивом ровно с одним объектом, как в согласованном формате.",
    );
  }

  const candidate = parsed[0];
  for (const field of ["submittedAt", "formMode", ...REQUIRED_FILE_ROLES]) {
    if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
      throw new AuditApiError(
        400,
        "INVALID_METADATA",
        `В metadata должно присутствовать непустое строковое поле «${field}».`,
      );
    }
  }

  return candidate as unknown as UploadMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleFileMap(metadata: UploadMetadata): Map<string, InternalCsvName> {
  const mapping = new Map<string, InternalCsvName>();
  for (const role of REQUIRED_FILE_ROLES) {
    const uploadedFieldName = metadata[role].trim();
    if (mapping.has(uploadedFieldName)) {
      throw new AuditApiError(
        400,
        "DUPLICATE_FILE_REFERENCE",
        `В metadata имя «${uploadedFieldName}» назначено нескольким ролям файлов.`,
      );
    }
    mapping.set(uploadedFieldName, FILE_ROLE_TO_INTERNAL_NAME[role]);
  }
  return mapping;
}

function requireAuthorization(authorization: string | undefined, accessToken: string | undefined): void {
  if (!accessToken) {
    return;
  }
  if (authorization !== `Bearer ${accessToken}`) {
    throw new AuditApiError(401, "UNAUTHORIZED", "Требуется корректный Bearer-токен API.");
  }
}

function summaryForApi(result: Awaited<ReturnType<typeof runAudit>>): Record<string, unknown> {
  const statusDistribution = Object.fromEntries(
    result.statusResolution.flights.reduce<Map<string, number>>((counts, flight) => {
      counts.set(flight.status, (counts.get(flight.status) ?? 0) + 1);
      return counts;
    }, new Map()),
  );

  return {
    historicalReportCutoff: result.statusResolution.reportGeneratedAt,
    outputReportGeneratedAt: result.analysis.metadata.generatedAt,
    uniqueClients: result.analysis.statistics.uniqueReconstructedClients,
    flights: result.statusResolution.flights.length,
    statuses: statusDistribution,
    issues: result.analysis.statistics.issueCount,
    questions: result.analysis.statistics.questionCount,
  };
}

/**
 * Создаёт API для хостинга. Один POST /v1/audit принимает шесть бинарных CSV
 * с произвольными именами и metadata, которое связывает эти имена с ролями аудита.
 */
export async function buildAuditApi(options: AuditApiOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: true, bodyLimit: 6 * 5 * 1024 * 1024 });

  await server.register(multipart, {
    limits: {
      files: REQUIRED_INTERNAL_NAMES.length,
      fileSize: 5 * 1024 * 1024,
      fields: 10,
    },
  });

  server.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  server.get("/health", async () => ({
    status: "ok",
    endpoint: "POST /v1/audit",
    metadataField: "metadata",
    requiredRoles: REQUIRED_FILE_ROLES,
    accessTokenRequired: Boolean(options.accessToken),
  }));

  server.post("/v1/audit", async (request, reply) => {
    requireAuthorization(request.headers.authorization, options.accessToken);
    if (!request.isMultipart()) {
      throw new AuditApiError(415, "MULTIPART_REQUIRED", "Отправьте один multipart/form-data запрос.");
    }

    const requestId = randomUUID();
    const workingDirectory = await mkdtemp(join(tmpdir(), "node-n8n-audit-"));
    const dataDirectory = join(workingDirectory, "data");
    const outputDirectory = join(workingDirectory, "output");
    let metadataRaw: string | undefined;
    const uploadedFiles = new Map<string, Buffer>();

    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (uploadedFiles.has(part.fieldname)) {
            throw new AuditApiError(400, "DUPLICATE_UPLOAD", `Поле файла «${part.fieldname}» передано более одного раза.`);
          }
          const content = await part.toBuffer();
          if (content.length === 0) {
            throw new AuditApiError(400, "EMPTY_FILE", `Загруженный файл «${part.fieldname}» пуст.`);
          }
          uploadedFiles.set(part.fieldname, content);
        } else if (part.fieldname === "metadata") {
          if (metadataRaw !== undefined) {
            throw new AuditApiError(400, "DUPLICATE_METADATA", "Поле metadata передано более одного раза.");
          }
          metadataRaw = String(part.value);
        }
      }

      const metadata = parseMetadata(metadataRaw);
      const expectedFiles = roleFileMap(metadata);
      const unexpectedFiles = [...uploadedFiles.keys()].filter((name) => !expectedFiles.has(name));
      if (unexpectedFiles.length > 0) {
        throw new AuditApiError(
          400,
          "UNEXPECTED_FILE",
          `Загружены файлы, которых нет в metadata: ${unexpectedFiles.join(", ")}.`,
        );
      }

      const missingFiles = [...expectedFiles.keys()].filter((name) => !uploadedFiles.has(name));
      if (missingFiles.length > 0) {
        throw new AuditApiError(
          400,
          "MISSING_FILES",
          `Не получены файлы из metadata: ${missingFiles.join(", ")}.`,
        );
      }

      await mkdir(dataDirectory, { recursive: true });
      await mkdir(outputDirectory, { recursive: true });
      for (const [uploadedName, internalName] of expectedFiles) {
        await writeFile(join(dataDirectory, internalName), uploadedFiles.get(uploadedName)!);
      }

      const result = await runAudit(dataDirectory, outputDirectory);
      const [reportFixedCsv, discrepanciesRaw] = await Promise.all([
        readFile(result.artifacts.reportFixedPath, "utf8"),
        readFile(result.artifacts.discrepanciesPath, "utf8"),
      ]);

      return reply.status(200).send({
        requestId,
        status: "completed",
        request: metadata,
        summary: summaryForApi(result),
        analysis: result.analysis,
        files: {
          report_fixed_csv: reportFixedCsv,
          audit_discrepancies_json: JSON.parse(discrepanciesRaw),
        },
      });
    } finally {
      // Загруженные клиентом CSV и временные артефакты удаляются после подготовки ответа.
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof AuditApiError) {
      return reply.status(error.statusCode).send({
        status: "error",
        code: error.code,
        message: error.message,
        metadataFormat: "[{ submittedAt, formMode, checked_report, raw_monthly_shipments, projects_directory, projects_change_history, service_changes, flight_length }]",
      });
    }
    if (error instanceof Error && error.name === "RequestFileTooLargeError") {
      return reply.status(413).send({
        status: "error",
        code: "FILE_TOO_LARGE",
        message: "Размер каждого CSV не должен превышать 5 МБ.",
      });
    }

    request.log.error(error);
    return reply.status(422).send({
      status: "error",
      code: "AUDIT_FAILED",
      message: error instanceof Error ? error.message : "Не удалось выполнить аудит загруженных файлов.",
    });
  });

  return server;
}

async function startApi(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT должен быть целым числом от 1 до 65535.");
  }

  const server = await buildAuditApi({ accessToken: process.env.API_ACCESS_TOKEN });
  await server.listen({ port, host });
  server.log.info(`Audit API is listening on http://${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((error: unknown) => {
    console.error(`Не удалось запустить API: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
