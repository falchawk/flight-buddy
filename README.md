# Flight Buddy（オフライン対応 運航前ブリーフィング PWA）

> **参考情報。運航判断の正本は公式資料。**

旧版（Render + サーバー取得）の作り直しです。**サーバーはありません。**

- アプリ本体は静的ファイル（GitHub Pages）。
- データは Grok Bot が地上で作る「パック」（`data/`）。ボットが `scripts/build_pack.py` で作って commit/push します。
- アプリは一度オンラインで開くと、アプリ本体と最新パック（画像含む全ファイル）を端末の Cache Storage に保存します。
  以降は機内モードでも全タブ表示できます。最新パックと 1 つ前のパックを端末に保持します。
- ID・パスワードはアプリにもリポジトリにも置きません（MetAir 等のログインはボット側だけ）。

## タブ
| タブ | 内容 | データ |
|---|---|---|
| BRIEF | ボットが書いたブリーフ本文 | パック `brief.json` |
| WX | METAR/TAF（色分け・簡易デコード・TAF は変化群ごとに改行） | パック `wx.json`（aviationweather.gov） |
| CHARTS | 旧 Flight Buddy と同じ8分類（地上天気図／衛星画像／レーダーエコー／三十分大気解析／高層天気図／下層悪天／Windy／AIRPORT）。コマ送り（◀▶・スライダー）、タップで全画面（ピンチ/ホイール拡大）。Windy のみオンライン専用 | パック `charts.json`（v2）+ `data/blobs/` |
| NOTAM | メイン空港のみ・空港ごとの箱・直近 3H/1D/1W/ALL 切替（NEW 表示） | パック `notam.json`（SWIM ステージング） |
| AIRPORT | 運用時間・滑走路・進入方式・日の出日没・標高・磁気偏差・周波数（無い項目は「未取得」） | パック `airports.json` + 端末内計算 |
| DUTY | 日付・会社・便番号（数字のみ）・バッファ・メモ（端末内保存） | 端末 |
| TAS | ISA 固定の TAS 早見表、kt⇔km/h | 端末（完全オフライン） |
| SETTINGS | メイン空港（名称/IATA/ICAO 検索）、保存済みパック一覧・切替・再ダウンロード | 端末 |

ヘッダーに ONLINE/OFFLINE、パックの経過時間、ステータス行に「パック作成時刻（JST/UTC）・最新か保存済み表示か・SAMPLE 有無」を常時表示します。3 時間超で注意、12 時間超で警告バナー。

## 自動更新（ボット用）

ルーティンから毎時 00/15/30/45 分に次を実行します（終了コード 0=成功/スキップ、1=失敗。最後に1行サマリー）。

```bash
python3 /workspace/flight-buddy/scripts/auto_update.py
```

- 空港: `config/pack_config.json` の `airport_set: "japan_all"`（aviationweather.gov に登録された国内の METAR/TAF 局すべて）＋ `extra_airports` ＋ 同期 issue の空港。
- 図: `scripts/charts.py` が気象庁・MetAir（/pict/ 直リンク）・n-kishou から **plain HTTP で並列取得**（ブラウザ不要）。
  画像は内容アドレス（`data/blobs/<sha256>.<ext>`）でパック間共有。タイムスタンプ入り URL は再取得しない（`data/.cache/urlmap.json`）。
  端末も新しい画像だけダウンロード（差分）。今回取れなかった種類・地域・高度は前回分を「前回分」印付きで引き継ぎ。
  - 三十分大気解析: 断面図 航空路10＋経度10、平面図 FL390〜FL110（ソースは奇数FLのみ、FL400/FL100 は存在しない。既定 FL390／断面 福岡-東京）。
    ANALYSIS＝気象庁 直近25時刻、FORECAST＝MetAir 解析最新時刻から +6h まで。
  - ひまわり（赤外/可視/水蒸気）・雲頂高度: 直近2時間（10分毎）。ナウキャスト/雷/今後の雨: 全国＋19地域（地図・境界線を重ね表示）。
- SWIM: `/workspace/fb-staging/notam/<ICAO>.json`（USV001 応答）、`atis.json`（LGV062 応答）、`profile/<ICAO>.json`（LGV220 応答）を
  そのまま置けば整形して取り込みます（`{"fetchedAt":"…Z","response":<応答>}` 形式も可）。6時間（ATIS は1.5時間）より古いものは使いません。
  認証情報はこのリポジトリでは扱いません。
- ブリーフ: `/workspace/fb-staging/brief.md` が前回より新しければ採用。そうでなければ前回の本文を引き継ぎ（アプリに「前回のブリーフ（作成時刻）」と表示）。`autoText`（自動サマリー）は毎回生成。
- NOTAM: 整形済み `/workspace/fb-staging/notam.json` があればそれを優先（無ければ上記 SWIM 応答から）。DUTY: `/workspace/fb-staging/duty.json` があれば採用。
- 中身（METAR/TAF本文・図・ブリーフ・NOTAM）が前回と同じならパックを作らず公開もしない（`changed=no pushed=no`）。
- 公開: `data/` を `pack-data.tar.gz` にして GitHub Release `pack-data` の asset を差し替え、`Deploy Pages` workflow を起動。
  **データは git の履歴に入らない**ので、15分ごとに更新してもリポジトリは肥大化しません。
