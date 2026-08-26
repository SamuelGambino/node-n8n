import "dotenv/config";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";

import { runAudit } from "./audit.js";
import { parseDashboardInput, renderDashboard } from "./dashboard.js";
import { renderUploadPage } from "./upload-page.js";

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

interface AuditPayload {
  requestId: string;
  status: "completed";
  request: UploadMetadata;
  summary: Record<string, unknown>;
  analysis: Awaited<ReturnType<typeof runAudit>>["analysis"];
  files: {
    report_fixed_csv: string;
    audit_discrepancies_json: unknown;
  };
}

interface AuditApiOptions {
  accessToken?: string;
  n8nWebhookUrl?: string;
  n8nWebhookToken?: string;
  n8nTimeoutMs?: number;
  n8nClient?: (payload: AuditPayload) => Promise<unknown>;
}

/** Ошибка запроса, которую API безопасно возвращает вызывающему n8n-сценарию или браузеру. */
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

async function readUploadedCsv(request: FastifyRequest): Promise<{ metadata: UploadMetadata; files: Map<string, Buffer> }> {
  if (!request.isMultipart()) {
    throw new AuditApiError(415, "MULTIPART_REQUIRED", "Отправьте один multipart/form-data запрос.");
  }

  let metadataRaw: string | undefined;
  const uploadedFiles = new Map<string, Buffer>();
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
    throw new AuditApiError(400, "UNEXPECTED_FILE", `Загружены файлы, которых нет в metadata: ${unexpectedFiles.join(", ")}.`);
  }

  const missingFiles = [...expectedFiles.keys()].filter((name) => !uploadedFiles.has(name));
  if (missingFiles.length > 0) {
    throw new AuditApiError(400, "MISSING_FILES", `Не получены файлы из metadata: ${missingFiles.join(", ")}.`);
  }

  return { metadata, files: uploadedFiles };
}

/**
 * Выполняет детерминированный аудит в изолированной временной папке.
 * Файлы не сохраняются после HTTP-ответа и не передаются в ИИ напрямую.
 */
