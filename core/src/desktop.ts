// Desktop-Werkzeug: hält einen `uimap serve`-Prozess (Mac) bzw. uimap.exe (Windows) offen.
import { join } from "node:path";

type Reply = Record<string, unknown> & { ok: boolean };

export class Desktop {
  private proc?: ReturnType<typeof Bun.spawn>;
  private pending = new Map<number, (r: Reply) => void>();
  private rid = 0;

  constructor(private bin = process.platform === "win32"
    ? join(import.meta.dir, "../../tools/uimap-win/bin/uimap.exe")
    : join(import.meta.dir, "../../tools/uimap-mac/bin/uimap")) {}

  private ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    this.proc = Bun.spawn([this.bin, "serve"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    (async () => {
      const reader = (this.proc!.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const reply = JSON.parse(buf.slice(0, i)) as Reply; buf = buf.slice(i + 1);
          const id = reply.rid as number;
          this.pending.get(id)?.(reply); this.pending.delete(id);
        }
      }
      for (const [, resolve] of this.pending) resolve({ ok: false, error: "uimap beendet" });
      this.pending.clear();
    })();
  }

  call(cmd: Record<string, unknown>, timeoutMs = 15000): Promise<Reply> {
    this.ensure();
    const rid = ++this.rid;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, error: "Zeitüberschreitung" }); }, timeoutMs);
      this.pending.set(rid, r => { clearTimeout(timer); resolve(r); });
      const sink = this.proc!.stdin as import("bun").FileSink;
      sink.write(JSON.stringify({ ...cmd, rid }) + "\n");
      sink.flush();
    });
  }

  stop() { this.proc?.kill(); }
}
