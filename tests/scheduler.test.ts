import test from "node:test";
import assert from "node:assert/strict";

import { getLatestDueTime } from "../src/scheduler.ts";
import type { ScheduleDefinition } from "../src/models.ts";

test("scheduler resolves hourly jobs to the current local hour", () => {
  const now = new Date(2026, 4, 21, 14, 37, 12, 0);
  const due = getLatestDueTime({ kind: "hourly" }, now);
  assert.ok(due);
  assert.equal(due.getFullYear(), 2026);
  assert.equal(due.getMonth(), 4);
  assert.equal(due.getDate(), 21);
  assert.equal(due.getHours(), 14);
  assert.equal(due.getMinutes(), 0);
});

test("scheduler resolves daily jobs to the latest local occurrence", () => {
  const schedule: ScheduleDefinition = { kind: "daily", time: "16:45" };

  const sameDay = getLatestDueTime(schedule, new Date(2026, 4, 21, 18, 0, 0, 0));
  assert.ok(sameDay);
  assert.equal(sameDay.getDate(), 21);
  assert.equal(sameDay.getHours(), 16);
  assert.equal(sameDay.getMinutes(), 45);

  const previousDay = getLatestDueTime(schedule, new Date(2026, 4, 21, 12, 0, 0, 0));
  assert.ok(previousDay);
  assert.equal(previousDay.getDate(), 20);
  assert.equal(previousDay.getHours(), 16);
  assert.equal(previousDay.getMinutes(), 45);
});

test("scheduler resolves weekly jobs to the latest local weekday occurrence", () => {
  const schedule: ScheduleDefinition = { kind: "weekly", weekday: "friday", time: "09:30" };

  const sameWeek = getLatestDueTime(schedule, new Date(2026, 4, 22, 12, 0, 0, 0));
  assert.ok(sameWeek);
  assert.equal(sameWeek.getDay(), 5);
  assert.equal(sameWeek.getDate(), 22);
  assert.equal(sameWeek.getHours(), 9);
  assert.equal(sameWeek.getMinutes(), 30);

  const previousWeek = getLatestDueTime(schedule, new Date(2026, 4, 22, 8, 0, 0, 0));
  assert.ok(previousWeek);
  assert.equal(previousWeek.getDay(), 5);
  assert.equal(previousWeek.getDate(), 15);
  assert.equal(previousWeek.getHours(), 9);
  assert.equal(previousWeek.getMinutes(), 30);
});
