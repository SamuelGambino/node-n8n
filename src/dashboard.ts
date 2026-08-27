import { CsvParseError, parseSemicolonCsv, type CsvRow } from "./csv.js";

export interface DashboardInput {
  finalReportCsv: string;
  auditMarkdown: string;
  analysis?: unknown;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function unwrapSingleN8nItem(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) {
    return value[0];
  }
  return value;
}

function removeMarkdownFence(value: string): string {
  const fenced = value.match(/^```(?:csv|text|plaintext)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1]!.trim() : value.trim();
}

/**
 * Некоторые ИИ-узлы возвращают не текст, а сериализованное сообщение вида
 * { parts: [{ text, thoughtSignature }] }. Извлекаем только text и никогда
 * не подаём JSON-обёртку в CSV-парсер.
 */
function unwrapAiText(value: unknown): string | undefined {
  let current = unwrapSingleN8nItem(value);

  for (let depth = 0; depth < 4; depth += 1) {
    const text = asNonEmptyString(current);
    if (text) {
      if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
        try {
          current = JSON.parse(text);
          continue;
        } catch {
          return removeMarkdownFence(text);
        }
      }
      return removeMarkdownFence(text);
    }

    if (Array.isArray(current)) {
      const partTexts = current
        .filter(isRecord)
        .map((part) => asNonEmptyString(part.text))
        .filter((part): part is string => part !== undefined);
      if (partTexts.length > 0) {
        return removeMarkdownFence(partTexts.join("\n"));
      }
      current = unwrapSingleN8nItem(current);
      continue;
    }

    if (isRecord(current)) {
      if (Array.isArray(current.parts)) {
        const partTexts = current.parts
          .filter(isRecord)
          .map((part) => asNonEmptyString(part.text))
          .filter((part): part is string => part !== undefined);
        if (partTexts.length > 0) {
          return removeMarkdownFence(partTexts.join("\n"));
        }
      }

      const nested = current.text ?? current.content ?? current.output;
      if (nested !== undefined) {
        current = nested;
        continue;
      }
    }

    break;
  }

  return undefined;
}

function validateFinalReportCsv(value: string): string {
  if (!value.startsWith("client_id;")) {
    throw new Error(
      "n8n вернул final_report_csv не как CSV: ожидается строка заголовков, начинающаяся с «client_id;». " +
      "В финальном Code/Merge node передайте извлечённый текст ИИ, а не весь JSON-объект ответа модели.",
    );
  }

  try {
    const rows = parseSemicolonCsv(value, "final_report_csv");
    if (rows.length === 0) {
      throw new Error("CSV содержит только заголовок без строк.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `n8n вернул неполный или некорректный final_report_csv: ${detail} ` +
      "Проверьте, что ИИ выдал CSV целиком, увеличьте лимит выходных токенов и передайте в Respond to Webhook только текст CSV.",
    );
  }

  return value;
}

/**
 * Принимает единственный JSON, который n8n возвращает после двух ИИ-вызовов.
 * Поддерживает типичные обёртки n8n и ИИ, но в Dashboard передаёт только чистый CSV/Markdown.
 */
export function parseDashboardInput(value: unknown): DashboardInput {
  const item = unwrapSingleN8nItem(value);
  if (!isRecord(item)) {
    throw new Error("n8n должен вернуть JSON-объект с полями final_report_csv и audit_md.");
  }

  const finalReportCsv = unwrapAiText(item.final_report_csv);
  const auditMarkdown = unwrapAiText(item.audit_md);
  if (!finalReportCsv || !auditMarkdown) {
    throw new Error(
      "В ответе n8n отсутствуют читаемые final_report_csv или audit_md. " +
      "Убедитесь, что финальный Code/Merge node возвращает текст, а не объект сообщения ИИ.",
    );
  }

  return {
    finalReportCsv: validateFinalReportCsv(finalReportCsv),
    auditMarkdown,
    analysis: item.analysis,
  };
}

function analysisCount(analysis: unknown, key: "Issues" | "Questions"): number {
  if (!isRecord(analysis)) {
    return 0;
  }
  return Array.isArray(analysis[key]) ? analysis[key].length : 0;
}

function statusDistribution(rows: CsvRow[]): Map<string, number> {
  return rows.reduce<Map<string, number>>((counts, row) => {
    const status = row.status || "не указан";
    counts.set(status, (counts.get(status) ?? 0) + 1);
    return counts;
  }, new Map());
}

function renderStatusBadges(rows: CsvRow[]): string {
  return [...statusDistribution(rows)]
    .map(([status, count]) => `<span class="status-badge">${escapeHtml(status)} <b>${count}</b></span>`)
    .join("");
}

function renderTable(rows: CsvRow[]): string {
  if (rows.length === 0) {
    return "<p class=\"empty\">Итоговый отчёт не содержит строк.</p>";
  }
  const headers = Object.keys(rows[0]!);
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const bodyHtml = rows.map((row) => {
    const searchText = headers.map((header) => row[header] ?? "").join(" ").toLowerCase();
    const status = row.status ?? "";
    return `<tr data-search="${escapeHtml(searchText)}" data-status="${escapeHtml(status)}">${headers
      .map((header) => `<td>${escapeHtml(row[header] ?? "")}</td>`)
      .join("")}</tr>`;
  }).join("");

  return `<div class="table-wrap"><table id="report-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderAuditMarkdown(markdown: string): string {
  // Markdown остаётся текстом, чтобы результат ИИ не мог внедрить HTML/JS в страницу.
  return `<pre class="audit-markdown">${escapeHtml(markdown)}</pre>`;
}

function renderAnalysisList(analysis: unknown, key: "Issues" | "Questions", emptyText: string): string {
  if (!isRecord(analysis) || !Array.isArray(analysis[key]) || analysis[key].length === 0) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }

  return `<div class="analysis-list">${analysis[key].map((item, index) => {
    const serialized = typeof item === "string" ? item : JSON.stringify(item, null, 2);
    return `<details><summary>${key === "Issues" ? "Факт аудита" : "Вопрос к заказчику"} ${index + 1}</summary><pre>${escapeHtml(serialized)}</pre></details>`;
  }).join("")}</div>`;
}

