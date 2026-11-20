"""Small manual client for the live local Sidecar, or an async test session."""

import argparse
import asyncio
import json
import sys
import time

from websockets.asyncio.client import connect


class Client:
    def __init__(self, socket):
        self.socket = socket
        self.messages = []
        self.changed = asyncio.Event()
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.socket:
            self.messages.append((time.monotonic(), json.loads(raw)))
            self.changed.set()

    async def send(self, kind, **fields):
        start = time.monotonic()
        await self.socket.send(json.dumps({"type": kind, **fields}, ensure_ascii=False))
        return start

    async def wait(self, kind, since=0.0, timeout=20, **match):
        async with asyncio.timeout(timeout):
            while True:
                self.changed.clear()
                for received, message in self.messages:
                    if received >= since and message["type"] == kind and all(message.get(k) == v for k, v in match.items()):
                        return received, message
                await self.changed.wait()

    async def close(self):
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)


async def interactive(url):
    async with connect(url) as socket:
        async def display():
            async for raw in socket:
                if json.loads(raw)["type"] != "level":
                    print(raw, flush=True)

        task = asyncio.create_task(display())
        try:
            while line := await asyncio.to_thread(sys.stdin.readline):
                await socket.send(json.dumps(json.loads(line)))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1:7778")
    asyncio.run(interactive(parser.parse_args().url))
