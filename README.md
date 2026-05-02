# epic-games-slack-notification

Epic Games Store の無料配布（週次・24h・72h 限定含む）を GitHub Actions の cron で 15 分ごとに監視し、**通常は有料だが現在無料になっているPCゲームの新規検知のみ** Slack に通知する MVP。

要件詳細は Linear の [Requirements ドキュメント](https://linear.app/racoma-dev/document/requirements-b5aeb97f7809) を参照。

## 主な機能

- **15 分間隔の自動監視** — GitHub Actions cron + 手動実行 (`workflow_dispatch`)
- **通常有料のPCゲームのみ通知** — `originalPrice > 0` かつ `discountPrice === 0` のゲーム本体 / ゲームバンドルを対象にし、常設 Free-to-Play と DLC / Add-on は除外
- **重複通知防止** — `offerId|startDate|endDate` をキーに通知済みを記録、再通知は再プロモ（期間変更）時のみ
- **JST 表示** — Slack 上では日時を `Asia/Tokyo` で描画、内部処理は UTC のまま
- **失敗時 retry セーフ** — Slack 投稿に失敗した offer は state に記録されないので、次回 cron で自動再試行
- **依存ゼロ** — Node.js 20 標準機能のみ（`fetch`, `node:test`）

## アーキテクチャ

```
GitHub Actions (cron 15min / workflow_dispatch)
        │
        ▼
scripts/check-epic-free-games.js   ← エントリポイント
        │
        ├─ providers/epic.js       … Epic Store API 取得（FR-2）
        ├─ lib/filter.js           … 期間 + 実質無料判定（FR-3）
        ├─ lib/state.js (load)     … data/seen-epic-offers.json を読み込み
        │   └─ selectNewOffers     … 通知済みを除外
        ├─ lib/notifier.js         … 1 offer = 1 Slack POST（FR-5/FR-6）
        └─ lib/state.js (record + save)
            └─ ★ 成功した offer のみ追記
                ↓
           workflow が data/seen-epic-offers.json を main に commit/push
           （差分があるときのみ・[skip ci] 付与）
```

データフローは「fetch → filter → diff → notify → record → persist」の一直線。各層は純粋関数として分離されており、`scripts/lib/*` 単体で `node --test` で検証できる（NFR-4）。

## ディレクトリ構成

```text
.
├── .github/workflows/
│   ├── epic-free-games-notifier.yml   # 監視 workflow (cron + dispatch)
│   └── test.yml                       # ユニットテスト (push/PR)
├── scripts/
│   ├── check-epic-free-games.js       # エントリポイント
│   ├── providers/epic.js              # Epic API 取得 + 形式変換
│   └── lib/
│       ├── filter.js                  # 無料配布判定
│       ├── state.js                   # 重複防止用の状態管理
│       └── notifier.js                # Slack 通知 + JST 整形
├── test/
│   ├── *.test.js                      # node --test 用テスト
│   └── fixtures/epic-response.json    # API レスポンス fixture
├── data/
│   └── seen-epic-offers.json          # 通知済み state（CI が自動 commit）
├── package.json
└── README.md
```

## セットアップ

何も知らない状態から本番稼働させるまでの手順。

### 1. リポジトリの準備

このリポジトリを使う場合はそのまま、自分の組織で動かす場合は **Fork** または `Use this template` してください。

### 2. Slack Incoming Webhook を作成

1. [Slack API: Sending messages using Incoming Webhooks](https://api.slack.com/messaging/webhooks) を開く
2. 通知先 Workspace で App を作成 → Incoming Webhook を有効化 → 通知先 Channel を選択
3. 発行された Webhook URL（`https://hooks.slack.com/services/...`）を控える

### 3. GitHub Secrets / Variables を登録

`Settings → Secrets and variables → Actions` で以下を登録します。

#### Secrets（必須）

| 名前                | 内容                                                |
| ------------------- | --------------------------------------------------- |
| `SLACK_WEBHOOK_URL` | 上で取得した Slack Incoming Webhook URL（漏洩厳禁） |

#### Variables（任意・未設定時はデフォルト値で動作）

| 名前              | 既定値  | 役割                                                                                |
| ----------------- | ------- | ----------------------------------------------------------------------------------- |
| `EPIC_LOCALE`     | `ja-JP` | Epic API に渡す locale。Slack のタイトル文字列に影響                                |
| `EPIC_COUNTRY`    | `JP`    | Epic API に渡す国コード。価格通貨に影響                                             |
| `INCLUDE_ADDONS`  | `false` | DLC・Add-on も通知対象に含めるか。通常運用では `false` 推奨                         |
| `NOTIFY_UPCOMING` | `false` | MVP では未使用（公開予定の offer 通知用フラグ、将来拡張）                           |

> `STATE_FILE` 環境変数で state ファイルのパスを差し替えることもできますが、CI 上では既定の `data/seen-epic-offers.json` を使ってください（commit/push 経路がこのパス前提）。

### 4. Actions を有効化

`Settings → Actions → General` で **Allow all actions and reusable workflows** を選択（fork した直後は Actions が無効化されている場合があります）。`Workflow permissions` は **Read and write permissions** にしてください。state ファイルを main に push するために必要です。

### 5. 動作確認（手動実行）

`Actions` タブ → `epic-free-games-notifier` → `Run workflow` を実行。

- 配布中の無料ゲームがあれば Slack に通知が届く
- 該当が無い場合は `[check] no new free offers` のログで終了
- 同じ条件でもう一度 `Run workflow` すると、state により `[check] notified=0 ...` になり Slack には届かない

ここまで通れば本番稼働 OK。以降は cron が UTC `7,22,37,52` 分に自動実行します（JST だとそれぞれ +9h）。

## CI 動作

### 監視 workflow (`epic-free-games-notifier.yml`)

- **cron**: `7,22,37,52 * * * *` UTC（毎時 :00 直後の cron rush を避けるオフセット）
- **手動実行**: `workflow_dispatch`（FR-8）
- **同時実行抑止**: `concurrency` で queue。配信中の Slack POST は中断しない（FR-1）
- **状態コミット**: 通知が 1 件以上成功した実行のみ `data/seen-epic-offers.json` を main にコミット
  - 差分が無ければ skip
  - `pull --rebase` + 3 回リトライで concurrent push を吸収
  - メッセージに `[skip ci]` 付与
  - `main` ブランチでの実行のみ実施（feature ブランチでの dispatch 時は state を書かない）
- **失敗時**: スクリプトが exit 1 を返すと workflow も赤くなる。Actions タブのログで原因追跡可能

### 検知対象と既知の制約

検知対象は Epic の `freeGamesPromotions` endpoint に載る offer のうち、現在 promotion 期間内で、通常価格が 0 より大きく、現在価格が 0 のPCゲーム本体またはゲームバンドルです。`Firestone Online Idle RPG` のような常設 Free-to-Play、DLC、Add-on、期限切れ、公開予定のみの offer は通知しません。

Mega Sale 経由の `-100%` 配布（例: Hogwarts Legacy）は、現在利用している `freeGamesPromotions` endpoint に載らない場合があります。これらは Cloudflare 配下の別 endpoint でしか確認できないため、MVP では検知対象外です。

### テスト workflow (`test.yml`)

- `push: main` と全 PR で `npm test` を実行
- 監視 workflow と分離されているため、テスト実行が state や Slack に影響しない

## ローカル実行

```sh
# 通知（実 Slack に投げる）
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." npm run check

# テスト（外部通信なし）
npm test
```

ローカルで生成された `data/seen-epic-offers.json` は **コミットしない**（CI の自動コミットと衝突する原因になります）。`.gitignore` で除外していないのは CI 側で commit する必要があるためです。検証で書き換えた場合は `git restore data/seen-epic-offers.json` で戻してください。

## トラブルシューティング

### 通知が来ない

| 症状                                | 切り分け                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 手動 dispatch しても Slack に来ない | Actions ログで `[check] no new free offers` なら本当に新規無料ゲームが無い／state に既に記録済み              |
| state を確認したい                  | `data/seen-epic-offers.json` を見る。再通知させたい entry はそのキーの行を消して PR でコミット                |
| 60 日アクティビティ無しで cron 停止 | Public repo の GitHub 仕様。手動 dispatch するか、軽い commit を 1 つ push すれば再開                         |

### 取得失敗（Epic API 5xx / 4xx）

- 一過性なら次の cron（15 分後）で自動回復
- 連続して 4xx が出続ける場合は Epic 側のエンドポイント変更の可能性。`scripts/providers/epic.js` の `DEFAULT_ENDPOINT` を見直す
- `[epic-provider] HTTP <code>` ログにエラー本文が記録されるので参考に

### Slack 通知失敗

- `[notifier] Slack POST failed for "..."`：HTTP ステータスを確認
  - `404`：Webhook が削除/無効化されている → Slack で再発行 → `SLACK_WEBHOOK_URL` Secret を更新
  - `429`：レート制限。本実装は 1 offer = 1 POST のシーケンシャル送信なので通常起こらない
- 失敗した offer は state に記録されないので、次回 cron で自動再試行されます

### state ファイルの競合

- 二つの cron が同時刻に走った場合、後発の commit は `pull --rebase` で吸収される設計
- それでも `Failed to push state after 3 retries` が出る場合は、main の状態を確認して必要なら手動でリベース

### 重複通知が届く

- ローカルで `npm run check` を実行して state ファイルを書き換えた／コミットしていないなど、**ローカルと main で state がズレている**可能性が一番多い
- `data/seen-epic-offers.json` を main の最新版に戻し（`git restore --source=origin/main data/seen-epic-offers.json`）、必要なら手動で entry 追加してコミット

### Workflow が見つからない / 実行できない

- `Settings → Actions → General` で Actions が **Disabled** になっていないか
- `Workflow permissions` が **Read and write** になっているか（state コミットに必須）
- Fork 直後は workflow が初回ブロックされることがある（Actions タブで Enable を要求されたら承認）

## 開発

```sh
# テスト一括実行（72 ケース・~270ms）
npm test

# 構文チェックのみ
node --check scripts/check-epic-free-games.js
```

純粋関数を増やすときは `scripts/lib/` 配下に追加し、対応する `test/<name>.test.js` を `node --test` で書いてください。HTTP は必ず `fetchImpl` 注入で fixture に置き換え、外部通信を発生させないこと（テスト方針）。

## ライセンス

[MIT](LICENSE)
