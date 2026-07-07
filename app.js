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
  let currentTab = "memos"; // "memos" | "files"

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
  const newBtn = document.getElementById("newBtn");
  const uploadBtn = document.getElementById("uploadBtn");
  const fileInput = document.getElementById("fileInput");
  const tabMemos = document.getElementById("tabMemos");
  const tabFiles = document.getElementById("tabFiles");
  const emptyState = document.getElementById("emptyState");
  const emptyStateText = document.getElementById("emptyStateText");
  const editorPane = document.getElementById("editorPane");
  const titleInput = document.getElementById("titleInput");
  const bodyInput = document.getElementById("bodyInput");
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
  const emailInput = document.getElementById("emailInput");
  const passwordInput = document.getElementById("passwordInput");
  const signupBtn = document.getElementById("signupBtn");
  const emailLoginBtn = document.getElementById("emailLoginBtn");
  const resetLink = document.getElementById("resetLink");
  const syncModalStatus = document.getElementById("syncModalStatus");
  const syncCloseBtn = document.getElementById("syncCloseBtn");

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

  function visibleMemos() {
    return memos.filter((m) => !m.deleted);
  }

  function sortedMemos() {
    return visibleMemos().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function filteredMemos() {
    const q = searchQuery.trim().toLowerCase();
    let list = sortedMemos();
    if (q) {
      list = list.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.body.toLowerCase().includes(q)
      );
    }
    return list;
  }

  function filteredFiles() {
    const q = searchQuery.trim().toLowerCase();
    let list = [...filesMeta].sort((a, b) => b.createdAt - a.createdAt);
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
    return list;
  }

  // --- スワイプで削除 ---
  const SWIPE_W = 80; // 削除ボタンの幅(px)
  let openSwipeEl = null;

  function closeOpenSwipe() {
    if (openSwipeEl) {
      openSwipeEl.style.transform = "";
      openSwipeEl = null;
    }
  }

  function attachSwipe(content, onTap) {
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
        const off = Math.max(-SWIPE_W, Math.min(0, base + dx));
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
        if (off < -SWIPE_W / 2) {
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

  // --- Rendering ---
  function buildRow({ titleText, previewText, dateText, selected, onTap, onDelete }) {
    const li = document.createElement("li");
    li.className = "memo-item" + (selected ? " selected" : "");

    const title = document.createElement("div");
    title.className = "memo-title";
    title.textContent = titleText;

    const preview = document.createElement("div");
    preview.className = "memo-preview";
    preview.textContent = previewText;

    const date = document.createElement("div");
    date.className = "memo-date";
    date.textContent = dateText;

    const content = document.createElement("div");
    content.className = "memo-swipe-content";
    content.append(title, preview, date);

    const del = document.createElement("button");
    del.className = "memo-delete-btn";
    del.textContent = "削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });

    li.append(del, content);
    attachSwipe(content, onTap);
    return li;
  }

  function renderList() {
    memoList.innerHTML = "";
    openSwipeEl = null;

    if (currentTab === "memos") {
      const list = filteredMemos();
      list.forEach((m) => {
        memoList.appendChild(
          buildRow({
            titleText: m.title.trim() || "無題のメモ",
            previewText: m.body.trim().split("\n")[0] || "本文なし",
            dateText: formatDate(m.updatedAt),
            selected: m.id === selectedId,
            onTap: () => selectMemo(m.id),
            onDelete: () => deleteMemoById(m.id),
          })
        );
      });
      const total = visibleMemos().length;
      countLabel.textContent = searchQuery.trim() && total > 0
        ? `${list.length} / ${total} 件`
        : `${total} 件のメモ`;
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
      memoList.appendChild(
        buildRow({
          titleText: f.name,
          previewText: downloadingIds.has(f.id)
            ? "ダウンロード中…"
            : `${formatSize(f.size)}・タップでダウンロード`,
          dateText: formatDate(f.createdAt),
          selected: false,
          onTap: () => downloadFile(f),
          onDelete: () => deleteFile(f),
        })
      );
    });
    countLabel.textContent = `${filesMeta.length} 件のファイル`;
  }

  function renderEditor() {
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
      emptyStateText.innerHTML = "メモを選択するか、<br>「+ 新規」で作成してください。";
      return;
    }
    emptyState.hidden = true;
    editorPane.hidden = false;
    // 他端末からの反映時に入力中のカーソルを壊さないよう、値が違う時だけ入れ替える
    if (titleInput.value !== memo.title) titleInput.value = memo.title;
    if (bodyInput.value !== memo.body) bodyInput.value = memo.body;
    savedLabel.textContent = "最終更新: " + formatDate(memo.updatedAt);
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
      syncLabel.textContent = "リアルタイム同期中";
      syncLabel.className = "sync-label sync-ok";
    }
  }

  function render() {
    renderList();
    renderEditor();
    updateSyncLabel();
  }

  function switchTab(tab) {
    currentTab = tab;
    tabMemos.classList.toggle("active", tab === "memos");
    tabFiles.classList.toggle("active", tab === "files");
    newBtn.hidden = tab !== "memos";
    uploadBtn.hidden = tab !== "files";
    render();
  }

  // --- Actions (メモ) ---
  function createMemo() {
    const memo = {
      id: uid(),
      title: "",
      body: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    memos.push(memo);
    save();
    pushMemo(memo);
    selectMemo(memo.id);
    titleInput.focus();
  }

  function selectMemo(id) {
    selectedId = id;
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

  function deleteMemoById(id) {
    const memo = getMemo(id);
    if (!memo) return;
    const name = memo.title.trim() || "このメモ";
    if (!confirm(`「${name}」を削除しますか？`)) return;
    // 他端末にも削除が伝わるよう、消すのではなく削除済みの印を残す
    const idx = memos.findIndex((m) => m.id === id);
    const tombstone = { id: memo.id, deleted: true, updatedAt: Date.now() };
    memos[idx] = tombstone;
    if (selectedId === id) selectedId = null;
    save();
    pushMemo(tombstone);
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

  async function downloadFile(meta) {
    if (!fb || !user || downloadingIds.has(meta.id)) return;
    downloadingIds.add(meta.id);
    renderList();
    try {
      const parts = [];
      for (let i = 0; i < meta.chunkCount; i++) {
        const ref = fb.fs.doc(fb.db, "users", user.uid, "chunks", `${meta.id}_${i}`);
        const snap = await fb.fs.getDoc(ref);
        if (!snap.exists()) throw new Error("ファイルの一部が見つかりません");
        parts.push(snap.data().data);
      }
      const blob = new Blob([b64ToBytes(parts.join(""))], { type: meta.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = meta.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      alert(`「${meta.name}」のダウンロードに失敗しました: ` + (e.message || e));
    } finally {
      downloadingIds.delete(meta.id);
      renderList();
    }
  }

  async function deleteFile(meta) {
    if (!fb || !user) return;
    if (!confirm(`「${meta.name}」を削除しますか？`)) return;
    try {
      await fb.fs.deleteDoc(fb.fs.doc(fb.db, "users", user.uid, "files", meta.id));
      for (let i = 0; i < meta.chunkCount; i++) {
        fb.fs
          .deleteDoc(fb.fs.doc(fb.db, "users", user.uid, "chunks", `${meta.id}_${i}`))
          .catch(() => {});
      }
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
  function updateModalViews() {
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

  async function onLogoutClick() {
    if (!fb) return;
    await fb.signOut(fb.auth);
    syncModalStatus.textContent = "ログアウトしました（メモはこの端末に残ります）。";
  }

  // --- Events ---
  newBtn.addEventListener("click", createMemo);
  deleteBtn.addEventListener("click", deleteSelected);
  titleInput.addEventListener("input", updateSelected);
  bodyInput.addEventListener("input", updateSelected);
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderList();
  });

  tabMemos.addEventListener("click", () => switchTab("memos"));
  tabFiles.addEventListener("click", () => switchTab("files"));
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = "";
  });

  syncBtn.addEventListener("click", openModal);
  syncCloseBtn.addEventListener("click", closeModal);
  loginBtn.addEventListener("click", onLoginClick);
  signupBtn.addEventListener("click", onSignupClick);
  emailLoginBtn.addEventListener("click", onEmailLoginClick);
  resetLink.addEventListener("click", onResetClick);
  logoutBtn.addEventListener("click", onLogoutClick);
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

  // --- Init ---
  render();
  initFirebase();
})();
