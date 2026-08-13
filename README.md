# マイカー管理アプリ

Googleアカウントでログインして使う、複数デバイス対応の車両管理Webアプリです。
Firebase Authentication（Googleログイン）とCloud Firestoreを使い、同じGoogleアカウントであればどのデバイスからでも同じデータを参照・編集できます。

## 🎯 目的・概要

- 複数台の車両（最大5台）の基本情報・車検・保険・給油・メンテナンスを一元管理
- 車検／保険の満了日や、メンテナンス予約日が近づくと色分けバッジで警告
- 給油記録から燃費（km/L）を自動計算
- メンテナンス予約 → 完了までのステータス管理と、レシート画像の保存
- Chart.jsによる費用分析（月別費用・カテゴリ別費用・燃費推移）と年間維持費の可視化
- 給油・メンテナンス記録のCSVエクスポート

## ✅ 実装済み機能

### 認証・基盤
- Firebase Authentication（Googleログイン、`signInWithRedirect` + `getRedirectResult` によるリダイレクト方式。iPad/iPhone Safariのポップアップ問題に対応）
- ログイン関連のエラーは、トースト通知に加えて必ず `alert()` でコード・内容を表示（サイレントに失敗しない設計）
- Cloud Firestoreによるデータ保存（`users/{uid}/...` 以下にユーザーごとにデータを分離）
- iOSホーム画面追加用メタタグ（アプリらしい見た目に対応）

### ① 車両管理
- 車両の登録・編集・削除（最大5台、上限に達すると追加ボタンが自動的に無効化）
- ニックネーム・メーカー・車種・年式・ナンバー・現在の走行距離・車検満了日
- 車検／自賠責保険／任意保険の満了日を色分け表示（30日以内=赤、31〜60日=黄、61日以上=緑、期限切れ=赤）
- 車両詳細モーダル：基本情報／保険情報／費用分析の3タブ構成
- 自賠責保険・任意保険の詳細情報（保険会社・証券番号・満了日・年間保険料・担当者/代理店の電話番号 tel:リンク）

### ② 給油記録（レシート撮影・店舗選択対応）
- 日付・走行距離・給油量・金額・満タンフラグの記録
- 前回給油との走行距離差分から燃費（km/L）を自動計算
- 給油した店舗を店舗マスタからプルダウン選択
- 「📷レシートを撮影」ボタン（`<input type="file" accept="image/*" capture="environment">`）でレシート撮影
  - canvasで幅800px程度にリサイズ・JPEG圧縮し、Base64文字列として `fuelLogs` ドキュメントの `receiptImage` フィールドに直接保存（Firebase Storageは使用しない）
- 履歴一覧にレシート画像のサムネイルを表示、タップで拡大表示（ライトボックス）

### ③ メンテナンス記録（予約ステータス管理）
- `maintenanceLogs` に `status`（未予約／予約済み／完了）を持たせて管理
- 「予約中・進行中」タブ：カード形式で一覧表示。予約日までの残り日数を色分け
  - 3日以内=赤、4〜7日=黄、8日以上=青、期限超過=赤で「期限超過」表示
- 「＋新規予約」：作業カテゴリ（カテゴリマスタから選択）・予約日・予約時間・店舗（店舗マスタから選択）・担当者名・備考を入力して登録
- 「✅完了にする」：実施日・実施時走行距離・実際の費用・作業内容・次回予定日を入力するモーダル。保存すると `status` が「完了」になり「完了済み」タブに移動
- 「完了済み」タブ：実施日・ODO・カテゴリ・店舗・費用・作業内容・次回予定日のテーブル表示

### ④ 設定タブ
- **作業カテゴリ管理**：`users/{uid}/categories` に対するCRUD。初回アクセス時、カテゴリが0件であれば下記の初期カテゴリを自動投入
  - オイル交換／タイヤ交換・ローテーション／バッテリー交換／ブレーキパッド交換／エアフィルター交換／ワイパー交換／車検整備／定期点検（6ヶ月・12ヶ月）／板金・塗装／洗車・コーティング／その他
- **店舗マスタ管理**：`users/{uid}/shops` に対するCRUD（店舗名・電話番号・メモ、電話番号はtel:リンク表示）
- **CSVエクスポート**：選択中車両の給油記録・メンテナンス記録をそれぞれCSVファイルとしてダウンロード（Excelでの文字化け防止のためUTF-8 BOM付き）

### ⑤ 費用分析タブ（車両詳細モーダル内）
- Chart.js（CDN読み込み）による3種類のグラフ
  1. 月別費用の積み上げ棒グラフ（燃料費＋完了済みメンテ費用、直近12ヶ月）
  2. カテゴリ別費用内訳の円グラフ（完了済みメンテのみ、全期間集計）
  3. 燃費推移の折れ線グラフ
