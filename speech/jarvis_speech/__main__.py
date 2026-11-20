"""Start the Jarvis speech sidecar."""

import asyncio
import logging

from .server import Sidecar


async def run():
    sidecar = Sidecar()
    try:
        await sidecar.start()
        async with sidecar.serve() as server:
            logging.info("Sprach-Sidecar bereit auf ws://127.0.0.1:7778 (%s, %s)", sidecar.stt.name, sidecar.tts.name)
            await server.serve_forever()
    finally:
        await sidecar.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
