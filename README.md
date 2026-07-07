# メモ帳

ブラウザで動くシンプルなメモアプリです。作成・編集・削除・検索に対応し、
Firebaseを設定するとGoogleログインで複数端末のリアルタイム同期ができます。

- 公開URL: https://okadamasayuki.github.io/test/
- `main` ブランチにプッシュすると GitHub Actions が自動でGitHub Pagesへデプロイします。

## 機能

- メモの作成・編集・削除、タイトル・本文の全文検索
- 入力すると自動保存（常に `localStorage` へキャッシュ、未ログインでも使えます）
- Googleログインで複数端末のリアルタイム同期（Firebase Firestore）
- 「ファイル」タブで端末間のファイル受け渡し（1ファイル20MBまで、要ログイン。
  ファイルはFirestoreに分割保存され、無料枠1GiBの範囲で使えます）
- 画像・PDF・テキストはタップでプレビュー表示（その場でダウンロードも可能）、
  その他の形式はタップで直接ダウンロード
- 一覧の左スワイプで削除、ダークモード対応、`Ctrl` / `Cmd` + `N` で新規メモ

## 端末間同期（Firebase）のセットアップ

初回だけ以下の設定が必要です（無料のSparkプランでOK、クレジットカード不要）。

### 1. Firebaseプロジェクトを作成

1. https://console.firebase.google.com を開き「プロジェクトを作成」
2. プロジェクト名は自由（例: `memo-app`）。Google アナリティクスは無効でOK

### 2. ログイン方法を有効化

1. 左メニュー「構築」→「Authentication」→「始める」
2. 「Sign-in method」タブ →「Google」を選んで有効化 → 保存
3. 同じく「メール / パスワード」を選んで有効化 → 保存
   （メールアドレスでの新規登録・ログインに必要）
4. 「Settings」タブ →「承認済みドメイン」に `okadamasayuki.github.io` を追加

### 3. Firestoreデータベースを作成

1. 左メニュー「構築」→「Firestore Database」→「データベースを作成」
2. ロケーションは `asia-northeast1`（東京）がおすすめ。「本番環境モード」で作成
3. 「ルール」タブを開き、以下に置き換えて「公開」

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

（自分のデータ（メモ・ファイル）は自分のアカウントでしか読み書きできない、という設定です）

### 4. Webアプリの設定値を取得して貼り付け

1. プロジェクトの概要ページで Web アイコン（`</>`）をクリックしてアプリを登録
   （Hostingのチェックは不要）
2. 表示される `firebaseConfig = { ... }` の中身をコピー
3. このリポジトリの `firebase-config.js` を開き、`window.FIREBASE_CONFIG = null;` を
   コピーした値で置き換えてコミット＆プッシュ

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef",
};
```

※ この `apiKey` はプロジェクトの識別子で、秘密鍵ではありません。
公開リポジトリに置いても問題なく、アクセス制御は手順3のルールで行われます。

### 5. 使う

デプロイ後、アプリ右上の ⚙ →「Googleでログイン」。
他の端末でも同じGoogleアカウントでログインすれば、メモが即座に同期されます。

## 構成

| ファイル             | 役割                                       |
|----------------------|--------------------------------------------|
| `index.html`         | 画面の構造                                 |
| `style.css`          | スタイル                                   |
| `app.js`             | ロジック・保存・同期処理                   |
| `firebase-config.js` | Firebase設定（未設定時はローカル動作のみ） |

## データについて

- メモは常にブラウザの `localStorage` にキャッシュされます
- ログイン中はFirestoreの `users/{あなたのUID}/memos` にも保存され、他端末と同期します
- 同期はメモ単位の「更新日時が新しい方が勝ち」でマージ、削除は墓標方式で伝播します
