# epic-games-slack-notification

Epic Games Store の無料配布（週次・24h・72h 限定含む）を GitHub Actions で 15 分ごとに監視し、新規検知時に Slack へ通知する MVP。

詳細は Linear の [Requirements ドキュメント](https://linear.app/racoma-dev/document/requirements-b5aeb97f7809) を参照。

## ディレクトリ構成

```text
.
├── .github/workflows/   # GitHub Actions workflow (epic-free-games-notifier.yml)
├── scripts/             # 監視スクリプト (check-epic-free-games.js)
├── data/                # 通知済み offer の状態ファイル (seen-epic-offers.json)
├── package.json
└── README.md
```

## 実行環境

- Node.js 20 以上（`actions/setup-node` で固定）
- 外部依存は最小限。Node.js 標準の `fetch` を優先。

## セットアップ（後続タスクで肉付け）

1. リポジトリを clone
2. GitHub Secrets に `SLACK_WEBHOOK_URL` を登録
3. （任意）Variables / 環境変数を設定
   - `EPIC_LOCALE`（既定 `ja-JP`）
   - `EPIC_COUNTRY`（既定 `JP`）
   - `NOTIFY_UPCOMING`（既定 `false`）
   - `INCLUDE_ADDONS`（既定 `true`）
   - `STATE_FILE`（任意）

## ローカル実行

```sh
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." npm run check
```

## ライセンス

MIT
