# J-Quants Timeseries

J-Quants API V2から日本株の日足・1分足・30分足を取得し、CSVをGoogle Driveの
「時系列データ」フォルダへ保存する個人用ツールです。

現在は **GitHub Actions → J-Quants → Google Drive** を推奨経路とします。
Render上のMCPサーバーは互換用としてコードを残していますが、Actions経路ではRenderを使いません。

## 推奨: GitHub Actionsから直接Driveへ保存

`.github/workflows/jquants-to-drive.yml` と `actions_export.py` で、GitHub Actionsから
J-Quants APIを呼び、CSVを直接Google Driveへ保存できます。

対応する足種:

- `daily`: 日足
- `1m`: J-Quantsの生1分足
- `30m`: 1分足を東証セッション基準で30分足へ集計

ファイル名モード:

- `auto`: 日付範囲を明示した場合は日付入り、範囲無指定なら固定名
- `stable`: 固定名。同名ファイルがDriveにあれば内容を更新
- `dated`: `JQ_<銘柄名>_<期間>.csv` のような日付入りファイル名

### GitHub Secrets

Repository Settings → Secrets and variables → Actions へ次を登録してください。

| Secret | 内容 |
| --- | --- |
| `JQUANTS_API_KEY` | J-Quants V2 APIキー |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth Refresh Token |
| `GOOGLE_DRIVE_FOLDER_ID` | 保存先「時系列データ」フォルダID |

Google OAuthはDrive APIを利用できるスコープが必要です。既存ファイルを検索して同名CSVを
更新する運用では `https://www.googleapis.com/auth/drive` スコープが確実です。
より狭い `drive.file` スコープでは、そのOAuthアプリが作成・許可されたファイルだけが対象に
なるため、既存CSVを見つけられず同名ファイルが増える場合があります。

秘密情報はリポジトリ、Issue本文、ログへ書かないでください。

### GitHub画面から手動実行

Actions → `J-Quants CSV to Drive` → `Run workflow` から実行できます。

例:

- stock: `285A`
- interval: `30m`
- filename_mode: `stable`

### ChatGPTから実行するためのIssue入口

ChatGPTのGitHub接続からIssueを作成するとActionsを起動できます。リポジトリがpublicなので、
秘密情報はIssueへ書かず、銘柄・足種・期間だけを書きます。

Issueタイトル:

```text
[jquants] 285A 30m
```

必要ならIssue本文で詳細指定できます。

```text
stock: 285A
interval: 30m
from_date: 2026-01-01
to_date: 2026-09-12
filename_mode: dated
```

安全のため、Issue起動はリポジトリ所有者本人が作成した `[jquants]` Issueだけ実行します。
成功すると結果をIssueへコメントして自動クローズします。Drive URLや認証情報はIssueへ出しません。

## 主な動作

- 銘柄コードまたは会社名から上場銘柄を検索
- `/v2/equities/bars/daily` の全ページを取得
- `/v2/equities/bars/minute` の全ページを取得し、1分足を集約せずCSV化
- 同じ1分足を東証の前場・後場ごとに30分足へ集計
- 調整前・調整済みOHLCVとストップ高安フラグをCSV化
- 銘柄が曖昧なときは候補を返し、推測で選ばない
- GitHub Actions経路ではOAuth Refresh Tokenから短期Access Tokenを発行し、Drive APIへ直接保存

## ローカルテスト

```text
python -m venv .venv
.venv/bin/pip install -r requirements.txt
PYTHONPATH=. .venv/bin/python -m unittest discover -s tests -v
```

Windows PowerShellでは仮想環境のPythonを `.venv\\Scripts\\python.exe` に
読み替えてください。

Actions用エクスポーターをDriveアップロードなしで試す場合:

```text
JQUANTS_API_KEY=... python actions_export.py --stock 285A --interval daily --no-upload
```

## 互換用: Render MCP

従来のMCPサーバーも `server.py` / `render.yaml` に残しています。この経路では
Renderの公開URLをCSV一時受け渡しに利用します。GitHub Actions経路では不要です。

従来MCPの環境変数:

| 名前 | 内容 |
| --- | --- |
| `JQUANTS_API_KEY` | J-Quants V2のAPIキー。必須。 |
| `GOOGLE_DRIVE_FOLDER_ID` | 保存先DriveフォルダのID。 |
| `MCP_ACCESS_TOKEN` | MCP URLの秘密パス。32文字以上。 |
| `PORT` | HTTP待受ポート。Renderが自動設定。 |
| `RENDER_EXTERNAL_HOSTNAME` | Renderが自動設定する公開ホスト名。 |

起動例:

```text
JQUANTS_API_KEY=... GOOGLE_DRIVE_FOLDER_ID=... MCP_ACCESS_TOKEN=32文字以上の秘密文字列 python server.py
```

接続URL:

```text
https://<Renderのホスト名>/mcp/<MCP_ACCESS_TOKEN>
```

## J-Quantsのプラン制限

取得可能期間や分足利用可否は契約中のJ-Quantsプラン・アドオンに依存します。
実際に返った `first_date` と `last_date` を確認してください。

## 1分足

1分足CSV列:

- `Date`
- `TimeJST`
- `Code`
- `CompanyName`
- `Open`
- `High`
- `Low`
- `Close`
- `Volume`
- `TurnoverValue`

取引がなかった1分間は補完しません。分足APIには調整済み株価がないため、株式分割・併合を
またぐ分析では別途補正が必要です。

## 30分足

1分足を次の東証セッション区切りで30分足OHLCVへ集計します。

- 前場: 09:00〜11:30
- 後場: 12:30〜15:30
- 11:30と15:30の引け約定は直前の30分足へ含める
- 取引がない1分間は補完せず、`SourceMinuteCount`へ実在した分足数を記録
