// Regressionstest: Abbrechen und sofort neu fragen. Der neue Lauf muss seinen Text liefern.
// bun scripts/abort-test.ts [mitWarten=1|0]
import { OpenCode } from "../src/opencode";
const wait = process.argv[2] !== "0";
const oc = new OpenCode(4096); await oc.start();
const model = "opencode/nemotron-3.5-lightning-free";
let failures = 0;
for (let round = 1; round <= 4; round++) {
  const sid = await oc.createSession("Test");
  let textB = "", doneB = false;
  await oc.prompt(sid, "Erzähle mir eine lange Geschichte über einen Kompass in zehn Sätzen.", model, "", () => {});
  await Bun.sleep(500 + round * 150);
  await oc.abort(sid, wait);
  await oc.prompt(sid, "Antworte nur mit dem Wort: Banane", model, "", e => { if (e.kind === "text") textB += e.delta; if (e.kind === "done") doneB = true; });
  const t0 = Date.now();
  while (!doneB && Date.now() - t0 < 25000) await Bun.sleep(100);
  await Bun.sleep(300);
  const ok = /banane/i.test(textB);
  if (!ok) failures++;
  console.log(`Runde ${round}: ${ok ? "OK " : "FEHLT"} | fertig gemeldet nach ${Date.now() - t0} ms | Text: ${JSON.stringify(textB.slice(0, 40))}`);
}
console.log(wait ? "MIT Warten:" : "OHNE Warten (alter Stand):", failures === 0 ? "alle Runden OK" : `${failures} von 4 Runden ohne Antwort`);
process.exit(failures ? 1 : 0);