- 720 秒で強制中断（通常 1〜3 分）。多重起動はロックでスキップ。`--no-publish`（作るだけ）、`--force`（変化が無くても作る）。

### 空港の同期（SETTINGS の空港 ⇔ パック）
- パックは国内の METAR/TAF 局すべて（約130）を含むので、アプリの SETTINGS で選んだ空港がそのまま表示されます（設定は端末内、オフラインでも切替可）。
- リスト外の空港（海外など）を選ぶと「パック未収録」になり、SETTINGS に **「Botに同期」** ボタンが出ます。
  押すと `falchawk/flight-buddy` の新規 issue（ラベル `airports-sync`、本文 `AIRPORTS: RJTT,RJFF,...`）が開くので Submit するだけ。
  `build_pack.py` は所有者（falchawk）が作った最新の `airports-sync` issue を `gh` で読み、その空港を取得対象に加えます。

### 手動でパックを作る
```bash
python3 scripts/build_pack.py [--brief FILE] [--swim-dir DIR] [--airports RJTT,RJFF] [--notam-file F] [--duty-file F] \
  [--brief-if-newer] [--skip-if-unchanged] [--no-fetch-charts] [--workers 16] [--charts-dir DIR --allow-restricted] [--keep 3]
```
（`build_pack.py` は data/ に書くだけ。公開は `auto_update.py` が行います。）

### デプロイ方式
GitHub Pages は **GitHub Actions デプロイ**（`.github/workflows/pages.yml`）。main への push か workflow_dispatch で、
main のアプリ＋Release asset のデータを組み合わせて公開します。ブランチ方式の「1時間10ビルド」ソフト上限は Actions デプロイには適用されません。

## パック形式（schema `flight-buddy-pack/1`）

```
data/
  latest/manifest.json      最新パックの目録（アプリが最初に見る。no-store で取得）
  previous/manifest.json    1つ前の目録
  index.json                保持中パック一覧
  packs/<packId>/           不変（同じURLの中身は変わらない）
    manifest.json
    wx.json  notam.json  airports.json  brief.json  charts.json
    charts/<画像>
```

`manifest.json`:
```json
{
  "schema": "flight-buddy-pack/1",
  "packId": "20261118T073517Z",
  "generatedAt": "2026-11-18T07:35:17Z",
  "base": "data/packs/20261118T073517Z/",
  "airports": ["RJTT", "RJFF"],
  "sample": true,
  "duty": null,
  "sections": {"wx": "wx.json", "notam": "notam.json", "airports": "airports.json", "brief": "brief.json", "charts": "charts.json"},
  "files": [{"path": "charts/x.png", "bytes": 1234, "sha256": "…", "type": "image/png"}],
  "totalBytes": 25177,
  "previousPackId": null
}
```

- `wx.json`: `{source, fetchedAt, airports: {ICAO: {ok, fetchedAt, metar:[{raw, obsTime, fltCat}], taf:{raw, issueTime, validFrom, validTo}, error, carriedOver?}}}`
- `notam.json`: `{ok, source, note, airports: {ICAO: {items:[{id, issued, effectiveFrom, effectiveTo, text}]}}}`
- `airports.json`: `{source, airports: {ICAO: {name, iata, lat, lon, elevationFt, magdec, runways[], freqs[], sun[], operatingHours, approaches, notes}}}`
- `brief.json`: `{ok, text, author, writtenAt}`
- `charts.json`: `{charts:[{id, title, category, file, validTime?, validTimeHint?, source, restricted, sample, note?}], skippedRestricted:[…]}`

アプリはファイルを 1 つずつ取得して sha256 を検証し、全部揃った時だけ「保存完了」とします（中途半端なパックは表示しない）。

## アプリを更新した時
`sw.js` の `VERSION` を上げてください（アプリ本体は cache-first のため）。新しいファイルを追加したら `SHELL` 配列にも追加。

## MetAir の図について（重要）
MetAir（気象庁 航空気象情報提供システム）は登録利用者向けです。ユーザーが MetAir から個別に利用許可を得たため（2026-11-18）、
`config/pack_config.json` の `include_restricted: true` で MetAir 図を既定で含めています。許可が無くなったら `false` に戻してください。

MetAir 画像を載せたい場合の選択肢:
1. GitHub Pro 等で **private リポジトリ + Pages** にする（Pages の公開範囲は要確認。Enterprise の private Pages ならアクセス制限可）。
2. Cloudflare Pages + Cloudflare Access など、本人だけが見られるホスティングにする。
3. 公開してよい図（気象庁ホームページの公開図など。出典明記）だけを `restricted:false` で入れる。

アプリ側は相対パスだけで動くので、どのホスティングでもそのまま動きます。`config/pack_config.json` の `public_repo` を `false` にすれば restricted 図を既定で含めます（非公開ホスティングの時だけ）。

## ローカル確認
```bash
python3 -m http.server 8000   # → http://localhost:8000/
```
