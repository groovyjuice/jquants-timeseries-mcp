# J-Quants request trigger

`requests/latest.json` を main ブランチで更新すると、GitHub Actions が J-Quants CSV を取得して Google Drive へ保存します。

例:

```json
{
  "stock": "1570",
  "interval": "daily",
  "from_date": "",
  "to_date": "",
  "filename_mode": "stable"
}
```

`interval` は `daily` / `1m` / `30m`、`filename_mode` は `auto` / `stable` / `dated` を指定します。
