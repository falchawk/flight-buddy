# Flight Buddy（オフライン対応 運航前ブリーフィング PWA）

旧版（Render + サーバー取得）の作り直しです。**サーバーはありません。**

- アプリ本体は静的ファイル（GitHub Pages）。
- データは Grok Bot が地上で作る「パック」（`data/`）。ボットが `scripts/build_pack.py` で作って commit/push します。
- アプリは一度オンラインで開くと、アプリ本体と最新パック（画像含む全ファイル）を端末の Cache Storage に保存します。
  以降は機内モードでも全タブ表示できます。最新パックと 1 つ前のパックを端末に保持します。
- ID・パスワードはアプリにもリポジトリにも置きません（MetAir 等のログインはボット側だけ）。

## タブ
| タブ（旧版と同じ順） | 内容 | 状態 |
|---|---|---|
| MAP | 空港の飛行状態（VFR/MVFR/IFR/LIFR）を地図（同梱の Natural Earth＋オンライン時は Esri 背景タイル・地名）に表示。経緯線（旧版と同じ：拡大すると 10°→5°→2°→1°）、現在地、鹿島スタジアム（公式エンブレム。ヘッダーのロゴも同じ）。飛行状態は日本の航空法（施行規則第5条第4号）優先、MVFR/LIFR だけ FAA 基準（scripts/flightcat.py） | 簡易版（航路線・NOTAM影響は未対応） |
| DUTY | 日付・会社・便番号・バッファ・メモ（端末内保存） | 動作 |
| WX | 旧版の8分類（地上天気図／衛星画像／レーダーエコー／三十分大気解析／高層天気図／下層悪天／Windy／AIRPORT）。AIRPORT > METAR TAF ATIS に空港ごとの METAR（過去分つき）・TAF・ATIS。IFR/LIFR の要因だけ赤 | 動作（Windy はオンライン専用、ATIS は SWIM ステージング待ち） |
| BRIEF | 選択空港サマリー＋ボットのブリーフ本文 | 動作 |
| FLIGHTS | 会社別時刻表からの便名検索 | 未対応（時刻表データ無し。タブに「未対応」表示） |
| NOTAM | 選んだ空港・直近 3H/1D/1W/ALL（古いものは薄く表示） | 動作（SWIM） |
| AIRPORT | 運用状況・使用滑走路・遅延・飛行場警報（SWIM）、標高・磁気偏差・滑走路・周波数（SWIM AIP）、日の出日没 | 動作 |
| TAS | ISA 固定の TAS 早見表、kt⇔km/h | 動作（完全オフライン） |
| SETTINGS | 空港（端末ごと）、保存済みパック（表示の自動/ライト/ダークはヘッダーのボタン）。ヘッダーの「SYNC」（全体更新）で新しいパックを確認。（「WX だけ更新」ボタンは v1.9.16 で廃止）|

ヘッダーに ONLINE/OFFLINE、パックの経過時間、ステータス行に「パック作成時刻（JST/UTC）・最新か保存済み表示か・SAMPLE 有無」を常時表示します。3 時間超で注意、12 時間超で警告バナー。

## 自動更新（ボット用）

ルーティンから15分ごと（JST の毎時 02/17/32/47 分）に次を実行します（終了コード 0=成功/スキップ、1=失敗。最後に1行サマリー）。

```bash
python3 /workspace/flight-buddy/scripts/auto_update.py
```

