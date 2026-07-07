(function () {
  "use strict";

  const STORAGE_KEY = "memo-app.memos.v1";

  // --- State ---
  let memos = load();
  let selectedId = null;
  let searchQuery = "";
  let saveTimer = null;

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
      createdAt: now - s.age,
      updatedAt: now - s.age,
    }));
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memos));
    } catch (e) {
      console.error("メモの保存に失敗しました", e);
    }
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
    return memos.find((m) => m.id === id) || null;
  }

  function sortedMemos() {
    return [...memos].sort((a, b) => b.updatedAt - a.updatedAt);
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

    const total = memos.length;
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
      editorPane.hidden = true;
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    editorPane.hidden = false;
    titleInput.value = memo.title;
    bodyInput.value = memo.body;
    savedLabel.textContent = "最終更新: " + formatDate(memo.updatedAt);
  }

  function render() {
    renderList();
    renderEditor();
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

    savedLabel.textContent = "保存中…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save();
      renderList();
      savedLabel.textContent = "保存しました";
    }, 400);
  }

  function deleteSelected() {
    const memo = getMemo(selectedId);
    if (!memo) return;
    const name = memo.title.trim() || "このメモ";
    if (!confirm(`「${name}」を削除しますか？`)) return;
    memos = memos.filter((m) => m.id !== selectedId);
    selectedId = null;
    save();
    render();
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

  // Ctrl/Cmd+N で新規作成
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      createMemo();
    }
  });

  // --- Init ---
  render();
})();
