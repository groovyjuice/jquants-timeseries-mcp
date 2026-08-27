# J-Quants Timeseries MCP

J-Quants API V2から日本株の日足または30分足を取得し、ChatGPTがGoogle Driveの
「時系列データ」フォルダへ保存できるCSVを返す個人用MCPサーバーです。

## 主な動作

- 銘柄コードまたは会社名から上場銘柄を検索
- `/v2/equities/bars/daily` の全ページを取得
- `/v2/equities/bars/minute` の全ページを取得し、東証の前場・後場ごとに30分足へ集計
- 調整前・調整済みOHLCVとストップ高安フラグをCSV化
- Renderの秘密設定から保存先フォルダIDを読み込み、ツール結果に含める
- 銘柄が曖昧なときは候補を返し、推測で選ばない

## 環境変数

| 名前 | 内容 |
| --- | --- |
| `JQUANTS_API_KEY` | J-Quants V2のAPIキー。必須。 |
| `GOOGLE_DRIVE_FOLDER_ID` | 保存先DriveフォルダのID。必須。 |
| `MCP_ACCESS_TOKEN` | MCP URLの秘密パス。32文字以上。必須。 |
| `PORT` | HTTP待受ポート。Renderが自動設定。 |
| `RENDER_EXTERNAL_HOSTNAME` | Renderが自動設定する公開ホスト名。 |

APIキー、DriveフォルダID、アクセストークンはソース、会話、ログへ
書かないでください。

## ローカルテスト

```text
python -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v
```

Windows PowerShellでは仮想環境のPythonを `.venv\\Scripts\\python.exe` に
読み替えてください。

## 起動

```text
JQUANTS_API_KEY=... GOOGLE_DRIVE_FOLDER_ID=... MCP_ACCESS_TOKEN=32文字以上の秘密文字列 python server.py
```

接続URLは次の形式です。

```text
https://<Renderのホスト名>/mcp/<MCP_ACCESS_TOKEN>
```

このURL全体を秘密情報として扱ってください。個人利用の簡易的な保護であり、
OAuth認証の代替になる強固な方式ではありません。漏えいした場合は
`MCP_ACCESS_TOKEN`を再生成してください。

## ChatGPT側

1. Web版ChatGPTの「設定」→「セキュリティとログイン」でDeveloper modeを有効化。
2. Pluginsの追加画面で上記MCP URLを登録。
3. 会話でDeveloper modeからJ-QuantsアプリとGoogle Driveを選択。
4. 「キオクシアの時系列データを取って」と依頼。

ツールはCSV本文、ファイル名、秘密設定から読み込んだ保存先フォルダIDを
返します。ChatGPTはそのCSVを指定されたGoogle Driveフォルダへアップロードします。

## J-Quants Freeの制限

Freeプランでは、取得できる株価は直近12週間を除く過去2年分です。実際に返った
`first_date` と `last_date` を確認してください。

## 30分足

`get_stock_30min_timeseries` はJ-Quantsの1分足を取得し、次の区切りで
30分足OHLCVへ集計します。

- 前場: 09:00〜11:30
- 後場: 12:30〜15:30
- 11:30と15:30の引け約定は直前の30分足へ含める
- 取引がない1分間は補完せず、`SourceMinuteCount`へ実在した分足数を記録

利用にはLight以上のベースプランと、株価分足・ティックアドオンが必要です。
分足の取得可能期間は過去2年間で、調整済み株価は含まれません。
