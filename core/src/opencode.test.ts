import { test, expect } from "bun:test";
import { parseModels } from "./opencode";
test("gruppiert Modelle", () => {
  const m = parseModels("opencode/big-pickle\nlmstudio/qwen/qwen3.5-9b\nopencode/nemotron-3.5-super-vl-free\nnoise");
  expect(m.map(x => x.group)).toEqual(["free", "lmstudio", "free"]);
  expect(m[2].vision).toBe(true);
});
