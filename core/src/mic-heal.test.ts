import { test, expect } from "bun:test";
import { nextMicStep, type InputDevice } from "./mic-heal";

const devs: InputDevice[] = [
  { id: 4, name: "Virtuelles Mikrofon", default: false },
  { id: 2, name: "MacBook Pro-Mikrofon", default: true },
  { id: 7, name: "AirPods", default: false },
];

test("erst Neustart, dann echte Geräte vor virtuellen, dann aufgeben", () => {
  expect(nextMicStep(false, devs, new Set([2]))).toEqual({ action: "restart" });
  expect(nextMicStep(true, devs, new Set([2]))).toEqual({ action: "device", id: 7, name: "AirPods" });
  expect(nextMicStep(true, devs, new Set([2, 7]))).toEqual({ action: "device", id: 4, name: "Virtuelles Mikrofon" });
  expect(nextMicStep(true, devs, new Set([2, 7, 4]))).toEqual({ action: "giveup" });
  expect(nextMicStep(true, [], new Set())).toEqual({ action: "giveup" });
});
