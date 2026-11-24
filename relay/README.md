# 近リアルタイム気象リレー（Flight Buddy）

ATIS（SWIM）と METAR / SPECI / TAF（AWC＝aviationweather.gov。2026-11-24 から SWIM の空港詳細は使わない）を箱側の通常プロセス（`scripts/wx_live_poller.py`。モデルや LLM は呼ばない）で取り、Cloudflare KV に置き、Worker が CORS 付き JSON を返します。アプリ（オンライン時）は約 60 秒ごとにこれを見て、パックより新しい報だけを重ねます。オフラインでは最後に受信した LIVE 報を端末に残し、より古いパックへは戻りません。

秘密情報（SWIM の ID/パスワード、Cloudflare の API トークン）はリポジトリ・クライアント・ログに出さないでください。

## 構成

- 箱側: `scripts/wx_live_poller.py`（`scripts/wx_live_start.sh` で常駐）
- Worker: `relay/src/worker.js`（読み取り専用。書き込みは Cloudflare API）
- アプリ: `js/wx-live.js`。`js/wx-relay-config.js` の `FB_WX_RELAY_URL` が空なら無効（今の公開版は空のまま）

対象は国内空港のすべて（METAR/SPECI/TAF ＝ pack の japan_all のうち RJ**/RO**、ATIS ＝ `fetchers/swim/swim.js` の `ATIS_SUPPORTED_ICAO`）。路線や SETTINGS 既定などの部分集合には絞らない。間隔は `config/wx_relay.json`（pollSeconds 120 秒。METAR/TAF は AWC に約40空港ずつ。ATIS は SWIM に1リクエストで全対応空港、前回の問い合わせから `atisMinSeconds`＝120 秒以上あけた時だけ。エラーを返した空港は6時間問い合わせない＝`fetchers/swim/lib/swimGuard.js`）。SWIM の空港詳細（f2appr）はこのポラーからは呼ばない。KV への書き込みは、空港の報の内容が変わったときに限り、最短 180 秒ごと（`kvMinWriteSeconds`）。UTC 日あたり 600 回（`kvDailyWriteBudget`）を超えたらその日は書かない。無料枠の書き込み上限（1,000 回/日）を超えないようにするため。

## ボックスが入れ替わったとき

リポジトリを pull したあと、`/workspace/fb-secrets/cloudflare.env`（chmod 600）を置き直し、`bash scripts/wx_live_start.sh` を再実行する。スクリプト自体はリポジトリにある。

## アカウント作成後の作業（手順の詳細はチャット側の案内に従う）

トークンやアカウント ID はチャットに貼らず、マスクされた入力で渡す。受け取った側が KV 名前空間の作成、Worker のデプロイ、`FB_WX_RELAY_URL` の記入、ポラーの起動を行う。