- 空港: `config/pack_config.json` の `airport_set: "japan_all"`（aviationweather.gov に登録された国内の METAR/TAF 局すべて）＋ `extra_airports` ＋ 同期 issue の空港。
- 図: `scripts/charts.py` が気象庁・MetAir（/pict/ 直リンク）・n-kishou から **plain HTTP で並列取得**（ブラウザ不要）。
  画像は内容アドレス（`data/blobs/<sha256>.<ext>`）でパック間共有。タイムスタンプ入り URL は再取得しない（`data/.cache/urlmap.json`）。
  端末も新しい画像だけダウンロード（差分）。今回取れなかった種類・地域・高度は前回分を「前回分」印付きで引き継ぎ。
  - 三十分大気解析: 断面図 航空路10＋経度10、平面図 FL410・FL390〜FL110・FL090（ソースは奇数FLのみ、FL400/FL100 は存在しない。既定 FL390／断面 福岡-東京）。
    ANALYSIS＝気象庁 直近25時刻、FORECAST＝MetAir 解析最新時刻から +6h まで。
  - ひまわり（赤外/可視/水蒸気）: 気象庁 bosai の日付入りタイル（`himawari/data/satimg/targetTimes_fd.json` の最新 basetime、フルディスク z5・10分毎・観測の約5分後に公開）を Pillow で日本域（117–152E, 20–47.5N）に切り出して合成し、海岸線・県境（気象庁 `tile/jma/transparent-cities`）・経緯線・右下に JST 時刻を重ねる。直近2時間。タイルが取れない時だけ旧 `mscweb/.../jpn_*.jpg`（日付なしで毎日上書きされるため Last-Modified が枠の時刻以降のものだけ採用）にフォールバック。雲頂高度: 直近2時間（10分毎）。
  - 高層天気図 › 福岡FIR解説報（FBJP の右隣）: 気象庁 航空気象情報「全国航空気象解説報（福岡FIR）」`https://www.data.jma.go.jp/airinfo/data/pict/ajpn_cmnt/qyya83.png`（ページ: `awfo_ajpn_cmnt_fukuokafir.html`、ログイン不要の公開画像）。1日2回（16時台・4時台 JST）。URL に日付が無いので 15分ごとに HEAD で ETag/Last-Modified を見て、変わった時だけ本文を取得。掲載時刻はファイルの Last-Modified、ISSUED/VALID は画像内。
  - 下層悪天予想図: 東日本（fbtk）を上、西日本（fbos）を下に積んで表示。
  - 地上天気図 ASAS/FSAS24/FSAS48 と AUPQ35/78・FXJP854・FXFE502/5782 は、気象庁のベクター PDF（`yoho/data/wxchart/quick/{ASAS_COLOR,FSAS24_COLOR_ASIA,FSAS48_COLOR_ASIA}.pdf`、`bosai/numericmap/data/nwpmap/*_{00,12}.pdf`）を pdftoppm で長辺3000px の可逆 WebP（各 0.3〜1.1MB）にして使用。ETag/Last-Modified が変わった時だけ取得（15分ごとは HEAD のみ）。基準時刻は bosai 一覧の発表時刻つきファイル名と PDF の Last-Modified を突き合わせて決定。PDF が取れない／bosai の方が新しい時だけ従来の PNG（600×512）にフォールバック。ビューアはピンチ・ホイールで原寸の12倍まで拡大可。
  - AUPQ35/78 は `scripts/aupq_mark.py`（PyMuPDF。`pip install --target ~/.local/share/fb-pylib pymupdf`）で PDF に日本の海岸線（オレンジ・半透明・細線。`scripts/aupq_japan_coast.json`＝Natural Earth 10m）と低気圧 L（赤。PDF 内では太さ1.13の折れ線 (0,0)→(0,8)→(4.5,8)）を重ねてから画像にする。投影（140E 中心の極ステレオ）は実 PDF の経緯線と海岸線で較正済みで、毎回、図の海岸線との一致率を検査（0.6 未満なら描かない）。失敗時・PyMuPDF 無しは原図（原図の画像も別キーでキャッシュ）。高気圧 H も青で上書き（既定 on。環境変数 `FB_AUPQ_MARK_H=0` で off）。トラフ線は AUPQ の PDF に描かれていない（線の太さは 0.28/0.57/0.85/1.13 の黒のみで、トラフ専用の線種・色が無い）ので検出・描画しない。
  - 降水ナウキャスト/雷/今後の雨は気象庁 rain.html と同じ `bosai/rain/data/*/time.json`（5分/10分毎）の最新を使用（約5分遅れ）。ナウキャスト/雷/今後の雨: 全国＋19地域（地図・境界線を重ね表示）。
- SWIM: `/workspace/fb-staging/notam/<ICAO>.json`（USV001 応答）、`atis.json`（LGV062 応答）、`profile/<ICAO>.json`（LGV220 応答）を
  そのまま置けば整形して取り込みます（`{"fetchedAt":"…Z","response":<応答>}` 形式も可）。6時間（ATIS は1.5時間）より古いものは使いません。
  認証情報はこのリポジトリでは扱いません。
