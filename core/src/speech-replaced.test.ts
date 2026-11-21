import { expect, test } from "bun:test";
import { Speech } from "./speech";

// Ersetzt ein anderer Daemon die Verbindung (Close-Code 1012), darf der Daemon den Sidecar nicht sofort zurückholen,
// holt ihn aber beim nächsten Start von Diktat/Live wieder.
test("durch anderen Daemon ersetzt: kein Zurückholen, erst bei neuem Sprachwunsch", async () => {
  const sockets: any[] = [];
  const server = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response("no"); },
    websocket: { open(ws) { sockets.push(ws); }, message() {} } });
  const events: string[] = [];
  const speech = new Speech(e => events.push(e.type), `ws://127.0.0.1:${server.port}`);
  await Bun.sleep(300);
  expect(sockets.length).toBe(1);
  sockets[0].close(1012, "ersetzt");
  await Bun.sleep(2600);
  expect(sockets.length).toBe(1);
  expect(events).toContain("replaced");
  speech.mode("live");
  await Bun.sleep(400);
  expect(sockets.length).toBe(2);
  server.stop(true);
});
