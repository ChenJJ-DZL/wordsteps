/* =========================================================
   WordSteps 阶梯背单词 —— 多词库 / 真实音频 / 艾宾浩斯复习 / 自动发音 / 整本预缓存
   ========================================================= */
(function () {
  "use strict";

  var REGISTRY = window.BOOK_REGISTRY || [];
  var BOOK_COUNTS = {};   // 各单词本真实词数：加载后由 window.BOOK_<id>.words.length 动态写入
  var BOOKS_DATA = {};                 // id -> book object (lazy loaded)
  var STORE_KEY = "vocab_app_v2";
  var DAY = 86400000;
  var APP_VER = "20260727c";           // 版本号：强制刷新缓存（遗忘曲线深度融入SRS + 间隔增长基于实际遗忘率动态调整）
  var EN_DEFS = window.BOOK_EN_DEFS || {};   // 构建期生成的离线英文释义包（en + 发音 URL），键=归一化小写词
  function normJs(w) { return (w || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }  // 与 rebuild_v3.py 的 norm 对齐
  // 间隔基准值（用于新词初始间隔 & 旧数据迁移），实际复习间隔由自适应算法动态调整
  var T_10MIN = 10 * 60 * 1000, T_4H = 4 * 3600 * 1000, T_1D = 1 * DAY;
  var EB = [T_10MIN, T_1D, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];

  /* ---------- 状态 / 版本化迁移 ---------- */
  var SCHEMA_VER = 3;   // schema 版本：v3=遗忘率追踪+自适应间隔（接入实际遗忘数据调整间隔倍增系数）
  function defaultSkeleton() {
    return {
      schemaVer: SCHEMA_VER,
      settings: { accent: "us", book: (REGISTRY[0] && REGISTRY[0].id) || "ogden", incremental: false, bookSort: {}, dailyNewLimit: 0 },
      streak: { lastDate: "", count: 0 }, sessions: [], cache: {}, books: {},
      forgetStats: {}   // key=间隔毫秒, value={total,forgotten}  每个间隔段的实际遗忘率追踪
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
  var MIGRATIONS = { 0: migrate_0_to_1, 2: function(r) { r.forgetStats = r.forgetStats || {}; return r; } };
  function loadState() {
    var def = defaultSkeleton();
    try {
      var r = localStorage.getItem(STORE_KEY);
      if (!r) return def;
      var raw = JSON.parse(r);
      var curVer = raw.schemaVer || 0;
      // 升级前先备份一份，防迁移失败可回滚（仅保留最近 3 份，避免无限增长）
      if (curVer < SCHEMA_VER) { try { localStorage.setItem(STORE_KEY + "_bak_" + Date.now(), r); pruneBackups(); } catch (e) {} }
      while (curVer < SCHEMA_VER) {
        var fn = MIGRATIONS[curVer];
        if (!fn) break;                       // 没有对应迁移函数则停止，避免死循环
        raw = fn(raw) || raw;
        curVer++;
      }
      return deepMergeSkeleton(def, raw);
    } catch (e) {
      console.warn("loadState 迁移失败，使用默认骨架：", e);
      return def;
    }
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
  function saveState() { state.schemaVer = SCHEMA_VER; try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
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
  // 词根序：按 root 聚类 + 轮转交错，保证同根词分散到不同位置（避免密集聚类的前摄干扰）；
  // 无 root 的词（'_'+词）各自成组，同样参与交错。字母/词频序分别按词形与词频(collins 星级)排序。
  function sortWords(words, mode) {
    if (mode === "freq") {
      return words.slice().sort(function (a, b) {
        var fa = (a.freq != null ? a.freq : -1), fb = (b.freq != null ? b.freq : -1);
        if (fb !== fa) return fb - fa;               // collins 星级高（更常用）在前
        return (a.w || "").localeCompare(b.w || "");
      });
    }
    if (mode === "alpha") {
      return words.slice().sort(function (a, b) { return (a.w || "").localeCompare(b.w || ""); });
    }
    var g = {}, i, k;
    words.forEach(function (w) {
      var key = w.root || ("_" + (w.w || ""));
      (g[key] = g[key] || []).push(w);
    });
    var ks = Object.keys(g).sort(function (a, b) { return g[b].length - g[a].length; });
    var out = [], idx = 0, any = true;
    while (any) {
      any = false;
      for (i = 0; i < ks.length; i++) {
        var arr = g[ks[i]];
        if (arr.length > idx) { out.push(arr[idx]); any = true; }
      }
      idx++;
    }
    return out;
  }

  /* ---------- 时间工具 ---------- */
  function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfDay(ts) { return startOfDay(ts) + DAY - 1; }
  function dayStr(ts) { var d = new Date(ts); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  /* ---------- 进度记录（按词库） ---------- */
  // 遗忘率追踪：间隔段分桶（对数尺度），用于统计 + 调度修正
  var FORGET_BRACKETS = [T_10MIN, T_4H, T_1D, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
  function closestBracket(iv) {
    for (var i = 0; i < FORGET_BRACKETS.length; i++) { if (iv <= FORGET_BRACKETS[i] * 1.4) return FORGET_BRACKETS[i]; }
    return FORGET_BRACKETS[FORGET_BRACKETS.length - 1];
  }
  function getForgetRate(iv) {
    var b = closestBracket(iv);
    var s = state.forgetStats[b];
    if (!s || s.total < 3) return null;   // 数据不足，不做调整
    return s.forgotten / s.total;
  }
  function recordForget(iv) {
    var b = closestBracket(iv);
    if (!state.forgetStats[b]) state.forgetStats[b] = { total: 0, forgotten: 0 };
    state.forgetStats[b].total++;
    state.forgetStats[b].forgotten++;
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
      recordForget(r.interval);              // 追踪：在这个间隔段上真正遗忘了
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
    // 按 overdue 程度 + lapses 加权排序：越 overdue、越易忘的词越优先
    out.sort(function (a, b) {
      var ra = rs[a.w], rb = rs[b.w];
      var ia = Math.max(ra.interval || T_1D, T_1D), ib = Math.max(rb.interval || T_1D, T_1D);
      var oa = (now - ra.nextReview) / ia, ob = (now - rb.nextReview) / ib;
      oa *= 1 + (ra.lapses || 0) * 0.2; ob *= 1 + (rb.lapses || 0) * 0.2;
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
      state.cache[word] = c; cb(c); return;
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

  /* ---------- 发音（真实音频优先，TTS 兜底） ---------- */
  var player = document.getElementById("player");
  function playAudio(word) {
    var c = state.cache[word];
    var url = c ? (state.settings.accent === "uk" ? c.audio_uk : c.audio_us) : "";
    if (url) { try { player.src = url; player.play().catch(function () {}); return; } catch (e) {} }
    speak(word);
  }
  function speak(word) {
    if (!("speechSynthesis" in window) || !word) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = state.settings.accent === "uk" ? "en-GB" : "en-US"; u.rate = 0.92;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // 浏览器自动播放策略：首次用户手势后整页可自动播放。这里在首次交互时预热一次。
  var audioPrimed = false;
  function primeAudio() {
    if (audioPrimed) return; audioPrimed = true;
    try { window.speechSynthesis.getVoices(); } catch (e) {}
  }
  document.addEventListener("pointerdown", primeAudio, { once: true });

  /* ---------- 单词卡 ---------- */
  var tpl = document.getElementById("card-tpl");
  function buildCard(bw) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    node._word = bw.w;
    var ipa = bw.ipa_uk || bw.ipa_us || "";
    node.querySelector(".word").textContent = bw.w;
    node.querySelector(".ipa").textContent = ipa;
    var rootBadge = node.querySelector(".root-badge");
    if (rootBadge) {
      if (bw.root) { rootBadge.style.display = "inline-block"; rootBadge.textContent = "族：-" + bw.root + "-"; }
      else { rootBadge.style.display = "none"; }
    }
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
  // 渲染卡片时：确保富化 -> 填充背面 -> 自动朗读（满足「展示时 / 翻页时自动播放」）
  function prepareCard(bw, node) {
    node._enriched = true;
    enrich(bw.w, function () { fillBack(node, bw); playAudio(bw.w); }, true);
  }
  function fillBack(node, bw) {
    var word = node._word, c = state.cache[word];
    var en = (c && c.en) ? c.en : (c && c.loaded ? (c.error ? "（离线，暂无英文释义）" : "") : "加载中…");
    // 例句：所有词库均用「真题例句(kajweb) + 公版读物例句」填充（见 tools/build_examples_v2.py），
    // 优先 bw.ex(英文) + bw.exz(中文译文)；真题例句自带校对中文，公版例句经 gtx 翻译。
    // 两者皆无时 bw.ex 缺失，回退 dictionaryapi.dev 英文例句 c.ex（仅英文）。
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
  }
  function mkChip(s) {
    var c = document.createElement("span"); c.className = "chip"; c.textContent = s;
    c.addEventListener("click", function (e) { e.stopPropagation(); playAudio(s); });
    return c;
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

  /* ---------- 遗忘曲线进度（基于实际遗忘率追踪数据） ---------- */
  function forgetCurveData() {
    var brackets = [T_4H, T_1D, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
    var labelDays = [0, 1, 2, 4, 7, 15, 30, 60, 120];  // X轴标签（天）
    var pts = brackets.map(function (b) {
      var s = state.forgetStats[b] || { total: 0, forgotten: 0 };
      return s.total >= 3 ? s.forgotten / s.total : null;
    });
    // 计算总学习量（用于显示"记忆保持率"）
    var totalLearned = 0, totalForgotten = 0;
    for (var b in state.forgetStats) {
      totalLearned += state.forgetStats[b].total;
      totalForgotten += state.forgetStats[b].forgotten;
    }
    var retentionRate = totalLearned > 0 ? Math.round((1 - totalForgotten / totalLearned) * 100) : 100;
    return { xs: labelDays, pts: pts, total: totalLearned, retention: retentionRate };
  }
  function drawForgetCurve() {
    var cv = document.getElementById("fc-canvas");
    if (!cv) return;
    var d = forgetCurveData();
    var el30 = document.getElementById("fc-30");
    if (el30) el30.textContent = d.retention + "%";
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var cssW = cv.clientWidth || 200, cssH = cv.clientHeight || 128;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var padL = 12, padR = 12, padT = 8, padB = 16;
    var plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    function X(i) { return padL + plotW * d.xs[i] / 120; }
    function Y(v) { return padT + plotH * (1 - v); }  // v=遗忘率, 0=顶部(100%记忆), 1=底部(0%)
    // 横向网格
    ctx.strokeStyle = "rgba(31,39,51,0.06)"; ctx.lineWidth = 1;
    for (var g = 0; g <= 2; g++) { var gy = padT + plotH * g / 2; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy); ctx.stroke(); }
    // 绘制实际遗忘率
    var validPts = [];
    for (var i = 0; i < d.pts.length; i++) {
      if (d.pts[i] !== null) validPts.push(i);
    }
    if (validPts.length > 0) {
      // 曲线渐变填充（记忆保持率 = 1 - 遗忘率）
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
        ctx.fillStyle = d.pts[i] > 0.3 ? "#e25555" : "#4f6ef7";  // 高遗忘率点标红
        ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      });
    } else {
      ctx.fillStyle = "rgba(154,165,180,0.9)"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("学习 + 复习后显示遗忘曲线", padL + plotW / 2, padT + plotH / 2);
    }
    // X 轴天数标签
    ctx.fillStyle = "rgba(154,165,180,0.95)"; ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    var showLabels = [0, 2, 7, 15, 30, 60, 120];
    showLabels.forEach(function (day) {
      var idx = d.xs.indexOf(day);
      if (idx >= 0) ctx.fillText(day === 0 ? "今天" : day + "天后", X(idx), padT + plotH + 12);
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
    loadBook(id, function () { learnQueue = newWords(id, limit); learnIdx = 0; learnRated = 0; startSession(); renderLearn(); });
  }
  function renderLearn() {
    var id = curBook();
    var stage = document.getElementById("learn-stage"); stage.innerHTML = "";
    document.getElementById("learn-counter").textContent = (learnQueue.length ? learnRated + 1 : 0) + " / " + learnQueue.length;
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
    scheduleReview(curBook(), bw.w, rating);
    if (curSession) { curSession.newCount++; curSession[rating]++; }
    learnRated++; learnIdx++; renderLearn();
  });

  /* ---------- 复习 ---------- */
  var reviewQueue = [], reviewIdx = 0, reviewRated = 0;
  function startReview() {
    var id = curBook();
    loadBook(id, function () { reviewQueue = dueWords(id); reviewIdx = 0; reviewRated = 0; startSession(); renderReview(); });
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

  /* ---------- 学习会话 ---------- */
  var curSession = null;
  function bumpStreak() {
    var today = dayStr(Date.now()); if (state.streak.lastDate === today) return;
    var y = dayStr(Date.now() - DAY);
    state.streak.count = state.streak.lastDate === y ? state.streak.count + 1 : 1;
    state.streak.lastDate = today; saveState();
  }
  function startSession() { bumpStreak(); curSession = { start: Date.now(), newCount: 0, reviewCount: 0, know: 0, fuzzy: 0, unknown: 0, book: curBook() }; }
  function endSession() {
    if (!curSession) return;
    var dur = Date.now() - curSession.start;
    if (curSession.newCount || curSession.reviewCount) {
      state.sessions.unshift({ ts: Date.now(), date: dayStr(Date.now()), book: curSession.book, durMs: dur, newCount: curSession.newCount, reviewCount: curSession.reviewCount, know: curSession.know, fuzzy: curSession.fuzzy, unknown: curSession.unknown });
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
  homeSel.addEventListener("change", function () { state.settings.book = homeSel.value; saveState(); learnSel.value = curBook(); renderHome(); });
  learnSel.addEventListener("change", function () { state.settings.book = learnSel.value; saveState(); homeSel.value = curBook(); showView("learn"); });

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
  fillBookSelect(homeSel); fillBookSelect(learnSel);
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
