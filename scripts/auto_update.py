#!/usr/bin/env python3
"""
Flight Buddy 自動更新（ルーティン用の入口）
==========================================
  python3 /workspace/flight-buddy/scripts/auto_update.py

1. 多重起動防止ロック
2. 端末内の data/ が無ければ公開中のパック（Release asset）から復元
3. build_pack で新しいパックを作成（全国の空港 + 同期issueの空港、METAR/TAF、NOTAMファイルがあれば）
   - 図: 旧 Flight Buddy の8分類（地上天気図・衛星・レーダー・三十分大気解析・高層・下層悪天・Windy・AIRPORT）を
         気象庁 / MetAir / n-kishou から plain HTTP で並列取得（ログイン不要。ブラウザ不要）
   - SWIM: /workspace/fb-staging/{notam/<ICAO>.json, atis.json, profile/<ICAO>.json}（ボットが保存した応答）を読み込み
   - ブリーフ: /workspace/fb-staging/brief.md が前回より新しければ採用、でなければ前回本文を引き継ぎ（＋自動サマリー）
   - 中身が前回と同じなら何もしない（公開しない）
4. data/ を tar.gz にして GitHub Release "pack-data" の asset を差し替え → Pages デプロイ workflow を起動
   （データは git の履歴に入らないので、リポジトリが肥大化しない）
最後に1行サマリーを出力。失敗時は非0で終了。
"""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build_pack  # noqa: E402

REPO = "falchawk/flight-buddy"
RELEASE_TAG = "pack-data"
ASSET = "pack-data.tar.gz"
WORKFLOW = "pages.yml"
DATA = os.path.join(ROOT, "data")
LOCK = "/tmp/flight-buddy-auto-update.lock"
HARD_TIMEOUT_S = 720  # 15分間隔に収める（ロックで多重起動も防止）


def log(*a):
    print("[auto_update]", *a, file=sys.stderr, flush=True)


def run(cmd, timeout=60, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} 失敗: {r.stderr.strip()[:400]}")
    return r


def restore_from_release():
    if os.path.exists(os.path.join(DATA, "latest", "manifest.json")):
        return
    log("端末内に data/ が無いので公開中のパックから復元")
    tmp = "/tmp/fb-restore"
    os.makedirs(tmp, exist_ok=True)
    r = run(["gh", "release", "download", RELEASE_TAG, "-R", REPO, "-p", ASSET, "-D", tmp, "--clobber"], 120, check=False)
    if r.returncode != 0:
        log("復元できる公開パックがありません（初回扱い）")
        return
    with tarfile.open(os.path.join(tmp, ASSET)) as t:
        t.extractall(ROOT, filter="data")


def make_tarball(path):
    with tarfile.open(path, "w:gz", compresslevel=1) as t:
        def flt(ti):
            return None if "/.cache" in ti.name else ti
        for name in ("latest", "previous", "packs", "blobs", "index.json"):
            p = os.path.join(DATA, name)
            if os.path.exists(p):
                t.add(p, arcname=f"data/{name}", filter=flt)
    return os.path.getsize(path)


def publish():
    tar = "/tmp/" + ASSET
    size = make_tarball(tar)
    log(f"アップロード {size // 1024}KB")
    r = run(["gh", "release", "view", RELEASE_TAG, "-R", REPO], 30, check=False)
    if r.returncode != 0:
        run(["gh", "release", "create", RELEASE_TAG, "-R", REPO, "--title", "Pack data (auto)", "--latest=false",
             "--notes", "Flight Buddy のデータパック置き場（自動更新）。手で消さないでください。", tar], 120)
    else:
        for i in range(3):
            try:
                run(["gh", "release", "upload", RELEASE_TAG, tar, "-R", REPO, "--clobber"], 120)
                break
            except Exception as e:  # noqa: BLE001
                if i == 2:
                    raise
                log("upload 再試行:", e)
                time.sleep(5)
    run(["gh", "workflow", "run", WORKFLOW, "-R", REPO, "--ref", "main"], 60)
    return size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charts-dir", help="任意: 追加の図フォルダ（通常は不要）")
    ap.add_argument("--swim-dir", default="/workspace/fb-staging")
    ap.add_argument("--brief", default="/workspace/fb-staging/brief.md")
    ap.add_argument("--notam-file", default="/workspace/fb-staging/notam.json")
    ap.add_argument("--duty-file", default="/workspace/fb-staging/duty.json")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--force", action="store_true", help="変化が無くても新しいパックを作って公開")
    a = ap.parse_args()

    def on_timeout(*_):
        raise TimeoutError(f"{HARD_TIMEOUT_S}秒を超えたため中断")
    signal.signal(signal.SIGALRM, on_timeout)
    signal.alarm(HARD_TIMEOUT_S)
    t0 = time.time()
    lockf = open(LOCK, "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("FLIGHT-BUDDY SKIP: 別の自動更新が実行中")
        return 0
    try:
        restore_from_release()
        argv = ["--keep", "3", "--brief-if-newer"]
        if not a.force:
            argv.append("--skip-if-unchanged")
        if os.path.isdir(a.swim_dir):
            argv += ["--swim-dir", a.swim_dir]
        if a.charts_dir and os.path.isdir(a.charts_dir):
            argv += ["--charts-dir", a.charts_dir]
        if os.path.exists(a.brief):
            argv += ["--brief", a.brief]
        if os.path.exists(a.notam_file):
            argv += ["--notam-file", a.notam_file]
        if os.path.exists(a.duty_file):
            argv += ["--duty-file", a.duty_file]
        r = build_pack.build(build_pack.make_parser().parse_args(argv))
        pushed, size = False, 0
        if r["changed"] and not a.no_publish:
            size = publish()
            pushed = True
        errs = r.get("chartErrors") or []
        st = r.get("chartStats") or {}
        print(f"FLIGHT-BUDDY OK pack={r['packId']} airports={r['airports']} frames={r['charts']}({r['chartMode']}) "
              f"images={r.get('blobs', '-')} packMB={(r.get('bytes') or 0) / 1e6:.1f} tarMB={size / 1e6:.1f} "
              f"fetch={st.get('seconds', '-')}s req={st.get('requests', '-')} chartErrors={len(errs)} "
              f"changed={'yes' if r['changed'] else 'no'} pushed={'yes' if pushed else 'no'} time={time.time() - t0:.0f}s")
        for e in errs[:20]:
            print("  chart-error:", e)
        return 0
    except BaseException as e:  # noqa: BLE001
        print(f"FLIGHT-BUDDY FAILED: {type(e).__name__}: {e} (time={time.time() - t0:.0f}s)")
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
