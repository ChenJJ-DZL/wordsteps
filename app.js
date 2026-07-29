/* =========================================================
   WordSteps 阶梯背单词 —— 多词库 / 真实音频 / 艾宾浩斯复习 / 自动发音 / 整本预缓存
   ========================================================= */
(function () {
  "use strict";
  
  /* ---------- Service Worker 更新检测（仅新版弹窗，点稍后 2h 抑制） ---------- */
  var CHANGELOG = [
    { ver: "20260730f", note: "记忆曲线恢复7天一档 + 更新弹窗仅新版触发" },
    { ver: "20260729e", note: "学习排序改为同族组块(同根词连续出现便于对比) + favicon.ico 补齐" },
    { ver: "20260729d", note: "PWA桌面应用自动更新提示(顶部横幅一键刷新)" },
    { ver: "20260729c", note: "打破固定背诵顺序：族内打乱+族间随机+复习±5%扰动" },
    { ver: "20260729b", note: "长单词字号放宽：>12字母才缩20%(原>6即缩)" },
    { ver: "20260729a", note: "数据安全：补全迁移链+每次启动备份+失败自动恢复+手动恢复按钮" },
    { ver: "20260728d", note: "IndexedDB 音频持久化：离线零延迟(二次打开即可离线播放)" },
    { ver: "20260728c", note: "音频预加载(卡片出现即下载mp3) + TTS语音优选(Google/Microsoft)" },
    { ver: "20260728b", note: "移除正面'族'角标(背面已有完整词法分解)" },
    { ver: "20260728a", note: "词法分解行(前缀+词根+后缀均含中文释义) + 卡片背面版面压缩" }
  ];
  // 立即标记当前版本（DOM 就绪之前），防止 controllerchange 先于 markVersionSeen 触发
  try { localStorage.setItem("__last_seen_ver", APP_VER); } catch (e) {}
  function shouldShowBanner() {
    try {
      var dismissTs = parseInt(localStorage.getItem("__update_dismissed") || "0", 10);
      if (dismissTs && Date.now() - dismissTs < 2 * 3600 * 1000) return false;
      var lastSeen = localStorage.getItem("__last_seen_ver") || "0";
      return lastSeen < APP_VER;
    } catch (e) { return false; }
  }
  function showUpdateBanner() {
    if (!shouldShowBanner()) return;
    var b = document.getElementById("update-banner");
    if (!b) return;
    b.style.display = "";
    var reloadBtn = document.getElementById("update-reload");
    var dismissBtn = document.getElementById("update-dismiss");
    var detailBtn = document.getElementById("update-detail");
    var detailEl = document.getElementById("update-details");
    if (reloadBtn) reloadBtn.addEventListener("click", function () {
      b.style.display = "none";
      try { localStorage.setItem("__last_seen_ver", APP_VER); } catch (e) {}
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'skip-waiting' });
      }
      location.reload();
    });
    if (dismissBtn) dismissBtn.addEventListener("click", function () {
      b.style.display = "none";
      try { localStorage.setItem("__update_dismissed", Date.now().toString()); } catch (e) {}
    });
    if (detailBtn && detailEl) {
      var txt = CHANGELOG.map(function (c) {
        return "v" + c.ver + "  " + c.note;
      }).join("\n");
      detailEl.textContent = txt;
      detailBtn.addEventListener("click", function () {
        detailEl.classList.toggle("show");
      });
    }
  }
  function initSWUpdater() {
    if (!("serviceWorker" in navigator)) return;
    // 延迟兜底：controllerchange 若在监听注册前已触发，则手动检查一次
    setTimeout(function () { showUpdateBanner(); }, 800);
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "sw-updated") showUpdateBanner();
    });
    navigator.serviceWorker.ready.then(function (reg) {
      reg.addEventListener("updatefound", function () {
        var newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", function () {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: 'skip-waiting' });
          }
        });
      });
      setInterval(function () { reg.update(); }, 60 * 60 * 1000);
    });
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      showUpdateBanner();
    });
  }
  if (document.readyState === "complete" || document.readyState === "interactive") {
    initSWUpdater();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      initSWUpdater();
    });
  }

  var REGISTRY = window.BOOK_REGISTRY || [];
  var BOOK_COUNTS = {};   // 各单词本真实词数：加载后由 window.BOOK_<id>.words.length 动态写入
  var BOOKS_DATA = {};                 // id -> book object (lazy loaded)
  var STORE_KEY = "vocab_app_v2";
  var DAY = 86400000;
  var APP_VER = "20260730f";           // 版本号：强制刷新缓存（词根中文释义 + 词法行对齐 + 长词自适应字号）
  var EN_DEFS = window.BOOK_EN_DEFS || {};   // 构建期生成的离线英文释义包（en + 发音 URL），键=归一化小写词
  function normJs(w) { return (w || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }  // 与 rebuild_v3.py 的 norm 对齐
  // 间隔基准值（用于新词初始间隔 & 旧数据迁移），实际复习间隔由自适应算法动态调整
  var T_10MIN = 10 * 60 * 1000, T_4H = 4 * 3600 * 1000, T_1D = 1 * DAY;
  var EB = [T_10MIN, T_1D, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];

  /* ---------- 状态 / 版本化迁移 ---------- */
  var SCHEMA_VER = 4;   // schema 版本：v4=双层遗忘统计(间隔段+自然日分桶)
  function defaultSkeleton() {
    return {
      schemaVer: SCHEMA_VER,
      settings: { accent: "us", book: (REGISTRY[0] && REGISTRY[0].id) || "ogden", incremental: false, bookSort: {}, dailyNewLimit: 0 },
      streak: { lastDate: "", count: 0 }, sessions: [], cache: {}, books: {},
      forgetStats: {},    // 间隔段遗忘统计(SRS引擎用)
      dayForgetStats: {}  // 自然日遗忘统计(曲线可视化用)
    };
  }
  // 前向兼容：把已存 raw 与默认骨架深合并，新增字段永远有默认值，且不覆盖已有内容
  function deepMergeSkeleton(def, raw) {
    def.settings = Object.assign({}, def.settings, raw.settings || {});
    if (!def.settings.bookSort) def.settings.bookSort = {};
    if (raw.streak) def.streak = raw.streak;
    if (Array.isArray(raw.sessions)) def.sessions = raw.sessions;
    if (raw.cache) def.cache = raw.cache;
    if (raw.books) def.books = raw.books;
    if (raw.forgetStats) def.forgetStats = raw.forgetStats;
    if (raw.dayForgetStats) def.dayForgetStats = raw.dayForgetStats;
    def.schemaVer = SCHEMA_VER;
    return def;
  }
  // ---------- 迁移函数（表驱动：源版本号 -> 升级函数(oldState)=>newState） ----------
  // 0->1：现存无 schemaVer 的老存档 → 规范化结构；只补形状，不删任何 records（零丢失）
  function migrate_0_to_1(raw) {
    raw.books = raw.books || {};
    for (var id in raw.books) {
      if (!raw.books[id]) raw.books[id] = {};
      if (!raw.books[id].records) raw.books[id].records = {};
    }
    raw.sessions = raw.sessions || [];
    raw.settings = raw.settings || {};
    raw.streak = raw.streak || { lastDate: "", count: 0 };
    raw.cache = raw.cache || {};
    return raw;
  }
  // 预留：未来重命名词本时整体搬移 records（零丢失）
  function migrate_renameBook(raw, oldId, newId) {
    if (raw.books && raw.books[oldId]) { raw.books[newId] = raw.books[oldId]; delete raw.books[oldId]; }
    return raw;
  }
  // 预留：未来词 w 拼写变化时单条搬移
  function migrate_renameWord(raw, id, oldW, newW) {
    var b = raw.books && raw.books[id];
    if (b && b.records && b.records[oldW]) { b.records[newW] = b.records[oldW]; delete b.records[oldW]; }
    return raw;
  }
  var MIGRATIONS = {
    0: migrate_0_to_1,
    1: function(r) { return r; },                                           // v1→v2 占位：数据格式正确，无需转换
    2: function(r) { r.forgetStats = r.forgetStats || {}; return r; },
    3: function(r) { r.dayForgetStats = r.dayForgetStats || {}; return r; }
  };
  var _loadedOk = false;   // 标记本次加载是否成功（用于判断是否需要显示恢复提示）
  function loadState() {
    var def = defaultSkeleton();
    try {
      var r = localStorage.getItem(STORE_KEY);
      if (!r) return def;
      var raw = JSON.parse(r);
      // 每次启动自动备份一份（只保留最近 3 份），防止后续代码崩溃或误写导致数据不可逆丢失
      maybeAutoBackup(r);
      var curVer = raw.schemaVer || 0;
      while (curVer < SCHEMA_VER) {
        var fn = MIGRATIONS[curVer];
        if (!fn) break;
        raw = fn(raw) || raw;
        curVer++;
      }
      _loadedOk = true;
      return deepMergeSkeleton(def, raw);
    } catch (e) {
      console.warn("loadState 解析/迁移失败，尝试从自动备份恢复…", e);
      return tryRestoreFromBackup(def);
    }
  }
  // 自动备份：每 30 分钟写一份（防频繁写入），保留最近 3 份
  var _lastAutoBackup = 0;
  function maybeAutoBackup(rawJson) {
    var now = Date.now();
    if (now - _lastAutoBackup < 1800000) return;  // 30 分钟内不重复
    _lastAutoBackup = now;
    try {
      localStorage.setItem(STORE_KEY + "_bak_" + now, rawJson);
      pruneBackups();
    } catch (e) {}
  }
  function tryRestoreFromBackup(def) {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORE_KEY + "_bak_") === 0) keys.push(k);
      }
      keys.sort().reverse();  // 最新的优先
      for (var j = 0; j < keys.length; j++) {
        var bk = localStorage.getItem(keys[j]);
        if (!bk) continue;
        try {
          var raw = JSON.parse(bk);
          var curVer = raw.schemaVer || 0;
          while (curVer < SCHEMA_VER) {
            var fn = MIGRATIONS[curVer];
            if (!fn) break;
            raw = fn(raw) || raw;
            curVer++;
          }
          // 恢复成功后重新保存一份
          var restored = deepMergeSkeleton(def, raw);
          localStorage.setItem(STORE_KEY, JSON.stringify(restored));
          console.warn("loadState 已从备份恢复，备份时间戳：", keys[j].replace(STORE_KEY + "_bak_", ""));
          _loadedOk = true;
          return restored;
        } catch (e2) { continue; }
      }
    } catch (e) {}
    return def;
  }
  function pruneBackups() {
    try {
      var keys = [], prefix = STORE_KEY + "_bak_";
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) keys.push(k);
      }
      keys.sort();
      while (keys.length > 3) localStorage.removeItem(keys.shift());
    } catch (e) {}
  }
  function saveState() {
    state.schemaVer = SCHEMA_VER;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("saveState 保存失败（可能存储空间满）：", e);
    }
  }
  function bookRecs(id) { if (!state.books[id]) state.books[id] = { records: {} }; return state.books[id].records; }

  // 必须在 MIGRATIONS 赋值完成后调用
  var state = loadState();

  /* ---------- 词库懒加载 ---------- */
  function loadBook(id, cb) {
    if (BOOKS_DATA[id]) { afterLoad(id); cb(BOOKS_DATA[id]); return; }
    var meta = REGISTRY.filter(function (r) { return r.id === id; })[0] || { file: "books/" + id + ".js" };
    var s = document.createElement("script");
    s.src = meta.file + "?v=" + APP_VER;
    s.onload = function () { BOOKS_DATA[id] = window["BOOK_" + id]; afterLoad(id); cb(BOOKS_DATA[id]); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }
  // 书加载完成后：记录真实词数，并刷新所有显示书名的界面（动态「名称(N词)」）
  function afterLoad(id) {
    var b = BOOKS_DATA[id];
    if (b && b.words) { BOOK_COUNTS[id] = b.words.length; clearIncCache(); refreshBookLabels(); }
  }
  // 增量模式：这些词本始终显示全量（基础/初中），其余从「之前所有词本并集」中剔除已学底层词
  var FULL_BOOKS = { ogden: 1, chuzhong: 1 };
  // 差集比对用的归一化键：转小写、去非字母数字（容忍大小写/标点差异）
  function wkey(w) { return (w || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // 计算「排在 bookId 之前的所有词本」的词形键并集（增量差集的「已掌握底层」）
  function prevUnionKeys(id) {
    var idx = -1;
    for (var i = 0; i < REGISTRY.length; i++) { if (REGISTRY[i].id === id) { idx = i; break; } }
    var set = {};
    for (var j = 0; j < idx; j++) {
      var b = BOOKS_DATA[REGISTRY[j].id];
      if (!b || !b.words) continue;
      for (var k = 0; k < b.words.length; k++) set[wkey(b.words[k].w)] = 1;
    }
    return set;
  }
  var _incCache = {};                       // 增量差集词数缓存（切换/加载时失效）
  function clearIncCache() { _incCache = {}; }
  function incrementalEligible(id) { return !!state.settings.incremental && !FULL_BOOKS[id]; }
  // 词本显示词数：增量模式且非全量本时 = 与之前所有词本的差集词数
  function bookIncCount(id) {
    var b = BOOKS_DATA[id];
    if (!incrementalEligible(id)) return b ? b.words.length : (BOOK_COUNTS[id] != null ? BOOK_COUNTS[id] : null);
    if (_incCache[id] != null) return _incCache[id];
    if (!b) return BOOK_COUNTS[id] != null ? BOOK_COUNTS[id] : null;
    var prev = prevUnionKeys(id), n = 0;
    for (var i = 0; i < b.words.length; i++) if (!prev[wkey(b.words[i].w)]) n++;
    _incCache[id] = n;
    return n;
  }
  // 运行时拼出书名：【中文名】英文简称 (词数词)；词数未加载时先省略，加载后自动补全
  // 增量模式下显示差集词数（如「【高考】GaoKao (1000)」）
  function bookLabel(id) {
    var r = REGISTRY.filter(function (x) { return x.id === id; })[0];
    if (!r) return id;
    var n = bookIncCount(id);
    return "【" + r.cn + "】" + r.en + (n != null ? " (" + n + "词)" : "");
  }
  // 刷新所有用到书名的下拉框与历史标题（词数加载后调用）
  function refreshBookLabels() {
    [homeSel, learnSel].forEach(function (sel) {
      if (!sel) return;
      Array.prototype.forEach.call(sel.options, function (o) { o.textContent = bookLabel(o.value); });
      sel.value = curBook();
    });
    var hbn = document.getElementById("hist-book-name");
    if (hbn) hbn.textContent = bookLabel(curBook());
  }
  function curBook() { return state.settings.book; }
  // 唯一词集入口：增量开启且非全量本时，滤除「之前所有词本并集」中的词（纯展示层变换，不影响 SRS 进度）
  function curWords() {
    var b = BOOKS_DATA[curBook()];
    if (!b) return [];
    var ws = b.words;
    if (incrementalEligible(curBook())) {
      var prev = prevUnionKeys(curBook());
      ws = ws.filter(function (v) { return !prev[wkey(v.w)]; });
    }
    return sortWords(ws, sortMode(curBook()));
  }
  // 单本内排序方式（可逐本覆盖；所有本默认「词根」：聚类 + 跨天交错）
  var DEFAULT_SORT = "root";
  function sortMode(id) {
    return (state.settings.bookSort && state.settings.bookSort[id]) || DEFAULT_SORT;
  }
  // 词根序（学习用）：同词族单词连续出现，便于对比记忆（如 reform/formal/uniform）；
  // 族内随机排列 + 族间随机排列，避免固定顺序形成肌肉记忆。
  // 无 root 的词（'_'+词）各自成组放最后。
  function sortWords(words, mode) {
    if (mode === "freq") {
      return words.slice().sort(function (a, b) {
        var fa = (a.freq != null ? a.freq : -1), fb = (b.freq != null ? b.freq : -1);
        if (fb !== fa) return fb - fa;
        return (a.w || "").localeCompare(b.w || "");
      });
    }
    if (mode === "alpha") {
      return words.slice().sort(function (a, b) { return (a.w || "").localeCompare(b.w || ""); });
    }
    // 词族分组：族内打乱 + 族间随机排列 → 同族连续出现，但组间顺序每次不同
    var g = {}, i, k;
    words.forEach(function (w) {
      var key = w.root || ("_" + (w.w || ""));
      (g[key] = g[key] || []).push(w);
    });
    function shuffle(arr) {
      for (var j = arr.length - 1; j > 0; j--) {
        var r = Math.floor(Math.random() * (j + 1));
        var t = arr[j]; arr[j] = arr[r]; arr[r] = t;
      }
    }
    var ks = Object.keys(g);
    // 分离"有词根"的族和"无词根"的散词(以 _ 开头)
    var rooted = [], orphans = [];
    for (i = 0; i < ks.length; i++) {
      if (ks[i][0] === "_") orphans.push(ks[i]); else rooted.push(ks[i]);
      shuffle(g[ks[i]]);  // 族内打乱
    }
    shuffle(rooted); shuffle(orphans);  // 族间随机排列
    ks = rooted.concat(orphans);
    var out = [];
    for (i = 0; i < ks.length; i++) {
      out = out.concat(g[ks[i]]);
    }
    return out;
  }

  /* ---------- 时间工具 ---------- */
  function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(ts) { return startOfDay(ts) + DAY - 1; }
  function dayStr(ts) { var d = new Date(ts); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  /* ---------- 进度记录（按词库） ---------- */
  // 遗忘率双层追踪
  //   forgetStats: 按间隔段分桶 → SRS引擎动态调整增长系数（同一天内多次遗忘各算一次）
  //   dayForgetStats: 按首次学习后的自然日分桶 → 遗忘曲线可视化（同一天只算1次）
  var FORGET_BRACKETS = [T_10MIN, T_4H, T_1D, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
  function closestBracket(iv) {
    for (var i = 0; i < FORGET_BRACKETS.length; i++) { if (iv <= FORGET_BRACKETS[i] * 1.4) return FORGET_BRACKETS[i]; }
    return FORGET_BRACKETS[FORGET_BRACKETS.length - 1];
  }
  function getForgetRate(iv) {
    var b = closestBracket(iv);
    var s = state.forgetStats[b];
    if (!s || s.total < 3) return null;
    return s.forgotten / s.total;
  }
  function recordForget(r) {
    // SRS引擎用：按间隔段分桶
    var b = closestBracket(r.interval);
    if (!state.forgetStats[b]) state.forgetStats[b] = { total: 0, forgotten: 0 };
    state.forgetStats[b].total++;
    state.forgetStats[b].forgotten++;
    // 遗忘曲线用：按首次学习后的自然日分桶
    var days = Math.floor((Date.now() - r.firstLearned) / DAY);
    var dayKey = days === 0 ? "当天" : days + "天后";
    if (!state.dayForgetStats) state.dayForgetStats = {};
    if (!state.dayForgetStats[dayKey]) state.dayForgetStats[dayKey] = { total: 0, forgotten: 0 };
    state.dayForgetStats[dayKey].total++;
    state.dayForgetStats[dayKey].forgotten++;
  }
  // 将旧格式（intervalIdx）懒迁移为新格式（interval 毫秒）
  function migrateRecord(r) {
    if (r.interval != null) return;  // 已是新格式，无需迁移
    r.interval = r.intervalIdx != null ? (EB[r.intervalIdx] || T_1D) : T_1D;
    delete r.intervalIdx;
  }
  function ensureRecord(id, word) {
    var rs = bookRecs(id), r = rs[word];
    if (!r) {
      var now = Date.now();
      r = rs[word] = { word: word, firstLearned: now, lastReviewed: now, nextReview: now + T_4H, interval: T_4H, reps: 0, lapses: 0, lastRating: "new", status: "learning" };
      saveState();
    } else {
      migrateRecord(r);  // 懒迁移旧格式记录
    }
    return r;
  }
  function scheduleReview(id, word, rating) {
    var r = ensureRecord(id, word), now = Date.now();
    var iv = r.interval || T_4H;
    // 首次复习(间隔=T_4H 且 reps=0)：认识→进入日级循环(1天)，不认识→重置4小时
    if (r.reps === 0 && rating === "know") {
      iv = T_1D; r.status = "review";
    } else if (rating === "know") {
      var fr = getForgetRate(iv);            // 读取该间隔段的实际遗忘率
      var growth = fr === null ? 2 : (fr > 0.3 ? 1.5 : (fr < 0.05 ? 2.5 : 2));
      iv = Math.min(Math.round(iv * growth), 120 * DAY);
      r.status = iv >= 60 * DAY ? "mastered" : "review";
    } else if (rating === "fuzzy") {
      iv = Math.max(Math.round(iv * 0.5), T_4H);
      r.status = "review";
    } else {
      recordForget(r);                        // 追踪：记录遗忘事件（双层：间隔段+自然日）
      iv = T_10MIN; r.lapses = (r.lapses || 0) + 1;
      r.status = "learning";
    }
    r.interval = iv; r.nextReview = now + iv; r.lastReviewed = now; r.reps = (r.reps || 0) + 1; r.lastRating = rating;
    saveState();
  }

  /* ---------- 统计（按词库） ---------- */
  function stats(id) {
    var rs = bookRecs(id), now = Date.now(), sod = startOfDay(now), eod = endOfDay(now);
    var total = 0, mastered = 0, newToday = 0, due = 0, lapses = 0;
    for (var w in rs) {
      var r = rs[w]; total++;
      if (r.status === "mastered") mastered++;
      if (startOfDay(r.firstLearned) === sod) newToday++;
      if (r.nextReview <= eod) due++;
      if (r.lapses > 0) lapses += r.lapses;
    }
    return { total: total, mastered: mastered, newToday: newToday, due: due, lapses: lapses, pct: total ? Math.round(mastered / total * 100) : 0 };
  }
  function dueWords(id) {
    var now = Date.now(), eod = endOfDay(now), out = [], words = curWords(), rs = bookRecs(id);
    for (var i = 0; i < words.length; i++) { var r = rs[words[i].w]; if (r && r.nextReview <= eod) { migrateRecord(r); out.push(words[i]); } }
    // 按 overdue 程度 + lapses 加权排序：越 overdue、越易忘的词越优先，+微小随机扰动打破固定顺序
    out.sort(function (a, b) {
      var ra = rs[a.w], rb = rs[b.w];
      var ia = Math.max(ra.interval || T_1D, T_1D), ib = Math.max(rb.interval || T_1D, T_1D);
      var oa = (now - ra.nextReview) / ia, ob = (now - rb.nextReview) / ib;
      oa *= 1 + (ra.lapses || 0) * 0.2; ob *= 1 + (rb.lapses || 0) * 0.2;
      // ±5% 随机抖动，打破同一批 overdue 词之间的固定排序
      oa *= 0.95 + Math.random() * 0.1; ob *= 0.95 + Math.random() * 0.1;
      return ob - oa;
    });
    return out;
  }
  function newWords(id, limit) {
    var words = curWords(), rs = bookRecs(id);
    words = words.filter(function (v) { return !rs[v.w]; });
    // 每日新词上限：limit>0 时截断（首页预览不传 limit，学习视图传入 dailyNewLimit）
    if (limit > 0 && words.length > limit) {
      // 计算今天已学新词数
      var sod = startOfDay(Date.now()), todayNew = 0;
      for (var w in rs) { var r = rs[w]; if (r && startOfDay(r.firstLearned) === sod) todayNew++; }
      var remaining = limit - todayNew;
      if (remaining <= 0) return [];
      words = words.slice(0, remaining);
    }
    return words;
  }

  /* ---------- 富化（dictionaryapi.dev，可缓存离线） ---------- */
  // 免费接口有速率限制，因此采用「温和预取 + 按需富化」：
  //  - 卡片展示时按需触发单个请求（节奏由用户操作决定，不会刷屏）；
  //  - 后台预取仅针对「今日待复习 + 前若干新词」，单并发、间隔 1.5s；
  //  - 遇到 429 / 网络错误 立即全局冷却并停止预取，绝不刷控制台。
  // persist===false 时只写内存、不落盘（用于后台预取，避免频繁写 localStorage）
  var rateLimitedUntil = 0;   // 全局冷却截止时间（ms）
  var inflight = {};          // 去重并发请求：word -> [cb,...]
  var ONLINE_ENRICH = false;  // 默认关闭外网词典富化：本地「有道」数据(音标/中文/例句/近反义) + 浏览器 TTS 已覆盖全部需求；
                              // 关闭后可彻底消除控制台 404 噪声与外部 API 依赖，应用纯离线。需要在线英文释义时改为 true。
  function enrich(word, cb, persist) {
    // 优先用构建期抓好的离线包（books/en_defs.js）：零网络、网页加载即就绪
    var local = EN_DEFS[normJs(word)];
    if (local) {
      var c = {
        loaded: true, error: !local.en,          // 词库无释义 -> error=true，卡片显示「（离线，暂无英文释义）」
        en: local.en || "", ex: "", syn: [], ant: [],
        audio_uk: local.audio_uk || "", audio_us: local.audio_us || ""
      };
      state.cache[word] = c; cb(c);
      // 静默预加载音频
      if (c.audio_us) preloadAudioUrl(c.audio_us);
      if (c.audio_uk && c.audio_uk !== c.audio_us) preloadAudioUrl(c.audio_uk);
      return;
    }
    if (!ONLINE_ENRICH) {     // 离线模式：直接返回本地数据占位，绝不发外网请求（无 404 / 无限流）
      var off = { loaded: true, error: false, en: "", ex: "", syn: [], ant: [], audio_uk: "", audio_us: "" };
      state.cache[word] = off; cb(off); return;
    }
    var c = state.cache[word];
    if (c && c.loaded && !c.error) { cb(c); return; }      // 已缓存，直接用
    if (Date.now() < rateLimitedUntil) { cb({ loaded: true, error: true }); return; } // 冷却中，走 TTS 兜底
    if (inflight[word]) { inflight[word].push(cb); return; } // 同词已在请求，合并回调
    inflight[word] = [cb];
    fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word), { cache: "force-cache" })
      .then(function (r) {
        if (r.status === 429) {                                   // 限流：全局冷却 60s 并停止预取
          rateLimitedUntil = Date.now() + 60000; preCache.blocked = true; return { loaded: true, error: true };
        }
        if (r.status === 404) {                                   // 词库里没有该词：标记 error 走 TTS，不再重试
          var nf = { loaded: true, error: true }; state.cache[word] = nf; if (persist !== false) saveState(); return nf;
        }
        if (!r.ok) { return { loaded: true, error: true }; }
        return r.json().then(function (d) {
          var c = parseDict(d, word); state.cache[word] = c; if (persist !== false) saveState(); return c;
        }, function () { return { loaded: true, error: true }; }); // 响应体非 JSON
      })
      .then(function (res) { var cbs = inflight[word] || []; delete inflight[word]; cbs.forEach(function (f) { f(res); }); })
      .catch(function () {                                          // 网络 / CORS 失败：冷却 30s 并停止预取
        rateLimitedUntil = Date.now() + 30000; preCache.blocked = true;
        var cbs = inflight[word] || []; delete inflight[word]; cbs.forEach(function (f) { f({ loaded: true, error: true }); });
      });
  }
  function parseDict(d, word) {
    var c = { loaded: true, ipa_uk: "", ipa_us: "", en: "", ex: "", syn: [], ant: [], audio_uk: "", audio_us: "" };
    if (!Array.isArray(d) || !d.length) return c;
    var entry = d[0];
    (entry.phonetics || []).forEach(function (p) {
      var au = p.audio || "";
      if (au) {
        if (/uk|au|gb/i.test(au) && !c.audio_uk) c.audio_uk = au;
        else if (/us/i.test(au) && !c.audio_us) c.audio_us = au;
        else if (!c.audio_us) c.audio_us = au;
      }
      if (p.text && !c.ipa_us) c.ipa_us = p.text;
    });
    if (!c.audio_uk) c.audio_uk = c.audio_us;
    if (!c.audio_us) c.audio_us = c.audio_uk;
    if (entry.phonetic && !c.ipa_us) c.ipa_us = entry.phonetic;
    (entry.meanings || []).forEach(function (m) {
      (m.definitions || []).forEach(function (def) {
        if (!c.en && def.definition) c.en = def.definition;
        if (!c.ex && def.example) c.ex = def.example;
      });
      if (m.synonyms) m.synonyms.forEach(function (s) { if (c.syn.indexOf(s) < 0) c.syn.push(s); });
      if (m.antonyms) m.antonyms.forEach(function (s) { if (c.ant.indexOf(s) < 0) c.ant.push(s); });
    });
    c.syn = c.syn.slice(0, 8); c.ant = c.ant.slice(0, 8);
    return c;
  }

  /* ---------- 发音（真实音频优先，TTS 兜底，IndexedDB 持久化离线可用） ---------- */
  var player = document.getElementById("player");
  // IndexedDB 音频持久化：key=url, value=blob。二次打开后播放零延迟且完全离线。
  var IDB_AUDIO_NAME = "wordsteps-audio", IDB_AUDIO_VER = 1, audioIdb = null;
  function idbAudioReady(cb) {
    if (audioIdb) { cb(audioIdb); return; }
    if (!("indexedDB" in window)) { cb(null); return; }
    var req = indexedDB.open(IDB_AUDIO_NAME, IDB_AUDIO_VER);
    req.onupgradeneeded = function (e) { var db = e.target.result; if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs"); };
    req.onsuccess = function (e) { audioIdb = e.target.result; cb(audioIdb); };
    req.onerror = function () { cb(null); };
  }
  function idbAudioGet(url, cb) {
    idbAudioReady(function (db) {
      if (!db) { cb(null); return; }
      try {
        var tx = db.transaction("blobs", "readonly"), store = tx.objectStore("blobs");
        var req = store.get(url);
        req.onsuccess = function () { cb(req.result ? req.result.blob : null); };
        req.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }
  function idbAudioSet(url, blob) {
    idbAudioReady(function (db) {
      if (!db) return;
      try { var tx = db.transaction("blobs", "readwrite"); tx.objectStore("blobs").put({url:url, blob:blob}); } catch (e) {}
    });
  }
  // 静默预加载：fetch mp3 → 写入 IndexedDB，供后续离线播放
  function preloadAudioUrl(url) {
    if (!url) return;
    idbAudioGet(url, function (blob) { if (blob) return; fetchAudio(url, null); });
  }
  function fetchAudio(url, cb) {
    try {
      fetch(url, { cache: "force-cache" }).then(function (r) {
        if (!r.ok) { if (cb) cb(null); return; }
        return r.blob();
      }).then(function (blob) {
        if (!blob) { if (cb) cb(null); return; }
        idbAudioSet(url, blob);      // 持久化到 IndexedDB
        if (cb) cb(blob);
      }).catch(function () { if (cb) cb(null); });
    } catch (e) { if (cb) cb(null); }
  }
  function playAudio(word) {
    var c = state.cache[word];
    var url = c ? (state.settings.accent === "uk" ? c.audio_uk : c.audio_us) : "";
    if (url) {
      // 1) 优先从 IndexedDB 读 blob（离线可用，零延迟）
      idbAudioGet(url, function (blob) {
        if (blob) {
          try {
            var prev = player._blobUrl;
            player.srcObject = null; player.src = (player._blobUrl = URL.createObjectURL(blob));
            if (prev) URL.revokeObjectURL(prev);
            player.play().catch(function () {});
          } catch (e) {}
          return;
        }
        // 2) 回退到 fetch 并写入 IDB（首次在线）
        fetchAudio(url, function (blob2) {
          if (blob2) {
            try {
              var prev2 = player._blobUrl;
              player.srcObject = null; player.src = (player._blobUrl = URL.createObjectURL(blob2));
              if (prev2) URL.revokeObjectURL(prev2);
              player.play().catch(function () {});
            } catch (e) {}
          } else { speak(word); }
        });
      });
      return;
    }
    speak(word);
  }
  // TTS 兜底：选最佳英文语音（Google > Microsoft > Apple > 其他英文本地语音）
  function bestVoice() {
    if (!("speechSynthesis" in window)) return null;
    var list = window.speechSynthesis.getVoices();
    if (!list.length) return null;
    var lang = state.settings.accent === "uk" ? "en-GB" : "en-US";
    var tier1 = [], tier2 = [], tier3 = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i], l = v.lang || "";
      if (l.indexOf(lang) !== 0) continue;
      if (/google/i.test(v.name)) tier1.push(v);
      else if (/microsoft|zira|david|mark/i.test(v.name)) tier2.push(v);
      else tier3.push(v);
    }
    var pool = tier1.length ? tier1 : (tier2.length ? tier2 : tier3);
    if (pool.length) {
      // 选本地语音（避免网络合成）
      for (var j = 0; j < pool.length; j++) { if (pool[j].localService) return pool[j]; }
      return pool[0];
    }
    // 放宽到任意英文
    for (var k = 0; k < list.length; k++) { if (list[k].lang && list[k].lang.indexOf("en") === 0) return list[k]; }
    return null;
  }
  function speak(word) {
    if (!("speechSynthesis" in window) || !word) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = state.settings.accent === "uk" ? "en-GB" : "en-US";
      u.rate = 0.92; u.voice = bestVoice();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // 浏览器自动播放策略：首次用户手势后预热 TTS 引擎 + 加载语音列表
  var audioPrimed = false;
  function primeAudio() {
    if (audioPrimed) return; audioPrimed = true;
    try {
      var s = window.speechSynthesis;
      s.getVoices();  // 触发语音列表加载
      s.onvoiceschanged = function () { s.getVoices(); };  // Chrome 异步加载需监听
    } catch (e) {}
  }
  document.addEventListener("pointerdown", primeAudio, { once: true });

  /* ---------- 单词卡 ---------- */
  var tpl = document.getElementById("card-tpl");
  function buildCard(bw) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    node._word = bw.w;
    var ipa = bw.ipa_uk || bw.ipa_us || "";
    // 长单词（≥12字母）缩小一圈，避免正面溢出卡片
    if (bw.w.length > 12) node.classList.add("long-word");
    node.querySelector(".word").textContent = bw.w;
    node.querySelector(".ipa").textContent = ipa;
    var rootBadge = node.querySelector(".root-badge");
    if (rootBadge) rootBadge.style.display = "none";
    node.querySelector(".word-sm").textContent = bw.w;
    node.querySelector(".ipa-sm").textContent = ipa;
    node.querySelector(".zh").textContent = bw.zh || "";
    node.querySelector(".core").style.display = bw.core ? "block" : "none";
    node.querySelector(".core-t").textContent = bw.core || "";
    // 翻面：切换 .flipped class + 自动发音
    node.addEventListener("click", function () { node.classList.toggle("flipped"); playAudio(bw.w); });
    node.querySelectorAll("[data-speak]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); playAudio(bw.w); });
    });
    fillBack(node, bw);
    return node;
  }
  // 渲染卡片时：确保富化 -> 填充背面 -> 预加载发音 -> 自动朗读
  function prepareCard(bw, node) {
    node._enriched = true;
    enrich(bw.w, function (c) {
      fillBack(node, bw);
      // 预加载真实音频到浏览器缓存，后续点击播放零延迟
      if (c.audio_us) preloadAudioUrl(c.audio_us);
      if (c.audio_uk && c.audio_uk !== c.audio_us) preloadAudioUrl(c.audio_uk);
      playAudio(bw.w);
    }, true);
  }
  function fillBack(node, bw) {
    var word = node._word, c = state.cache[word];
    var en = (c && c.en) ? c.en : (c && c.loaded ? (c.error ? "（离线，暂无英文释义）" : "") : "加载中…");
    var exEn = bw.ex ? bw.ex : (c && c.ex) ? c.ex : (c && c.loaded ? (c.error ? "" : "（暂无例句）") : "加载中…");
    var exZh = bw.exz ? bw.exz : "";
    node.querySelector(".en").textContent = en;
    node.querySelector(".ex").textContent = exEn;
    var exZhEl = node.querySelector(".ex-zh");
    if (exZh) { exZhEl.style.display = "block"; exZhEl.textContent = exZh; }
    else { exZhEl.style.display = "none"; exZhEl.textContent = ""; }
    var syn = (c && c.syn && c.syn.length) ? c.syn : (bw.syn || []);
    var ant = (c && c.ant && c.ant.length) ? c.ant : (bw.ant || []);
    var sb = node.querySelector(".syn-chips"); sb.innerHTML = "";
    if (syn.length) syn.forEach(function (s) { sb.appendChild(mkChip(s)); }); else sb.innerHTML = '<span class="chip empty">无</span>';
    var ab = node.querySelector(".ant-chips"); ab.innerHTML = "";
    if (ant.length) ant.forEach(function (s) { ab.appendChild(mkChip(s)); }); else ab.innerHTML = '<span class="chip empty">无</span>';
    fillAnalysis(node, bw);
  }
  function mkChip(s) {
    var c = document.createElement("span"); c.className = "chip"; c.textContent = s;
    c.addEventListener("click", function (e) { e.stopPropagation(); playAudio(s); });
    return c;
  }

  /* ---------- 词法分解（前/词缀 + 词根 + 后缀） ---------- */
  var PREFIX_MAP = {
    "un":"不/非","in":"不/非","im":"不/非","il":"不/非","ir":"不/非","non":"非/无","dis":"否定/相反",
    "re":"再/重复","pre":"前/预","fore":"前/预","post":"后",
    "over":"过度/在上","under":"不足/在下","up":"向上","down":"向下","out":"向外/超过",
    "mis":"错误","mal":"坏/错误",
    "anti":"反/抗","counter":"反/对",
    "inter":"之间","intra":"之内",
    "sub":"下/次","super":"上/超","sur":"上/超",
    "trans":"跨越/转变","ex":"向外/前","extra":"额外/超出","ad":"向/到",
    "co":"共同","com":"共同","con":"共同","col":"共同","cor":"共同",
    "de":"去除/向下","pro":"向前/支持","per":"贯穿/完全",
    "en":"使…","em":"使…","be":"使…/在",
    "auto":"自己","bi":"双","tri":"三","multi":"多","semi":"半",
    "micro":"微","macro":"宏","mono":"单","poly":"多",
    "neo":"新","pseudo":"伪","quasi":"准",
    "tele":"远程","photo":"光","geo":"地","bio":"生命",
    "hetero":"异","homo":"同","intro":"向内","retro":"向后",
    "circum":"周围","peri":"周围","mid":"中",
    "hyper":"极度","hypo":"低于",
  };
  var SUFFIX_MAP = {
    "tion":"名词","sion":"名词","ion":"名词","ness":"名词","ment":"名词","ity":"名词",
    "ance":"名词","ence":"名词","ure":"名词","age":"名词","dom":"名词(领域)",
    "hood":"名词(状态)","ship":"名词(关系)",
    "al":"形容词","ial":"形容词","ic":"形容词","ical":"形容词",
    "ous":"形容词","ious":"形容词","ive":"形容词","ative":"形容词",
    "ful":"形容词","less":"无/缺","able":"可…","ible":"可…",
    "ly":"副词","wise":"副词(方向)","ward":"副词(方向)",
    "er":"名词(者)","or":"名词(者)","ist":"名词(者)",
    "ize":"动词","ise":"动词","ify":"动词","ate":"动词",
    "ish":"稍/有点","like":"像…","some":"有…倾向","proof":"防…",
    "fold":"…倍","most":"最…",
  };
  // 已知词族表（与 tools/rebuild_v3.py 的 ROOT_LIST 对齐），用于词法分解时验证"剥离后是否仍是真词根"
  var ROOT_SET = new Set([
    "act","aud","bell","bene","bon","bio","cap","cept","cip","capt","ced","ceed","cess","chron",
    "cid","cis","civ","clar","cogn","cord","corp","cosm","cred","cruc","cub","cumb","cur","curs",
    "dem","demo","derm","dict","doc","doct","domin","duc","duct","dyn","equ","err","fac","fact",
    "fic","fect","fer","fid","fin","flagr","flam","flect","flex","flor","flu","flux","fort","forc",
    "found","form","frag","fract","frat","fus","fund","gen","gener","geo","grad","gress","gram",
    "graph","grat","grav","greg","hab","hibit","helio","heter","hom","horr","hum","hydr","hypn",
    "ign","ject","junct","jur","just","juven","lab","labor","langu","lingu","lapid","lat","lav",
    "leg","lex","lect","lev","liber","libr","lic","lin","liter","loc","loqu","log","logy","luc",
    "lum","lud","magn","man","manu","mater","matr","medi","mega","mem","mens","ment","merc","migr",
    "min","miss","mit","mob","mot","mov","mon","mono","mort","morph","multi","mut","nat","nas",
    "nav","naut","nec","neg","neur","nihil","noc","nox","nom","nomin","nov","numer","nutri","onym",
    "oper","opt","ora","ordin","orn","paci","pan","par","pare","pat","pass","path","ped","pod",
    "pel","puls","pend","pens","pet","phil","phon","photo","plat","pli","plic","ply","plex","plor",
    "pne","pol","port","pos","pon","post","pound","pot","prehend","prim","prob","prov","psych",
    "publ","pur","pyr","quer","quest","quir","quie","rad","reg","rect","rid","ris","rod","rupt",
    "sacr","sanct","sal","san","sat","satis","sci","scrib","script","sect","sed","sess","sid",
    "sens","sent","sequ","secu","sert","sig","sign","simil","simul","sol","son","soph","spec",
    "spic","sper","spir","stell","struct","suad","sum","super","syn","sym","tang","tact","techn",
    "tele","tem","ten","tend","term","terr","test","tex","the","theo","therm","tim","tom","ton",
    "tort","tract","trib","trop","tru","turb","typ","uni","urb","vac","van","val","vari",
    "ven","vent","ver","verb","vers","vert","viv","vic","vict","vid","vis","voc","vok","vol","volv",
    "vor","vuln","zo","advert","advertis","comfort","connect","complet","consider","construct",
    "continu","cover","creat","decid","defin","develop","differ","divid","educ","estim","event",
    "examin","explain","explor","express","form","grad","imit","improv","incorpor","inform",
    "intend","interest","interpret","introduc","invent","invest","judg","knowledg","limit",
    "maintain","manag","measur","mov","natur","observ","offer","organ","perform","practic",
    "prepar","present","print","produc","provid","purchas","recognis","represent","requir",
    "research","satisf","sci","sell","serv","solv","spec","spend","star","struct","success",
    "suggest","suppli","support","tend","term","treat","turn","understand","visit","wait","work",
    // 拉丁词根截短形式（去掉结尾的辅音便于跨词匹配）
    "struc","spect","ject","duct","fer","pos","ten","fac","manu","mit","ven","duc",
    "cap","cep","fin","fus","form","gen","gress","ject","miss","press","script","serv",
    "sign","simil","solve","tend","tract","vene","versi","vide","voke","volve"
  ]);
  // 已知词族的中文含义（按 ROOT_SET 配套），用于显示"<sub>转/看/...</sub>"的下标说明
  var ROOT_MEANINGS = {
    act:"行动",aud:"听",bell:"战争",bene:"好",bon:"好",bio:"生命",cap:"头/抓",cept:"拿",
    cip:"拿",capt:"抓",ced:"走",ceed:"走",cess:"走",chron:"时间",cid:"切",cis:"切",
    civ:"公民",clar:"清楚",cogn:"知道",cord:"心",corp:"身体",cosm:"宇宙",cred:"相信",
    cruc:"十字/交叉",cub:"躺",cumb:"躺",cur:"跑",curs:"跑",dem:"人民",demo:"人民",derm:"皮",
    dict:"说",doc:"教",doct:"教",domin:"主",duc:"引/导",duct:"引/导",dyn:"力量",
    equ:"等",err:"错",fac:"做/造",fact:"做/造",fic:"做",fect:"做",fer:"带/承",fid:"信",
    fin:"结束",flagr:"烧",flam:"烧",flect:"弯",flex:"弯",flor:"花",flu:"流",flux:"流",
    fort:"强",forc:"强",found:"建/底",form:"形",frag:"碎",fract:"碎",frat:"兄弟",fus:"流",
    fund:"底",gen:"生/族",gener:"生/族",geo:"地",grad:"步/级",gress:"步",gram:"写/字",
    graph:"写/图",grat:"感谢",grav:"重",greg:"群",hab:"有/住",hibit:"有",helio:"太阳",
    heter:"异",hom:"同",horr:"怕",hum:"地/人",hydr:"水",hypn:"睡",ign:"火",
    ject:"投/扔",junct:"连接",jur:"法/誓",just:"法",juven:"年轻",lab:"工作",labor:"工作",
    langu:"语言",lingu:"语言",lapid:"石",lat:"带",lav:"洗",leg:"法",lex:"法",
    lect:"选/读",lev:"举/轻",liber:"自由",libr:"书",lic:"允许",lin:"线",liter:"文字",
    loc:"地方",loqu:"说",log:"说/词",logy:"学",luc:"光",lum:"光",lud:"玩/戏",
    magn:"大",man:"手",manu:"手",mater:"母",matr:"母",medi:"中",mega:"大",mem:"记",
    mens:"测量",ment:"心/智",merc:"商/贸易",migr:"移",min:"小",miss:"送",mit:"送",
    mob:"动",mot:"动",mov:"动",mon:"警告/独",mono:"单",mort:"死",morph:"形",multi:"多",
    mut:"变",nat:"生",nas:"鼻",nav:"船",naut:"船",nec:"伤",neg:"否",neur:"神经",nihil:"无",
    noc:"伤",nox:"伤",nom:"名",nomin:"名",nov:"新",numer:"数",nutri:"养",
    oper:"工作",opt:"选",ora:"说",ordin:"顺序",orn:"装饰",paci:"和平",pan:"全",
    par:"等/比",pare:"准备",pat:"走/父",pass:"走/过",path:"感情/路",ped:"脚",pod:"脚",
    pel:"推",puls:"推",pend:"挂/称",pens:"称",pet:"寻求/宠",phil:"爱",phon:"声",
    photo:"光",plat:"平",pli:"折",plic:"折",ply:"折",plex:"折",plor:"探索",pne:"气/呼吸",
    pol:"极/城",port:"港/带",pos:"放",pon:"放",post:"后",pound:"重",pot:"能/喝",
    prehend:"抓",prim:"第一",prob:"证明",prov:"证明",psych:"精神",publ:"公共",pur:"纯",
    pyr:"火",quer:"询问",quest:"询问",quir:"询问",quie:"安静",rad:"根/辐",reg:"王/规则",
    rect:"正/直",rid:"笑",ris:"笑/起",rod:"咬",rupt:"破",sacr:"神圣",sanct:"神圣",sal:"盐/健康",
    san:"健康",sat:"足够",satis:"足够",sci:"知道",scrib:"写",script:"写",sect:"切",
    sed:"坐",sess:"坐",sid:"坐",sens:"感觉",sent:"感觉/送",sequ:"跟随",secu:"跟随",
    sert:"放/连接",sig:"记号",sign:"记号",simil:"相似",simul:"相似",sol:"单独/太阳",
    son:"声",soph:"聪明",spec:"看",spic:"看",sper:"希望",spir:"呼吸",stell:"星",
    struct:"建",suad:"劝",sum:"拿/和",super:"上",syn:"同",sym:"同",tang:"触",tact:"触",
    techn:"技术",tele:"远",tem:"时间",ten:"持",tend:"伸",term:"边界",terr:"土地/怕",
    test:"证明",tex:"织",the:"神",theo:"神",therm:"热",tim:"怕",tom:"切",ton:"声",
    tort:"扭",tract:"拉",trib:"部落",trop:"转",tru:"真",turb:"搅",typ:"类型",
    uni:"一",urb:"城",vac:"空",van:"空",val:"价值/强",vari:"变",ven:"来",vent:"来",
    ver:"转",verb:"词",vers:"转",vert:"转",viv:"活",vic:"胜",vict:"胜",vid:"看",
    vis:"看",voc:"叫/声",vok:"叫",vol:"飞/意愿",volv:"滚",vor:"吃",vuln:"伤",zo:"动物",
    advert:"注意/转向",advertis:"注意",comfort:"舒适",connect:"连接",complet:"完整",
    consider:"考虑",construct:"建",continu:"继续",cover:"盖",creat:"创造",decid:"决定",
    defin:"定义",develop:"发展",differ:"不同",divid:"分",educ:"教育",estim:"估计",
    event:"事件",examin:"检查",explain:"解释",explor:"探索",express:"表达",form:"形",
    grad:"步",imit:"模仿",improv:"改进",incorpor:"合并",inform:"通知",intend:"打算",
    interest:"兴趣",interpret:"解释",introduc:"介绍",invent:"发明",invest:"投资",
    judg:"判断",knowledg:"知识",limit:"限制",maintain:"维持",manag:"管理",
    measur:"测量",mov:"动",natur:"自然",observ:"观察",offer:"提供",organ:"器官",
    perform:"表演",practic:"实践",prepar:"准备",present:"呈现",print:"打印",produc:"生产",
    provid:"提供",purchas:"买",recognis:"认出",represent:"代表",requir:"要求",
    research:"研究",satisf:"满意",sell:"卖",serv:"服务",solv:"解决",spend:"花",
    star:"星",success:"成功",suggest:"建议",suppli:"供应",support:"支持",tend:"倾向",
    term:"期限",treat:"对待",turn:"转",understand:"理解",visit:"访问",wait:"等",work:"工作"
  };

function fillAnalysis(node, bw) {
    var w = bw.w.toLowerCase();
    var el = node.querySelector(".analysis-line");
    if (!el) return;
    if (w.length < 5) { el.style.display = "none"; return; }
    var preKeys = Object.keys(PREFIX_MAP).sort(function(a,b){return b.length-a.length;});
    var sufKeys = Object.keys(SUFFIX_MAP).sort(function(a,b){return b.length-a.length;});
    // 递归分解：返回扁平 morpheme 列表 [prefix?, root, suffix?]
    // 优先 1) 整词为词根；2) prefix+root+suffix（root 在 ROOT_SET）；3) 递归向内
    function decomp(word, depth) {
      if (depth > 4 || word.length < 3) return null;
      // 1) 整词就是词根
      if (ROOT_SET.has(word)) return [{type:'root', val:word}];
      var cands = [];
      // 2) prefix + suffix（root 在 ROOT_SET）
      for (var pi = 0; pi < preKeys.length; pi++) {
        var p = preKeys[pi];
        if (word.slice(0, p.length) !== p || word.length <= p.length + 3) continue;
        var afterPre = word.slice(p.length);
        for (var si = 0; si < sufKeys.length; si++) {
          var s = sufKeys[si];
          if (afterPre.slice(-s.length) !== s || afterPre.length <= s.length + 2) continue;
          var stem = afterPre.slice(0, afterPre.length - s.length);
          if (stem.length < 3) continue;
          if (!ROOT_SET.has(stem)) continue;
          var score = stem.length + (p && s ? 200 : 100);
          cands.push({p:p, s:s, stem:stem, score:score});
        }
      }
      // 选最优 prefix+suffix
      if (cands.length) {
        cands.sort(function(a,b){return b.score-a.score;});
        var b = cands[0];
        return [{type:'p', val:b.p}, {type:'root', val:b.stem}, {type:'s', val:b.s}];
      }
      // 3) 递归：尝试剥前缀或后缀后继续分析剩余部分
      for (var pi2 = 0; pi2 < preKeys.length; pi2++) {
        var p2 = preKeys[pi2];
        if (word.slice(0, p2.length) !== p2 || word.length <= p2.length + 3) continue;
        var rest = word.slice(p2.length);
        var sub = decomp(rest, depth + 1);
        if (sub) return [{type:'p', val:p2}].concat(sub);
      }
      for (var si2 = 0; si2 < sufKeys.length; si2++) {
        var s2 = sufKeys[si2];
        if (word.slice(-s2.length) !== s2 || word.length <= s2.length + 3) continue;
        var stem2 = word.slice(0, word.length - s2.length);
        var sub2 = decomp(stem2, depth + 1);
        if (sub2) return sub2.concat([{type:'s', val:s2}]);
      }
      return null;
    }
    var morphs = decomp(w, 0);
    if (!morphs) { el.style.display = "none"; return; }
    // 渲染 morpheme 列表
    var parts = [];
    for (var i = 0; i < morphs.length; i++) {
      var m = morphs[i];
      if (m.type === 'p') parts.push('<span class="ana-pre">' + m.val + '-<sub>' + PREFIX_MAP[m.val] + '</sub></span>');
      else if (m.type === 's') parts.push('<span class="ana-suf">-' + m.val + '<sub>' + SUFFIX_MAP[m.val] + '</sub></span>');
      else parts.push('<span class="ana-root">-' + m.val + '-<sub>' + (ROOT_MEANINGS[m.val] || "词根") + '</sub></span>');
    }
    el.innerHTML = parts.join(" · ");
    el.style.display = "";
  }

  /* ---------- 温和后台预取（不刷屏、遇限流即停） ---------- */
  var preCache = { active: false, blocked: false };
  function startPreCache(id) {
    var b = BOOKS_DATA[id];
    if (!b || preCache.active || preCache.blocked) return;
    if (Date.now() < rateLimitedUntil) { preCache.blocked = true; return; }
    // 只预取「今日待复习 + 前 30 个新词」这一小批量，避免打满接口额度
    var need = {};
    dueWords(id).forEach(function (v) { need[v.w] = 1; });
    newWords(id).slice(0, 30).forEach(function (v) { need[v.w] = 1; });
    var q = b.words.filter(function (v) { var c = state.cache[v.w]; return need[v.w] && !(c && c.loaded && !c.error); });
    if (!q.length) { updateCacheBadge(id); return; }
    preCache.active = true;
    var i = 0, DELAY = 1500; // 单并发、间隔 1.5s
    function tick() {
      if (preCache.blocked || Date.now() < rateLimitedUntil) { preCache.active = false; return; }
      if (i >= q.length) { preCache.active = false; updateCacheBadge(id); return; }
      var w = q[i++].w;
      enrich(w, function () { updateCacheBadge(id); }, false);
      setTimeout(tick, DELAY);
    }
    updateCacheBadge(id);
    tick();
  }
  function updateCacheBadge(id) {
    var b = BOOKS_DATA[id]; var el = document.getElementById("cache-badge");
    if (!b || !el) return;
    var cached = 0;
    b.words.forEach(function (v) { var c = state.cache[v.w]; if (c && c.loaded && !c.error) cached++; });
    el.textContent = "缓存 " + cached + " / " + b.words.length;
  }

  /* ---------- 视图切换 ---------- */
  function showView(name) {
    endSession();
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
    document.getElementById("view-" + name).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.view === name); });
    if (name === "home") renderHome();
    if (name === "history") renderHistory();
    if (name === "learn") startLearn();
    if (name === "review") startReview();
  }

  /* ---------- 首页 ---------- */
  function renderHome() {
    var id = curBook();
    loadBook(id, function () {
      refreshSort();
      var s = stats(id);
      document.getElementById("stat-due").textContent = s.due;
      document.getElementById("stat-new").textContent = s.newToday;
      document.getElementById("stat-total").textContent = s.total;
      document.getElementById("stat-mastered").textContent = s.mastered;
      document.getElementById("ring-pct").textContent = s.pct + "%";
      document.getElementById("mastery-ring").style.setProperty("--pct", s.pct);
      document.getElementById("ms-streak").textContent = state.streak.count;
      // 累计时长：仅统计当前单词本（避免跨词本汇总造成的「聚合」错觉）
      var mins = Math.round(state.sessions.filter(function (x) { return x.book === id; }).reduce(function (a, x) { return a + x.durMs; }, 0) / 60000);
      document.getElementById("ms-time").textContent = mins + "m";
      document.getElementById("ms-lapses").textContent = s.lapses;
      document.getElementById("home-review-sub").textContent = s.due + " 个单词待复习";
      // 计算即将到来的复习（4小时内 + 24小时内）
      var now = Date.now(), upcoming4h = 0, upcoming24h = 0;
      var rs = bookRecs(id);
      for (var w in rs) {
        var nr = rs[w].nextReview;
        if (nr > now && nr <= now + T_4H) upcoming4h++;
        if (nr > now && nr <= now + T_1D) upcoming24h++;
      }
      if (s.due > 0) {
        // 有到期复习
      } else if (upcoming4h > 0) {
        var nextTime = new Date(now + T_4H);
        document.getElementById("home-review-sub").textContent = "约 " + upcoming4h + " 个单词即将需复习（" + nextTime.getHours() + ":" + (nextTime.getMinutes()<10?"0":"") + nextTime.getMinutes() + " 左右）";
      } else {
        document.getElementById("home-review-sub").textContent = upcoming24h + " 个单词复习中（最晚今夜到齐）";
      }
      // 上次学习时间
      var lastSession = state.sessions[0];
      if (lastSession) {
        var elapsed = now - lastSession.ts;
        var agoStr = elapsed < 60000 ? "刚刚" : elapsed < 3600000 ? Math.round(elapsed / 60000) + "分钟前" : elapsed < 86400000 ? Math.round(elapsed / 3600000) + "小时前" : Math.round(elapsed / 86400000) + "天前";
        document.getElementById("home-review-sub").textContent += " · 上次 " + agoStr;
      }
      var limit = state.settings.dailyNewLimit || 0, totalNew = newWords(id, 0).length;
      document.getElementById("home-learn-sub").textContent = totalNew + " 个新词待学" + (limit > 0 ? "（今日上限 " + limit + "）" : "");
      document.getElementById("home-limit").value = limit;
      var prev = document.getElementById("due-preview"); prev.innerHTML = "";
      dueWords(id).slice(0, 24).forEach(function (v) {
        var li = document.createElement("li"); li.className = "chip-word"; li.textContent = v.w; li.title = v.zh || ""; prev.appendChild(li);
      });
      if (!prev.children.length) prev.innerHTML = '<li class="empty">今天没有需要复习的单词，去学点新词吧 🎉</li>';
      // 后台节流预取整本富化数据（加载网页时即开始）
      startPreCache(id);
      drawForgetCurve();
    });
  }

  /* ---------- 记忆曲线（基于自然日遗忘数据，7天一档） ---------- */
  function forgetCurveData() {
    var dfs = state.dayForgetStats || {};
    // 从 dayForgetStats 中按天数桶查遗忘率
    function frAt(day) {
      var key = day === 0 ? "当天" : day + "天后";
      var s = dfs[key] || { total: 0, forgotten: 0 };
      return s.total >= 3 ? s.forgotten / s.total : null;
    }
    // X 轴：0/7/14/21/28天，缺失的点用线性插值
    var xs = [0, 7, 14, 21, 28];
    var pts = xs.map(function (d) { return frAt(d); });
    // 统计总遗忘与第30天保持率
    var totalLearned = 0, totalForgotten = 0, f30 = frAt(30);
    for (var k in dfs) { totalLearned += dfs[k].total; totalForgotten += dfs[k].forgotten; }
    var est30 = f30 !== null ? Math.round((1 - f30) * 100) : (totalLearned > 0 ? Math.round((1 - totalForgotten / totalLearned) * 100) : 100);
    return { xs: xs, pts: pts, est30: est30 };
  }
  function drawForgetCurve() {
    var cv = document.getElementById("fc-canvas");
    if (!cv) return;
    var d = forgetCurveData();
    var el30 = document.getElementById("fc-30");
    if (el30) el30.textContent = d.est30;
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var cssW = cv.clientWidth || 200, cssH = cv.clientHeight || 128;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var padL = 12, padR = 12, padT = 8, padB = 16;
    var plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    function X(i) { return padL + plotW * d.xs[i] / 28; }
    function Y(v) { return padT + plotH * (1 - v); }
    // 横向网格（0%/50%/100%记忆保持率）
    ctx.strokeStyle = "rgba(31,39,51,0.06)"; ctx.lineWidth = 1;
    for (var g = 0; g <= 2; g++) { var gy = padT + plotH * g / 2; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke(); }
    // 有效数据点
    var validPts = [];
    for (var i = 0; i < d.pts.length; i++) { if (d.pts[i] !== null) validPts.push(i); }
    if (validPts.length >= 2) {
      // 曲线渐变填充
      ctx.beginPath();
      ctx.moveTo(X(validPts[0]), Y(d.pts[validPts[0]]));
      for (var j = 1; j < validPts.length; j++) ctx.lineTo(X(validPts[j]), Y(d.pts[validPts[j]]));
      ctx.lineTo(X(validPts[validPts.length - 1]), padT + plotH);
      ctx.lineTo(X(validPts[0]), padT + plotH);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, "rgba(79,110,247,0.30)");
      grad.addColorStop(1, "rgba(79,110,247,0.02)");
      ctx.fillStyle = grad; ctx.fill();
      // 曲线
      ctx.beginPath();
      ctx.moveTo(X(validPts[0]), Y(d.pts[validPts[0]]));
      for (j = 1; j < validPts.length; j++) ctx.lineTo(X(validPts[j]), Y(d.pts[validPts[j]]));
      ctx.strokeStyle = "#4f6ef7"; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
      // 数据点
      validPts.forEach(function (i) {
        ctx.beginPath(); ctx.arc(X(i), Y(d.pts[i]), 3.5, 0, Math.PI * 2);
        ctx.fillStyle = d.pts[i] > 0.3 ? "#e25555" : "#4f6ef7";
        ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      });
    } else {
      ctx.fillStyle = "rgba(154,165,180,0.9)"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("学习 + 复习后显示记忆曲线", padL + plotW / 2, padT + plotH / 2);
    }
    // X 轴标签：0/7/14/21/28天
    ctx.fillStyle = "rgba(154,165,180,0.95)"; ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    d.xs.forEach(function (day, idx) {
      ctx.fillText(day === 0 ? "今天" : day + "天", X(idx), padT + plotH + 12);
    });
  }

  // 屏幕旋转 / 尺寸变化时重绘曲线（仅首页激活时）
  window.addEventListener("resize", function () {
    if (document.getElementById("view-home") && document.getElementById("view-home").classList.contains("active")) drawForgetCurve();
  });

  /* ---------- 学习（新词） ---------- */
  var learnQueue = [], learnIdx = 0, learnRated = 0;
  function startLearn() {
    var id = curBook();
    var limit = state.settings.dailyNewLimit || 0;
    loadBook(id, function () { learnQueue = newWords(id, limit); learnIdx = 0; learnRated = 0; renderLearn(); });
  }
  function renderLearn() {
    var id = curBook(), now = Date.now();
    var stage = document.getElementById("learn-stage"); stage.innerHTML = "";
    // 当天已学新词数（从 records 计数，跨会话累计）
    var sod = startOfDay(now), rs = bookRecs(id), todayTotal = 0;
    for (var w in rs) { if (startOfDay(rs[w].firstLearned) === sod) todayTotal++; }
    document.getElementById("learn-counter").textContent = "今日已学 " + todayTotal + " 词" + (learnQueue.length ? " · 当前第 " + (learnIdx + 1) + "/" + learnQueue.length : "");
    updateCacheBadge(id);
    if (!learnQueue.length) {
      var limit = state.settings.dailyNewLimit || 0;
      if (limit > 0 && newWords(id, 0).length > 0) {
        stage.innerHTML = '<div class="panel" style="text-align:center">🎯 今日新词目标（' + limit + '词）已完成！<br><small style="color:var(--ink-faint)">明天再来学新的，或去复习旧词吧。</small></div>';
      } else {
        stage.innerHTML = '<div class="panel" style="text-align:center">🎉 这个单词本的核心词都学完啦！</div>';
      }
      return;
    }
    var bw = learnQueue[learnIdx];
    var node = buildCard(bw); stage.appendChild(node); prepareCard(bw, node);
  }
  document.getElementById("learn-rate-controls").addEventListener("click", function (e) {
    var btn = e.target.closest(".rate"); if (!btn || !learnQueue.length) return;
    var rating = btn.dataset.rate, bw = learnQueue[learnIdx];
    ensureSession();
    scheduleReview(curBook(), bw.w, rating);
    if (curSession) { curSession.newCount++; curSession[rating]++; }
    learnRated++; learnIdx++; renderLearn();
  });

  /* ---------- 复习 ---------- */
  var reviewQueue = [], reviewIdx = 0, reviewRated = 0;
  function startReview() {
    var id = curBook();
    loadBook(id, function () { reviewQueue = dueWords(id); reviewIdx = 0; reviewRated = 0; renderReview(); });
  }
  function renderReview() {
    var stage = document.getElementById("review-stage"), controls = document.getElementById("rate-controls");
    stage.innerHTML = ""; controls.hidden = true;
    document.getElementById("review-counter").textContent = (reviewQueue.length ? reviewRated + 1 : 0) + " / " + reviewQueue.length;
    if (!reviewQueue.length) { stage.innerHTML = '<div class="panel" style="text-align:center">🔥 今日复习全部完成，明天见！</div>'; return; }
    var bw = reviewQueue[reviewIdx];
    var node = buildCard(bw);
    node.addEventListener("click", function () { controls.hidden = false; });
    stage.appendChild(node); prepareCard(bw, node);
  }
  document.getElementById("rate-controls").addEventListener("click", function (e) {
    var btn = e.target.closest(".rate"); if (!btn || !reviewQueue.length) return;
    var rating = btn.dataset.rate, bw = reviewQueue[reviewIdx];
    ensureSession();
    scheduleReview(curBook(), bw.w, rating);
    if (curSession) { curSession.reviewCount++; curSession[rating]++; }
    reviewRated++; reviewIdx++; renderReview();
  });
  document.getElementById("review-exit").addEventListener("click", function () { showView("home"); });

  /* ---------- 历史 ---------- */
  function renderHistory() {
    var id = curBook(), s = stats(id);
    document.getElementById("hist-book-name").textContent = bookLabel(id);
    document.getElementById("hs-total").textContent = s.total;
    document.getElementById("hs-new").textContent = s.newToday;
    document.getElementById("hs-due").textContent = s.due;
    document.getElementById("hs-mastered").textContent = s.mastered;
    var list = document.getElementById("session-list"); list.innerHTML = "";
    if (!state.sessions.length) {
      list.innerHTML = '<li class="empty" style="color:var(--ink-faint)">还没有学习记录，去学习或复习吧。</li>';
    } else {
      state.sessions.slice(0, 40).forEach(function (x) {
        var li = document.createElement("li");
        var mins = Math.max(1, Math.round(x.durMs / 60000));
        var bname = bookLabel(x.book);
        li.innerHTML = '<div><div class="s-date">' + (x.date || "") + (bname ? " · " + bname : "") +
          '</div><div class="s-meta">新学 ' + x.newCount + ' · 复习 ' + x.reviewCount + ' · 认识 ' + x.know + '/模糊 ' + x.fuzzy + '/不认识 ' + x.unknown + '</div></div><div class="s-meta">' + mins + ' 分钟</div>';
        list.appendChild(li);
      });
    }
    renderLearned();
  }
  function renderLearned() {
    var id = curBook(), box = document.getElementById("learned-list");
    var q = document.getElementById("hist-search").value.trim().toLowerCase();
    var f = document.getElementById("hist-filter").value;
    box.innerHTML = "";
    var rs = bookRecs(id), words = Object.keys(rs).map(function (w) { return rs[w]; });
    words.sort(function (a, b) { return b.lastReviewed - a.lastReviewed; });
    var shown = 0;
    words.forEach(function (r) {
      if (f !== "all" && r.status !== f) return;
      var meta = (BOOKS_DATA[id] ? BOOKS_DATA[id].words.filter(function (v) { return v.w === r.word; })[0] : null);
      if (q && r.word.toLowerCase().indexOf(q) === -1 && !(meta && meta.zh && meta.zh.toLowerCase().indexOf(q) !== -1)) return;
      shown++;
      var li = document.createElement("li");
      var pct = Math.min(100, Math.round((r.interval || T_1D) / (120 * DAY) * 100));
      var lvlCls = r.status === "mastered" ? "lvl-mastered" : (r.status === "review" ? "lvl-review" : "lvl-learning");
      var lvlTxt = r.status === "mastered" ? "已掌握" : (r.status === "review" ? "复习中" : "学习中");
      li.innerHTML = '<span class="lw">' + r.word + '</span><span class="lzh">' + (meta ? meta.zh : "") + '</span><span class="lbar"><i style="width:' + pct + '%"></i></span><span class="lvl-tag ' + lvlCls + '">' + lvlTxt + '</span>';
      box.appendChild(li);
    });
    if (!shown) box.innerHTML = '<li class="empty" style="color:var(--ink-faint)">没有匹配的单词。</li>';
  }
  document.getElementById("hist-search").addEventListener("input", renderLearned);
  document.getElementById("hist-filter").addEventListener("change", renderLearned);
  document.getElementById("btn-reset").addEventListener("click", function () {
    var m = REGISTRY.filter(function (r) { return r.id === curBook(); })[0];
    if (confirm("确定清空「" + bookLabel(curBook()) + "」的全部本地进度吗？此操作不可恢复。")) {
      state.books[curBook()] = { records: {} }; saveState(); renderHistory(); renderHome();
    }
  });
  // 恢复备��按钮：仅在检测到备份数据且当前进度为空时显示
  (function checkRestorePanel() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORE_KEY + "_bak_") === 0) keys.push(k);
      }
      if (keys.length) {
        document.getElementById("restore-panel").style.display = "";
        document.getElementById("btn-restore").addEventListener("click", function () {
          keys.sort().reverse();
          var latest = localStorage.getItem(keys[0]);
          if (!latest || !confirm("确定从备份恢复吗？当前进度将被替换。")) return;
          try {
            var raw = JSON.parse(latest);
            var curVer = raw.schemaVer || 0;
            while (curVer < SCHEMA_VER) {
              var fn = MIGRATIONS[curVer];
              if (!fn) break;
              raw = fn(raw) || raw;
              curVer++;
            }
            var restored = deepMergeSkeleton(defaultSkeleton(), raw);
            localStorage.setItem(STORE_KEY, JSON.stringify(restored));
            alert("已恢复。请刷新页面查看。");
            location.reload();
          } catch (e) { alert("备份数据损坏，无法恢复。"); }
        });
      }
    } catch (e) {}
  })();

  /* ---------- 学习会话（活跃间隔判断） ---------- */
  var curSession = null, SESSION_GAP = 3600000;  // 1小时无操作则记为新一次学习
  function bumpStreak() {
    var today = dayStr(Date.now()); if (state.streak.lastDate === today) return;
    var y = dayStr(Date.now() - DAY);
    state.streak.count = state.streak.lastDate === y ? state.streak.count + 1 : 1;
    state.streak.lastDate = today; saveState();
  }
  // 首次操作（评分）时创建会话；距上次操作超过1小时则结束上一段、开新会话
  function ensureSession() {
    var now = Date.now();
    if (curSession && now - curSession._lastAct < SESSION_GAP) {
      curSession._lastAct = now;  // 更新最近活跃时间
      return;
    }
    bumpStreak();
    // 如果已有旧会话(超时未操作)，先存档
    if (curSession && (curSession.newCount || curSession.reviewCount)) {
      endSession();
    }
    curSession = {
      _firstAct: now, _lastAct: now,
      newCount: 0, reviewCount: 0,
      know: 0, fuzzy: 0, unknown: 0,
      book: curBook()
    };
  }
  function endSession() {
    if (!curSession) return;
    if (curSession.newCount || curSession.reviewCount) {
      var dur = curSession._lastAct - curSession._firstAct;
      state.sessions.unshift({
        ts: Date.now(), date: dayStr(Date.now()),
        book: curSession.book, durMs: dur,
        newCount: curSession.newCount, reviewCount: curSession.reviewCount,
        know: curSession.know, fuzzy: curSession.fuzzy, unknown: curSession.unknown
      });
      if (state.sessions.length > 300) state.sessions.length = 300;
      saveState();
    }
    curSession = null;
  }

  /* ---------- 音标口音切换（左右滑动开关，与「增量」同款） ---------- */
  var accentBtn = document.getElementById("btn-accent");
  function refreshAccent() {
    if (!accentBtn) return;
    var uk = state.settings.accent === "uk";
    accentBtn.classList.toggle("on", uk);
    accentBtn.setAttribute("aria-pressed", uk ? "true" : "false");
    var lbl = accentBtn.querySelector(".accent-label");
    if (lbl) lbl.textContent = uk ? "英音" : "美音";
  }
  if (accentBtn) accentBtn.addEventListener("click", function () {
    state.settings.accent = state.settings.accent === "uk" ? "us" : "uk"; saveState(); refreshAccent();
  });

  /* ---------- 单词本选择器 ---------- */
  var homeSel = document.getElementById("home-book"), learnSel = document.getElementById("learn-book");
  function fillBookSelect(sel) {
    sel.innerHTML = "";
    REGISTRY.forEach(function (r) { var o = document.createElement("option"); o.value = r.id; o.textContent = bookLabel(r.id); sel.appendChild(o); });
    sel.value = curBook();
  }
  homeSel.addEventListener("change", function () { state.settings.book = homeSel.value; saveState(); if (learnSel) learnSel.value = curBook(); renderHome(); });
  if (learnSel) learnSel.addEventListener("change", function () { state.settings.book = learnSel.value; saveState(); homeSel.value = curBook(); showView("learn"); });

  /* ---------- 排序方式开关（字母 / 词频 / 词根，逐本记忆，默认全部词根） ---------- */
  var sortSeg = document.getElementById("home-sort");
  function refreshSort() {
    if (!sortSeg) return;
    var m = sortMode(curBook());
    Array.prototype.forEach.call(sortSeg.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.dataset.mode === m);
    });
  }
  if (sortSeg) sortSeg.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-mode]"); if (!btn) return;
    if (!state.settings.bookSort) state.settings.bookSort = {};   // 防御性兜底，避免老存档缺失字段时报错
    state.settings.bookSort[curBook()] = btn.dataset.mode; saveState();
    refreshSort();
    if (document.getElementById("view-home").classList.contains("active")) renderHome();
  });

  /* ---------- 导航 ---------- */
  document.querySelectorAll(".nav-btn").forEach(function (b) { b.addEventListener("click", function () { showView(b.dataset.view); }); });
  document.getElementById("home-review").addEventListener("click", function () { showView("review"); });
  document.getElementById("home-learn").addEventListener("click", function () { showView("learn"); });
  // 「增量」开关：开启后除基础/初中外，每个词本只显示与上一难度差集的新词
  // 「on」状态挂在父容器 .inc-block 上，使开关 + 问号 整块一起高亮、保持同一边框
  var incBtn = document.getElementById("home-inc");
  var incBlock = document.getElementById("home-inc-block");
  function refreshInc() {
    if (!incBtn) return;
    var on = !!state.settings.incremental;
    incBtn.setAttribute("aria-pressed", on ? "true" : "false");
    incBtn.classList.toggle("on", on);
    if (incBlock) incBlock.classList.toggle("on", on);
    var lbl = incBtn.querySelector(".inc-label");
    if (lbl) lbl.textContent = on ? "增量 ✓" : "增量";
  }
  if (incBtn) incBtn.addEventListener("click", function () {
    state.settings.incremental = !state.settings.incremental;
    saveState();
    clearIncCache();          // 差集词数失效，下次渲染重算
    refreshInc();
    refreshBookLabels();      // 下拉书名（差集词数）即时更新
    if (document.getElementById("view-home").classList.contains("active")) renderHome();
  });

  /* ---------- 增量说明「?」浮窗 ---------- */
  var incHelp = document.getElementById("inc-help");
  var incPop = document.getElementById("inc-help-pop");
  if (incHelp && incPop) {
    incHelp.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!incPop.hidden) { incPop.hidden = true; return; }
      incPop.hidden = false;
      var r = incHelp.getBoundingClientRect();
      var pw = incPop.offsetWidth, ph = incPop.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
      var top = r.top - ph - 10;
      if (top < 8) top = r.bottom + 10;   // 上方空间不足则显示在下方
      incPop.style.left = left + "px";
      incPop.style.top = top + "px";
    });
    document.addEventListener("click", function (e) {
      if (!incPop.hidden && e.target !== incHelp && !incPop.contains(e.target)) incPop.hidden = true;
    });
  }

  /* ---------- 初始化 ---------- */
  fillBookSelect(homeSel); if (learnSel) fillBookSelect(learnSel);
  window.addEventListener("beforeunload", endSession);
  refreshAccent();
  refreshInc();
  // 每日新词上限输入框
  var limitInput = document.getElementById("home-limit");
  if (limitInput) {
    limitInput.value = state.settings.dailyNewLimit || 0;
    limitInput.addEventListener("change", function () {
      var v = parseInt(limitInput.value, 10);
      state.settings.dailyNewLimit = isNaN(v) || v < 0 ? 0 : v; saveState();
    });
  }
  // 启动即预载全部词本，读出各本真实词数（动态「名称(N词)」），加载完成后自动刷新下拉框/历史标题
  REGISTRY.forEach(function (r) { loadBook(r.id, function () {}); });
  showView("home");
  console.log("[vocab] books:", REGISTRY.length, "current:", curBook());
})();
