"""Run the private desktop API while its owner keeps the stdin pipe open.

A kernel-owned pipe also closes when Electron is killed. A PID file alone cannot
provide that guarantee and must never be used to kill an unrelated process.
"""
import argparse
import os
import sys
import threading

import uvicorn


def main(argv=None):
    parser = argparse.ArgumentParser(description='PixelArting private desktop backend')
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args(argv)
    config = uvicorn.Config('backend.app:app', host='127.0.0.1', port=args.port)
    server = uvicorn.Server(config)

    def watch_owner():
        try:
            while sys.stdin.buffer.read(1):
                pass
        finally:
            server.should_exit = True
            # Mirror the desktop's ordinary 5s stop deadline, including a provider
            # stuck during graceful shutdown. Only this private process exits.
            timer = threading.Timer(5, lambda: os._exit(0))
            timer.daemon = True
            timer.start()

    threading.Thread(target=watch_owner, name='pixelart-desktop-owner', daemon=True).start()
    server.run()


if __name__ == '__main__':
    main()
