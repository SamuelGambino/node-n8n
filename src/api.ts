import "dotenv/config";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";

import { runAudit } from "./audit.js";
import { parseDashboardInput, renderDashboard } from "./dashboard.js";
import { FileRunStore, type StoredRun } from "./run-store.js";
import { renderUploadPage, renderWaitingPage } from "./upload-page.js";

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

/** Метаданные одного запуска: каждая роль указывает на имя бинарного multipart-поля. */
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

interface N8nStartPayload {
  run_id: string;
  callback_url: string;
  audit: AuditPayload;
}

interface AuditApiOptions {
  accessToken?: string;
  n8nWebhookUrl?: string;
  n8nWebhookToken?: string;
  n8nCallbackToken?: string;
  /** Публичный базовый URL Render без завершающего слеша. */
  publicBaseUrl?: string;
  runStore?: FileRunStore;
  runStoreDirectory?: string;
  runTtlMs?: number;
  n8nStartTimeoutMs?: number;
  /** Используется в тестах и позволяет не вызывать реальный n8n webhook. */
  n8nLauncher?: (payload: N8nStartPayload) => Promise<void>;
}

/** Контролируемая ошибка, безопасная для возврата браузеру и n8n. */
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
    throw new AuditApiError(400, "MISSING_METADATA", "Добавьте текстовое multipart-поле metadata с массивом из одного объекта ролей файлов.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuditApiError(400, "INVALID_METADATA", "Поле metadata должно содержать корректный JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new AuditApiError(400, "INVALID_METADATA", "Поле metadata должно быть массивом ровно с одним объектом, как в согласованном формате.");
  }

  const candidate = parsed[0];
  for (const field of ["submittedAt", "formMode", ...REQUIRED_FILE_ROLES]) {
    if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
      throw new AuditApiError(400, "INVALID_METADATA", `В metadata должно присутствовать непустое строковое поле «${field}».`);
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
      throw new AuditApiError(400, "DUPLICATE_FILE_REFERENCE", `В metadata имя «${uploadedFieldName}» назначено нескольким ролям файлов.`);
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

/** Выполняет аудит во временной директории; исходные CSV удаляются до возврата из функции. */
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

function baseUrl(options: AuditApiOptions): string {
  const value = options.publicBaseUrl?.trim().replace(/\/+$/, "");
  if (!value) {
    throw new AuditApiError(503, "PUBLIC_BASE_URL_NOT_CONFIGURED", "Для асинхронного dashboard задайте PUBLIC_BASE_URL, например https://your-app.onrender.com.");
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new AuditApiError(503, "PUBLIC_BASE_URL_INVALID", "PUBLIC_BASE_URL должен быть абсолютным HTTP(S)-URL.");
  }
  return value;
}

function callbackUrl(runId: string, options: AuditApiOptions): string {
  return `${baseUrl(options)}/v1/runs/${runId}/result`;
}

async function startN8n(run: StoredRun, options: AuditApiOptions): Promise<void> {
  const payload: N8nStartPayload = {
    run_id: run.id,
    callback_url: callbackUrl(run.id, options),
    audit: run.auditPayload as AuditPayload,
  };
  if (options.n8nLauncher) {
    await options.n8nLauncher(payload);
    return;
  }
  if (!options.n8nWebhookUrl) {
    throw new AuditApiError(503, "N8N_NOT_CONFIGURED", "Для запуска обработки настройте N8N_WEBHOOK_URL.");
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
      signal: AbortSignal.timeout(options.n8nStartTimeoutMs ?? 20_000),
    });
  } catch (error) {
    throw new AuditApiError(502, "N8N_START_UNAVAILABLE", `Не удалось запустить n8n: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new AuditApiError(502, "N8N_START_ERROR", `n8n не принял запуск: HTTP ${response.status}: ${detail}`);
  }
}

function readViewToken(request: FastifyRequest): string | undefined {
  const url = new URL(request.raw.url ?? "/", "http://localhost");
  return url.searchParams.get("token") ?? undefined;
}

function requireViewToken(run: StoredRun, request: FastifyRequest): void {
  if (readViewToken(request) !== run.viewToken) {
    throw new AuditApiError(404, "RUN_NOT_FOUND", "Запуск не найден или ссылка на результат недействительна.");
  }
}

function publicRun(run: StoredRun, options: AuditApiOptions): Record<string, unknown> {
  const token = encodeURIComponent(run.viewToken);
  return {
    run_id: run.id,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    expires_at: run.expiresAt,
    status_url: `${baseUrl(options)}/v1/runs/${run.id}/status?token=${token}`,
    dashboard_url: `${baseUrl(options)}/runs/${run.id}?token=${token}`,
  };
}

function renderErrorPage(error: AuditApiError | Error): string {
  const message = error.message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Ошибка обработки</title><style>body{margin:0;padding:40px;background:#f4f7fb;color:#1d2632;font:16px system-ui}main{max-width:700px;margin:auto;padding:28px;background:#fff;border:1px solid #dce3eb;border-radius:12px}a{color:#1463d8}</style><main><h1>Не удалось сформировать дашборд</h1><p>${message}</p><p><a href="/">Вернуться к загрузке файлов</a></p></main></html>`;
}

function isBrowserRunRequest(request: FastifyRequest): boolean {
  return request.url.startsWith("/runs/")
    || (request.url === "/v1/runs" && request.headers.accept?.includes("text/html") === true);
}

/**
 * API поддерживает два режима. POST /v1/audit сразу возвращает детерминированные
 * данные, а POST /v1/runs запускает долгий n8n workflow асинхронно и возвращает
 * браузеру страницу ожидания. Финальный callback хранится во временном JSON.
 */
export async function buildAuditApi(options: AuditApiOptions = {}): Promise<FastifyInstance> {
  const store = options.runStore ?? new FileRunStore({
    directory: options.runStoreDirectory ?? join(process.cwd(), "temp-db"),
    ttlMs: options.runTtlMs,
  });
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
    startEndpoint: "POST /v1/runs",
    callbackEndpoint: "POST /v1/runs/:runId/result",
    metadataField: "metadata",
    requiredRoles: REQUIRED_FILE_ROLES,
    accessTokenRequired: Boolean(options.accessToken),
    n8nConfigured: Boolean(options.n8nWebhookUrl || options.n8nLauncher),
    callbackSecured: Boolean(options.n8nCallbackToken),
  }));

  server.post("/v1/audit", async (request, reply) => {
    requireAuthorization(request.headers.authorization, options.accessToken);
    const upload = await readUploadedCsv(request);
    return reply.status(200).send(await executeAudit(upload.metadata, upload.files));
  });

  server.post("/v1/runs", async (request, reply) => {
    if (!options.n8nCallbackToken) {
      throw new AuditApiError(503, "CALLBACK_NOT_CONFIGURED", "Для асинхронного dashboard задайте N8N_CALLBACK_TOKEN.");
    }
    if (!options.n8nWebhookUrl && !options.n8nLauncher) {
      throw new AuditApiError(503, "N8N_NOT_CONFIGURED", "Для запуска обработки настройте N8N_WEBHOOK_URL.");
    }
    baseUrl(options);
    const upload = await readUploadedCsv(request);
    const auditPayload = await executeAudit(upload.metadata, upload.files);
    const run = await store.create(auditPayload);
    try {
      await startN8n(run, options);
    } catch (error) {
      const apiError = error instanceof AuditApiError
        ? error
        : new AuditApiError(502, "N8N_START_FAILED", error instanceof Error ? error.message : "Не удалось запустить n8n.");
      await store.fail(run.id, apiError.code, apiError.message);
    }
    return reply.status(303).header("Location", `/runs/${run.id}?token=${encodeURIComponent(run.viewToken)}`).send();
  });

  server.get("/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await store.read(runId);
    if (!run) {
      throw new AuditApiError(404, "RUN_NOT_FOUND", "Запуск не найден или срок временного хранения истёк.");
    }
    requireViewToken(run, request);
    if (run.status === "processing") {
      return reply.type("text/html; charset=utf-8").send(renderWaitingPage(run.id, run.viewToken));
    }
    if (run.status === "failed") {
      return reply.status(502).type("text/html; charset=utf-8").send(renderErrorPage(new AuditApiError(502, run.error?.code ?? "N8N_FAILED", run.error?.message ?? "Обработка в n8n завершилась ошибкой.")));
    }

    const withDeterministicAnalysis = isRecord(run.n8nResult) && run.n8nResult.analysis === undefined
      ? { ...run.n8nResult, analysis: (run.auditPayload as AuditPayload).analysis }
      : run.n8nResult;
    return reply.type("text/html; charset=utf-8").send(renderDashboard(parseDashboardInput(withDeterministicAnalysis)));
  });

  server.get("/v1/runs/:runId/status", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await store.read(runId);
    if (!run) {
      throw new AuditApiError(404, "RUN_NOT_FOUND", "Запуск не найден или срок временного хранения истёк.");
    }
    requireViewToken(run, request);
    return reply.send({ ...publicRun(run, options), error: run.error });
  });

  server.post("/v1/runs/:runId/result", async (request, reply) => {
    if (!options.n8nCallbackToken) {
      throw new AuditApiError(503, "CALLBACK_NOT_CONFIGURED", "Для приёма результата n8n задайте N8N_CALLBACK_TOKEN.");
    }
    requireAuthorization(request.headers.authorization, options.n8nCallbackToken);
    const runId = (request.params as { runId: string }).runId;
    const run = await store.read(runId);
    if (!run) {
      throw new AuditApiError(404, "RUN_NOT_FOUND", "Запуск не найден или срок временного хранения истёк.");
    }

    try {
      const normalized = parseDashboardInput(request.body);
      const result = {
        final_report_csv: normalized.finalReportCsv,
        audit_md: normalized.auditMarkdown,
        analysis: normalized.analysis,
      };
      await store.complete(runId, result);
      return reply.status(200).send({ status: "completed", run_id: runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "n8n вернул некорректный итоговый результат.";
      await store.fail(runId, "N8N_RESULT_INVALID", message);
      throw new AuditApiError(422, "N8N_RESULT_INVALID", message);
    }
  });

  server.setErrorHandler((error, request, reply) => {
    const apiError = error instanceof AuditApiError
      ? error
      : error instanceof Error && error.name === "RequestFileTooLargeError"
        ? new AuditApiError(413, "FILE_TOO_LARGE", "Размер каждого CSV не должен превышать 5 МБ.")
        : new AuditApiError(422, "AUDIT_FAILED", error instanceof Error ? error.message : "Не удалось выполнить аудит.");

    if (isBrowserRunRequest(request)) {
      return reply.status(apiError.statusCode).type("text/html; charset=utf-8").send(renderErrorPage(apiError));
    }
    if (!(error instanceof AuditApiError)) {
      request.log.error(error);
    }
    return reply.status(apiError.statusCode).send({ status: "error", code: apiError.code, message: apiError.message });
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
    n8nCallbackToken: process.env.N8N_CALLBACK_TOKEN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    runStoreDirectory: process.env.RUN_STORE_DIR,
    runTtlMs: process.env.RUN_TTL_MS ? Number(process.env.RUN_TTL_MS) : undefined,
    n8nStartTimeoutMs: process.env.N8N_START_TIMEOUT_MS ? Number(process.env.N8N_START_TIMEOUT_MS) : undefined,
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
