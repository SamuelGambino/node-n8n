import "dotenv/config";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import { runAudit } from "./audit.js";

const REQUIRED_CSV_FILES = [
  "works.csv",
  "projects.csv",
  "projects_history.csv",
  "service_changes.csv",
  "service_terms.csv",
  "report.csv",
] as const;

const REQUIRED_FILE_SET = new Set<string>(REQUIRED_CSV_FILES);
type RequiredCsvFile = typeof REQUIRED_CSV_FILES[number];

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

function requestedFileName(fieldName: string, originalName: string | undefined): RequiredCsvFile {
  // n8n может отправить имя CSV как поле multipart или как исходное имя бинарного файла.
  const candidates = [fieldName, originalName ? basename(originalName) : null].filter(
    (value): value is string => Boolean(value),
  );
  const resolved = candidates.find((value) => REQUIRED_FILE_SET.has(value));
  if (!resolved) {
    throw new AuditApiError(
      400,
      "UNEXPECTED_FILE",
      `Ожидался один из файлов: ${REQUIRED_CSV_FILES.join(", ")}. Получен файл «${originalName ?? fieldName}».`,
    );
  }
  return resolved as RequiredCsvFile;
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
    inputRecords: {
      works: result.data.works.length,
      projects: result.data.projects.length,
      projectsHistory: result.data.projectsHistory.length,
      serviceChanges: result.data.serviceChanges.length,
      serviceTerms: result.data.serviceTerms.length,
      report: result.data.report.length,
    },
    output: {
      uniqueClients: result.analysis.statistics.uniqueReconstructedClients,
      flights: result.statusResolution.flights.length,
      statuses: statusDistribution,
      issues: result.analysis.statistics.issueCount,
      questions: result.analysis.statistics.questionCount,
    },
  };
}

/**
 * Создаёт HTTP API без запуска TCP-порта. Это упрощает тестирование через inject()
 * и не позволяет тестам оставлять открытые сетевые соединения.
 */
export async function buildAuditApi(options: AuditApiOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: true,
    bodyLimit: 6 * 5 * 1024 * 1024,
  });

  await server.register(multipart, {
    limits: {
      files: REQUIRED_CSV_FILES.length,
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
    requiredFiles: REQUIRED_CSV_FILES,
    accessTokenRequired: Boolean(options.accessToken),
  }));

  server.post("/v1/audit", async (request, reply) => {
    requireAuthorization(request.headers.authorization, options.accessToken);

    if (!request.isMultipart()) {
      throw new AuditApiError(
        415,
        "MULTIPART_REQUIRED",
        "Отправьте шесть CSV как multipart/form-data.",
      );
    }

    const requestId = randomUUID();
    const workingDirectory = await mkdtemp(join(tmpdir(), "node-n8n-audit-"));
    const dataDirectory = join(workingDirectory, "data");
    const outputDirectory = join(workingDirectory, "output");
    const receivedFiles = new Set<RequiredCsvFile>();

    try {
      await mkdir(dataDirectory, { recursive: true });
      await mkdir(outputDirectory, { recursive: true });

      for await (const part of request.parts()) {
        if (part.type !== "file") {
          continue;
        }
        const fileName = requestedFileName(part.fieldname, part.filename);
        if (receivedFiles.has(fileName)) {
          throw new AuditApiError(400, "DUPLICATE_FILE", `Файл «${fileName}» передан более одного раза.`);
        }

        const content = await part.toBuffer();
        if (content.length === 0) {
          throw new AuditApiError(400, "EMPTY_FILE", `Файл «${fileName}» пуст.`);
        }
        await writeFile(join(dataDirectory, fileName), content);
        receivedFiles.add(fileName);
      }

      const missingFiles = REQUIRED_CSV_FILES.filter((fileName) => !receivedFiles.has(fileName));
      if (missingFiles.length > 0) {
        throw new AuditApiError(
          400,
          "MISSING_FILES",
          `Не получены обязательные CSV: ${missingFiles.join(", ")}.`,
        );
      }

      const result = await runAudit(dataDirectory, outputDirectory);
      const [reportFixedCsv, discrepanciesRaw] = await Promise.all([
        readFile(result.artifacts.reportFixedPath, "utf8"),
        readFile(result.artifacts.discrepanciesPath, "utf8"),
      ]);

      return reply.status(200).send({
        requestId,
        status: "completed",
        receivedFiles: REQUIRED_CSV_FILES,
        summary: summaryForApi(result),
        results: {
          reportFixedCsv,
          analysis: result.analysis,
          auditDiscrepancies: JSON.parse(discrepanciesRaw),
        },
      });
    } finally {
      // Загруженные клиентом файлы и сформированные результаты удаляются после ответа.
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof AuditApiError) {
      return reply.status(error.statusCode).send({
        status: "error",
        code: error.code,
        message: error.message,
        requiredFiles: REQUIRED_CSV_FILES,
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

  if (process.argv.includes("--tunnel")) {
    if (!process.env.NGROK_AUTHTOKEN) {
      throw new Error("Для --tunnel требуется переменная окружения NGROK_AUTHTOKEN.");
    }
    const ngrok = await import("@ngrok/ngrok");
    const listener = await ngrok.forward({ addr: port, authtoken_from_env: true });
    server.log.info(`Public ngrok URL: ${listener.url()}`);

    const close = async (): Promise<void> => {
      await listener.close();
      await server.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((error: unknown) => {
    console.error(`Не удалось запустить API: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
