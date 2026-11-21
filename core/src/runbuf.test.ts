import { expect, test } from "bun:test";
import { RunBuffer } from "./runbuf";

test("Text wird zusammengefasst, Werkzeug-Updates ersetzen sich", () => {
  const b = new RunBuffer();
  b.start("a");
  b.add("a", { type: "delta", text: "Hal" });
  b.add("a", { type: "delta", text: "lo" });
  b.add("a", { type: "tool", id: "t1", status: "running" });
  b.add("a", { type: "tool", id: "t1", status: "completed" });
  b.add("a", { type: "delta", text: "Fertig" });
  expect(b.get("a")).toEqual([
    { type: "delta", text: "Hallo" },
    { type: "tool", id: "t1", status: "completed" },
    { type: "delta", text: "Fertig" },
  ]);
});

test("Chats sind getrennt, ohne Start wird nichts gemerkt, clear räumt auf", () => {
  const b = new RunBuffer();
  b.add("x", { type: "delta", text: "verloren" });
  expect(b.has("x")).toBe(false);
  b.start("a"); b.start("b");
  b.add("a", { type: "delta", text: "A" });
  b.add("b", { type: "delta", text: "B" });
  expect(b.get("a")[0].text).toBe("A");
  expect(b.get("b")[0].text).toBe("B");
  b.clear("a");
  expect(b.has("a")).toBe(false);
  expect(b.has("b")).toBe(true);
});
