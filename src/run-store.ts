import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

export type RunStatus = "processing" | "completed" | "failed";

export interface StoredRun {
  version: 1;
  id: string;
  viewToken: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Детерминированный результат, отправленный в n8n и нужный для fallback analysis. */
  auditPayload: unknown;
  /** Финальный JSON из n8n с final_report_csv и audit_md. */
  n8nResult?: unknown;
  error?: { code: string; message: string };
}

interface FileRunStoreOptions {
  directory: string;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * Минимальное временное хранилище запусков. Каждый запуск лежит в отдельном
 * JSON-файле, поэтому long-running n8n workflow не привязан к HTTP-соединению
 * браузера. Файлы безопасно удаляются при следующем обращении после истечения TTL.
 */
export class FileRunStore {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  public constructor(private readonly options: FileRunStoreOptions) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("RUN_TTL_MS должен быть положительным числом миллисекунд.");
    }
  }

  public async create(auditPayload: unknown): Promise<StoredRun> {
    await this.cleanupExpired();
    const now = this.now();
    const run: StoredRun = {
      version: 1,
      id: randomUUID(),
      viewToken: randomBytes(24).toString("base64url"),
      status: "processing",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      auditPayload,
    };
    await this.write(run);
    return run;
  }

  public async read(id: string): Promise<StoredRun | undefined> {
    this.assertRunId(id);
    await this.cleanupExpired();
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      const parsed = JSON.parse(raw) as StoredRun;
      if (!this.isStoredRun(parsed)) {
        await rm(this.pathFor(id), { force: true });
        return undefined;
      }
      return parsed;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async complete(id: string, n8nResult: unknown): Promise<StoredRun | undefined> {
    return this.update(id, (run) => ({ ...run, status: "completed", n8nResult, error: undefined }));
  }

  public async fail(id: string, code: string, message: string): Promise<StoredRun | undefined> {
    return this.update(id, (run) => ({ ...run, status: "failed", error: { code, message } }));
  }

  public async cleanupExpired(): Promise<number> {
    await mkdir(this.options.directory, { recursive: true });
    const now = this.now().getTime();
    const files = await readdir(this.options.directory, { withFileTypes: true });
    let removed = 0;

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) {
        continue;
      }
      const filePath = join(this.options.directory, file.name);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<StoredRun>;
        if (typeof parsed.expiresAt !== "string" || Date.parse(parsed.expiresAt) <= now) {
          await rm(filePath, { force: true });
          removed += 1;
        }
      } catch {
        // Повреждённый временный файл не должен блокировать следующие запуски.
        await rm(filePath, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async update(id: string, updater: (run: StoredRun) => StoredRun): Promise<StoredRun | undefined> {
    const current = await this.read(id);
    if (!current) {
      return undefined;
    }
    const updated = { ...updater(current), updatedAt: this.now().toISOString() };
    await this.write(updated);
    return updated;
  }

  private async write(run: StoredRun): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const target = this.pathFor(run.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private pathFor(id: string): string {
    this.assertRunId(id);
    return join(this.options.directory, `${id}.json`);
  }

  private assertRunId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Некорректный идентификатор запуска.");
    }
  }

  private isStoredRun(value: unknown): value is StoredRun {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const run = value as Partial<StoredRun>;
    return run.version === 1
      && typeof run.id === "string"
      && typeof run.viewToken === "string"
      && (run.status === "processing" || run.status === "completed" || run.status === "failed")
      && typeof run.createdAt === "string"
      && typeof run.updatedAt === "string"
      && typeof run.expiresAt === "string";
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