async function executeAudit(metadata: UploadMetadata, uploadedFiles: Map<string, Buffer>): Promise<AuditPayload> {
  const requestId = randomUUID();
  const workingDirectory = await mkdtemp(join(tmpdir(), "node-n8n-audit-"));
  const dataDirectory = join(workingDirectory, "data");
  const outputDirectory = join(workingDirectory, "output");

  try {
    await mkdir(dataDirectory, { recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    for (const [uploadedName, internalName] of roleFileMap(metadata)) {
      await writeFile(join(dataDirectory, internalName), uploadedFiles.get(uploadedName)!);
    }

    const result = await runAudit(dataDirectory, outputDirectory);
    const [reportFixedCsv, discrepanciesRaw] = await Promise.all([
      readFile(result.artifacts.reportFixedPath, "utf8"),
      readFile(result.artifacts.discrepanciesPath, "utf8"),
    ]);

    return {
      requestId,
      status: "completed",
      request: metadata,
      summary: summaryForApi(result),
      analysis: result.analysis,
      files: {
        report_fixed_csv: reportFixedCsv,
        audit_discrepancies_json: JSON.parse(discrepanciesRaw),
      },
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function callN8n(payload: AuditPayload, options: AuditApiOptions): Promise<unknown> {
  if (options.n8nClient) {
    return options.n8nClient(payload);
  }
  if (!options.n8nWebhookUrl) {
    throw new AuditApiError(503, "N8N_NOT_CONFIGURED", "Для дашборда настройте переменную N8N_WEBHOOK_URL.");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.n8nWebhookToken) {
    headers.authorization = `Bearer ${options.n8nWebhookToken}`;
  }

  let response: Response;
  try {
    response = await fetch(options.n8nWebhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.n8nTimeoutMs ?? 120_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditApiError(502, "N8N_UNAVAILABLE", `Не удалось дождаться ответа n8n: ${detail}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AuditApiError(502, "N8N_ERROR", `n8n вернул HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AuditApiError(502, "N8N_INVALID_RESPONSE", "n8n должен вернуть JSON с final_report_csv и audit_md.");
  }
}

function renderErrorPage(error: AuditApiError | Error): string {
  const message = error instanceof AuditApiError || error instanceof Error ? error.message : String(error);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Ошибка обработки</title><style>body{margin:0;padding:40px;background:#f4f7fb;color:#1d2632;font:16px system-ui}main{max-width:700px;margin:auto;padding:28px;background:#fff;border:1px solid #dce3eb;border-radius:12px}a{color:#1463d8}</style><main><h1>Не удалось сформировать дашборд</h1><p>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p><a href="/">Вернуться к загрузке файлов</a></p></main></html>`;
}

/**
 * Создаёт API и browser-first интерфейс. POST /v1/dashboard удерживает только
 * текущий запрос: после n8n-ответа HTML отправляется браузеру, без БД и файлового хранения.
 */
export async function buildAuditApi(options: AuditApiOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: true, bodyLimit: 6 * 5 * 1024 * 1024 });

  await server.register(multipart, {
    limits: { files: REQUIRED_INTERNAL_NAMES.length, fileSize: 5 * 1024 * 1024, fields: 10 },
  });

  server.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  server.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(renderUploadPage()));
  server.get("/health", async () => ({
    status: "ok",
    endpoint: "POST /v1/audit",
    dashboardEndpoint: "POST /v1/dashboard",
    metadataField: "metadata",
    requiredRoles: REQUIRED_FILE_ROLES,
    accessTokenRequired: Boolean(options.accessToken),
    n8nConfigured: Boolean(options.n8nWebhookUrl || options.n8nClient),
  }));

  server.post("/v1/audit", async (request, reply) => {
    requireAuthorization(request.headers.authorization, options.accessToken);
    const upload = await readUploadedCsv(request);
    return reply.status(200).send(await executeAudit(upload.metadata, upload.files));
  });

  server.post("/v1/dashboard", async (request, reply) => {
    requireAuthorization(request.headers.authorization, options.accessToken);
    const upload = await readUploadedCsv(request);
    const auditPayload = await executeAudit(upload.metadata, upload.files);
    const n8nResult = await callN8n(auditPayload, options);
    const withDeterministicAnalysis = isRecord(n8nResult) && n8nResult.analysis === undefined
      ? { ...n8nResult, analysis: auditPayload.analysis }
      : n8nResult;
    return reply.type("text/html; charset=utf-8").send(renderDashboard(parseDashboardInput(withDeterministicAnalysis)));
  });

  server.setErrorHandler((error, request, reply) => {
    const apiError = error instanceof AuditApiError
      ? error
      : error instanceof Error && error.name === "RequestFileTooLargeError"
        ? new AuditApiError(413, "FILE_TOO_LARGE", "Размер каждого CSV не должен превышать 5 МБ.")
        : new AuditApiError(422, "AUDIT_FAILED", error instanceof Error ? error.message : "Не удалось выполнить аудит.");

    if (request.url.startsWith("/v1/dashboard")) {
      return reply.status(apiError.statusCode).type("text/html; charset=utf-8").send(renderErrorPage(apiError));
    }
    if (!(error instanceof AuditApiError)) {
      request.log.error(error);
    }
    return reply.status(apiError.statusCode).send({
      status: "error",
      code: apiError.code,
      message: apiError.message,
      metadataFormat: "[{ submittedAt, formMode, checked_report, raw_monthly_shipments, projects_directory, projects_change_history, service_changes, flight_length }]",
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

  const server = await buildAuditApi({
    accessToken: process.env.API_ACCESS_TOKEN,
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
    n8nWebhookToken: process.env.N8N_WEBHOOK_TOKEN,
    n8nTimeoutMs: process.env.N8N_TIMEOUT_MS ? Number(process.env.N8N_TIMEOUT_MS) : undefined,
  });
  await server.listen({ port, host });
  server.log.info(`Audit API is listening on http://${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((error: unknown) => {
    console.error(`Не удалось запустить API: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
