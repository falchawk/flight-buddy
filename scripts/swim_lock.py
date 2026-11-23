"""SWIM 取得の排他ロック。auto_update の 15 分パックと wx_live_poller が同時に
SWIM へログイン／Cookie を書かないようにする。パック組み立て中（図など）は持たない。"""
from __future__ import annotations

import fcntl
import os
import time
from contextlib import contextmanager

LOCK = os.environ.get("FB_SWIM_LOCK", "/tmp/flight-buddy-swim.lock")


@contextmanager
def hold(timeout_s=180):
    os.makedirs(os.path.dirname(LOCK) or "/tmp", exist_ok=True)
    f = open(LOCK, "w")
    t0 = time.time()
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() - t0 >= timeout_s:
                f.close()
                raise TimeoutError(f"SWIM ロックを {timeout_s:.0f}s 待っても取れませんでした")
            time.sleep(0.4)
    try:
        yield
    finally:
        try:
            fcntl.flock(f, fcntl.LOCK_UN)
        finally:
            f.close()
