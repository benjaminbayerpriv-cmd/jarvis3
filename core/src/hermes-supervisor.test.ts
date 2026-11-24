import { expect, test } from "bun:test";
import { HermesSupervisor } from "./hermes-supervisor";
import { managedGateway } from "./hermes";

test("externe Gateway-Adresse wird ohne fremden Prozessstart geprüft", async () => {
  const paths: string[] = [];
  const s = Bun.serve({ hostname:"127.0.0.1", port:0, fetch(req) {
    paths.push(new URL(req.url).pathname);
    if (new URL(req.url).pathname.endsWith("/v1/capabilities")) return Response.json({features:{run_submission:true,run_events_sse:true,run_stop:true}});
    return Response.json({data:[]});
  } });
  const sup = new HermesSupervisor(7777);
  try {
    const url = `http://127.0.0.1:${s.port}/profile`;
    expect(managedGateway(url)).toBe(false);
    await sup.ensure(url, "gateway-key");
    expect(paths).toEqual(["/profile/v1/capabilities", "/profile/api/sessions"]);
    expect(sup.running).toBe(false);
  } finally { sup.stop(); s.stop(true); }
});
