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
| CHARTS | 図（平面図・断面図など）。タップで全画面、ピンチ/ホイール/ボタンで拡大、ダブルタップ、前後送り | パック `charts.json` + 画像 |
| NOTAM | メイン空港のみ・空港ごとの箱・直近 3H/1D/1W/ALL 切替（NEW 表示） | パック `notam.json`（現在はスタブ） |
| AIRPORT | 運用時間・滑走路・進入方式・日の出日没・標高・磁気偏差・周波数（無い項目は「未取得」） | パック `airports.json` + 端末内計算 |
| DUTY | 日付・会社・便番号（数字のみ）・バッファ・メモ（端末内保存） | 端末 |
| TAS | ISA 固定の TAS 早見表、kt⇔km/h | 端末（完全オフライン） |
| SETTINGS | メイン空港（名称/IATA/ICAO 検索）、保存済みパック一覧・切替・再ダウンロード | 端末 |

ヘッダーに ONLINE/OFFLINE、パックの経過時間、ステータス行に「パック作成時刻（JST/UTC）・最新か保存済み表示か・SAMPLE 有無」を常時表示します。3 時間超で注意、12 時間超で警告バナー。

## パックの作り方（ボット用）

```bash
cd /workspace/flight-buddy
# 典型: ブリーフ本文 + 図フォルダ + push まで
python3 scripts/build_pack.py \
  --brief /workspace/fb-work/brief.md \
  --charts-dir /workspace/metair \
  --publish
```

オプション:

- `--airports RJTT,RJFF` … 取得空港（省略時 `config/pack_config.json`）
- `--brief FILE` … ブリーフ本文（Markdown 風: `#` 見出し, `-` 箇条書き, `**太字**`）
- `--charts-dir DIR` … 画像フォルダ（png/jpg/gif/webp/svg）。`DIR/charts.json` があればメタデータとして優先（例: `examples/charts.sample.json`）。
  無ければファイル名から推定（`CS_Fukuoka-Tokyo_ANALYSIS_20261118_0600UTC.png` → 断面図 福岡-東京 解析 06Z 等）。
- `--allow-restricted` … `restricted: true`（MetAir 由来は既定で restricted）の図も含める。**公開リポジトリでは使わないこと**（下記）。
- `--sample-charts` … SAMPLE（見本）図を入れる
- `--notam-file FILE` … NOTAM JSON（形式は `examples/notam.sample.json`）
- `--duty-file FILE` … `{"date":"2026-11-18","flights":["SFJ70"],"note":"..."}`（BRIEF/DUTY に表示）
- `--keep N` … リポジトリに残すパック数（既定 3）
- `--publish` … `git add data && commit && pull --rebase && push`（リトライ付き）

METAR/TAF は 4 回まで指数バックオフでリトライ。失敗した空港は前回パックの値を `carriedOver`（STALE 表示）で引き継ぎます。

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
MetAir（気象庁 航空気象情報提供システム）は登録利用者向けで、取得した図を第三者が見られる場所へ再配布することは利用条件に抵触する可能性が高いです。
このリポジトリは公開（GitHub Pages 無料枠）のため、**MetAir の画像は commit しません**（`build_pack.py` は既定で除外）。

MetAir 画像を載せたい場合の選択肢:
1. GitHub Pro 等で **private リポジトリ + Pages** にする（Pages の公開範囲は要確認。Enterprise の private Pages ならアクセス制限可）。
2. Cloudflare Pages + Cloudflare Access など、本人だけが見られるホスティングにする。
3. 公開してよい図（気象庁ホームページの公開図など。出典明記）だけを `restricted:false` で入れる。

アプリ側は相対パスだけで動くので、どのホスティングでもそのまま動きます。`config/pack_config.json` の `public_repo` を `false` にすれば restricted 図を既定で含めます（非公開ホスティングの時だけ）。

## ローカル確認
```bash
python3 -m http.server 8000   # → http://localhost:8000/
```
