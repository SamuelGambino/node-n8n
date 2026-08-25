import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildInputIndexes } from "../src/indexes.js";
import { loadInputData } from "../src/loaders.js";
import {
  buildProjectStates,
  projectStateKey,
  resolveProjectState,
} from "../src/temporal-state.js";
import type { ProjectStateResult } from "../src/types.js";

const dataDirectory = resolve(process.cwd(), "data");

function getState(
  result: ProjectStateResult,
  projectId: string,
  month: `${number}-${string}`,
) {
  const state = result.stateByProjectAndMonth.get(projectStateKey(projectId, month));
  assert.ok(state, `Состояние для project_id ${projectId} за ${month} должно быть рассчитано.`);
  return state;
}

test("восстанавливает временные атрибуты проектов по месяцам", async () => {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const result = buildProjectStates(data, indexes);

  assert.equal(result.states.length, 96);

  assert.deepEqual(getState(result, "310", "2024-06-01"), {
    projectId: "310",
    month: "2024-06-01",
    projectName: "Гамма Ритейл",
    serviceType: "Управление репутацией",
    termMonths: 6,
    projectType: "Обычный",
  });

  assert.deepEqual(getState(result, "311", "2024-07-01"), {
    projectId: "311",
    month: "2024-07-01",
    projectName: "Гамма Ритейл Про",
    serviceType: "Управление репутацией",
    termMonths: 6,
    projectType: "Обычный",
  });

  assert.equal(getState(result, "320", "2024-03-01").projectName, "Дельта Пиар");
  assert.equal(getState(result, "321", "2024-04-01").projectName, "Дельта Реклама");

  const stateBefore330Change = getState(result, "330", "2024-06-01");
  assert.equal(stateBefore330Change.serviceType, "Крауд-маркетинг");
  assert.equal(stateBefore330Change.termMonths, 6);

  const stateAfter330Change = resolveProjectState("330", "2024-07-01", indexes).state;
  assert.equal(stateAfter330Change.serviceType, "Мониторинг СМИ");
  assert.equal(stateAfter330Change.termMonths, 12);

  const stateBefore331Change = getState(result, "331", "2024-06-01");
  assert.equal(stateBefore331Change.serviceType, "Мониторинг СМИ");
  assert.equal(stateBefore331Change.termMonths, 12);

  const stateAfter331Change = getState(result, "331", "2024-07-01");
  assert.equal(stateAfter331Change.serviceType, "Управление репутацией");
  assert.equal(stateAfter331Change.termMonths, 6);

  assert.equal(result.issues.length, 12);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.projectId === "330" &&
        issue.month === "2024-06-01" &&
        issue.type === "DATA_CONFLICT",
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.projectId === "331" &&
        issue.month === "2024-06-01" &&
        issue.type === "DATA_CONFLICT",
    ),
  );
});