- 「年間維持費」カード：直近12ヶ月の完了済みメンテ費用＋給油費用＋年間保険料の合計を表示

## 🗂️ 画面構成・主なエントリ

このアプリはSPA（1つの `index.html`）で、内部タブ切り替えのみのため外部URLパラメータはありません。

- `index.html` … メイン画面（ログインゲート、4タブ構成：車両一覧／給油記録／メンテナンス／設定）
- `js/app.js` … 全ロジック（Firebase初期化、認証、Firestore CRUD、UI描画、Chart.js描画、CSV出力）

### 主なUI操作フロー
- ヘッダー「🔑 Googleでログイン」→ Googleアカウントでリダイレクトログイン
- 「＋ 車両を追加」→ 車両登録モーダル
- 車両カードの「詳細」→ 基本情報／保険情報／費用分析タブの車両詳細モーダル
- 「⛽ 給油記録」タブ → 給油記録の追加（レシート撮影・店舗選択含む）
- 「🔧 メンテナンス」タブ → 予約中・進行中／完了済みの切り替え、「＋新規予約」「✅完了にする」
- 「⚙️ 設定」タブ → カテゴリ管理／店舗管理／CSVエクスポート

## 🔧 セットアップ方法（Firebaseプロジェクト側）

1. [Firebase console](https://console.firebase.google.com/) でプロジェクトを作成
2. 「Authentication」→ Sign-in method で「Google」を有効化
3. 「Firestore Database」を作成（本番モード推奨。下記のセキュリティルールを設定）
4. 「プロジェクトの設定」→「マイアプリ」→ ウェブアプリを追加し、発行された設定値を `js/app.js` 内の `firebaseConfig` に反映（本プロジェクトでは `my-car-manager-daab9` の値を設定済み）
5. Authenticationの「承認済みドメイン」に、実際にアプリを公開するドメインを追加（Publishタブで発行されたドメインなど）

### 推奨セキュリティルール（Firestore）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 💾 データモデル（Cloud Firestore）

```
users/{uid}/cars/{carId}
  nickname, maker, model, year, plate, currentOdo, shakenDate
  jibaiseki: { company, policyNo, expiryDate }
  voluntary: { company, policyNo, agentName, agentPhone, agencyName, agencyPhone, memo, expiryDate, premium }
  createdAt, updatedAt

users/{uid}/cars/{carId}/fuelLogs/{logId}
  date, odo, liters, price, isFull, efficiency
  shopId, shopName
  receiptImage   … Base64文字列（canvasで幅800px程度にリサイズ・圧縮したJPEG。Firebase Storage未使用）
  createdAt

users/{uid}/cars/{carId}/maintenanceLogs/{logId}
  status … "未予約" | "予約済み" | "完了"
  category, reserveDate, reserveTime, shopId, shopName, person, notes   … 予約時に入力
  actualDate, actualOdo, actualCost, workDone, nextDate                  … 完了時に入力
  createdAt, updatedAt

users/{uid}/categories/{categoryId}
  name, order, createdAt, updatedAt

users/{uid}/shops/{shopId}
  name, phone, memo, createdAt, updatedAt
```

## 🌐 公開URL

このプロジェクトは静的サイトです。デプロイは **Publishタブ** から行ってください。Publishタブで発行されたURLが本番URLになります（本READMEでは固定URLは記載していません）。

## 🚧 未実装・今後の拡張候補

- Firestoreセキュリティルールの自動設定（現状は手動でFirebaseコンソールから設定が必要）
- 給油・メンテナンス記録の編集機能（現在は削除→再登録のみ対応、追加はできるが編集UIは無し）
- 費用分析タブの期間指定（現在は直近12ヶ月固定、カテゴリ円グラフは全期間集計）
- レシート画像の複数枚対応（現在は1件の給油記録につき1枚のみ）
- メンテナンス予約のプッシュ通知・リマインダー機能
- 作業カテゴリの並び替え（ドラッグ&ドロップ等）
- オフライン対応（Firestoreのオフライン永続化キャッシュの明示的な有効化）
- ダークモード対応

## 🛠️ 技術構成

- HTML5 / Tailwind CSS（CDN） / vanilla JavaScript（ESM）
- Firebase v9+ モジュール版SDK（`firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js`）をCDN経由でimport
- Chart.js 4系（CDN）でグラフ描画
- データ永続化：Cloud Firestore（リアルタイムリスナー `onSnapshot` で複数デバイス同期）
- 認証：Firebase Authentication（Googleログイン、リダイレクト方式）
- レシート画像：Canvas APIでリサイズ・圧縮し、Base64としてFirestoreドキュメントに直接格納（Firebase Storage不使用）
