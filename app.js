(async function () {
  "use strict";

  const STORAGE_KEY = "memo-app.memos.v1";
  const TOMBSTONE_TTL = 60 * 24 * 3600 * 1000; // 削除の記録を60日保持
  const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
  const CHUNK_CHARS = 700000; // Firestoreの1MiB制限に収まるbase64チャンク長
  const MAX_FILE_BYTES = 20 * 1024 * 1024; // アップロード上限 20MB

  // --- State ---
  let memos = load();
  let selectedId = null;
  let searchQuery = "";
  let saveTimer = null;
  const TAB_KEY = "memo-app.tab.v1";
  // リロードしても選択中のタブを維持する
  const savedTab = localStorage.getItem(TAB_KEY);
  let currentTab =
    savedTab === "files" || savedTab === "saved" || savedTab === "schedule" ? savedTab : "memos";
  let selectMode = false; // 一括削除の選択モード
  const checkedIds = new Set();

  // Firebase関連
  let fb = null; // { fs, db, auth, signInWithPopup, GoogleAuthProvider, signOut }
  let user = null;
  let unsubscribe = null;
  let unsubscribeFiles = null;
  let remoteById = new Map(); // サーバ側の最新状態（差分アップロードの判定用）
  let syncState = "off"; // off | nologin | live | error
  let syncErrorMsg = null;

  // ファイルタブ関連
  let filesMeta = []; // サーバ上のファイル一覧（メタデータ）
  let uploading = []; // [{id, name, progress}]
  const downloadingIds = new Set();

  // --- Elements ---
  const memoList = document.getElementById("memoList");
  const searchInput = document.getElementById("searchInput");
  const sortDueBtn = document.getElementById("sortDueBtn");
  const aiSearchBtn = document.getElementById("aiSearchBtn");
  const aiBar = document.getElementById("aiBar");
  const aiBarText = document.getElementById("aiBarText");
  const aiBarClose = document.getElementById("aiBarClose");
  const newBtn = document.getElementById("newBtn");
  const selectBtn = document.getElementById("selectBtn");
  const selectBar = document.getElementById("selectBar");
  const selectAllBtn = document.getElementById("selectAllBtn");
  const selectCount = document.getElementById("selectCount");
  const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  const uploadBtn = document.getElementById("uploadBtn");
  const fileInput = document.getElementById("fileInput");
  const tabSchedule = document.getElementById("tabSchedule");
  const tabMemos = document.getElementById("tabMemos");
  const tabSaved = document.getElementById("tabSaved");
  const tabFiles = document.getElementById("tabFiles");
  const emptyState = document.getElementById("emptyState");
  const emptyStateText = document.getElementById("emptyStateText");
  const editorPane = document.getElementById("editorPane");
  const backBtn = document.getElementById("backBtn");
  const titleInput = document.getElementById("titleInput");
  const dueSelect = document.getElementById("dueSelect");
  const dueDate = document.getElementById("dueDate");
  const dueInfo = document.getElementById("dueInfo");
  const bodyInput = document.getElementById("bodyInput");
  const copyBodyBtn = document.getElementById("copyBodyBtn");
  const translationPane = document.getElementById("translationPane");
  const translationText = document.getElementById("translationText");
  const proofBar = document.getElementById("proofBar");
  const proofBarText = document.getElementById("proofBarText");
  const proofBarUndo = document.getElementById("proofBarUndo");
  const autoProofreadCheck = document.getElementById("autoProofreadCheck");
  const deleteBtn = document.getElementById("deleteBtn");
  const savedLabel = document.getElementById("savedLabel");
  const countLabel = document.getElementById("countLabel");
  const syncBtn = document.getElementById("syncBtn");
  const syncLabel = document.getElementById("syncLabel");
  const syncModal = document.getElementById("syncModal");
  const syncSetupView = document.getElementById("syncSetupView");
  const syncLoginView = document.getElementById("syncLoginView");
  const syncUserView = document.getElementById("syncUserView");
  const userLabel = document.getElementById("userLabel");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const seedBtn = document.getElementById("seedBtn");
  const anthropicKeyInput = document.getElementById("anthropicKeyInput");
  const anthropicKeySaveBtn = document.getElementById("anthropicKeySaveBtn");
  const anthropicKeyState = document.getElementById("anthropicKeyState");
  const emailInput = document.getElementById("emailInput");
  const passwordInput = document.getElementById("passwordInput");
  const signupBtn = document.getElementById("signupBtn");
  const emailLoginBtn = document.getElementById("emailLoginBtn");
  const resetLink = document.getElementById("resetLink");
  const syncModalStatus = document.getElementById("syncModalStatus");
  const syncCloseBtn = document.getElementById("syncCloseBtn");
  const previewModal = document.getElementById("previewModal");
  const previewTitle = document.getElementById("previewTitle");
  const previewBody = document.getElementById("previewBody");
  const previewDownloadBtn = document.getElementById("previewDownloadBtn");
  const previewDeleteBtn = document.getElementById("previewDeleteBtn");
  const previewCloseBtn = document.getElementById("previewCloseBtn");

  // --- Persistence (ローカルキャッシュ) ---
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return sampleMemos(); // 初回起動時のみサンプルを投入
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error("メモの読み込みに失敗しました", e);
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memos));
    } catch (e) {
      console.error("メモの保存に失敗しました", e);
    }
  }

  function sampleMemos() {
    const now = Date.now();
    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;
    const samples = [
      {
        title: "今日のToDo",
        body: "・朝会の資料を共有\n・見積書のレビュー依頼を返す\n・経費精算（締切は今週金曜）\n・佐藤さんに議事録を送る",
        age: 2 * HOUR,
      },
      {
        title: "週次定例 議事録",
        body: "日時: 月曜 10:00〜10:30\n参加: 開発チーム全員\n\n決定事項:\n・リリースは来週木曜に延期\n・レビュー担当を持ち回り制に変更\n\n宿題:\n・パフォーマンス計測の結果共有（担当: 自分、期限: 水曜）",
        age: 5 * HOUR,
      },
      {
        title: "1on1メモ（上長と）",
        body: "・次の四半期は設計スキルを伸ばしたい旨を相談\n・新プロジェクトのリーダー候補の話あり\n・来月の評価面談の日程は後日調整\n\n次回までに: キャリア目標を3つ書き出す",
        age: 1 * DAY,
      },
      {
        title: "新機能のアイデア",
        body: "・CSVエクスポート機能（顧客からの要望多数）\n・ダークモード対応\n・検索結果のハイライト表示\n・Slack通知連携 → まずは工数見積もりから",
        age: 1 * DAY + 6 * HOUR,
      },
      {
        title: "顧客打ち合わせ（A社）",
        body: "日時: 6/30 15:00\n先方: 山田様、鈴木様\n\n要望:\n・帳票のレイアウトカスタマイズ\n・月次レポートの自動送信\n\n次回アクション: 見積もりを7/10までに提出",
        age: 2 * DAY,
      },
      {
        title: "リリース手順メモ",
        body: "1. mainブランチのCIが緑であることを確認\n2. ステージングで動作確認\n3. リリースタグを作成\n4. デプロイ実行\n5. 本番でスモークテスト\n6. リリースノートを社内チャンネルに投稿",
        age: 3 * DAY,
      },
      {
        title: "読みたい資料・記事",
        body: "・「達人プログラマー」第2版の後半\n・社内Wikiの新人向け設計ガイド\n・先週の技術共有会のスライド\n・競合B社の新サービスのプレスリリース",
        age: 4 * DAY,
      },
      {
        title: "出張準備チェックリスト",
        body: "□ 新幹線の予約（往復）\n□ ホテルの手配\n□ 名刺の残数確認\n□ デモ用PCの動作確認\n□ 出張申請の提出\n□ 訪問先への事前連絡",
        age: 5 * DAY,
      },
      {
        title: "今四半期の目標（OKR）",
        body: "O: 開発プロセスの改善\n\nKR1: レビューの平均待ち時間を2日→1日に短縮\nKR2: テストカバレッジを60%→75%に向上\nKR3: 障害の再発防止ドキュメントを毎回作成（実施率100%）",
        age: 6 * DAY,
      },
      {
        title: "障害対応の振り返り",
        body: "発生: 先週火曜 14:20頃、API応答が遅延\n原因: バッチ処理とピーク時間帯の重複\n対応: バッチを深夜帯に移動して復旧\n\n再発防止:\n・バッチ実行時間のルールを明文化\n・遅延アラートのしきい値を見直す",
        age: 7 * DAY,
      },
    ];
    return samples.map((s, i) => ({
      id: uid() + i.toString(36),
      title: s.title,
      body: s.body,
      sample: true,
      createdAt: now - s.age,
      updatedAt: now - s.age,
    }));
  }

  // --- Helpers ---
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const pad = (n) => String(n).padStart(2, "0");
    if (sameDay) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function getMemo(id) {
    return memos.find((m) => m.id === id && !m.deleted) || null;
  }

  // --- 期日 ---
  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x.getTime();
  }

  function presetDue(kind) {
    const d = new Date();
    if (kind === "today") return endOfDay(d);
    if (kind === "tomorrow") {
      d.setDate(d.getDate() + 1);
      return endOfDay(d);
    }
    if (kind === "week") {
      // 日曜日を週の終わりとする
      d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
      return endOfDay(d);
    }
    if (kind === "nextweek") {
      d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + 7);
      return endOfDay(d);
    }
    return null;
  }

  // 期日タイムスタンプ → 表示用チップ（文言と色クラス）
  function dueChip(due) {
    if (typeof due !== "number") return null;
    const now = Date.now();
    if (due < now) return { text: "期限切れ", cls: "overdue" };
    if (due <= presetDue("today")) return { text: "本日中", cls: "today" };
    if (due <= presetDue("tomorrow")) return { text: "明日中", cls: "soon" };
    if (due <= presetDue("week")) return { text: "今週中", cls: "soon" };
    if (due <= presetDue("nextweek")) return { text: "来週中", cls: "later" };
    const d = new Date(due);
    return { text: `${d.getMonth() + 1}/${d.getDate()}まで`, cls: "later" };
  }

  // 期日タイムスタンプ → セレクトの選択値
  function dueToSelectValue(due) {
    if (typeof due !== "number") return "";
    for (const k of ["today", "tomorrow", "week", "nextweek"]) {
      if (due === presetDue(k)) return k;
    }
    return "custom";
  }

  function setDue(ts) {
    const memo = getMemo(selectedId);
    if (!memo) return;
    // 並び順が未確定(order無し)のメモはupdatedAt更新で先頭に跳ねてしまうため、
    // 先に現在の表示順を全メモに確定させて位置を動かさない
    if (typeof memo.order !== "number") {
      sortedMemos().forEach((m, i) => {
        if (m.order !== i) {
          m.order = i;
          m.updatedAt = Date.now();
          pushMemo(m);
        }
      });
    }
    if (ts === null) delete memo.due;
    else memo.due = ts;
    memo.updatedAt = Date.now();
    delete memo.sample;
    pushMemo(memo);
    save();
    render();
  }

  function visibleMemos() {
    return memos.filter((m) => !m.deleted);
  }

  // 並び順: 手動で並び替えたメモはorder昇順、未設定のもの(新規など)は
  // 更新が新しい順に先頭へ来る
  function sortKey(m) {
    return typeof m.order === "number" ? m.order : -m.updatedAt;
  }

  function sortedMemos() {
    return visibleMemos().sort((a, b) => sortKey(a) - sortKey(b));
  }

  // 「期日順」ボタン: 期日ありを期日が近い順に先頭へ並べ直す
  // （その後のドラッグでの手動並び替えは自由にできる）
  function resortByDue() {
    const list = visibleMemos();
    const withDue = list
      .filter((m) => typeof m.due === "number")
      .sort((a, b) => a.due - b.due || sortKey(a) - sortKey(b));
    const rest = list
      .filter((m) => typeof m.due !== "number")
      .sort((a, b) => sortKey(a) - sortKey(b));
    [...withDue, ...rest].forEach((m, i) => {
      if (m.order !== i) {
        m.order = i;
        m.updatedAt = Date.now();
        pushMemo(m);
      }
    });
  }




  // --- 本文の自動整形(誤字脱字の修正 + タイトルの自動生成) ---
  //
  // iOSアプリの src/lib/proofreadContent.ts / proofread.ts と同じロジック。
  // 入力が止まったら自動で走り、本文を直接書き換える。自動で課金され、かつ
  // ユーザーの文章を書き換えるので、暴走しないための判定を持つ:
  //  1. 整形後の本文でまた走る無限ループ  → 直前の整形結果と同じなら走らない
  //  2. 書きかけの短文を勝手に直される    → 一定の長さに満たなければ走らない
  //  3. 変えていないのに何度も課金される  → 前回送った本文と同じなら走らない

  const PROOFREAD_ENABLED_STORAGE = "memo-app.auto-proofread.v1";
  // 自動整形は入力が止まるたびに走って課金されるため、安いHaikuを使う(opusの約1/5)。
  // 注意: Haiku 4.5 は thinking:{type:"adaptive"} と output_config.effort を
  // 受け付けない世代なので、リクエストにこの2つを入れないこと(400になる)。
  const PROOFREAD_MODEL = "claude-haiku-4-5";
  const PROOFREAD_MIN_BODY_CHARS = 10;
  const PROOFREAD_MAX_BODY_CHARS = 20000;
  const PROOFREAD_IDLE_MS = 3000;
  const PROOFREAD_UNDO_VISIBLE_MS = 12000;

  const PROOFREAD_SYSTEM_PROMPT =
    "あなたは日本語の編集者です。渡されたメモの本文について、次の作業をしてください。" +
    "\n\n" +
    "1. corrected: 誤字・脱字・変換ミスを直し、意味を変えない範囲で" +
    "自然で読みやすい書き言葉（常体）に書き直した本文を返す。" +
    "語順の入れ替えや言い回しの調整はしてかまいません。" +
    "「えーと」「あの」などの言いよどみは取り除き、話し言葉は書き言葉に直します。" +
    "ただし意味の変更、情報の追加・削除、要約は禁止です。" +
    "事実・数字・固有名詞は変えないでください。" +
    "改行・箇条書き・記号などの構造はそのまま保ってください。" +
    "直すところが無ければ、渡された本文をそのまま返します。" +
    "\n\n" +
    "2. changes: 直した箇所を before/after の組で列挙する。直していなければ空配列。" +
    "\n\n" +
    "3. title: 本文の内容を表す20文字以内の短いタイトルを1つ考える。" +
    "本文が意味をなさない場合は空文字にする。" +
    "\n\n" +
    "4. translation: correctedの本文全体を自然な英語に翻訳する。" +
    "改行・箇条書きの構造は本文に合わせる。";

  const PROOFREAD_SCHEMA = {
    type: "object",
    properties: {
      corrected: { type: "string" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { before: { type: "string" }, after: { type: "string" } },
          required: ["before", "after"],
          additionalProperties: false,
        },
      },
      title: { type: "string" },
      translation: { type: "string" },
    },
    required: ["corrected", "changes", "title", "translation"],
    additionalProperties: false,
  };

  const EMPTY_PROOFREAD_MEMORY = { lastSent: null, lastCorrected: null };

  function shouldRunProofread(body, memory) {
    const trimmed = body.trim();
    if (trimmed.length < PROOFREAD_MIN_BODY_CHARS) return false;
    if (trimmed.length > PROOFREAD_MAX_BODY_CHARS) return false;
    if (memory.lastCorrected !== null && body === memory.lastCorrected) return false;
    if (memory.lastSent !== null && body === memory.lastSent) return false;
    return true;
  }

  // タイトルは空のときだけ入れる。自分で付けたタイトルを消さない。
  function pickTitle(currentTitle, suggested) {
    if (currentTitle.trim() !== "") return null;
    const t = suggested.trim();
    return t === "" ? null : t;
  }

  function bodyChanged(before, after) {
    return before !== after;
  }

  function changesLabel(count) {
    return count > 0 ? `${count}箇所を修正しました` : "直すところはありませんでした";
  }

  // 既定はオン。切りたければ設定から。
  function isProofreadEnabled() {
    return localStorage.getItem(PROOFREAD_ENABLED_STORAGE) !== "off";
  }

  function setProofreadEnabled(on) {
    localStorage.setItem(PROOFREAD_ENABLED_STORAGE, on ? "on" : "off");
  }

  async function requestProofread(body) {
    const apiKey = getAnthropicKey();
    if (!apiKey) throw new Error("APIキーが設定されていません（⚙から設定）");

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: PROOFREAD_MODEL,
          max_tokens: 8192,
          // Haiku 4.5 は adaptive thinking と effort に非対応(送ると400)。
          output_config: {
            format: { type: "json_schema", schema: PROOFREAD_SCHEMA },
          },
          system: PROOFREAD_SYSTEM_PROMPT,
          messages: [{ role: "user", content: body }],
        }),
      });
    } catch (e) {
      throw new Error("ネットワークに接続できません。");
    }

    if (!res.ok) {
      let apiMessage = "";
      try {
        apiMessage = (await res.json()).error?.message || "";
      } catch (e) {
        /* JSONでないエラー本文は無視 */
      }
      throw new Error(summaryStatusErrMsg(res.status, apiMessage));
    }

    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("この本文は整形できませんでした。");
    // 本文が途中で切れた結果で上書きすると文章が失われる
    if (data.stop_reason === "max_tokens") throw new Error("本文が長すぎて整形できませんでした。");

    const raw = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error("整形の結果を解釈できませんでした。");
    }
    if (typeof parsed.corrected !== "string") {
      throw new Error("整形の結果を解釈できませんでした。");
    }
    return {
      corrected: parsed.corrected,
      changes: parsed.changes || [],
      title: parsed.title || "",
      translation: parsed.translation || "",
    };
  }

  let proofreadMemory = { ...EMPTY_PROOFREAD_MEMORY };
  let proofreadTimer = null;
  let proofreadBusy = false;
  let proofreadUndoBody = null;
  let proofreadUndoTranslation = null;
  let proofreadUndoTimer = null;

  function showProofBar(text, canUndo, isError) {
    proofBar.hidden = false;
    proofBarText.textContent = text;
    proofBarText.classList.toggle("error", !!isError);
    proofBarUndo.hidden = !canUndo;
  }

  function hideProofBar() {
    proofBar.hidden = true;
    proofreadUndoBody = null;
    proofreadUndoTranslation = null;
  }

  function scheduleProofBarHide() {
    clearTimeout(proofreadUndoTimer);
    proofreadUndoTimer = setTimeout(hideProofBar, PROOFREAD_UNDO_VISIBLE_MS);
  }

  function undoProofread() {
    if (proofreadUndoBody === null) return;
    // 戻した本文でまた整形が走らないよう、送信済みとして記録しておく
    proofreadMemory = { lastSent: proofreadUndoBody, lastCorrected: proofreadUndoBody };
    bodyInput.value = proofreadUndoBody;
    // 英訳も整形前のものに戻す
    const memo = getMemo(selectedId);
    if (memo) {
      memo.translation = proofreadUndoTranslation || "";
      renderTranslation(memo);
    }
    updateSelected();
    hideProofBar();
  }

  // 英訳ペインの表示をメモの保存値に合わせる
  function renderTranslation(memo) {
    const tr = ((memo && memo.translation) || "").trim();
    translationText.textContent = tr;
    translationPane.hidden = !tr;
  }

  async function runProofread() {
    const memo = getMemo(selectedId);
    if (!memo) return;
    const sent = bodyInput.value;
    proofreadBusy = true;
    showProofBar("整形しています…", false, false);
    proofreadMemory = { ...proofreadMemory, lastSent: sent };
    try {
      const result = await requestProofread(sent);
      // 待っているあいだにユーザーが打ち直していたら、古い結果で上書きしない
      if (bodyInput.value !== sent || getMemo(selectedId) !== memo) return;

      proofreadMemory = { lastSent: sent, lastCorrected: result.corrected };

      let applied = false;
      if (bodyChanged(sent, result.corrected)) {
        bodyInput.value = result.corrected;
        proofreadUndoBody = sent;
        proofreadUndoTranslation = memo.translation || "";
        applied = true;
      }
      const newTitle = pickTitle(titleInput.value, result.title);
      if (newTitle) {
        titleInput.value = newTitle;
        applied = true;
      }
      // 英訳はメモに保存する(端末をまたいで同期され、iOS版の長押しにも出る)
      const newTranslation = result.translation.trim();
      if (newTranslation && newTranslation !== (memo.translation || "")) {
        memo.translation = newTranslation;
        applied = true;
      }
      renderTranslation(memo);
      if (applied) updateSelected();

      showProofBar(changesLabel(result.changes.length), proofreadUndoBody !== null, false);
      scheduleProofBarHide();
    } catch (e) {
      showProofBar(String(e?.message || e), false, true);
      scheduleProofBarHide();
    } finally {
      proofreadBusy = false;
    }
  }

  function resetProofread() {
    clearTimeout(proofreadTimer);
    clearTimeout(proofreadUndoTimer);
    proofreadMemory = { ...EMPTY_PROOFREAD_MEMORY };
    proofreadUndoBody = null;
    proofreadUndoTranslation = null;
    proofBar.hidden = true;
    translationPane.hidden = true;
    translationText.textContent = "";
  }

  // 入力が止まってから走らせる
  function scheduleProofread() {
    clearTimeout(proofreadTimer);
    if (proofreadBusy || !getAnthropicKey() || !isProofreadEnabled()) return;
    if (!shouldRunProofread(bodyInput.value, proofreadMemory)) return;
    proofreadTimer = setTimeout(runProofread, PROOFREAD_IDLE_MS);
  }

  // --- AI意味検索 ---
  //
  // ベクトル検索ではない。生きているメモの本文をまとめて1回のリクエストで送り、
  // Claudeに全文を読ませて選ばせる(総当たり)。「どのメモが該当するか」だけでなく
  // 「本文のどの一文が根拠か」を逐語で返させ、その一文を蛍光する。
  // iOSアプリの src/lib/aiSearchContent.ts / aiSearch.ts と同じロジック。

  const AI_MAX_MEMOS = 80;
  const AI_MAX_TOTAL_CHARS = 100000;
  // 1件あたりの上限。これが無いと、巨大なメモ1件が総量を食い潰して
  // 以降のメモが1件も送られなくなる。
  const AI_MAX_MEMO_CHARS = 4000;

  const AI_SEARCH_SYSTEM_PROMPT =
    "あなたはメモ検索の補助です。ユーザーの検索語に、意味の上で関連するメモを選んでください。" +
    "文字列が一致していなくても、内容が該当すれば選びます（例:「お金の話」→ 金額や費用が書かれたメモ）。" +
    "関連しないメモは選ばないでください。該当が無ければ空の配列を返します。" +
    "各メモについて quote には、そのメモの title か body から根拠となる一文を" +
    "一字一句そのまま抜き出してください。要約・言い換え・省略記号の付加は禁止です。" +
    "関連度の高い順に並べてください。";

  const AI_SEARCH_SCHEMA = {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, quote: { type: "string" } },
          required: ["id", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["matches"],
    additionalProperties: false,
  };

  let aiResult = null; // { query, hits: [{memo, preview, quoteFound}], truncated }
  let aiBusy = false;
  const aiCache = new Map();

  function bodyForSearch(body) {
    return body.length <= AI_MAX_MEMO_CHARS ? body : body.slice(0, AI_MAX_MEMO_CHARS);
  }

  function buildAiPayload(memosToSend) {
    return memosToSend.map((m) => ({ id: m.id, title: m.title, body: bodyForSearch(m.body) }));
  }

  function selectMemosToSend(list) {
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    const sent = [];
    let chars = 0;
    for (const m of sorted) {
      if (sent.length >= AI_MAX_MEMOS) break;
      const size = m.title.length + bodyForSearch(m.body).length;
      if (chars + size > AI_MAX_TOTAL_CHARS) break;
      chars += size;
      sent.push(m);
    }
    return { sent, truncated: list.length - sent.length };
  }

  // モデルの出力を信用しきらない: 存在しないid・重複idは捨てる
  function buildHits(memosSent, matches) {
    const byId = new Map(memosSent.map((m) => [m.id, m]));
    const seen = new Set();
    const hits = [];
    for (const { id, quote } of matches) {
      const memo = byId.get(id);
      if (!memo || seen.has(id)) continue;
      seen.add(id);

      const inBody = locateQuote(memo.body, quote);
      if (inBody) {
        hits.push({ memo, preview: makeSnippet(memo.body, [inBody]), quoteFound: true });
        continue;
      }
      if (locateQuote(memo.title, quote)) {
        hits.push({ memo, preview: makeSnippet(memo.body, []), quoteFound: true });
        continue;
      }
      // 言い換えられて本文に無い。落とさず、返ってきた一文をそのまま見せる。
      hits.push({ memo, preview: { text: quote.trim(), ranges: [] }, quoteFound: false });
    }
    return hits;
  }

  async function requestAiSearch(query, list) {
    const apiKey = getAnthropicKey();
    if (!apiKey) throw new Error("APIキーが設定されていません（⚙から設定）");
    const { sent, truncated } = selectMemosToSend(list);
    if (sent.length === 0) return { query, hits: [], truncated };

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: AI_SEARCH_SCHEMA },
          },
          system: AI_SEARCH_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `検索語: ${query}\n\nメモ一覧(JSON):\n${JSON.stringify(buildAiPayload(sent))}`,
            },
          ],
        }),
      });
    } catch (e) {
      throw new Error("ネットワークに接続できません。通信環境を確認してください。");
    }

    if (!res.ok) {
      let apiMessage = "";
      try {
        apiMessage = (await res.json()).error?.message || "";
      } catch (e) {
        /* JSONでないエラー本文は無視 */
      }
      throw new Error(summaryStatusErrMsg(res.status, apiMessage));
    }

    const data = await res.json();
    if (data.stop_reason === "refusal") {
      throw new Error("この検索語では実行できませんでした。");
    }
    const raw = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error("AI検索の結果を解釈できませんでした。もう一度お試しください。");
    }
    return { query, hits: buildHits(sent, parsed.matches || []), truncated };
  }

  function memoFingerprint() {
    const live = tabScopedMemos();
    return `${live.length}:${live.reduce((max, m) => Math.max(max, m.updatedAt), 0)}`;
  }

  function clearAiResult() {
    aiResult = null;
    aiBar.hidden = true;
    renderList();
  }

  async function executeAiSearch() {
    const query = searchQuery.trim();
    if (!query || aiBusy || currentTab === "files" || !getAnthropicKey()) return;

    const cacheKey = `${currentTab} ${memoFingerprint()} ${query}`;
    if (aiCache.has(cacheKey)) {
      aiResult = aiCache.get(cacheKey);
      showAiBar();
      renderList();
      return;
    }

    aiBusy = true;
    aiBar.hidden = false;
    aiBarText.textContent = "AI検索を実行しています…";
    aiBarClose.hidden = true;
    try {
      const result = await requestAiSearch(query, tabScopedMemos());
      aiCache.set(cacheKey, result);
      aiResult = result;
      showAiBar();
      renderList();
    } catch (e) {
      aiResult = null;
      aiBarText.textContent = String(e?.message || e);
      aiBarClose.hidden = false;
      renderList();
    } finally {
      aiBusy = false;
    }
  }

  function showAiBar() {
    aiBar.hidden = false;
    aiBarClose.hidden = false;
    aiBarText.textContent =
      `AI検索: ${aiResult.query}` +
      (aiResult.truncated > 0 ? `（更新の古い${aiResult.truncated}件は対象外）` : "");
  }

  // --- 検索の正規化・マッチ・抜粋 ---
  //
  // iOSアプリの src/lib/search.ts と同じロジック。出力が一致することを
  // スクリプトで突き合わせている。片方だけ直さないこと。
  //
  // 蛍光するには「正規化後の一致位置」を「元テキストの位置」に戻す必要がある。
  // ところが正規化は文字数を変える:
  //   "ﾊﾟ" (2文字) → NFKC → "パ" (1文字)   縮む
  //   "㍿" (1文字) → NFKC → "株式会社"      伸びる
  //   "İ".toLowerCase()                    → 2文字に伸びる
  // そのため単純な1対1の対応表では足りず、正規化後の各文字が元テキストの
  // どの範囲から来たかを starts/ends で持つ。

  const HALF_DAKUTEN = "ﾞ";
  const HALF_HANDAKUTEN = "ﾟ";

  function katakanaToHiragana(ch) {
    const c = ch.codePointAt(0);
    if (c !== undefined && c >= 0x30a1 && c <= 0x30f6) return String.fromCodePoint(c - 0x60);
    return ch;
  }

  // 1文字→1文字にならない小文字化(İ など)は諦めて元の文字を保つ。
  // 崩れた対応表で蛍光位置がずれるより、その文字が一致しないほうがましなため。
  function safeLower(ch) {
    const lower = ch.toLowerCase();
    return [...lower].length === 1 ? lower : ch;
  }

  function fold(ch) {
    return safeLower(katakanaToHiragana(ch));
  }

  function normalizeWithMap(text) {
    let normalized = "";
    const starts = [];
    const ends = [];
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      let src = ch;
      let consumed = ch.length;

      // 半角カナ + 濁点/半濁点 はペアで正規化しないと結合しない
      const next = text[i + ch.length];
      if (next === HALF_DAKUTEN || next === HALF_HANDAKUTEN) {
        src = ch + next;
        consumed = ch.length + 1;
      }

      const nfkc = src.normalize("NFKC");
      for (const outCh of nfkc) {
        for (const folded of fold(outCh)) {
          normalized += folded;
          starts.push(i);
          ends.push(i + consumed);
        }
      }
      i += consumed;
    }
    return { normalized, starts, ends };
  }

  function normalizeText(text) {
    return normalizeWithMap(text).normalized;
  }

  function searchTerms(query) {
    return normalizeText(query)
      .split(/[\s　]+/)
      .filter((t) => t.length > 0);
  }

  function mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [sorted[0]];
    for (const [s, e] of sorted.slice(1)) {
      const last = out[out.length - 1];
      if (s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  function findRanges(text, terms) {
    if (terms.length === 0) return [];
    const { normalized, starts, ends } = normalizeWithMap(text);
    const ranges = [];
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const hit = normalized.indexOf(term, from);
        if (hit < 0) break;
        ranges.push([starts[hit], ends[hit + term.length - 1]]);
        from = hit + term.length;
      }
    }
    return mergeRanges(ranges);
  }

  function matchesAll(text, terms) {
    if (terms.length === 0) return true;
    const { normalized } = normalizeWithMap(text);
    return terms.every((t) => normalized.includes(t));
  }

  const SNIPPET_BEFORE = 12;
  const SNIPPET_AFTER = 48;

  // 改行を空白1文字に置き換える。文字数が変わらないので範囲をそのまま使える。
  function flatten(body) {
    return body.replace(/\n/g, " ");
  }

  function makeSnippet(body, ranges) {
    if (ranges.length === 0) {
      const firstLine = body.split("\n").find((l) => l.trim() !== "") || "";
      return { text: firstLine.trim(), ranges: [] };
    }
    const flat = flatten(body);
    const [hitStart, hitEnd] = ranges[0];
    const start = Math.max(0, hitStart - SNIPPET_BEFORE);
    const end = Math.min(flat.length, hitEnd + SNIPPET_AFTER);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < flat.length ? "…" : "";
    const text = prefix + flat.slice(start, end) + suffix;
    const offset = prefix.length - start;
    const out = ranges
      .filter(([s, e]) => s >= start && e <= end)
      .map(([s, e]) => [s + offset, e + offset]);
    return { text, ranges: out };
  }

  // Claudeが返した根拠の一文が、元テキストのどこにあるかを探す。
  function locateQuote(text, quote) {
    const trimmed = quote.trim();
    if (!trimmed) return null;
    const direct = text.indexOf(trimmed);
    if (direct >= 0) return [direct, direct + trimmed.length];
    const { normalized, starts, ends } = normalizeWithMap(text);
    const needle = normalizeText(trimmed);
    if (!needle) return null;
    const hit = normalized.indexOf(needle);
    if (hit < 0) return null;
    return [starts[hit], ends[hit + needle.length - 1]];
  }

  // --- スケジュールタブのカレンダー(iOSアプリの src/lib/calendar.ts と同じロジック) ---
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function dayKey(y, m, d) {
    return `${y}-${m + 1}-${d}`;
  }

  function dayKeyFromTs(ts) {
    const dt = new Date(ts);
    return dayKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  function monthLabel(y, m) {
    return `${y}年 ${m + 1}月`;
  }

  function addMonths(y, m, delta) {
    const total = y * 12 + m + delta;
    return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
  }

  // 日曜始まりの6週分(42マス)。先頭は「1日を含む週の日曜」。
  function monthGrid(y, m) {
    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push({
        y: dt.getFullYear(),
        m: dt.getMonth(),
        d: dt.getDate(),
        inMonth: dt.getMonth() === m && dt.getFullYear() === y,
        key: dayKey(dt.getFullYear(), dt.getMonth(), dt.getDate()),
      });
    }
    return cells;
  }

  function dueCountByDay(list) {
    const map = new Map();
    for (const m of list) {
      if (typeof m.due !== "number") continue;
      const key = dayKeyFromTs(m.due);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  const calNow = new Date();
  let calY = calNow.getFullYear();
  let calM = calNow.getMonth();
  let calSelectedKey = null; // クリックした日(その日のtodo一覧を下に出す)

  // 期日ドットと日別一覧はtodo(保存用でない)の生きているメモが対象
  function todoWithDue() {
    return sortedMemos().filter((m) => !m.saved && typeof m.due === "number");
  }

  // いま開いているメモ系タブ(メモ/保存用)に属するメモだけを返す
  function tabScopedMemos() {
    return sortedMemos().filter((m) => (currentTab === "saved" ? !!m.saved : !m.saved));
  }

  // ローカル検索とAI検索のどちらでも、行に渡す形(抜粋+蛍光範囲)に揃える
  function memoRows() {
    if (aiResult) {
      return aiResult.hits.map((h) => ({
        memo: h.memo,
        titleRanges: [],
        preview: h.preview,
      }));
    }
    const terms = searchTerms(searchQuery.trim());
    const list = tabScopedMemos();
    if (terms.length === 0) {
      return list.map((m) => ({ memo: m, titleRanges: [], preview: makeSnippet(m.body, []) }));
    }
    return list
      .filter((m) => matchesAll(m.title, terms) || matchesAll(m.body, terms))
      .map((m) => ({
        memo: m,
        titleRanges: findRanges(m.title, terms),
        preview: makeSnippet(m.body, findRanges(m.body, terms)),
      }));
  }

  function filteredMemos() {
    return memoRows().map((r) => r.memo);
  }

  // ファイルは名前しか持たないのでAI検索の対象外。ローカル検索のみ。
  function filteredFiles() {
    const terms = searchTerms(searchQuery.trim());
    let list = [...filesMeta].sort((a, b) => b.createdAt - a.createdAt);
    if (terms.length > 0) list = list.filter((f) => matchesAll(f.name, terms));
    return list;
  }

  // --- スワイプで削除(左) / 保存用へ移動(右) ---
  const SWIPE_W = 80; // 削除ボタンの幅(px)
  const SAVE_W = 96; // 保存用ラベルの幅(px)
  let openSwipeEl = null;

  function closeOpenSwipe() {
    if (openSwipeEl) {
      openSwipeEl.style.transform = "";
      openSwipeEl = null;
    }
  }

  function attachSwipe(content, onTap, onSave) {
    let active = false;
    let startX = 0;
    let startY = 0;
    let base = 0;
    let mode = null; // null | "swipe" | "scroll"
    let dragged = false;

    function start(x, y) {
      active = true;
      startX = x;
      startY = y;
      base = openSwipeEl === content ? -SWIPE_W : 0;
      mode = null;
      dragged = false;
    }

    // 戻り値true = スワイプ確定（呼び出し側でスクロールを止める）
    function move(x, y) {
      if (!active) return false;
      const dx = x - startX;
      const dy = y - startY;
      if (mode === null) {
        // 横方向の動きが優勢な時だけスワイプ扱いにし、縦スクロールは邪魔しない
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          mode = "swipe";
          content.style.transition = "none";
        } else if (Math.abs(dy) > 8) {
          mode = "scroll";
        }
      }
      if (mode === "swipe") {
        dragged = true;
        const off = Math.max(-SWIPE_W, Math.min(onSave ? SAVE_W : 0, base + dx));
        content.style.transform = `translateX(${off}px)`;
        return true;
      }
      return false;
    }

    function end(x) {
      if (!active) return;
      active = false;
      if (mode === "swipe") {
        content.style.transition = "";
        const off = base + (x - startX);
        if (onSave && off > SAVE_W / 2) {
          content.style.transform = "";
          if (openSwipeEl === content) openSwipeEl = null;
          onSave();
        } else if (off < -SWIPE_W / 2) {
          if (openSwipeEl && openSwipeEl !== content) closeOpenSwipe();
          content.style.transform = `translateX(-${SWIPE_W}px)`;
          openSwipeEl = content;
        } else {
          content.style.transform = "";
          if (openSwipeEl === content) openSwipeEl = null;
        }
      }
      mode = null;
    }

    // タッチ（スマホ）: iOS Safari等はPointer Eventsをスクロールに横取りする
    // ことがあるため、touchイベントで直接扱う
    content.addEventListener(
      "touchstart",
      (e) => start(e.touches[0].clientX, e.touches[0].clientY),
      { passive: true }
    );
    content.addEventListener(
      "touchmove",
      (e) => {
        if (move(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault();
      },
      { passive: false }
    );
    content.addEventListener("touchend", (e) =>
      end(e.changedTouches[0].clientX)
    );
    content.addEventListener("touchcancel", (e) =>
      end(e.changedTouches[0].clientX)
    );

    // マウス（PC）: pointerTypeがmouseの時だけ扱い、タッチとの二重処理を防ぐ
    content.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      start(e.clientX, e.clientY);
    });
    content.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (mode === "swipe" || active) {
        if (move(e.clientX, e.clientY) && !content.hasPointerCapture(e.pointerId)) {
          content.setPointerCapture(e.pointerId);
        }
      }
    });
    const mouseEnd = (e) => {
      if (e.pointerType !== "mouse") return;
      end(e.clientX);
    };
    content.addEventListener("pointerup", mouseEnd);
    content.addEventListener("pointercancel", mouseEnd);

    content.addEventListener("click", (e) => {
      if (dragged) {
        // スワイプ直後のクリックは選択扱いにしない
        dragged = false;
        e.stopPropagation();
        return;
      }
      if (openSwipeEl) {
        const wasSelf = openSwipeEl === content;
        closeOpenSwipe();
        if (wasSelf) return;
      }
      onTap();
    });
  }

  // --- ドラッグ＆ドロップで並び替え ---
  let draggingRow = false;

  function commitOrder() {
    const ids = [...memoList.querySelectorAll(".memo-item")].map((li) => li.dataset.id);
    let changed = false;
    ids.forEach((id, i) => {
      const m = getMemo(id);
      if (m && m.order !== i) {
        m.order = i;
        m.updatedAt = Date.now(); // 他端末へ並び順の変更を伝えるため
        pushMemo(m);
        changed = true;
      }
    });
    if (changed) save();
    renderList();
  }

  // 行を入れ替える際、他の行が滑らかに場所を空けるアニメーション(FLIP)
  function moveRowWithFlip(li, after) {
    const rows = [...memoList.children].filter(
      (el) => el !== li && el.classList.contains("memo-item")
    );
    const before = new Map(rows.map((el) => [el, el.getBoundingClientRect().top]));
    if (after) memoList.insertBefore(li, after);
    else memoList.appendChild(li);
    for (const el of rows) {
      const d = before.get(el) - el.getBoundingClientRect().top;
      if (d) {
        el.style.transition = "none";
        el.style.transform = `translateY(${d}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 0.18s ease";
          el.style.transform = "";
        });
      }
    }
  }

  function attachDragHandle(handle, li) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRow = true;

      // つかんだ行の「浮いた」分身を作り、指に追従させる
      const rect = li.getBoundingClientRect();
      const grabDy = e.clientY - rect.top;
      const ghost = li.cloneNode(true);
      ghost.className = "memo-item drag-ghost";
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      ghost.style.width = rect.width + "px";
      document.body.appendChild(ghost);
      requestAnimationFrame(() => ghost.classList.add("lifted"));
      li.classList.add("drag-source"); // 元の位置は半透明のプレースホルダーに

      // 行のDOM移動でポインター捕捉が途切れることがあるため、
      // move/upはwindow側で受ける
      const move = (ev) => {
        ghost.style.top = ev.clientY - grabDy + "px";
        const y = ev.clientY;
        const others = [...memoList.children].filter(
          (el) => el !== li && el.classList.contains("memo-item")
        );
        let after = null;
        for (const s of others) {
          const r = s.getBoundingClientRect();
          if (y < r.top + r.height / 2) {
            after = s;
            break;
          }
        }
        if (after) {
          if (after.previousElementSibling !== li) moveRowWithFlip(li, after);
        } else if (memoList.lastElementChild !== li) {
          moveRowWithFlip(li, null);
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        ghost.remove();
        li.classList.remove("drag-source");
        draggingRow = false;
        commitOrder();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    // ハンドル上でのタッチスクロール・スワイプは無効化(touch-action:noneと併用)
    handle.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    handle.addEventListener("click", (e) => e.stopPropagation());
  }

  // --- Rendering ---
  // 指定範囲だけ <mark> で包む。本文はユーザー入力なので必ずエスケープしてから
  // 挿し込む(innerHTMLに生データを入れないこと)。
  function fillHighlighted(el, text, ranges) {
    el.textContent = "";
    if (!ranges || ranges.length === 0) {
      el.textContent = text;
      return;
    }
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) el.appendChild(document.createTextNode(text.slice(cursor, start)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      el.appendChild(mark);
      cursor = end;
    }
    if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function buildRow({ id, titleText, previewText, dateText, selected, draggable, onTap, onDelete, onSave, saveLabel, titleRanges, previewRanges }) {
    const li = document.createElement("li");
    li.dataset.id = id;
    li.className =
      "memo-item" +
      (selected ? " selected" : "") +
      (selectMode && checkedIds.has(id) ? " checked" : "");

    const title = document.createElement("div");
    title.className = "memo-title";
    fillHighlighted(title, titleText, titleRanges);

    const preview = document.createElement("div");
    preview.className = "memo-preview";
    fillHighlighted(preview, previewText, previewRanges);

    const date = document.createElement("div");
    date.className = "memo-date";
    if (arguments[0].chip) {
      const c = document.createElement("span");
      c.className = "due-chip " + arguments[0].chip.cls;
      c.textContent = arguments[0].chip.text;
      date.appendChild(c);
    }
    date.appendChild(document.createTextNode(dateText));

    const check = document.createElement("span");
    check.className = "check-circle";

    const content = document.createElement("div");
    content.className = "memo-swipe-content" + (draggable ? " has-handle" : "");
    content.append(check, title, preview, date);

    if (draggable) {
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⠿";
      handle.title = "ドラッグで並び替え";
      content.appendChild(handle);
      attachDragHandle(handle, li);
    }

    const del = document.createElement("button");
    del.className = "memo-delete-btn";
    del.textContent = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });

    if (onSave) {
      const saveEl = document.createElement("div");
      saveEl.className = "memo-save-btn";
      saveEl.textContent = saveLabel || "保存用へ";
      li.appendChild(saveEl);
    }
    li.append(del, content);
    attachSwipe(content, () => {
      if (selectMode) {
        if (checkedIds.has(id)) checkedIds.delete(id);
        else checkedIds.add(id);
        renderList();
      } else {
        onTap();
      }
    }, selectMode ? undefined : onSave);
    return li;
  }

  // --- スケジュールタブの描画 ---
  function renderCalendar() {
    const li = document.createElement("li");
    li.className = "cal-container";

    const header = document.createElement("div");
    header.className = "cal-header";
    const title = document.createElement("span");
    title.className = "cal-title";
    title.textContent = monthLabel(calY, calM);
    title.title = "クリックで今月に戻る";
    title.addEventListener("click", () => {
      const now = new Date();
      calY = now.getFullYear();
      calM = now.getMonth();
      renderList();
    });
    const nav = document.createElement("div");
    nav.className = "cal-nav";
    for (const [label, delta] of [["‹", -1], ["›", 1]]) {
      const btn = document.createElement("button");
      btn.className = "cal-nav-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        const next = addMonths(calY, calM, delta);
        calY = next.y;
        calM = next.m;
        renderList();
      });
      nav.appendChild(btn);
    }
    header.append(title, nav);
    li.appendChild(header);

    const week = document.createElement("div");
    week.className = "cal-week";
    for (const w of WEEKDAYS) {
      const el = document.createElement("span");
      el.textContent = w;
      week.appendChild(el);
    }
    li.appendChild(week);

    const dueMap = dueCountByDay(todoWithDue());
    const now = new Date();
    const todayKey = dayKey(now.getFullYear(), now.getMonth(), now.getDate());
    const grid = document.createElement("div");
    grid.className = "cal-grid";
    let monthDue = 0;
    for (const cell of monthGrid(calY, calM)) {
      const dueCount = dueMap.get(cell.key) || 0;
      if (cell.inMonth) monthDue += dueCount;
      const el = document.createElement("button");
      el.className =
        "cal-cell" +
        (cell.inMonth ? "" : " out") +
        (cell.inMonth && cell.key === todayKey ? " today" : "") +
        (cell.key === calSelectedKey ? " selected" : "");
      const num = document.createElement("span");
      num.className = "cal-day";
      num.textContent = String(cell.d);
      const dots = document.createElement("span");
      dots.className = "cal-dots";
      for (let i = 0; i < Math.min(dueCount, 3); i++) {
        const dot = document.createElement("span");
        dot.className = "cal-dot";
        dots.appendChild(dot);
      }
      el.append(num, dots);
      // クリック(スマホはタップ)でその日のtodo一覧を下に出す
      el.addEventListener("click", () => {
        calSelectedKey = calSelectedKey === cell.key ? null : cell.key;
        calSelectedLabel = `${cell.m + 1}月${cell.d}日`;
        renderList();
      });
      grid.appendChild(el);
    }
    li.appendChild(grid);

    // 選んだ日のtodo一覧
    if (calSelectedKey) {
      const dayList = document.createElement("div");
      dayList.className = "cal-day-list";
      const head = document.createElement("div");
      head.className = "cal-day-list-title";
      head.textContent = `${calSelectedLabel}が期日のtodo`;
      dayList.appendChild(head);
      const items = todoWithDue()
        .filter((m) => dayKeyFromTs(m.due) === calSelectedKey)
        .sort((a, b) => a.due - b.due);
      if (!items.length) {
        const none = document.createElement("div");
        none.className = "cal-day-empty";
        none.textContent = "この日が期日のtodoはありません。";
        dayList.appendChild(none);
      }
      for (const m of items) {
        const row = document.createElement("button");
        row.className = "cal-day-item";
        const t = document.createElement("div");
        t.className = "cal-day-item-title";
        t.textContent = m.title.trim() || "無題のメモ";
        row.appendChild(t);
        const firstLine = m.body.trim().split("\n")[0];
        if (firstLine) {
          const p = document.createElement("div");
          p.className = "cal-day-item-preview";
          p.textContent = firstLine;
          row.appendChild(p);
        }
        row.addEventListener("click", () => selectMemo(m.id));
        dayList.appendChild(row);
      }
      li.appendChild(dayList);
    } else {
      const hint = document.createElement("div");
      hint.className = "cal-hint";
      hint.textContent = "● がその日が期日のtodo。日付を押すと一覧が出ます。";
      li.appendChild(hint);
    }

    memoList.appendChild(li);
    countLabel.textContent = `今月の期日: ${monthDue}件`;
  }
  let calSelectedLabel = "";

  // --- 選択モード（一括削除） ---
  function currentListIds() {
    return (currentTab === "files" ? filteredFiles() : filteredMemos()).map((x) => x.id);
  }

  function updateSelectBar() {
    selectBar.hidden = !selectMode;
    selectBtn.textContent = selectMode ? "✕" : "☑";
    selectBtn.title = selectMode ? "選択をキャンセル" : "選択して一括削除";
    selectBtn.classList.toggle("active", selectMode);
    memoList.classList.toggle("select-mode", selectMode);
    if (!selectMode) return;
    const n = checkedIds.size;
    selectCount.textContent = n ? `${n}件選択中` : "タップして選択";
    bulkDeleteBtn.textContent = n ? `削除 (${n})` : "削除";
    bulkDeleteBtn.disabled = n === 0;
    const ids = currentListIds();
    selectAllBtn.textContent =
      ids.length && ids.every((id) => checkedIds.has(id)) ? "選択解除" : "すべて選択";
  }

  function toggleSelectMode() {
    selectMode = !selectMode;
    checkedIds.clear();
    renderList();
  }

  function toggleSelectAll() {
    const ids = currentListIds();
    if (ids.length && ids.every((id) => checkedIds.has(id))) {
      checkedIds.clear();
    } else {
      ids.forEach((id) => checkedIds.add(id));
    }
    renderList();
  }

  async function bulkDelete() {
    const n = checkedIds.size;
    if (!n) return;
    const kind = currentTab === "files" ? "ファイル" : "メモ";
    if (!confirm(`選択した${kind}${n}件を削除しますか？`)) return;
    bulkDeleteBtn.disabled = true;
    if (currentTab !== "files") {
      for (const id of checkedIds) deleteMemoNow(id);
      save();
    } else {
      for (const id of checkedIds) {
        const meta = filesMeta.find((f) => f.id === id);
        if (meta) await deleteFileNow(meta).catch(() => {});
      }
    }
    selectMode = false;
    checkedIds.clear();
    render();
  }

  function renderList() {
    if (draggingRow) return; // ドラッグ中は同期による再描画で並びを壊さない
    memoList.innerHTML = "";
    openSwipeEl = null;

    if (currentTab === "schedule") {
      renderCalendar();
      return;
    }

    if (currentTab !== "files") {
      const rows = memoRows();
      // 検索中(ローカル/AI問わず)と選択モード中は並び替え無効
      const canDrag = !selectMode && !searchQuery.trim() && !aiResult;
      rows.forEach(({ memo: m, titleRanges, preview }) => {
        memoList.appendChild(
          buildRow({
            id: m.id,
            draggable: canDrag,
            onSave: () => setSaved(m.id, currentTab !== "saved"),
            saveLabel: currentTab === "saved" ? "todoへ戻す" : "保存用へ",
            chip: dueChip(m.due),
            titleText: m.title.trim() || "無題のメモ",
            titleRanges: m.title.trim() ? titleRanges : [],
            previewText: preview.text || m.body.trim().split("\n")[0] || "本文なし",
            previewRanges: preview.ranges,
            dateText: formatDate(m.updatedAt),
            selected: m.id === selectedId,
            onTap: () => selectMemo(m.id),
            onDelete: () => deleteMemoById(m.id),
          })
        );
      });
      const total = tabScopedMemos().length;
      countLabel.textContent = (searchQuery.trim() || aiResult) && total > 0
        ? `${rows.length} / ${total} 件`
        : `${total} 件のメモ`;
      updateSelectBar();
      return;
    }

    // --- ファイルタブ ---
    if (!user) {
      const li = document.createElement("li");
      li.className = "list-hint";
      li.textContent = syncState === "off"
        ? "ファイル機能を使うにはFirebaseの設定が必要です（README参照）"
        : "ファイル機能を使うには ⚙ からログインしてください";
      memoList.appendChild(li);
      countLabel.textContent = "";
      return;
    }

    for (const u of uploading) {
      const li = document.createElement("li");
      li.className = "list-hint";
      li.textContent = `⬆ ${u.name} をアップロード中… ${u.progress}%`;
      memoList.appendChild(li);
    }

    const list = filteredFiles();
    list.forEach((f) => {
      const canPreview = previewable(f);
      memoList.appendChild(
        buildRow({
          id: f.id,
          titleText: f.name,
          previewText: downloadingIds.has(f.id)
            ? "読み込み中…"
            : `${formatSize(f.size)}・タップで${canPreview ? "プレビュー" : "ダウンロード"}`,
          dateText: formatDate(f.createdAt),
          selected: false,
          onTap: () => (canPreview ? previewFile(f) : downloadFile(f)),
          onDelete: () => deleteFile(f),
        })
      );
    });
    countLabel.textContent = `${filesMeta.length} 件のファイル`;
    updateSelectBar();
  }

  function renderEditor() {
    // スマホでは編集対象がない時にエディタ領域ごと隠し、一覧を全画面にする
    const showEditor = currentTab !== "files" && !!getMemo(selectedId);
    document.body.classList.toggle("no-editor", !showEditor);

    if (currentTab === "files") {
      editorPane.hidden = true;
      emptyState.hidden = false;
      emptyStateText.innerHTML =
        "「⬆ アップロード」でファイルを追加できます。<br>一覧のファイルはタップでダウンロード、<br>左スワイプで削除できます。";
      return;
    }
    const memo = getMemo(selectedId);
    if (!memo) {
      selectedId = null;
      editorPane.hidden = true;
      emptyState.hidden = false;
      emptyStateText.innerHTML =
        currentTab === "schedule"
          ? "カレンダーの日付を押すと、<br>その日が期日のtodoが見えます。"
          : "メモを選択するか、<br>「+ 新規」で作成してください。";
      return;
    }
    emptyState.hidden = true;
    editorPane.hidden = false;
    // 他端末からの反映時に入力中のカーソルを壊さないよう、値が違う時だけ入れ替える
    if (titleInput.value !== memo.title) titleInput.value = memo.title;
    if (bodyInput.value !== memo.body) bodyInput.value = memo.body;
    renderTranslation(memo);
    savedLabel.textContent = "最終更新: " + formatDate(memo.updatedAt);

    // 期日セレクタの表示を現在の値に合わせる
    const dv = dueToSelectValue(memo.due);
    dueSelect.value = dv;
    dueDate.hidden = dv !== "custom";
    if (dv === "custom") {
      const d = new Date(memo.due);
      const pad = (n) => String(n).padStart(2, "0");
      dueDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } else {
      dueDate.value = "";
    }
    const chip = dueChip(memo.due);
    if (chip) {
      const d = new Date(memo.due);
      dueInfo.textContent = `${d.getMonth() + 1}/${d.getDate()}まで`;
      dueInfo.className = "due-info " + chip.cls;
    } else {
      dueInfo.textContent = "";
      dueInfo.className = "due-info";
    }
  }

  function updateSyncLabel() {
    syncLabel.title = "";
    if (syncState === "off") {
      syncLabel.textContent = "同期: 未設定";
      syncLabel.className = "sync-label";
    } else if (syncState === "nologin") {
      syncLabel.textContent = "未ログイン";
      syncLabel.className = "sync-label";
    } else if (syncState === "error") {
      syncLabel.textContent = "同期エラー";
      syncLabel.className = "sync-label sync-error";
      syncLabel.title = syncErrorMsg || "";
    } else {
      // 同期中は⚙ボタンの緑色で表現し、ラベルは出さない
      syncLabel.textContent = "";
      syncLabel.className = "sync-label";
    }
    // 設定ボタンの色も同期状態に合わせる（同期中=緑、エラー=赤）
    syncBtn.className =
      "header-btn" +
      (syncState === "live" ? " sync-ok" : syncState === "error" ? " sync-error" : "");
  }

  function render() {
    renderList();
    renderEditor();
    updateSyncLabel();
  }

  function switchTab(tab) {
    if (currentTab !== tab) {
      discardFreshIfEmpty(null);
      selectMode = false;
      checkedIds.clear();
    }
    currentTab = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch (e) {}
    // AI検索の結果は前のタブのメモ集合に対するものなので持ち越さない
    aiResult = null;
    aiBar.hidden = true;
    updateAiSearchBtn();
    tabSchedule.classList.toggle("active", tab === "schedule");
    tabMemos.classList.toggle("active", tab === "memos");
    tabSaved.classList.toggle("active", tab === "saved");
    tabFiles.classList.toggle("active", tab === "files");
    newBtn.hidden = tab === "files";
    uploadBtn.hidden = tab !== "files";
    sortDueBtn.hidden = tab === "files" || tab === "schedule";
    // カレンダーに検索と選択モードは無い
    searchInput.parentElement.hidden = tab === "schedule";
    selectBtn.hidden = tab === "schedule";
    render();
  }

  // --- Actions (メモ) ---
  // 作成したまま何も入力されなかった新規メモは、離れた時に自動で消す
  let freshMemoId = null;

  function discardFreshIfEmpty(exceptId) {
    if (!freshMemoId || freshMemoId === exceptId) {
      if (freshMemoId === exceptId) return;
      freshMemoId = null;
      return;
    }
    const m = getMemo(freshMemoId);
    if (m && !m.title.trim() && !m.body.trim()) {
      deleteMemoNow(freshMemoId);
      save();
    }
    freshMemoId = null;
  }

  function createMemo() {
    discardFreshIfEmpty(null);
    // 新規メモは常にtodo一覧に作る(他のタブで押した場合はタブも移す)
    if (currentTab !== "memos") switchTab("memos");
    const memo = {
      id: uid(),
      title: "",
      body: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    memos.push(memo);
    freshMemoId = memo.id;
    save();
    pushMemo(memo);
    selectMemo(memo.id);
    titleInput.focus();
  }

  function isMobile() {
    return window.matchMedia("(max-width: 640px)").matches;
  }

  function selectMemo(id) {
    discardFreshIfEmpty(id);
    // 別のメモに移ったら、前のメモの整形状態を持ち越さない
    resetProofread();
    // スマホではエディタが全画面になるため、ブラウザの「戻る」で一覧に
    // 戻れるよう履歴を1つ積む（iOSの端からの戻るスワイプにも対応）
    if (isMobile() && !(history.state && history.state.memoOpen)) {
      history.pushState({ memoOpen: true }, "");
    }
    selectedId = id;
    render();
  }

  // アプリ内の「戻る」では履歴操作をしない（history.back()の非同期性と
  // 競合して二重に戻る事故を防ぐ）。積んだ履歴はpopstate側で無害に消費される。
  function backToList() {
    discardFreshIfEmpty(null);
    selectedId = null;
    render();
  }

  function updateSelected() {
    const memo = getMemo(selectedId);
    if (!memo) return;
    memo.title = titleInput.value;
    memo.body = bodyInput.value;
    memo.updatedAt = Date.now();
    delete memo.sample; // 編集されたサンプルは通常のメモ扱い

    savedLabel.textContent = "保存中…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save();
      renderList();
      savedLabel.textContent = "保存しました";
      pushMemo(memo);
    }, 400);
  }

  // メモ一覧と保存用タブの間の移動(saved=trueで保存用へ)
  function setSaved(id, saved) {
    const memo = getMemo(id);
    if (!memo) return;
    if (saved) memo.saved = true;
    else delete memo.saved;
    delete memo.sample; // 触られたサンプルは通常のメモ扱い
    memo.updatedAt = Date.now();
    if (selectedId === id) selectedId = null; // 別タブに移るので選択を外す
    save();
    pushMemo(memo);
    render();
  }

  // 他端末にも削除が伝わるよう、消すのではなく削除済みの印を残す
  function deleteMemoNow(id) {
    const idx = memos.findIndex((m) => m.id === id && !m.deleted);
    if (idx < 0) return;
    const tombstone = { id, deleted: true, updatedAt: Date.now() };
    memos[idx] = tombstone;
    if (selectedId === id) selectedId = null;
    pushMemo(tombstone);
  }

  function deleteMemoById(id) {
    const memo = getMemo(id);
    if (!memo) return;
    const name = memo.title.trim() || "このメモ";
    if (!confirm(`「${name}」を削除しますか？`)) return;
    deleteMemoNow(id);
    save();
    render();
  }

  function deleteSelected() {
    deleteMemoById(selectedId);
  }

  // --- Actions (ファイル) ---
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function uploadFiles(fileList) {
    if (!fb || !user) {
      alert("ファイル機能を使うにはログインしてください（⚙から）。");
      return;
    }
    for (const file of fileList) {
      if (file.size > MAX_FILE_BYTES) {
        alert(`「${file.name}」は${formatSize(MAX_FILE_BYTES)}を超えているためアップロードできません。`);
        continue;
      }
      const id = uid();
      const entry = { id, name: file.name, progress: 0 };
      uploading.push(entry);
      renderList();
      try {
        const b64 = bufToB64(await file.arrayBuffer());
        const chunkCount = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
        for (let i = 0; i < chunkCount; i++) {
          const ref = fb.fs.doc(fb.db, "users", user.uid, "chunks", `${id}_${i}`);
          await fb.fs.setDoc(ref, { data: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
          entry.progress = Math.round(((i + 1) / chunkCount) * 100);
          renderList();
        }
        // メタデータは最後に書き込む（一覧には完成したファイルだけが載る）
        const metaRef = fb.fs.doc(fb.db, "users", user.uid, "files", id);
        await fb.fs.setDoc(metaRef, {
          id,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          chunkCount,
          createdAt: Date.now(),
        });
      } catch (e) {
        setSyncError(e);
        alert(`「${file.name}」のアップロードに失敗しました: ` + (e.message || e));
      } finally {
        uploading = uploading.filter((u) => u !== entry);
        renderList();
      }
    }
  }

  async function fetchFileBase64(meta) {
    const parts = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      const ref = fb.fs.doc(fb.db, "users", user.uid, "chunks", `${meta.id}_${i}`);
      const snap = await fb.fs.getDoc(ref);
      if (!snap.exists()) throw new Error("ファイルの一部が見つかりません");
      parts.push(snap.data().data);
    }
    return parts.join("");
  }

  async function fetchFileBlob(meta) {
    return new Blob([b64ToBytes(await fetchFileBase64(meta))], { type: meta.type });
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadFile(meta) {
    if (!fb || !user || downloadingIds.has(meta.id)) return;
    downloadingIds.add(meta.id);
    renderList();
    try {
      triggerDownload(await fetchFileBlob(meta), meta.name);
    } catch (e) {
      alert(`「${meta.name}」のダウンロードに失敗しました: ` + (e.message || e));
    } finally {
      downloadingIds.delete(meta.id);
      renderList();
    }
  }

  // --- プレビュー ---
  function isDocx(meta) {
    return (
      meta.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      (meta.name || "").toLowerCase().endsWith(".docx")
    );
  }

  function isXlsx(meta) {
    return (
      meta.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      (meta.name || "").toLowerCase().endsWith(".xlsx")
    );
  }

  function previewable(meta) {
    const t = meta.type || "";
    return (
      t.startsWith("image/") ||
      t === "application/pdf" ||
      t.startsWith("text/") ||
      t === "application/json" ||
      isDocx(meta) ||
      isXlsx(meta)
    );
  }

  // --- xlsx の読み出し（iOSアプリの src/lib/xlsxRead.ts と同じロジック） ---
  //
  // 文字列は sharedStrings.xml に集約されて番号で参照される(t="s")ことも、
  // セルに直接埋め込まれる(inlineStr)こともある。Excelは前者、openpyxlは後者。
  // 数式は結果のキャッシュ<v>を持つが、ライブラリが書くと空になる。
  // 日付はシリアル値で、styles.xml の numFmtId を見ないと日付だと分からない。

  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

  function decodeXmlEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      const hit = XML_ENTITIES[body];
      return hit === undefined ? whole : hit;
    });
  }

  // 中の <t> をすべて連結する。自己閉じを先に試さないと後続を飲み込む。
  function collectText(xml) {
    const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = "";
    let m;
    while ((m = re.exec(xml))) text += decodeXmlEntities(m[1] ?? "");
    return text;
  }

  function columnIndex(ref) {
    const letters = /^([A-Z]+)/.exec(ref);
    if (!letters) return 0;
    let n = 0;
    for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function parseSharedStrings(xml) {
    const out = [];
    const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) out.push(collectText(m[1] ?? ""));
    return out;
  }

  const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

  function parseStyles(xml) {
    const custom = new Map();
    const fmtRe = /<numFmt\b[^>]*\snumFmtId="(\d+)"[^>]*\sformatCode="([^"]*)"/g;
    let m;
    while ((m = fmtRe.exec(xml))) custom.set(parseInt(m[1], 10), decodeXmlEntities(m[2]));

    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
    const fmtIds = [];
    const xfRe = /<xf\b([^>]*)\/>|<xf\b([^>]*)>[\s\S]*?<\/xf>/g;
    let x;
    while ((x = xfRe.exec(cellXfs))) {
      const attrs = x[1] ?? x[2] ?? "";
      fmtIds.push(parseInt(/\snumFmtId="(\d+)"/.exec(attrs)?.[1] ?? "0", 10));
    }

    // 書式コード中の [..] や "..." を除いた上で年月日時分秒の記号を探す
    const dateLike = (code) => /[ymdhs]/i.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, ""));

    return {
      isDate(styleIndex) {
        const id = fmtIds[styleIndex];
        if (id === undefined) return false;
        if (BUILTIN_DATE_FMTS.has(id)) return true;
        const code = custom.get(id);
        return code !== undefined && dateLike(code);
      },
    };
  }

  // Excelはシリアル60を実在しない1900/02/29として数えるため、60以前は1日ずれる
  function serialToDateText(serial) {
    const adjusted = serial < 61 ? serial + 1 : serial;
    const ms = Math.round((adjusted - 25569) * 86400000);
    if (!Number.isFinite(ms)) return String(serial);
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, "0");
    const date = `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`;
    if (serial - Math.floor(serial) === 0) return date;
    const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    return serial < 1 ? time : `${date} ${time}`;
  }

  const EMPTY_CELL = { text: "", numeric: false };

  function cellValue(attrs, inner, shared, styles) {
    const type = /\st="([^"]*)"/.exec(attrs)?.[1] ?? "n";
    if (type === "inlineStr") return { text: collectText(inner), numeric: false };

    const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (raw === undefined) {
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
      // 結果が無いなら数式そのものを見せる。空欄よりは伝わる。
      if (formula) return { text: "=" + decodeXmlEntities(formula), numeric: false };
      return EMPTY_CELL;
    }
    const v = decodeXmlEntities(raw);

    if (type === "s") return { text: shared[parseInt(v, 10)] ?? "", numeric: false };
    if (type === "b") return { text: v === "1" ? "TRUE" : "FALSE", numeric: false };
    if (type === "str" || type === "e") return { text: v, numeric: false };

    const styleIndex = parseInt(/\ss="(\d+)"/.exec(attrs)?.[1] ?? "-1", 10);
    const n = Number(v);
    if (styleIndex >= 0 && Number.isFinite(n) && styles.isDate(styleIndex)) {
      return { text: serialToDateText(n), numeric: false };
    }
    return { text: v, numeric: true };
  }

  function trimSheet(rows) {
    const isBlank = (c) => !c || c.text === "";
    while (rows.length && rows[rows.length - 1].every(isBlank)) rows.pop();
    let width = 0;
    for (const r of rows) {
      for (let i = r.length - 1; i >= 0; i--) {
        if (!isBlank(r[i])) {
          width = Math.max(width, i + 1);
          break;
        }
      }
    }
    return rows.map((r) => {
      const row = r.slice(0, width);
      while (row.length < width) row.push(EMPTY_CELL);
      return row;
    });
  }

  function parseSheetXml(xml, shared, styles) {
    const rows = [];
    // 自己閉じを先に試す。逆にすると <row r="3"/> が後続を飲み込む。
    const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const attrs = rm[1] ?? rm[2] ?? "";
      const inner = rm[3] ?? "";
      const rowNum = parseInt(/\sr="(\d+)"/.exec(attrs)?.[1] ?? "0", 10);
      const index = rowNum > 0 ? rowNum - 1 : rows.length;

      const cells = [];
      // 同上。<c r="A1"/> が次のセルを飲み込まないように。
      const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      let auto = 0;
      while ((cm = cellRe.exec(inner))) {
        const selfClosing = cm[1] !== undefined;
        const cAttrs = cm[1] ?? cm[2] ?? "";
        const cInner = cm[3] ?? "";
        const ref = /\sr="([A-Z]+\d+)"/.exec(cAttrs)?.[1];
        const col = ref ? columnIndex(ref) : auto;
        auto = col + 1;
        while (cells.length < col) cells.push(EMPTY_CELL);
        cells[col] = selfClosing ? EMPTY_CELL : cellValue(cAttrs, cInner, shared, styles);
      }
      while (rows.length < index) rows.push([]);
      rows[index] = cells;
    }
    return trimSheet(rows);
  }

  function firstSheetPath(workbookXml, relsXml) {
    const rid = /<sheet\b[^>]*\sr:id="([^"]+)"/.exec(workbookXml)?.[1];
    if (!rid) return null;
    const re = new RegExp(`<Relationship\\b[^>]*\\sId="${rid}"[^>]*\\sTarget="([^"]+)"`);
    const target = re.exec(relsXml)?.[1];
    if (!target) return null;
    return "xl/" + target.replace(/^\/?xl\//, "").replace(/^\.\//, "");
  }

  function firstSheetName(workbookXml) {
    const name = /<sheet\b[^>]*\sname="([^"]*)"/.exec(workbookXml)?.[1];
    return name ? decodeXmlEntities(name) : "Sheet1";
  }

  function readXlsx(bytes) {
    const zip = fflate.unzipSync(bytes);
    const read = (p) => (zip[p] ? fflate.strFromU8(zip[p]) : null);

    const workbook = read("xl/workbook.xml");
    if (!workbook) throw new Error("xlsxのブック(xl/workbook.xml)が見つかりません");

    const rels = read("xl/_rels/workbook.xml.rels") ?? "";
    const path = firstSheetPath(workbook, rels) ?? "xl/worksheets/sheet1.xml";
    const sheet = read(path) ?? read("xl/worksheets/sheet1.xml");
    if (!sheet) throw new Error("xlsxのシートが見つかりません");

    const shared = parseSharedStrings(read("xl/sharedStrings.xml") ?? "");
    const styles = parseStyles(read("xl/styles.xml") ?? "");
    return { name: firstSheetName(workbook), rows: parseSheetXml(sheet, shared, styles) };
  }

  // fflate（ZIP展開）は必要になった時に一度だけ読み込む
  let fflateLoading = null;
  function loadFflate() {
    if (window.fflate) return Promise.resolve(window.fflate);
    if (!fflateLoading) {
      fflateLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/fflate.umd.js";
        s.onload = () => resolve(window.fflate);
        s.onerror = () => reject(new Error("プレビュー用ライブラリの読み込みに失敗しました"));
        document.head.appendChild(s);
      });
    }
    return fflateLoading;
  }

  function renderXlsxTable(sheet) {
    const wrap = document.createElement("div");
    wrap.className = "xlsx-content";

    const caption = document.createElement("div");
    caption.className = "xlsx-sheet-name";
    caption.textContent = `シート: ${sheet.name}`;
    wrap.appendChild(caption);

    if (!sheet.rows.some((r) => r.some((c) => c.text !== ""))) {
      const p = document.createElement("p");
      p.textContent = "このシートには表示できるセルがありません。";
      wrap.appendChild(p);
      return wrap;
    }

    const table = document.createElement("table");
    sheet.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((cell) => {
        const td = document.createElement(r === 0 ? "th" : "td");
        td.textContent = cell.text;
        if (cell.numeric) td.classList.add("num");
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    return wrap;
  }

  // mammoth.js（docx→HTML変換）は必要になった時に一度だけ読み込む
  let mammothLoading = null;
  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothLoading) {
      mammothLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/mammoth.browser.min.js";
        s.onload = () => resolve(window.mammoth);
        s.onerror = () => reject(new Error("プレビュー用ライブラリの読み込みに失敗しました"));
        document.head.appendChild(s);
      });
    }
    return mammothLoading;
  }

  // --- AI要約（Claude API） ---
  //
  // iOSアプリ(src/lib/summaryContent.ts / summary.ts)と同じプロンプト・同じ
  // リクエスト形にすること。キーはこのブラウザのlocalStorageにだけ保存する。
  // 生成結果は users/{uid}/summaries/{fileId} にキャッシュし、iOSと共有する。

  const ANTHROPIC_KEY_STORAGE = "memo-app.anthropic-key.v1";
  const SUMMARY_MODEL = "claude-opus-4-8";
  const SUMMARY_SYSTEM_PROMPT =
    "ユーザーが送るファイルの内容を日本語で3〜4文に要約してください。" +
    "書式やファイル形式の説明ではなく、書かれている中身の要点（金額・日付・決定事項など）を伝えてください。" +
    "前置きは不要で、要約本文だけを返してください。";
  const SUMMARY_MAX_TEXT_CHARS = 50000;
  const SUMMARY_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  function getAnthropicKey() {
    return localStorage.getItem(ANTHROPIC_KEY_STORAGE) || "";
  }

  function summaryTruncate(text) {
    if (text.length <= SUMMARY_MAX_TEXT_CHARS) return text;
    return (
      text.slice(0, SUMMARY_MAX_TEXT_CHARS) +
      "\n\n（長いため以降は省略。ここまでの内容で要約してください）"
    );
  }

  function summaryTextBlock(name, body) {
    return { type: "text", text: `ファイル名: ${name}\n---\n${summaryTruncate(body)}` };
  }

  // 要約対象か(プレビュー可能な種別のうち、Claudeが読めるもの)
  function summarizable(meta) {
    const t = meta.type || "";
    if (t.startsWith("image/")) return SUMMARY_IMAGE_TYPES.includes(t);
    return previewable(meta);
  }

  async function buildSummaryContent(meta, base64) {
    const t = meta.type || "";
    if (t === "application/pdf") {
      return [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: `このPDF（ファイル名: ${meta.name}）を要約してください。` },
      ];
    }
    if (t.startsWith("image/")) {
      if (!SUMMARY_IMAGE_TYPES.includes(t)) {
        throw new Error(`この画像形式（${t}）は要約に対応していません`);
      }
      return [
        { type: "image", source: { type: "base64", media_type: t, data: base64 } },
        { type: "text", text: `この画像（ファイル名: ${meta.name}）に写っている内容を要約してください。` },
      ];
    }
    if (isDocx(meta)) {
      const mammoth = await loadMammoth();
      const result = await mammoth.extractRawText({ arrayBuffer: b64ToBytes(base64).buffer });
      return [summaryTextBlock(meta.name, result.value)];
    }
    if (isXlsx(meta)) {
      await loadFflate();
      const sheet = readXlsx(b64ToBytes(base64));
      const rows = sheet.rows.map((r) => r.map((c) => c.text).join("\t")).join("\n");
      return [summaryTextBlock(meta.name, `シート「${sheet.name}」\n${rows}`)];
    }
    // text / json
    return [summaryTextBlock(meta.name, new TextDecoder().decode(b64ToBytes(base64)))];
  }

  function summaryStatusErrMsg(status, apiMessage) {
    switch (status) {
      case 401:
        return "APIキーが正しくありません。⚙の設定で確認してください。";
      case 429:
        return "利用制限中です。しばらく待ってからお試しください。";
      case 400:
        return "このファイルは要約できませんでした（サイズ超過などの可能性）。";
      case 413:
        return "ファイルが大きすぎて要約できません。";
      case 529:
        return "APIが混み合っています。しばらく待ってからお試しください。";
      default:
        return `APIエラー (${status}): ${apiMessage}`;
    }
  }

  async function requestSummary(meta, base64) {
    const apiKey = getAnthropicKey();
    if (!apiKey) throw new Error("APIキーが設定されていません（⚙から設定）");
    const content = await buildSummaryContent(meta, base64);

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          // ブラウザから直接呼ぶためのCORSオプトイン(Anthropic側の許可条件)
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content }],
        }),
      });
    } catch (e) {
      throw new Error("ネットワークに接続できません。通信環境を確認してください。");
    }

    if (!res.ok) {
      let apiMessage = "";
      try {
        apiMessage = (await res.json()).error?.message || "";
      } catch (e) {
        /* JSONでないエラー本文は無視 */
      }
      throw new Error(summaryStatusErrMsg(res.status, apiMessage));
    }

    const data = await res.json();
    if (data.stop_reason === "refusal") {
      throw new Error("このファイルの要約は生成できませんでした。");
    }
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim();
    if (!text) throw new Error("要約が空でした。もう一度お試しください。");
    return data.stop_reason === "max_tokens" ? text + "…（末尾が切れています）" : text;
  }

  async function loadSummaryCache(fileId) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, "users", user.uid, "summaries", fileId));
      return snap.exists() ? snap.data().summary || null : null;
    } catch (e) {
      return null; // 読めなければ生成し直せばよい
    }
  }

  function saveSummaryCache(fileId, summary) {
    fb.fs
      .setDoc(fb.fs.doc(fb.db, "users", user.uid, "summaries", fileId), {
        fileId,
        summary,
        model: SUMMARY_MODEL,
        createdAt: Date.now(),
      })
      .catch(() => {});
  }

  // プレビュー上部に置くAI要約カード。キャッシュ確認・生成・再生成をここで完結する
  function buildSummaryCard(meta, base64) {
    const card = document.createElement("div");
    card.className = "summary-card";

    const head = document.createElement("div");
    head.className = "summary-head";
    const title = document.createElement("span");
    title.className = "summary-title";
    title.textContent = "✨ AI要約";
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "summary-body";
    card.appendChild(body);

    const setError = (msg) => {
      const p = document.createElement("p");
      p.className = "summary-error";
      p.textContent = msg;
      body.appendChild(p);
    };

    const showText = (text) => {
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "summary-text";
      p.textContent = text;
      body.appendChild(p);
      const regen = document.createElement("button");
      regen.className = "summary-regen";
      regen.textContent = "再生成 ↻";
      regen.addEventListener("click", generate);
      head.appendChild(regen);
    };

    const generate = async () => {
      head.querySelector(".summary-regen")?.remove();
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "summary-loading";
      p.textContent = "要約を生成しています…";
      body.appendChild(p);
      try {
        const summary = await requestSummary(meta, base64);
        saveSummaryCache(meta.id, summary);
        showText(summary);
      } catch (e) {
        body.innerHTML = "";
        setError(String(e?.message || e));
        addGenerateButton();
      }
    };

    const addGenerateButton = () => {
      const btn = document.createElement("button");
      btn.className = "summary-generate modal-btn";
      btn.textContent = "要約を生成";
      btn.addEventListener("click", generate);
      body.appendChild(btn);
    };

    // キャッシュがあれば即表示、なければ生成ボタン(勝手にAPIを呼ばない)
    loadSummaryCache(meta.id).then((cached) => {
      if (cached) showText(cached);
      else addGenerateButton();
    });

    return card;
  }

  let previewCurrent = null; // { meta, blob, url }

  async function previewFile(meta) {
    if (!fb || !user || downloadingIds.has(meta.id)) return;
    downloadingIds.add(meta.id);
    renderList();
    try {
      const base64 = await fetchFileBase64(meta);
      const blob = new Blob([b64ToBytes(base64)], { type: meta.type });
      const url = URL.createObjectURL(blob);
      previewCurrent = { meta, blob, url };
      previewTitle.textContent = meta.name;
      previewBody.innerHTML = "";
      if (getAnthropicKey() && summarizable(meta)) {
        previewBody.appendChild(buildSummaryCard(meta, base64));
      }
      const t = meta.type || "";
      if (t.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = meta.name;
        previewBody.appendChild(img);
      } else if (t === "application/pdf") {
        const frame = document.createElement("iframe");
        frame.src = url;
        frame.title = meta.name;
        previewBody.appendChild(frame);
      } else if (isDocx(meta)) {
        const mammoth = await loadMammoth();
        const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
        const div = document.createElement("div");
        div.className = "docx-content";
        div.innerHTML = result.value;
        previewBody.appendChild(div);
      } else if (isXlsx(meta)) {
        await loadFflate();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        previewBody.appendChild(renderXlsxTable(readXlsx(bytes)));
      } else {
        const pre = document.createElement("pre");
        pre.textContent = await blob.text();
        previewBody.appendChild(pre);
      }
      previewModal.hidden = false;
    } catch (e) {
      alert(`「${meta.name}」のプレビューに失敗しました: ` + (e.message || e));
    } finally {
      downloadingIds.delete(meta.id);
      renderList();
    }
  }

  function closePreview() {
    previewModal.hidden = true;
    previewBody.innerHTML = "";
    if (previewCurrent) {
      URL.revokeObjectURL(previewCurrent.url);
      previewCurrent = null;
    }
  }

  async function deleteFileNow(meta) {
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, "users", user.uid, "files", meta.id));
    for (let i = 0; i < meta.chunkCount; i++) {
      fb.fs
        .deleteDoc(fb.fs.doc(fb.db, "users", user.uid, "chunks", `${meta.id}_${i}`))
        .catch(() => {});
    }
    // AI要約のキャッシュも掃除する(無ければ何も起きない)
    fb.fs.deleteDoc(fb.fs.doc(fb.db, "users", user.uid, "summaries", meta.id)).catch(() => {});
  }

  async function deleteFile(meta) {
    if (!fb || !user) return;
    if (!confirm(`「${meta.name}」を削除しますか？`)) return;
    try {
      await deleteFileNow(meta);
    } catch (e) {
      alert("削除に失敗しました: " + (e.message || e));
    }
  }

  // --- Firebase同期 ---
  function mergeMemos(a, b) {
    const byId = new Map();
    for (const m of [...a, ...b]) {
      const cur = byId.get(m.id);
      if (!cur || (m.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(m.id, m);
    }
    const now = Date.now();
    return [...byId.values()].filter(
      (m) => !m.deleted || now - m.updatedAt < TOMBSTONE_TTL
    );
  }

  // リモートに実データがあるなら、この端末の未編集サンプルは重複防止のため捨てる
  function withoutUntouchedSamples(local, remote) {
    if (!remote.some((m) => !m.deleted)) return local;
    return local.filter((m) => !(m.sample && m.updatedAt === m.createdAt));
  }

  function setSyncError(e) {
    syncState = "error";
    syncErrorMsg = (e && e.message) || String(e);
    console.error("同期エラー", e);
    updateSyncLabel();
  }

  function pushMemo(memo) {
    if (!fb || !user) return;
    const ref = fb.fs.doc(fb.db, "users", user.uid, "memos", memo.id);
    fb.fs
      .setDoc(ref, memo)
      .then(() => {
        remoteById.set(memo.id, memo);
        if (syncState === "error") {
          syncState = "live";
          updateSyncLabel();
        }
      })
      .catch(setSyncError);
  }

  // スナップショット（サーバの全メモ）を受け取り、ローカルとマージして双方向に反映
  function applySnapshot(remote) {
    remoteById = new Map(remote.map((m) => [m.id, m]));
    const local = withoutUntouchedSamples(memos, remote);
    const merged = mergeMemos(local, remote);

    // ローカルの方が新しい/サーバに無いメモはアップロード
    for (const m of merged) {
      const r = remoteById.get(m.id);
      if (!r || (m.updatedAt || 0) > (r.updatedAt || 0)) pushMemo(m);
    }

    const changed = JSON.stringify(merged) !== JSON.stringify(memos);
    memos = merged;
    if (changed) {
      save();
      render();
    }
  }

  function startListening() {
    stopListening();
    const col = fb.fs.collection(fb.db, "users", user.uid, "memos");
    unsubscribe = fb.fs.onSnapshot(
      col,
      (snap) => {
        syncState = "live";
        applySnapshot(snap.docs.map((d) => d.data()));
        updateSyncLabel();
      },
      setSyncError
    );
    const filesCol = fb.fs.collection(fb.db, "users", user.uid, "files");
    unsubscribeFiles = fb.fs.onSnapshot(
      filesCol,
      (snap) => {
        filesMeta = snap.docs.map((d) => d.data());
        if (currentTab === "files") renderList();
      },
      setSyncError
    );
  }

  function stopListening() {
    if (unsubscribe) unsubscribe();
    if (unsubscribeFiles) unsubscribeFiles();
    unsubscribe = null;
    unsubscribeFiles = null;
    remoteById = new Map();
    filesMeta = [];
  }

  async function initFirebase() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg) {
      syncState = "off";
      updateSyncLabel();
      return;
    }
    try {
      const [{ initializeApp }, authMod, fs] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]);
      const app = initializeApp(cfg);
      fb = {
        fs,
        db: fs.getFirestore(app),
        auth: authMod.getAuth(app),
        signInWithPopup: authMod.signInWithPopup,
        GoogleAuthProvider: authMod.GoogleAuthProvider,
        signOut: authMod.signOut,
        createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword,
        signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
        sendPasswordResetEmail: authMod.sendPasswordResetEmail,
      };
      authMod.onAuthStateChanged(fb.auth, (u) => {
        user = u;
        if (u) {
          startListening();
        } else {
          stopListening();
          syncState = "nologin";
        }
        render();
        updateModalViews();
      });
      syncState = "nologin";
      updateSyncLabel();
    } catch (e) {
      setSyncError(e);
    }
  }

  // --- Sync modal ---
  function updateAutoProofreadCheck() {
    autoProofreadCheck.checked = isProofreadEnabled();
  }

  function updateAiSearchBtn() {
    aiSearchBtn.hidden = !(currentTab !== "files" && !!getAnthropicKey() && !!searchQuery.trim());
  }

  function updateAnthropicKeyState() {
    anthropicKeyState.textContent = getAnthropicKey() ? "・設定済み" : "";
    anthropicKeyInput.placeholder = getAnthropicKey()
      ? "変更する場合は新しいキーを入力（空で保存すると削除）"
      : "sk-ant-…";
  }

  function updateModalViews() {
    updateAnthropicKeyState();
    syncSetupView.hidden = !(syncState === "off");
    syncLoginView.hidden = !(syncState !== "off" && !user);
    syncUserView.hidden = !user;
    if (user) {
      userLabel.textContent = user.displayName || user.email || "ログイン中";
    }
  }

  function openModal() {
    syncModalStatus.textContent = "";
    updateModalViews();
    syncModal.hidden = false;
  }

  function closeModal() {
    syncModal.hidden = true;
  }

  function authErrMsg(e) {
    switch (e && e.code) {
      case "auth/invalid-email":
        return "メールアドレスの形式が正しくありません。";
      case "auth/email-already-in-use":
        return "このメールアドレスは登録済みです。「ログイン」をお試しください。";
      case "auth/weak-password":
        return "パスワードは6文字以上にしてください。";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "メールアドレスまたはパスワードが違います。";
      case "auth/too-many-requests":
        return "試行回数が多すぎます。しばらく待ってからお試しください。";
      case "auth/operation-not-allowed":
        return "この方式のログインが有効化されていません（Firebaseコンソールの設定が必要です）。";
      case "auth/popup-blocked":
        return "ポップアップがブロックされました。許可して再度お試しください。";
      default:
        return (e && e.message) || String(e);
    }
  }

  async function onLoginClick() {
    if (!fb) return;
    syncModalStatus.textContent = "ログインしています…";
    try {
      await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider());
      syncModalStatus.textContent = "ログインしました。同期が有効です。";
    } catch (e) {
      syncModalStatus.textContent = "ログインに失敗しました: " + authErrMsg(e);
    }
  }

  async function onSignupClick() {
    if (!fb) return;
    const email = emailInput.value.trim();
    const pw = passwordInput.value;
    if (!email || !pw) {
      syncModalStatus.textContent = "メールアドレスとパスワードを入力してください。";
      return;
    }
    syncModalStatus.textContent = "登録しています…";
    try {
      await fb.createUserWithEmailAndPassword(fb.auth, email, pw);
      syncModalStatus.textContent = "登録してログインしました。同期が有効です。";
    } catch (e) {
      syncModalStatus.textContent = "登録に失敗しました: " + authErrMsg(e);
    }
  }

  async function onEmailLoginClick() {
    if (!fb) return;
    const email = emailInput.value.trim();
    const pw = passwordInput.value;
    if (!email || !pw) {
      syncModalStatus.textContent = "メールアドレスとパスワードを入力してください。";
      return;
    }
    syncModalStatus.textContent = "ログインしています…";
    try {
      await fb.signInWithEmailAndPassword(fb.auth, email, pw);
      syncModalStatus.textContent = "ログインしました。同期が有効です。";
    } catch (e) {
      syncModalStatus.textContent = "ログインに失敗しました: " + authErrMsg(e);
    }
  }

  async function onResetClick(e) {
    e.preventDefault();
    if (!fb) return;
    const email = emailInput.value.trim();
    if (!email) {
      syncModalStatus.textContent = "リセットするメールアドレスを上に入力してください。";
      return;
    }
    try {
      await fb.sendPasswordResetEmail(fb.auth, email);
      syncModalStatus.textContent = `${email} にリセット用メールを送りました。`;
    } catch (err) {
      syncModalStatus.textContent = "送信に失敗しました: " + authErrMsg(err);
    }
  }

  // --- サンプルデータの投入 ---
  const SAMPLE_FILES = [
    ["samples/photo-whiteboard.jpg", "写真_ホワイトボード板書.jpg", "image/jpeg"],
    ["samples/photo-office.jpg", "写真_オフィス風景.jpg", "image/jpeg"],
    ["samples/photo-product-mock.jpg", "写真_製品モックアップ.jpg", "image/jpeg"],
    ["samples/photo-team-lunch.jpg", "写真_チームランチ.jpg", "image/jpeg"],
    ["samples/photo-logo-draft.jpg", "写真_ロゴ案スケッチ.jpg", "image/jpeg"],
    ["samples/doc-mitsumori.pdf", "見積書_A社.pdf", "application/pdf"],
    ["samples/doc-seikyusho.pdf", "請求書_2026年6月.pdf", "application/pdf"],
    ["samples/doc-kaigi-shiryo.pdf", "会議資料_新機能レビュー.pdf", "application/pdf"],
    ["samples/doc-ryohi.pdf", "出張旅費精算書.pdf", "application/pdf"],
    ["samples/doc-catalog.pdf", "製品カタログ2026.pdf", "application/pdf"],
    ["samples/word-gijiroku.docx", "議事録_週次定例.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["samples/word-teiansho.docx", "提案書_業務改善ドラフト.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["samples/word-houkoku.docx", "業務報告書_2026年6月.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["samples/word-tejunsho.docx", "手順書_リリース作業.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["samples/word-keiyaku.docx", "契約書テンプレート.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["samples/excel-keihi.xlsx", "経費精算_2026年6月.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["samples/excel-uriage.xlsx", "売上集計_2026年上期.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["samples/excel-zaiko.xlsx", "在庫リスト.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["samples/excel-kintai.xlsx", "勤怠管理_2026年6月.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["samples/excel-kokyaku.xlsx", "顧客リスト.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ];

  async function seedSampleData() {
    if (!fb || !user) return;
    seedBtn.disabled = true;
    try {
      // メモ: 同じタイトルがまだ無いものだけ追加する
      const titles = new Set(visibleMemos().map((m) => m.title));
      const newMemos = sampleMemos().filter((m) => !titles.has(m.title));
      for (const m of newMemos) {
        delete m.sample; // 投入したメモは通常メモ扱い（同期の重複排除対象にしない）
        memos.push(m);
        pushMemo(m);
      }
      if (newMemos.length) {
        save();
        render();
      }
      // ファイルも同名のものが既にあれば追加しない
      const existingNames = new Set(filesMeta.map((f) => f.name));
      const toUpload = SAMPLE_FILES.filter(([, name]) => !existingNames.has(name));
      if (!toUpload.length) {
        syncModalStatus.textContent = `メモを${newMemos.length}件追加しました。サンプルファイルは投入済みです。`;
        return;
      }
      syncModalStatus.textContent = `メモを${newMemos.length}件追加しました。サンプルファイルを準備中…`;

      const files = [];
      for (const [path, name, type] of toUpload) {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${path} の取得に失敗 (${res.status})`);
        files.push(new File([await res.blob()], name, { type }));
      }
      closeModal();
      switchTab("files");
      await uploadFiles(files);
    } catch (e) {
      syncModalStatus.textContent = "サンプルデータの投入に失敗しました: " + (e.message || e);
    } finally {
      seedBtn.disabled = false;
    }
  }

  async function onLogoutClick() {
    if (!fb) return;
    await fb.signOut(fb.auth);
    // 共有端末で他人にメモが見えないよう、この端末のデータは消去する
    // （クラウド側には残っており、再ログインで復元される）
    memos = [];
    selectedId = null;
    selectMode = false;
    checkedIds.clear();
    save();
    render();
    syncModalStatus.textContent =
      "ログアウトし、この端末のメモを消去しました。データはアカウントに残っているので、再ログインすると戻ります。";
  }

  // --- Events ---
  newBtn.addEventListener("click", createMemo);
  deleteBtn.addEventListener("click", deleteSelected);
  titleInput.addEventListener("input", updateSelected);
  bodyInput.addEventListener("input", () => {
    updateSelected();
    scheduleProofread();
  });
  proofBarUndo.addEventListener("click", undoProofread);
  copyBodyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(bodyInput.value);
      copyBodyBtn.textContent = "✓ コピーしました";
      setTimeout(() => {
        copyBodyBtn.textContent = "コピー";
      }, 2000);
    } catch (e) {
      alert("コピーできませんでした: " + (e?.message || e));
    }
  });
  autoProofreadCheck.addEventListener("change", () => {
    setProofreadEnabled(autoProofreadCheck.checked);
  });

  dueSelect.addEventListener("change", () => {
    const v = dueSelect.value;
    if (v === "custom") {
      // 日付入力を出すだけ。日付が選ばれた時点で確定する
      dueDate.hidden = false;
      if (dueDate.value) {
        setDue(endOfDay(new Date(dueDate.value + "T00:00:00")));
      } else {
        // 表示直後はレイアウト未確定でカレンダーが左上に出るため、
        // 位置が決まってから開く
        dueDate.getBoundingClientRect();
        requestAnimationFrame(() => {
          try {
            if (dueDate.showPicker) dueDate.showPicker();
            else dueDate.focus();
          } catch (err) {
            dueDate.focus();
          }
        });
      }
    } else if (v === "") {
      setDue(null);
    } else {
      setDue(presetDue(v));
    }
  });
  dueDate.addEventListener("change", () => {
    if (dueDate.value) setDue(endOfDay(new Date(dueDate.value + "T00:00:00")));
  });
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    // 検索語を変えたらAI結果は無効になる(古い結果を残さない)
    aiResult = null;
    aiBar.hidden = true;
    updateAiSearchBtn();
    renderList();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeAiSearch();
    }
  });
  aiSearchBtn.addEventListener("click", executeAiSearch);
  aiBarClose.addEventListener("click", clearAiResult);

  sortDueBtn.addEventListener("click", () => {
    resortByDue();
    save();
    render();
  });

  tabSchedule.addEventListener("click", () => switchTab("schedule"));
  tabMemos.addEventListener("click", () => switchTab("memos"));
  tabSaved.addEventListener("click", () => switchTab("saved"));
  tabFiles.addEventListener("click", () => switchTab("files"));
  selectBtn.addEventListener("click", toggleSelectMode);
  selectAllBtn.addEventListener("click", toggleSelectAll);
  bulkDeleteBtn.addEventListener("click", bulkDelete);
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = "";
  });

  syncBtn.addEventListener("click", openModal);
  syncCloseBtn.addEventListener("click", closeModal);
  previewCloseBtn.addEventListener("click", closePreview);
  previewModal.addEventListener("click", (e) => {
    if (e.target === previewModal) closePreview();
  });
  previewDownloadBtn.addEventListener("click", () => {
    if (previewCurrent) triggerDownload(previewCurrent.blob, previewCurrent.meta.name);
  });
  previewDeleteBtn.addEventListener("click", async () => {
    if (!previewCurrent) return;
    const meta = previewCurrent.meta;
    if (!confirm(`「${meta.name}」を削除しますか？`)) return;
    try {
      await deleteFileNow(meta);
      closePreview();
    } catch (e) {
      alert("削除に失敗しました: " + (e.message || e));
    }
  });
  loginBtn.addEventListener("click", onLoginClick);
  signupBtn.addEventListener("click", onSignupClick);
  emailLoginBtn.addEventListener("click", onEmailLoginClick);
  resetLink.addEventListener("click", onResetClick);
  logoutBtn.addEventListener("click", onLogoutClick);
  seedBtn.addEventListener("click", seedSampleData);
  anthropicKeySaveBtn.addEventListener("click", () => {
    const key = anthropicKeyInput.value.trim();
    if (key) {
      localStorage.setItem(ANTHROPIC_KEY_STORAGE, key);
      syncModalStatus.textContent =
        "APIキーを保存しました。ファイルのプレビューに「AI要約」が表示されます。";
    } else if (getAnthropicKey()) {
      localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
      syncModalStatus.textContent = "APIキーを削除しました。";
    }
    anthropicKeyInput.value = "";
    updateAnthropicKeyState();
    updateAiSearchBtn();
  });
  syncModal.addEventListener("click", (e) => {
    if (e.target === syncModal) closeModal();
  });

  // Ctrl/Cmd+N で新規作成
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      createMemo();
    }
  });

  // --- スマホ: エディタから一覧へ戻る ---
  backBtn.addEventListener("click", backToList);

  // ブラウザの「戻る」(iOSの端からのスワイプ含む)で一覧へ
  window.addEventListener("popstate", () => {
    if (selectedId) {
      discardFreshIfEmpty(null);
      selectedId = null;
      render();
    }
  });

  // エディタ内を右にスワイプしたら一覧へ戻る
  (function attachEditorBackSwipe() {
    let sx = 0;
    let sy = 0;
    let mode = null; // null | "back" | "scroll"
    editorPane.addEventListener(
      "touchstart",
      (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        mode = null;
      },
      { passive: true }
    );
    editorPane.addEventListener(
      "touchmove",
      (e) => {
        if (mode || !isMobile()) return;
        const dx = e.touches[0].clientX - sx;
        const dy = e.touches[0].clientY - sy;
        if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          mode = "back";
          backToList();
        } else if (Math.abs(dy) > 30) {
          mode = "scroll";
        }
      },
      { passive: true }
    );
  })();

  // --- Init ---
  switchTab(currentTab); // タブのボタン表示を含めて初期化（内部でrenderされる）
  initFirebase();
})();
