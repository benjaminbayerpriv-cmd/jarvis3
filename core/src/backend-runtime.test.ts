import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendRuntime, isHermes } from "./backend-runtime";

test.if(process.platform !== "win32")("Backend und Chat bleiben nach Neustart servergebunden", async () => {
  const home = mkdtempSync(join(tmpdir(), "jarvis-runtime-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ session: { id: "api_abc" } }) });
  try {
    const runtime = new BackendRuntime(home);
    runtime.configure({provider:"default",model:"hermes-agent",baseUrl:`http://127.0.0.1:${server.port}`});
    runtime.store.setKey("0123456789abcdef"); runtime.setActive("hermes");
    const id = await runtime.createSession("Thema"); expect(isHermes(id)).toBe(true); expect(runtime.raw(id)).toBe("api_abc");
    const restarted = new BackendRuntime(home); expect(restarted.active).toBe("hermes"); expect(restarted.rows[0].id).toBe(id);
    restarted.configure({provider:"default",model:"hermes-agent",baseUrl:"http://127.0.0.1:1"});
    expect(() => restarted.client(id)).toThrow("anderen Server");
    expect(new BackendRuntime(home).rows[0].id).toBe(id);
  } finally { server.stop(true); rmSync(home, {recursive:true,force:true}); }
});