/**
 * Формирует самостоятельный HTML-документ из временно сохранённого результата.
 * Исходные CSV не сохраняются, а готовые CSV/Markdown удаляются вместе с run по TTL.
 */
export function renderDashboard(input: DashboardInput): string {
  let rows: CsvRow[];
  try {
    rows = parseSemicolonCsv(input.finalReportCsv, "final_report_csv");
  } catch (error) {
    const message = error instanceof CsvParseError ? error.message : String(error);
    throw new Error(`Невозможно отобразить final_report_csv: ${message}`);
  }

  const statusOptions = [...statusDistribution(rows).keys()]
    .map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`)
    .join("");
  const reportJson = JSON.stringify(input.finalReportCsv).replace(/</g, "\\u003c");
  const auditJson = JSON.stringify(input.auditMarkdown).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Результат аудита отчёта</title>
  <style>
    :root { --ink:#1d2632; --muted:#617085; --line:#dce3eb; --bg:#f4f7fb; --card:#fff; --accent:#1463d8; --warn:#b45309; }
    * { box-sizing:border-box; } body { margin:0; color:var(--ink); background:var(--bg); font:14px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
    header { background:#132d4f; color:#fff; padding:38px max(20px, calc((100vw - 1280px)/2)); } h1 { margin:0 0 8px; font-size:28px; } h2 { margin:0 0 16px; font-size:20px; } .subtitle { margin:0; color:#c7d7ec; }
    main { max-width:1280px; margin:0 auto; padding:24px 20px 48px; } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px; margin-bottom:24px; }
    .card, section { background:var(--card); border:1px solid var(--line); border-radius:12px; box-shadow:0 3px 12px rgb(20 45 78 / 5%); } .card { padding:16px; } .metric { color:var(--muted); font-size:12px; } .number { margin-top:4px; font-size:28px; font-weight:700; }
    section { padding:22px; margin-top:18px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } input, select, button { font:inherit; border:1px solid #bdc9d8; border-radius:8px; padding:9px 11px; background:#fff; } input { min-width:260px; } button { cursor:pointer; background:var(--accent); color:#fff; border-color:var(--accent); }
    .status-badge { display:inline-flex; gap:6px; margin:0 7px 8px 0; padding:5px 9px; color:#37465b; background:#edf3fb; border-radius:999px; } .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; } table { width:100%; min-width:1000px; border-collapse:collapse; } th { position:sticky; top:0; text-align:left; background:#edf3fb; color:#33465e; } th, td { padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; } td { max-width:330px; white-space:pre-wrap; } tr:last-child td { border-bottom:0; }
    .audit-markdown, details pre { white-space:pre-wrap; overflow:auto; margin:0; padding:14px; color:#26384e; background:#f7f9fc; border-radius:8px; font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; } details { padding:10px 0; border-bottom:1px solid var(--line); } details:last-child { border-bottom:0; } summary { cursor:pointer; font-weight:600; } details pre { margin-top:10px; } .empty { color:var(--muted); } .notice { color:var(--warn); }
  </style>
</head>
<body>
  <header><h1>Результат аудита отчёта</h1><p class="subtitle">Результат временно доступен по этой защищённой ссылке до истечения срока хранения.</p></header>
  <main>
    <div class="grid">
      <div class="card"><div class="metric">Строк в новом отчёте</div><div class="number">${rows.length}</div></div>
      <div class="card"><div class="metric">Фактов аудита</div><div class="number">${analysisCount(input.analysis, "Issues")}</div></div>
      <div class="card"><div class="metric">Вопросов заказчику</div><div class="number">${analysisCount(input.analysis, "Questions")}</div></div>
      <div class="card"><div class="metric">Источник</div><div class="number" style="font-size:16px">n8n + ИИ</div></div>
    </div>
    <section><h2>Статусы нового отчёта</h2>${renderStatusBadges(rows)}</section>
    <section>
      <h2>Новый итоговый отчёт</h2>
      <div class="toolbar"><input id="search" type="search" placeholder="Поиск по клиенту, проекту, комментарию"><select id="status"><option value="">Все статусы</option>${statusOptions}</select><button id="download-report" type="button">Скачать итоговый CSV</button></div>
      ${renderTable(rows)}
    </section>
    <section><div class="toolbar"><h2 style="margin:0 auto 0 0">Аудит</h2><button id="download-audit" type="button">Скачать audit.md</button></div>${renderAuditMarkdown(input.auditMarkdown)}</section>
    <section><h2>Факты аудита</h2>${renderAnalysisList(input.analysis, "Issues", "Факты аудита не были возвращены n8n.")}</section>
    <section><h2>Вопросы к заказчику</h2>${renderAnalysisList(input.analysis, "Questions", "Вопросы к заказчику отсутствуют.")}</section>
  </main>
  <script>
    const search = document.getElementById('search'); const status = document.getElementById('status'); const rows = [...document.querySelectorAll('#report-table tbody tr')];
    function filterRows() { const query = search.value.toLowerCase(); const selected = status.value; rows.forEach((row) => { row.hidden = (query && !row.dataset.search.includes(query)) || (selected && row.dataset.status !== selected); }); }
    search?.addEventListener('input', filterRows); status?.addEventListener('change', filterRows);
    function downloadFile(content, filename, mimeType) { const blob = new Blob([content], { type: mimeType }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); }
    document.getElementById('download-report')?.addEventListener('click', () => downloadFile(${reportJson}, 'report_final.csv', 'text/csv;charset=utf-8'));
    document.getElementById('download-audit')?.addEventListener('click', () => downloadFile(${auditJson}, 'audit.md', 'text/markdown;charset=utf-8'));
  </script>
</body>
</html>`;
}
