# 近リアルタイム気象リレー（Flight Buddy）

SWIM の ATIS / METAR / SPECI / TAF を 1–2 分ごとに箱側で取り、Cloudflare KV に置き、Worker が CORS 付き JSON を返します。アプリ（オンライン時）は約 60 秒ごとにこれを見て、パックより新しい報だけを重ねます。オフラインでは最後に受信した LIVE 報を端末に残し、より古いパックへは戻りません。

秘密情報（SWIM の ID/パスワード、Cloudflare の API トークン）はリポジトリ・クライアント・ログに出さないでください。

## 構成

- 箱側: `scripts/wx_live_poller.py`（`scripts/wx_live_start.sh` で常駐）
- Worker: `relay/src/worker.js`（読み取り専用。書き込みは Cloudflare API）
- アプリ: `js/wx-live.js`。`js/wx-relay-config.js` の `FB_WX_RELAY_URL` が空なら無効（今の公開版は空のまま）

対象空港は `config/wx_relay.json`（ATIS 23 空港＋SFJ 路線＋既定の主空港。全 134 空港は取らない）。

## ボックスが入れ替わったとき

リポジトリを pull したあと、`/workspace/fb-secrets/cloudflare.env`（chmod 600）を置き直し、`bash scripts/wx_live_start.sh` を再実行する。スクリプト自体はリポジトリにある。

## アカウント作成後の作業（手順の詳細はチャット側の案内に従う）

トークンやアカウント ID はチャットに貼らず、マスクされた入力で渡す。受け取った側が KV 名前空間の作成、Worker のデプロイ、`FB_WX_RELAY_URL` の記入、ポラーの起動を行う。