- ブリーフ: `/workspace/fb-staging/brief.md` が前回より新しければ採用。そうでなければ前回の本文を引き継ぎ（アプリに「前回のブリーフ（作成時刻）」と表示）。`autoText`（自動サマリー）は毎回生成。
- NOTAM: 整形済み `/workspace/fb-staging/notam.json` があればそれを優先（無ければ上記 SWIM 応答から）。DUTY: `/workspace/fb-staging/duty.json` があれば採用。
- 中身（METAR/TAF本文・図・ブリーフ・NOTAM）が前回と同じならパックを作らず公開もしない（`changed=no pushed=no`）。
- 公開: `data/` を `pack-data.tar.gz` にして GitHub Release `pack-data` の asset を差し替え、`Deploy Pages` workflow を起動。
  **データは git の履歴に入らない**ので、15分ごとに更新してもリポジトリは肥大化しません。
- 540 秒で強制中断（通常は1分前後）。多重起動はロックでスキップ。`--no-publish`（作るだけ）、`--force`（変化が無くても作る）。

### 空港の選択（端末ごと）
- ボットはパックの全空港（国内の観測空港＋海外）を毎回取得します。端末（アプリ）は SETTINGS で選んだ空港の分（`ap/<ICAO>.json`）と共通の図だけをダウンロードします。
- 設定は端末内。空港を増やすとオンライン時にその空港の分だけ追加でダウンロードします（Botへの同期操作は不要）。表示順は旧版と同じ北→南です。

### AIRPORT タブの空港情報の出所
- 国内：標高・磁気偏差（AD 2.2）、滑走路（AD 2.12：長さ×幅・真方位・PCR・路面）、周波数（AD 2.18）は **SWIM AIP の AD 2 PDF** から（`fetchers/swim/aipAd2.js`）。
  目次（1リクエスト）を毎回確認し、PDF の URL（AIRAC 日付入り）が変わった空港だけ取り直します。目次が変わった時だけ ETag を HEAD で確認して AMDT の差し替えも拾います。PDF 本文は `aip-text/` にキャッシュ（パックには入れない）。
- AIP に無い空港（海外・一部国内）や AIP から読み取れなかった項目は、NOAA（aviationweather.gov）の値を「参考 (NOAA)」と明記して表示します。

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

## 取得頻度（国内／海外）
- 国内空港: METAR/TAF（SWIM→AWC→Ogimet）・ATIS・図は15分ごと、NOTAM は6時間ごと（00/06/12/18時 JST の予定時刻以降の最初の回）、空港情報（SWIM AIP・NOAA）と時刻表は1日1回（4時台）。
- 海外空港（日本の航空会社が過去・現在に使った152空港）: METAR/TAF は1時間ごと（毎正時以降の最初の回＝:02 の回）、空港情報（NOAA）は週1回（月曜 4時台 JST）。取らない回は前回パックの値と取得時刻をそのまま引き継ぐ（カードには各空港の取得時刻と経過を表示）。ATIS・NOTAM は対象外。
- 実行は :02/:17/:32/:47 なので、予定時刻（00:00・04:00・04:30・毎正時）は「予定時刻以降の最初の回」で取る（例: 00:00 の NOTAM は 00:02 の回）。
- AWC の METAR 照会は12時間分（夜間閉鎖の空港で観測が3〜12時間前の場合も観測時刻つきで表示）。Ogimet の `NIL`（観測なし）は報として扱わない。

## 飛行状態の基準（空港別）

- 通常：IFR は 視程 < 5,000m または シーリング < 1,000ft（航空法施行規則第5条第4号）。MVFR/LIFR だけ FAA。
- 告示空港（同号イ・ロの括弧書き＝管制圏内で国土交通大臣が告示で指定した空港。8km/450m）：IFR は 視程 < 8,000m または シーリング < 1,500ft、MVFR は 8,000m〜5SM・1,500〜3,000ft、LIFR は FAA のまま。
  **2026-11-18 確認：指定の告示は無く、指定空港は 0 件**（AIP Japan ENR 1.2 §1.2 は全空港 5km/300m。調布・但馬・天草は告示776号で「圏外の空港に 5km/300m を適用」する別の指定）。
  告示が出たら `js/vmc-designated.js` の `strict` に ICAO を足すだけで、地図・バッジ・IFR 赤・パック分類（scripts/flightcat.py が同じファイルを読む）・凡例が切り替わる。

