"""Start the Jarvis speech sidecar."""

import asyncio
import logging

from .errorlog import ErrorLogHandler, record
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
    logging.getLogger().addHandler(ErrorLogHandler())
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        import traceback
        record("speech", "speech/crash", f"Sprach-Sidecar abgestürzt: {error}", {"type": type(error).__name__}, traceback.format_exc()[-4000:])
        raise


if __name__ == "__main__":
    main()
