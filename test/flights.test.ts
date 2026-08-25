import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildFlights } from "../src/flights.js";
import { buildClientHistories, buildInputIndexes } from "../src/indexes.js";
import { loadInputData } from "../src/loaders.js";
import { buildProjectStates } from "../src/temporal-state.js";
import type { Flight, FlightBuildResult } from "../src/types.js";

const dataDirectory = resolve(process.cwd(), "data");

function getClientFlights(result: FlightBuildResult, clientId: string): Flight[] {
  return result.flights.filter((flight) => flight.clientId === clientId);
}

test("выделяет непрерывные периоды и формирует флайты по срокам услуг", async () => {
  const data = await loadInputData(dataDirectory);
  const indexes = buildInputIndexes(data);
  const histories = buildClientHistories(indexes);
  const projectStates = buildProjectStates(data, indexes);
  const result = buildFlights(data, indexes, histories, projectStates);

  assert.equal(result.periods.length, 12);
  assert.equal(result.flights.length, 17);
  assert.equal(result.issues.length, 5);

  assert.deepEqual(
    getClientFlights(result, "301").map((flight) => [
      flight.flightNo,
      flight.flightStart,
      flight.flightEnd,
      flight.lastActiveMonth,
    ]),
    [
      [1, "2024-01-01", "2024-06-01", "2024-06-01"],
      [2, "2024-07-01", "2024-12-01", "2024-12-01"],
    ],
  );

  const gammaFlights = getClientFlights(result, "311");
  assert.deepEqual(gammaFlights[0]?.projectIds, ["310"]);
  assert.equal(gammaFlights[0]?.projectId, "310");
  assert.equal(gammaFlights[0]?.flightStart, "2024-01-01");
  assert.equal(gammaFlights[0]?.flightEnd, "2024-06-01");
  assert.deepEqual(gammaFlights[1]?.projectIds, ["311"]);
  assert.equal(gammaFlights[1]?.flightStart, "2024-07-01");

  const deltaFirstFlight = getClientFlights(result, "321")[0];
  assert.deepEqual(deltaFirstFlight?.projectIds, ["320", "321"]);
  assert.equal(deltaFirstFlight?.flightStart, "2024-01-01");
  assert.equal(deltaFirstFlight?.flightEnd, "2024-06-01");

  const earlyStopFlight = getClientFlights(result, "303")[0];
  assert.equal(earlyStopFlight?.plannedFlightEnd, "2024-08-01");
  assert.equal(earlyStopFlight?.flightEnd, "2024-07-01");
  assert.equal(earlyStopFlight?.lastActiveMonth, "2024-06-01");
  assert.equal(earlyStopFlight?.stopMonth, "2024-07-01");
  assert.ok(earlyStopFlight?.issues.some((issue) => issue.type === "STOP_EVENT"));

  const quartzFlights = getClientFlights(result, "330");
  assert.deepEqual(
    quartzFlights.map((flight) => [
      flight.flightNo,
      flight.serviceType,
      flight.termMonths,
      flight.flightStart,
      flight.flightEnd,
    ]),
    [
      [1, "Крауд-маркетинг", 6, "2024-01-01", "2024-06-01"],
      [2, "Мониторинг СМИ", 12, "2024-11-01", "2025-10-01"],
    ],
  );
  assert.ok(quartzFlights[1]?.issues.some((issue) => issue.type === "ACTIVITY_GAP"));

  const titanFlight = getClientFlights(result, "331")[0];
  assert.equal(titanFlight?.serviceType, "Мониторинг СМИ");
  assert.equal(titanFlight?.termMonths, 12);
  assert.ok(titanFlight?.issues.some((issue) => issue.type === "SERVICE_CHANGE_IN_FLIGHT"));

  const sigmaFlights = getClientFlights(result, "340");
  assert.deepEqual(
    sigmaFlights.map((flight) => [
      flight.flightNo,
      flight.flightStart,
      flight.flightEnd,
      flight.lastActiveMonth,
      flight.stopMonth,
    ]),
    [
      [1, "2024-01-01", "2024-05-01", "2024-04-01", "2024-05-01"],
      [2, "2024-06-01", "2024-11-01", "2024-09-01", null],
    ],
  );
  assert.ok(sigmaFlights[1]?.issues.some((issue) => issue.type === "POST_STOP_CONTINUATION"));

  assert.deepEqual(
    getClientFlights(result, "350").map((flight) => [flight.flightStart, flight.flightEnd]),
    [
      ["2025-03-01", "2025-08-01"],
      ["2025-09-01", "2026-02-01"],
    ],
  );
});
