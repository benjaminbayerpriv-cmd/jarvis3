import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../", import.meta.url));
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export async function startBrowser(serve, chromeOptions = [], { headless = true } = {}) {
  const connections = [];
  const frames = [];
  const pending = new Map();
  let rid = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/browser" && server.upgrade(request)) return;
      return serve(new URL(request.url).pathname);
    },
    websocket: {
      idleTimeout: 0,
      message(ws, raw) {
        const message = JSON.parse(raw);
        if (process.env.JARVIS_TRACE) console.log("answer", message.rid, message.ok, message.via, message.error);
        if (message.type === "frame" || message.type === "stream_ended") frames.push(message);
        else if (message.hello === "jarvis-extension") connections.push({ ws, message });
        else {
          assert(pending.has(message.rid), "Unexpected protocol message");
          pending.get(message.rid)(message);
        }
      }
    }
  });

  const base = `http://127.0.0.1:${server.port}`;
  // Chrome tunnels the production WebSocket URL through an isolated proxy in the
  // test profile. This leaves any real daemon already listening on 7777 alone.
  const proxy = createServer(client => {
    client.on("error", () => {});
    function connect(chunk) {
      const split = chunk.indexOf("\r\n\r\n");
      if (split < 0) return client.destroy();
      if (!chunk.toString().startsWith("CONNECT 127.0.0.1:7777 HTTP/")) return client.destroy();
      const upstream = Bun.connect({
        hostname: "127.0.0.1", port: server.port,
        socket: {
          open(socket) {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const remaining = chunk.subarray(split + 4);
            if (remaining.length) socket.write(remaining);
            client.on("data", data => socket.write(data));
            client.on("close", () => socket.end());
          },
          data(_socket, data) { client.write(data); },
          close() { client.end(); },
          error() { client.destroy(); },
        }
      });
      upstream.catch(() => client.destroy());
    }
    client.once("data", connect);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const profile = await mkdtemp(join(tmpdir(), "jarvis-chrome-"));
  const chrome = spawn(chromePath, [
    "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--disable-background-networking",
    `--proxy-server=http=http://127.0.0.1:${proxy.address().port}`,
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${server.port}`, ...chromeOptions, base + "/sentinel"
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const closed = once(chrome, "close");
  const devtoolsPending = new Map();
  let buffer = "";
  let sequence = 0;
  chrome.stdio[4].setEncoding("utf8");
  chrome.stdio[4].on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const response = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      devtoolsPending.get(response.id)?.(response);
    }
  });
  function devtools(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        devtoolsPending.delete(id);
        reject(new Error("DevTools timeout: " + method));
      }, 10000);
      devtoolsPending.set(id, ({ error, result }) => {
        clearTimeout(timer);
        devtoolsPending.delete(id);
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }

  async function until(check, message, ms = 12000) {
    const deadline = Date.now() + ms;
    do {
      const value = await check();
      if (value) return value;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    assert.fail(message);
  }

  function ask(request) {
    const id = ++rid;
    if (process.env.JARVIS_TRACE) console.log("request", id, request.cmd, request.submit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Protocol timeout: " + request.cmd));
      }, 35000);
      pending.set(id, answer => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(answer);
      });
      connections.at(-1).ws.send(JSON.stringify({ ...request, rid: id }));
    });
  }

  async function ok(cmd, fields) {
    const answer = await ask({ cmd, ...fields });
    assert.equal(answer.ok, true, cmd + ": " + answer.error);
    return answer;
  }

  async function fails(cmd, fields, error) {
    const answer = await ask({ cmd, ...fields });
    assert.equal(answer.ok, false, cmd);
    assert.match(answer.error, error);
  }

  async function evaluate(target, expression) {
    const { sessionId } = await devtools("Target.attachToTarget", { targetId: target, flatten: true });
    try {
      const reply = await devtools("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    } finally {
      await devtools("Target.detachFromTarget", { sessionId });
    }
  }

  async function close() {
    await devtools("Browser.close").catch(() => {});
    await Promise.race([closed, Bun.sleep(3000)]);
    if (chrome.exitCode === null && chrome.kill()) await closed;
    proxy.close();
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
  return { base, extension, connections, frames, devtools, evaluate, until, ok, fails, close };
}
