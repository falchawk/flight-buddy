#!/usr/bin/env python3
"""
Flight Buddy 自動更新（ルーティン用の入口）
==========================================
  python3 /workspace/flight-buddy/scripts/auto_update.py

1. 多重起動防止ロック
2. 端末内の data/ が無ければ公開中のパック（Release asset）から復元
3. SWIM と時刻表を並行して取得し、build_pack で新しいパックを作成（パックの全空港＝国内の観測空港＋海外リスト。毎回全部）
   - 図: 旧 Flight Buddy の8分類（地上天気図・衛星・レーダー・三十分大気解析・高層・下層悪天・Windy・AIRPORT）を
         気象庁 / MetAir / n-kishou から plain HTTP で並列取得（ログイン不要。ブラウザ不要）
   - SWIM: fetchers/swim/run.js（wx-brief main のログイン・取得コード）で NOTAM・ATIS・空港プロファイル・AIP Lost Comm を取得
           （国内の全空港・毎回。同時4リクエストまで）→ /workspace/fb-staging/swim/swim.json。
           認証は環境変数 SWIM_USER / SWIM_PASS、Cookie は /workspace/fb-secrets（600）
   - 時刻表: fetchers/flights/run.js（毎回確認し、中身が変わった時だけ差し替え）
   - パックは共有ファイル（図など）＋空港別ファイル（ap/<ICAO>.json）。端末は選んだ空港の分だけダウンロード
   - ブリーフ: /workspace/fb-staging/brief.md が前回より新しければ採用、でなければ前回本文を引き継ぎ
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
import concurrent.futures
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
HARD_TIMEOUT_S = 540  # 10分間隔に収める（通常は1分前後。ロックで多重起動も防止）


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


FLIGHTS_RUNNER = os.path.join(ROOT, "fetchers", "flights", "run.js")  # 時刻表取得（鍵は環境変数 ODPT_CONSUMER_KEY だけ）
SWIM_RUNNER = os.path.join(ROOT, "fetchers", "swim", "run.js")  # SWIM 取得（ID/パスワードは環境変数 SWIM_USER / SWIM_PASS だけ）


def refresh_swim(staging):
    """SWIM（ATIS・空港プロファイル・NOTAM・AIP を毎回、国内の全空港）。失敗しても本体は続ける。"""
    if not os.path.exists(SWIM_RUNNER):
        return "skip(no-runner)"
    t0 = time.time()
    cfg = build_pack.read_json(os.path.join(ROOT, "config", "pack_config.json"), {}) or {}
    targets = build_pack.swim_targets(cfg)
    try:
        r = subprocess.run(["node", SWIM_RUNNER, "--out", os.path.join(staging, "swim"), "--airports", ",".join(targets)],
                           capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        log("SWIM タイムアウト（240秒）")
        return "fail(timeout)"
    line = next((ln for ln in reversed(r.stdout.strip().splitlines()) if ln.startswith("SWIM ")), "")
    log(line or r.stderr.strip()[-300:])
    kv = dict(t.split("=", 1) for t in line.split()[2:] if "=" in t)
    if line.startswith("SWIM SKIP"):
        return "skip(no-creds)"
    if r.returncode == 0 and line.startswith("SWIM OK"):
        # 例: swim=ok(atis:23/134,notam:1045,profile:129/134,aip:75/134,fetched:atis+profile+notam+aip,t:25s)  ※空白なし
        return (f"ok(atis:{kv.get('atis', '?')},notam:{kv.get('notam', '?')},profile:{kv.get('profile', '?')},"
                f"aip:{kv.get('aip', '?')},fetched:{kv.get('fetched', '?')},t:{time.time() - t0:.0f}s)")
    return f"fail({kv.get('reason', 'exit' + str(r.returncode))})"


def _flights_body(path):
    d = build_pack.read_json(path, {}) or {}
    d.pop("fetchedAt", None)
    d.pop("generatedAt", None)
    return json.dumps(d, sort_keys=True, ensure_ascii=False)


def refresh_flights(path):
    """時刻表も毎回確認し、中身が変わった時だけ差し替える。失敗したら前回分のまま。"""
    if not os.path.exists(FLIGHTS_RUNNER):
        return "skip(no-runner)"
    t0 = time.time()
    tmp = path + ".new"
    try:
        r = subprocess.run(["node", FLIGHTS_RUNNER, tmp], capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        log("時刻表 タイムアウト（240秒）")
        return "fail(timeout)"
    line = (r.stdout.strip().splitlines() or [""])[-1]
    log(line or r.stderr.strip()[-300:])
    t = f"t:{time.time() - t0:.0f}s"
    if r.returncode != 0 or not os.path.exists(tmp):
        return f"fail(kept-prev,{t})"
    if os.path.exists(path) and _flights_body(tmp) == _flights_body(path):
        os.remove(tmp)
        return f"same({t})"
    os.replace(tmp, path)
    return f"updated({t})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charts-dir", help="任意: 追加の図フォルダ（通常は不要）")
    ap.add_argument("--swim-dir", default="/workspace/fb-staging")
    ap.add_argument("--brief", default="/workspace/fb-staging/brief.md")
    ap.add_argument("--notam-file", default="/workspace/fb-staging/notam.json")
    ap.add_argument("--duty-file", default="/workspace/fb-staging/duty.json")
    ap.add_argument("--flights-file", default="/workspace/fb-staging/flights.json")
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
        os.makedirs(a.swim_dir, exist_ok=True)
        # SWIM と時刻表は相手先が別なので並行して取る
        with concurrent.futures.ThreadPoolExecutor(2) as ex:
            f_sw = ex.submit(refresh_swim, a.swim_dir)
            f_fl = ex.submit(refresh_flights, a.flights_file)
            sw, fl = f_sw.result(), f_fl.result()
        t_build = time.time()
        if os.path.exists(a.flights_file):
            argv += ["--flights-file", a.flights_file]
        if os.path.exists(a.duty_file):
            argv += ["--duty-file", a.duty_file]
        r = build_pack.build(build_pack.make_parser().parse_args(argv))
        pushed, size = False, 0
        if r["changed"] and not a.no_publish:
            size = publish()
            pushed = True
        errs = r.get("chartErrors") or []
        # 要点を先頭に（途中で切れても swim/flights が読めるように）。値に空白は入れない
        print(f"FLIGHT-BUDDY OK pack={r['packId']} swim={sw} flights={fl} changed={'yes' if r['changed'] else 'no'} "
              f"pushed={'yes' if pushed else 'no'} chartErrors={len(errs)} airports={r['airports']} "
              f"frames={r['charts']} sharedMB={(r.get('sharedBytes') or 0) / 1e6:.1f} build={time.time() - t_build:.0f}s time={time.time() - t0:.0f}s")
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
