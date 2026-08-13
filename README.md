# マイカー管理アプリ（Firebase版）

個人で複数台の車を所有している方向けの、車両情報・給油記録・メンテナンス記録・保険情報を
一元管理できる単一ページ（SPA）のWebアプリです。
**Firebase Authentication（Googleログイン）＋ Cloud Firestore** を使用しており、
同じGoogleアカウントでログインすれば、スマホ・PCなど複数デバイスから同じデータを
リアルタイムに確認・編集できます。

## 🎯 プロジェクトの目的
- 車検・自賠責・任意保険の満了日をひと目で把握したい
- 複数デバイス（自宅PC・スマホなど）から同じ車両データを見たい・編集したい
- 給油ごとに燃費(km/L)を自動計算して記録したい
- 保険会社・担当者・代理店の連絡先をワンタップで電話できるようにしたい
- オイル交換やタイヤ交換などのメンテナンス履歴を車両ごとに管理したい

## ⚠️ 利用開始前に必須の設定（Firebaseプロジェクトの準備）
本アプリを動作させるには、**あなた自身のFirebaseプロジェクト**が必要です。

1. [Firebaseコンソール](https://console.firebase.google.com/)で新規プロジェクトを作成
2. 「Authentication」→「Sign-in method」で **Google** を有効化
3. 「Firestore Database」を作成（本番モード推奨）し、以下のセキュリティルールを設定
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
4. 「プロジェクトの設定」→「マイアプリ」でウェブアプリを追加し、発行された
   `firebaseConfig` の値を `js/app.js` 冒頭の `firebaseConfig` 変数に貼り付ける
   ```js
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
5. Google認証の「承認済みドメイン」に、GitHub Pagesの公開ドメイン
   （例: `your-account.github.io`）を追加する

※ この設定を行わない場合、ログインボタンを押した際にエラーになります。

## ✅ 実装済み機能

### 1. 認証（Firebase Authentication / Googleログイン）
- ヘッダー右上に「Googleでログイン」ボタンを表示
- ログイン中はユーザーのアイコン・表示名と「ログアウト」ボタンを表示
- 未ログイン時は全タブの中身を非表示にし、「ログインしてください」という
  ガイド文言のみを表示（Firestoreへの通信も行わない）
- ログイン状態は `onAuthStateChanged` で監視し、状態変化に応じて
  画面表示とFirestoreの購読（リアルタイム同期）を自動的に切り替え

### 2. 車両管理（最大5台・Firestore CRUD）
- 保存先: `users/{uid}/cars/{carId}`
- ニックネーム（必須）・メーカー・車種・年式・ナンバー・現在の走行距離・車検満了日を登録
- **5台に達すると「＋ 車両を追加」ボタンが自動的に無効化**（ヘッダーに登録数「n / 5台」を表示）
- 車検・自賠責・任意保険の満了日に応じて色分け表示
  - 🔴 赤: 満了日まで30日以内（期限切れ含む）
  - 🟡 黄: 満了日まで31〜60日
  - 🟢 緑: 満了日まで61日以上
  - ⚪ グレー: 未設定
- 車両カードの「詳細」ボタンから車両詳細モーダルを開き、
  「基本情報」「保険情報」の2タブで内容を確認・編集
- 車両削除時は、Firestore上の給油記録・メンテナンス記録のサブコレクションも
  すべて削除（確認ダイアログあり）

### 3. 保険情報（車両詳細モーダル内の専用タブ）
- **自賠責保険**: 保険会社名、証券番号、満了日
- **任意保険**: 保険会社名、証券番号、担当者名、担当者電話番号、代理店名、
  代理店電話番号、補償内容メモ、満了日、年間保険料
- 担当者・代理店の電話番号は自動で `tel:` リンク化（スマホでタップして即発信可能）
- 保険情報は車両ドキュメント内のフィールド（`jibaiseki` / `voluntary`）として保存

### 4. 給油記録（Firestore CRUD・リアルタイム同期）
- 保存先: `users/{uid}/cars/{carId}/fuelLogs/{logId}`
- 日付、走行距離(ODO)、給油量(L)、金額(円)、満タンフラグを記録
- 登録時、同一車両の直前のODO記録との差分から燃費(km/L)を自動計算
- 記録追加時に車両の「現在の走行距離」をFirestore上で自動更新
- 一覧はODOの降順（新しい順）でリアルタイム表示、削除も可能

### 5. メンテナンス記録（Firestore CRUD・リアルタイム同期）
- 保存先: `users/{uid}/cars/{carId}/maintenanceLogs/{logId}`
- 日付、走行距離、作業カテゴリ（プルダウン＋その他自由入力）、費用、メモを記録
- 記録追加時に車両の「現在の走行距離」を自動更新
- 一覧は日付の降順でリアルタイム表示、削除も可能

### 6. マルチデバイス同期
- Cloud Firestoreの `onSnapshot` によるリアルタイム購読を採用しているため、
  同じGoogleアカウントで別デバイスからログインした場合、
  データ変更が自動的に反映されます（ページの再読み込み不要）

### 7. iOSホーム画面対応
- `apple-mobile-web-app-capable` 等のメタタグを追加し、
  iPhoneのホーム画面に追加した際にブラウザのアドレスバーなどを隠した
  アプリらしい表示になるよう設定
- `theme-color` によるステータスバー色の指定にも対応

## 📄 ページ構成
本アプリはSPA（単一HTML）のため、URLパスやクエリパラメータはありません。
画面内はタブ切り替え・モーダル表示によってビューを切り替えます（JSによる表示制御）。

| ファイル | 役割 |
|---|---|
| `index.html` | 全画面（ヘッダー認証UI、車両一覧／給油記録／メンテナンスの各タブ、車両登録・詳細モーダル）を含むメインページ |
| `js/app.js` | Firebase初期化、認証処理、Firestore CRUD・リアルタイム同期、画面描画、イベント処理を行うメインスクリプト（ESモジュール） |

## 💾 データモデル（Cloud Firestore）

### `users/{uid}/cars/{carId}`（車両情報）
```json
{
  "nickname": "マイロードスター",
  "maker": "マツダ",
  "model": "ロードスター",
  "year": 2020,
  "plate": "品川 300 あ 12-34",
  "currentOdo": 15230,
  "shakenDate": "2026-09-01",
  "jibaiseki": {
    "company": "○○損害保険",
    "policyNo": "1234-5678",
    "expiryDate": "2027-03-01"
  },
  "voluntary": {
    "company": "○○海上",
    "policyNo": "9876-5432",
    "agentName": "山田太郎",
    "agentPhone": "090-1234-5678",
    "agencyName": "○○代理店",
    "agencyPhone": "03-1234-5678",
    "memo": "対人・対物無制限、車両保険あり",
    "expiryDate": "2026-12-01",
    "premium": 65000
  },
  "createdAt": "(Firestore Timestamp)",
  "updatedAt": "(Firestore Timestamp)"
}
```

### `users/{uid}/cars/{carId}/fuelLogs/{logId}`（給油記録）
```json
{
  "date": "2026-07-20",
  "odo": 15230,
  "liters": 35.5,
  "price": 5500,
  "isFull": true,
  "efficiency": 14.32,
  "createdAt": "(Firestore Timestamp)"
}
```

### `users/{uid}/cars/{carId}/maintenanceLogs/{logId}`（メンテナンス記録）
```json
{
  "date": "2026-06-10",
  "odo": 14800,
  "category": "オイル交換",
  "cost": 8000,
  "memo": "エレメントも同時交換",
  "createdAt": "(Firestore Timestamp)"
}
```

## 🌐 公開URL
- 本プロジェクトは静的サイトのため、**Publishタブ**から公開してください。
  公開後のURLはPublishタブに表示されます。
- GitHub Pagesで公開する場合は、リポジトリの `index.html` と `js/app.js` を配置し、
  Pages設定で公開ブランチ・ディレクトリを指定してください（追加のビルド不要）。
- **重要**: 公開ドメインをFirebaseコンソールの「Authentication」→
  「Settings」→「承認済みドメイン」に追加しないと、Googleログインが失敗します。

## 🚧 未実装・今後の拡張候補（次の段階で追加予定）
- 給油記録・メンテナンス記録の編集機能（現在は追加・削除のみ）
- メンテナンスの予約ステータス管理（予定／完了など）や店舗選択
- レシート・車検証などの画像撮影・添付機能（Cloud Storage連携が必要）
- 給油記録／メンテナンス記録の車両別グラフ表示（燃費推移、費用推移など）
- データのCSVエクスポート／インポート
- 満了日が近い場合のブラウザ通知（Notification API）
- 複数車両のダッシュボード（全車両の満了日を一覧するサマリー画面）
- Firestoreセキュリティルールの単体テスト整備

## 🔧 技術構成
- HTML5 / CSS3 / Vanilla JavaScript（ESモジュール、フレームワーク不使用）
- Tailwind CSS（CDN経由）
- **Firebase Authentication**（Googleログイン、v9以降モジュール版SDKをCDN import）
- **Cloud Firestore**（データ永続化・複数デバイス間リアルタイム同期）
- レスポンシブ対応（Flexbox / CSS Grid）
- iOSホーム画面追加対応メタタグ

## 📁 ファイル構成
```
index.html      メインページ（全UI・モーダルを含む。Firebase SDKはjs/app.js内でimport）
js/app.js       アプリケーションロジック（Firebase初期化・認証・Firestore CRUD・画面描画）
README.md       本ドキュメント
```

## 🔐 セキュリティに関する注意
- `firebaseConfig` に含まれる `apiKey` 等はクライアント側で公開される情報ですが、
  実際のアクセス制御はFirestoreセキュリティルールで行われます。
  上記の「利用開始前に必須の設定」に記載したルールを必ず設定してください。
- ルールが未設定（テストモードのまま）だと、第三者が誰のデータでも読み書きできる
  状態になるため、本番公開前に必ず確認してください。
