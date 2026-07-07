(function () {
  "use strict";

  const STORAGE_KEY = "memo-app.memos.v1";
  const SYNC_KEY = "memo-app.sync.v1";
  const GIST_DESC = "メモ帳アプリの同期データ (memo-app)";
  const GIST_FILE = "memos.json";
  const API_BASE = "https://api.github.com";
  const PUSH_DELAY = 2000;
  const POLL_INTERVAL = 30000;
  const TOMBSTONE_TTL = 60 * 24 * 3600 * 1000; // 削除の記録を60日保持

  // --- State ---
  let memos = load();
  let selectedId = null;
  let searchQuery = "";
  let saveTimer = null;

  let syncConfig = loadSyncConfig(); // { token, gistId } | null
  let pushTimer = null;
  let syncBusy = false;
  let lastSyncAt = null;
  let syncError = null;
  let pollTimer = null;

  // --- Elements ---
  const memoList = document.getElementById("memoList");
  const searchInput = document.getElementById("searchInput");
  const newBtn = document.getElementById("newBtn");
  const emptyState = document.getElementById("emptyState");
  const editorPane = document.getElementById("editorPane");
  const titleInput = document.getElementById("titleInput");
  const bodyInput = document.getElementById("bodyInput");
  const deleteBtn = document.getElementById("deleteBtn");
  const savedLabel = document.getElementById("savedLabel");
  const countLabel = document.getElementById("countLabel");
  const syncBtn = document.getElementById("syncBtn");
  const syncLabel = document.getElementById("syncLabel");
  const syncModal = document.getElementById("syncModal");
  const tokenInput = document.getElementById("tokenInput");
  const syncModalStatus = document.getElementById("syncModalStatus");
  const syncConnectBtn = document.getElementById("syncConnectBtn");
  const syncDisconnectBtn = document.getElementById("syncDisconnectBtn");
  const syncCloseBtn = document.getElementById("syncCloseBtn");

  // --- Persistence ---
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

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      const cfg = raw ? JSON.parse(raw) : null;
      return cfg && cfg.token ? cfg : null;
    } catch (e) {
      return null;
    }
  }

  function saveSyncConfig(cfg) {
    syncConfig = cfg;
    if (cfg) {
      localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    } else {
      localStorage.removeItem(SYNC_KEY);
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

  // --- Rendering ---
  function renderList() {
    const list = filteredMemos();
    memoList.innerHTML = "";

    list.forEach((m) => {
      const li = document.createElement("li");
      li.className = "memo-item" + (m.id === selectedId ? " selected" : "");
      li.dataset.id = m.id;

      const title = document.createElement("div");
      title.className = "memo-title";
      title.textContent = m.title.trim() || "無題のメモ";

      const preview = document.createElement("div");
      preview.className = "memo-preview";
      preview.textContent = m.body.trim().split("\n")[0] || "本文なし";

      const date = document.createElement("div");
      date.className = "memo-date";
      date.textContent = formatDate(m.updatedAt);

      li.append(title, preview, date);
      li.addEventListener("click", () => selectMemo(m.id));
      memoList.appendChild(li);
    });

    const total = visibleMemos().length;
    const shown = list.length;
    if (searchQuery.trim() && total > 0) {
      countLabel.textContent = `${shown} / ${total} 件`;
    } else {
      countLabel.textContent = `${total} 件のメモ`;
    }
  }

  function renderEditor() {
    const memo = getMemo(selectedId);
    if (!memo) {
      selectedId = null;
      editorPane.hidden = true;
      emptyState.hidden = false;
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
    if (!syncConfig) {
      syncLabel.textContent = "同期: 未設定";
      syncLabel.className = "sync-label";
    } else if (syncError) {
      syncLabel.textContent = "同期エラー";
      syncLabel.className = "sync-label sync-error";
      syncLabel.title = syncError;
    } else if (syncBusy) {
      syncLabel.textContent = "同期中…";
      syncLabel.className = "sync-label";
    } else if (lastSyncAt) {
      syncLabel.textContent = "同期済み " + formatDate(lastSyncAt);
      syncLabel.className = "sync-label sync-ok";
    } else {
      syncLabel.textContent = "同期: 待機中";
      syncLabel.className = "sync-label";
    }
  }

  function render() {
    renderList();
    renderEditor();
    updateSyncLabel();
  }

  // --- Actions ---
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
    schedulePush();
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
      schedulePush();
    }, 400);
  }

  function deleteSelected() {
    const memo = getMemo(selectedId);
    if (!memo) return;
    const name = memo.title.trim() || "このメモ";
    if (!confirm(`「${name}」を削除しますか？`)) return;
    // 他端末にも削除が伝わるよう、消すのではなく削除済みの印を残す
    const idx = memos.findIndex((m) => m.id === selectedId);
    memos[idx] = { id: memo.id, deleted: true, updatedAt: Date.now() };
    selectedId = null;
    save();
    schedulePush();
    render();
  }

  // --- Gist sync ---
  async function api(method, path, body) {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        Authorization: "token " + syncConfig.token,
        Accept: "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = res.status === 401 ? "トークンが無効です" : `GitHub APIエラー (${res.status})`;
      throw new Error(msg);
    }
    return res.json();
  }

  async function readRemote() {
    const gist = await api("GET", "/gists/" + syncConfig.gistId);
    const file = gist.files && gist.files[GIST_FILE];
    if (!file) return [];
    let content = file.content;
    if (file.truncated) {
      content = await (await fetch(file.raw_url)).text();
    }
    try {
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

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

  function adoptMerged(merged) {
    const changed = JSON.stringify(merged) !== JSON.stringify(memos);
    memos = merged;
    if (changed) {
      save();
      render();
    }
  }

  async function doSync(alsoWrite) {
    if (!syncConfig || syncBusy) return;
    syncBusy = true;
    syncError = null;
    updateSyncLabel();
    try {
      const remote = await readRemote();
      const merged = mergeMemos(withoutUntouchedSamples(memos, remote), remote);
      if (alsoWrite || JSON.stringify(merged) !== JSON.stringify(remote)) {
        await api("PATCH", "/gists/" + syncConfig.gistId, {
          files: { [GIST_FILE]: { content: JSON.stringify(merged, null, 1) } },
        });
      }
      adoptMerged(merged);
      lastSyncAt = Date.now();
    } catch (e) {
      syncError = e.message || String(e);
      console.error("同期に失敗しました", e);
    } finally {
      syncBusy = false;
      updateSyncLabel();
    }
  }

  function schedulePush() {
    if (!syncConfig) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doSync(true), PUSH_DELAY);
  }

  function startPolling() {
    clearInterval(pollTimer);
    if (!syncConfig) return;
    pollTimer = setInterval(() => doSync(false), POLL_INTERVAL);
  }

  async function connect(token) {
    syncConfig = { token, gistId: null };
    // 既存の同期用Gistを探し、なければ作成する
    const gists = await api("GET", "/gists?per_page=100");
    const found = gists.find(
      (g) => g.description === GIST_DESC && g.files && g.files[GIST_FILE]
    );
    let gistId;
    if (found) {
      gistId = found.id;
    } else {
      const created = await api("POST", "/gists", {
        description: GIST_DESC,
        public: false,
        files: { [GIST_FILE]: { content: JSON.stringify(memos, null, 1) } },
      });
      gistId = created.id;
    }
    saveSyncConfig({ token, gistId });
    await doSync(true);
    startPolling();
  }

  function disconnect() {
    saveSyncConfig(null);
    clearInterval(pollTimer);
    clearTimeout(pushTimer);
    lastSyncAt = null;
    syncError = null;
    updateSyncLabel();
  }

  // --- Sync modal ---
  function openModal() {
    tokenInput.value = "";
    tokenInput.placeholder = syncConfig ? "設定済み（変更する場合のみ入力）" : "ghp_...";
    syncModalStatus.textContent = syncConfig
      ? "同期は有効です。別の端末では同じトークンを貼るだけで繋がります。"
      : "";
    syncModal.hidden = false;
  }

  function closeModal() {
    syncModal.hidden = true;
  }

  async function onConnectClick() {
    const token = tokenInput.value.trim() || (syncConfig && syncConfig.token);
    if (!token) {
      syncModalStatus.textContent = "トークンを入力してください。";
      return;
    }
    syncConnectBtn.disabled = true;
    syncModalStatus.textContent = "接続しています…";
    try {
      await connect(token);
      syncModalStatus.textContent = "接続しました！このタブと他の端末で同期されます。";
      updateSyncLabel();
    } catch (e) {
      saveSyncConfig(null);
      syncModalStatus.textContent = "接続に失敗しました: " + (e.message || e);
    } finally {
      syncConnectBtn.disabled = false;
    }
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

  syncBtn.addEventListener("click", openModal);
  syncCloseBtn.addEventListener("click", closeModal);
  syncConnectBtn.addEventListener("click", onConnectClick);
  syncDisconnectBtn.addEventListener("click", () => {
    disconnect();
    syncModalStatus.textContent = "同期を解除しました（メモはこの端末に残ります）。";
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

  // 画面に戻ってきた時に最新を取得
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) doSync(false);
  });

  // --- Init ---
  render();
  if (syncConfig) {
    doSync(false);
    startPolling();
  }
})();
