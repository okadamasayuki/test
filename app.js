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
      const data = raw ? JSON.parse(raw) : [];
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
