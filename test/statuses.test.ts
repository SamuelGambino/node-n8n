import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildFlights } from "../src/flights.js";
import { buildClientHistories, buildInputIndexes } from "../src/indexes.js";
import { loadInputData } from "../src/loaders.js";
import { resolveFlightStatuses } from "../src/statuses.js";
import { buildProjectStates } from "../src/temporal-state.js";
import type { FlightStatus, ResolvedFlight, StatusResolutionResult } from "../src/types.js";

const dataDirectory = resolve(process.cwd(), "data");

function getFlight(
  result: StatusResolutionResult,
  clientId: string,
  flightNo: number,
): ResolvedFlight {
  const flight = result.flights.find(
    (item) => item.clientId === clientId && item.flightNo === flightNo,
  );
  assert.ok(flight, `Должен быть рассчитан флайт ${flightNo} клиента ${clientId}.`);
  return flight;
}

test("рассчитывает статусы флайтов по decision tree на дату report_generated_at", async () => {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const histories = buildClientHistories(indexes);
  const states = buildProjectStates(data, indexes);
  const flightBuild = buildFlights(data, indexes, histories, states);
  const result = resolveFlightStatuses(data, histories, flightBuild);

  assert.equal(result.reportGeneratedAt, "2025-09-01");
  assert.equal(result.flights.length, 17);
  assert.equal(result.issues.length, 4);

  const statusCounts = new Map<FlightStatus, number>();
  for (const flight of result.flights) {
    statusCounts.set(flight.status, (statusCounts.get(flight.status) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(statusCounts), {
    "пролонгировано": 4,
    "непролонгировано": 3,
    "отвал": 2,
    "завершился (разовые работы)": 1,
    NEEDS_REVIEW: 5,
    "неизвестно": 2,
  });

  assert.equal(getFlight(result, "301", 1).status, "пролонгировано");
  assert.equal(getFlight(result, "301", 2).status, "непролонгировано");
  assert.equal(getFlight(result, "304", 1).status, "завершился (разовые работы)");

  const earlyStop = getFlight(result, "303", 1);
  assert.equal(earlyStop.status, "отвал");
  assert.equal(earlyStop.lastActiveMonth, "2024-06-01");

  const deltaSecondFlight = getFlight(result, "321", 2);
  assert.equal(deltaSecondFlight.status, "NEEDS_REVIEW");
  assert.ok(deltaSecondFlight.statusIssues.some((issue) => issue.type === "IRREGULAR_ACTIVITY"));

  const quartzFirstFlight = getFlight(result, "330", 1);
  assert.equal(quartzFirstFlight.status, "NEEDS_REVIEW");
  assert.ok(quartzFirstFlight.statusIssues.some((issue) => issue.type === "DELAYED_RENEWAL"));

  const quartzSecondFlight = getFlight(result, "330", 2);
  assert.equal(quartzSecondFlight.status, "NEEDS_REVIEW");
  assert.ok(quartzSecondFlight.statusIssues.some((issue) => issue.type === "IRREGULAR_ACTIVITY"));

  const titanFlight = getFlight(result, "331", 1);
  assert.equal(titanFlight.status, "NEEDS_REVIEW");
  assert.match(titanFlight.statusComment, /услуга изменилась/);

  const sigmaSecondFlight = getFlight(result, "340", 2);
  assert.equal(sigmaSecondFlight.status, "NEEDS_REVIEW");
  assert.match(sigmaSecondFlight.statusComment, /После STOP/);

  assert.equal(getFlight(result, "350", 1).status, "пролонгировано");
  const orionSecondFlight = getFlight(result, "350", 2);
  assert.equal(orionSecondFlight.status, "неизвестно");
  assert.equal(orionSecondFlight.lastActiveMonth, "2025-09-01");
  assert.ok(
    orionSecondFlight.statusIssues.some((issue) => issue.type === "ACTIVITY_AFTER_REPORT_DATE"),
  );

  assert.equal(getFlight(result, "351", 1).status, "неизвестно");
});