## BRIEF の作り方（自動／手動）
- 自動：15分ごとの更新が毎回 `python3 scripts/brief_request.py should-run-auto` を呼び、終了コード 0 なら本文を書いて `publish --kind auto`（10 は SKIP）。
  - 狙い時刻 ＝ 今日の最初の運航便（FLT）の STD − 3 時間（JST）。例：SFJ72 が 07:00 発なら 04:00。
  - 今日の便が無い日、狙い時刻が 08:30 より遅い日（午後便）、今日の `duty_default.json` が無い日は 08:30。
  - 現在が「狙い時刻 − 13 分」以降で、今日まだ自動を作っていなければ作る（04:00 狙いなら 03:47 の回）。
  - 今日 03:00 JST 以降に手動（`publish --kind manual`）があれば作らない。今日すでに自動を作っていても作らない。
  - `should-run-auto --explain` で狙い時刻と理由を表示（個人情報は出ない）。`duty_default.json` は 00:02 の更新で取得（05:02 に再確認）。
- 本文は Markdown。見出し・箇条書き・太字・`コード`・**表（Markdown 表）**・**画像**に対応。表は幅が広ければ横スクロール（小さめの文字）。
- **画像の書き方**：図（PNG/JPG）を `/workspace/fb-staging/brief-img/NAME.png` に置き、本文に `![説明](brief-img/NAME.png)` と1行で書く（NAME は英数字と `. _ -` だけ）。
  `publish` は本文が参照する画像だけをパックに入れる（図と同じ内容アドレス blob＝`data/blobs/<sha256>.png`。オフラインで見られる）。参照されない古い画像は publish のたびに削除。
  参照先が無ければ公開せず終了コード 7。画像の合計が 1.5MB 超（1枚 300KB 超も）は警告。アプリでは画像をタップすると全画面で拡大（ピンチ・ドラッグ可）。
- BRIEF の見出し（上のバー）に出るのは本文の作成時刻と「自動／手動」だけ。本文に作成時刻・資料一覧は書かない。「選択空港サマリー」カードは本文の上に常に出る。
- 手動はチャットでボットに頼みます（`publish --kind manual`）。アプリに依頼ボタンや暗証番号の入力はありません。
- アプリは本文の作成時刻と「自動／手動」を表示します（brief.json の writtenAt・kind）。

## DUTY の自動入力（iFlight）

- `scripts/duty_fetch.py`：StarFlyer iFlight Lite の主アカウントだけから、**今日（JST）の運航便（FLT）**を取り、`/workspace/fb-staging/duty_default.json` に書く（便乗 DHD・待機・宿泊・休日は対象外）。認証情報は環境変数（`SFJ_IFLIGHT_USERNAME` / `SFJ_IFLIGHT_PASSWORD`）だけで、リポジトリ・パック・ログには出さない。
- `auto_update.py`：00:00 JST 以降の最初の回（00:02）と 05:00 JST 以降の最初の回（05:02）に取得（失敗時は60分後に再試行）。パックに `duty_default.json`（日付・航空会社・便番号・出発/到着空港・出発/到着時刻だけ）を入れる。乗員名・社員番号・アカウント名・機体記号などは入らない（`build_pack.py` が許可リストで絞る）。
- アプリ：パックの日付が今日で、その日この端末で便の追加/削除/日付変更をしていなければ、DUTY の日付と便を自動入力して「自動入力（iFlight）」を表示。手動編集した日は「手動」で、次の日まで手動の内容を維持する。

## 黄砂・PM2.5（軽量版）
- 黄砂：予測 日本域（いまに一番近い時刻＋その先3時間ごとの4コマ、計5コマ）と 観測実況（視程）（当日の1枚だけ。早朝で当日分がまだ無い時は取れる一番新しい1枚で、何日の分かをラベルに表示）。
- PM2.5：1つの「PM2.5」タブに2つのサブタブ。「実況」＝そらまめ君の最新1枚、「予測」＝VENUS 日本周辺の「いま以降で一番早い時刻」から3時間ごと5コマ（12時間先まで、過去のコマは無し。開いた時点で過去になったコマはアプリ側で隠す）（混ぜない）。東アジアは取らない。
- 取るのは必要な画像だけ（リスト／ヘッダを予定の回に見て、必要な枚数だけ取得）。ヘッダの「SAMPLE含む」はサンプルが無いので出さない。
