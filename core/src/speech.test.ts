import { test, expect } from "bun:test";
import { SentenceSplitter, clean } from "./speech";

test("gibt fertige Sätze sofort aus", () => {
  const s = new SentenceSplitter();
  expect(s.push("Hallo Benjamin. Wie")).toEqual(["Hallo Benjamin."]);
  expect(s.push(" geht es dir? Gut")).toEqual(["Wie geht es dir?"]);
  expect(s.flush()).toEqual(["Gut"]);
});
test("liest keinen Code und kein Markdown vor", () => {
  const s = new SentenceSplitter();
  const out = [...s.push("Hier **fett**: ```js\nlet a = 1;\n``` Fertig. "), ...s.flush()];
  expect(out.join(" ")).not.toContain("let a");
  expect(out.join(" ")).toContain("fett");
  expect(clean("Siehe [Link](https://x.de) 🙂 und https://y.de")).toBe("Siehe Link und");
});

test("gibt einen fertigen Satz ohne folgendes Leerzeichen frei, sobald der Strom pausiert", () => {
  const s = new SentenceSplitter();
  expect(s.push("Ich öffne Gemini, einen Moment.")).toEqual([]);       // wartet auf ein Leerzeichen danach
  expect(s.flushIfSentence()).toEqual(["Ich öffne Gemini, einen Moment."]);
  expect(s.push("Ich bin noch mitten im")).toEqual([]);
  expect(s.flushIfSentence()).toEqual([]);                             // unvollständig: nicht zerhacken
});
