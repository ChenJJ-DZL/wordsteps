# -*- coding: utf-8 -*-
"""
rebuild_v3.py —— 按真实权威/教材词表多源并集重建各考试词本，并补全音标与中文。
设计要点：
- 高考: pluto0x0/word3500（严格 3500 大纲，自带音标）
- 四级/六级: exam-data/CETVocabulary（2016 四六级大纲，非★=四级 4025，全量=六级 5278）
- 考研: exam-data/NETEMVocabulary（2024 考研大纲 5530）
- 初中/托福: KyleBing 乱序 txt（保留）
- 雅思: jimuyouyou/all-ielts-words(剑桥真题~9000+) ∪ fanhongtao 新东方雅思(带音标) ∪ kajweb IELTS(带例句)
- SAT: kajweb SAT(新东方+有道) ∪ bedsDev word8000(通用学术 8000) → 力争 10000+
- 音标+中文: ECDICT(skywind3000, ~30万词) 流式构建 needed 映射兜底
- 例句: 复用 .bak(v2 富化) 与 kajweb(雅思/SAT) 真题例句，按归一化词形匹配
"""
import os, re, json, csv, urllib.request, urllib.parse, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOKS_DIR = os.path.join(ROOT, "books")
TEMP = os.path.join(os.environ.get("TEMP", "/tmp"), "vocab_corpus")
os.makedirs(TEMP, exist_ok=True)

def log(m): print(m, flush=True)

def get(url, binary=False, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = urllib.request.urlopen(req, timeout=timeout).read()
    return data if binary else data.decode("utf-8", "ignore")

def cache(name, url, binary=False, timeout=300):
    p = os.path.join(TEMP, name)
    if not os.path.exists(p):
        log("  下载 %s ..." % name)
        data = get(url, binary=binary, timeout=timeout)
        open(p, "wb").write(data if binary else data.encode("utf-8"))
    return p

def norm(w):
    w = (w or "").strip().lower()
    w = re.sub(r"\([^)]*\)", "", w)          # 去掉 (an) 等
    w = re.sub(r"[^a-z0-9'\-]", "", w)        # 仅保留字母数字连字符省文撇
    return w

def norm_case(w):
    """保留大小写的去重键：仅去掉末尾括号里的屈折说明(如 blow (blew, blown) -> blow)，
    去空格等非字母数字但保留大小写。用于高考等需区分 march/March、miss/Miss. 异义词的词本；
    不取首词，故 look after 等短语词不会被误并。"""
    w = (w or "").strip()
    w = re.sub(r"\s*\([^)]*\)\s*$", "", w)   # 仅去除末尾括号里的屈折说明，取基础词
    w = re.sub(r"[^A-Za-z0-9'\-]", "", w)    # 去空格等非字母数字，保留大小写
    return w

# ---------------- 词根聚类（词根词缀法：构建期给每个词打 root 标签） ----------------
# ROOT_LIST：常见拉丁/希腊词根串；匹配时取「最长命中」，先尝试剥前缀再匹配以降低误判。
# 仅用于单本内「词根序」的聚类 + 跨天交错（避免同根词密集成块导致前摄干扰），不参与其他逻辑。
ROOT_LIST = [
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
    "tort","tract","trib","trop","tru","turb","typ","uni","urb","us","ut","vac","van","val","vari",
    "ven","vent","ver","verb","vers","vert","viv","vic","vict","vid","vis","voc","vok","vol","volv",
    "vor","vuln","zo",
]
# 常见前缀：匹配前先剥掉，避免前缀干扰词根识别（如 respect -> 剥 re -> spect）
PREFIXES = ["counter","retro","ultra","circum","hetero","hypo","macro","micro","mono","multi",
    "photo","proto","super","trans","tri","anti","auto","bi","co","de","dis","en","ex","fore","in",
    "inter","mid","mis","non","out","over","peri","post","pre","pro","re","semi","sub","tele","un",
    "under","up","with","ab","ad","com","con","contra","equi","extra","hyper","intro","para","syn",
    "sym","di","hemi","holo","iso","meta","neo","pan","poly","pseudo","supra","vice","ante","apo",
    "cata","dys","ecto","endo","eu","ortho","geo","bio"]
PREFIXES.sort(key=len, reverse=True)

def root_of(w):
    """返回词根串（最长命中），无则 ''。仅用于单本内「词根序」聚类+交错。"""
    w = norm(w)
    if not w: return ""
    cands = [w]
    for p in PREFIXES:
        if w.startswith(p) and len(w) > len(p) + 1:
            cands.append(w[len(p):])
    best = ""
    for c in cands:
        for r in ROOT_LIST:
            if r in c and len(r) > len(best):
                best = r
    return best

# ---------------- 各源加载器 ----------------
def load_pluto3500():
    """以音标行([...])为锚点解析，容忍文件缺行/多行导致的 3 行对齐错位；严格掐前 3500 条=官方大纲。"""
    p = cache("pluto3500.txt", "https://raw.githubusercontent.com/pluto0x0/word3500/master/3500.txt")
    lines = [l.rstrip('\n') for l in open(p, encoding="utf-8")]
    ipa_re = re.compile(r'^\[[^\]]+\]$')
    POS = re.compile(r'^(n|v|adj|a|ad|prep|conj|pron|num|int|abbr|art|adv|det|interj|aux|sb|sth|pl|esp|usr)\.')
    out = []
    N = len(lines)
    for i in range(N):
        if ipa_re.match(lines[i].strip()):
            w = lines[i-1].strip() if i-1 >= 0 else ''
            zh = lines[i+1].strip() if i+1 < N else ''
            ipa = lines[i].strip().strip('[]').strip()
            # 词位必须含字母且不像释义(不以词性标记+句点开头)，避免错位把释义当词
            if re.search(r'[A-Za-z]', w) and not POS.match(w):
                out.append({"w": w, "ipa": ipa, "zh": zh})
    # 严格掐到 3500 大纲：官方 3500 排在前(A→T 段)，其后追加了 T–Z 扩展词，仅取前 3500
    return out[:3500]

def load_cet():
    p = cache("cet_full_list.json", "https://raw.githubusercontent.com/exam-data/CETVocabulary/master/cet_full_list.json")
    d = json.loads(open(p, encoding="utf-8").read())
    arr = d.get("四六级词汇词频排序表", [])
    c4, c6 = [], []
    for x in arr:
        w = (x.get("单词") or "").strip()
        if not w: continue
        zh = (x.get("释义") or "").strip()
        ent = {"w": w, "ipa": "", "zh": zh}
        if x.get("六级") in (None, "", 0, "0", "null") or str(x.get("六级","")) in ("","null"):
            c4.append(ent)
        c6.append(ent)   # 六级 = 全量（含四级）
    return c4, c6

def load_netem():
    p = cache("netem_full_list.json", "https://raw.githubusercontent.com/exam-data/NETEMVocabulary/master/netem_full_list.json")
    d = json.loads(open(p, encoding="utf-8").read())
    arr = d.get("5530考研词汇词频排序表", [])
    out = []
    for x in arr:
        w = (x.get("单词") or "").strip()
        if not w: continue
        out.append({"w": w, "ipa": "", "zh": (x.get("释义") or "").strip()})
    return out

KYLE = {
    "初中-乱序.txt": "1 初中-乱序.txt", "高中-乱序.txt": "2 高中-乱序.txt",
    "四级-乱序.txt": "3 四级-乱序.txt", "六级-乱序.txt": "4 六级-乱序.txt",
    "考研-乱序.txt": "5 考研-乱序.txt", "托福-乱序.txt": "6 托福-乱序.txt",
    "SAT-乱序.txt": "7 SAT-乱序.txt",
}
def load_kylebing(fname):
    exact = KYLE.get(fname, fname)
    p = cache(exact.replace(" ", "_"), "https://raw.githubusercontent.com/KyleBing/english-vocabulary/master/%s" % urllib.parse.quote(exact))
    out = []
    for l in open(p, encoding="utf-8", errors="ignore"):
        l = l.rstrip()
        if not l.strip(): continue
        parts = l.split("\t")
        w = parts[0].strip()
        if not w: continue
        zh = parts[1].strip() if len(parts) >= 2 else ""
        out.append({"w": w, "ipa": "", "zh": zh})
    return out

def _parse_kajweb_zip(p):
    """解析 kajweb 单词书 zip（单个 .json，每行一条记录）。
    抽取：headWord、usphone/ukphone(音标)、trans(中文释义)、sentence(例句)。
    失败抛异常，由调用方重试/降级。"""
    zf = zipfile.ZipFile(p)
    name = zf.namelist()[0]
    text = zf.read(name).decode("utf-8", "ignore")
    out = []
    exmap = {}
    for l in text.splitlines():
        l = l.strip()
        if not l: continue
        try: o = json.loads(l)
        except Exception: continue
        hw = (o.get("headWord") or "").strip()
        if not hw: continue
        c = o.get("content", {}).get("word", {}).get("content", {})
        # 音标：美音优先，回退英音/通用
        us = (c.get("usphone") or "").strip()
        uk = (c.get("ukphone") or "").strip()
        ph = (c.get("phone") or "").strip()
        ipa_us = us or ph
        ipa_uk = uk or ph
        ipa = ipa_us or ipa_uk
        # 中文释义：trans 列表 pos + tranCn 拼接（如 "adj. 可感觉的；明智的; n. 记号；标志"）
        zh = ""
        trans = c.get("trans") or []
        if isinstance(trans, list):
            parts = []
            for t in trans:
                if not isinstance(t, dict): continue
                pos = (t.get("pos") or "").strip()
                cn = (t.get("tranCn") or "").strip()
                if cn:
                    parts.append((pos + ". " + cn) if pos else cn)
            zh = "; ".join(parts)
        # 例句：取第一条例句（英文+中文译文）
        sents = c.get("sentence", {}).get("sentences", []) or []
        pairs = [(s.get("sContent",""), s.get("sCn","")) for s in sents if s.get("sContent")]
        ex = exz = ""
        if pairs:
            ex, exz = pairs[0]
            ex = re.sub(r"\s+", " ", ex or "").strip()
            exz = re.sub(r"\s+", " ", exz or "").strip()
        out.append({"w": hw, "ipa": ipa, "ipa_us": ipa_us, "ipa_uk": ipa_uk, "zh": zh, "ex": ex, "exz": exz})
        if ex:
            exmap[norm(hw)] = (ex, exz)
    return out, exmap

def load_kajweb_zip(zip_name, cache_name):
    """优先用本地已验证完整副本（TEMP/kajweb/），避免 GitHub raw 截断；缺失/损坏时带重试下载。
    全部失败则降级返回空，不抛异常。"""
    local_p = os.path.join(TEMP, "kajweb", zip_name)
    if os.path.exists(local_p):
        try:
            return _parse_kajweb_zip(local_p)
        except Exception as e:
            log("  本地 %s 解析失败，转下载: %s" % (zip_name, e))
    # 下载 + 重试（GitHub raw 对大二进制偶发截断）
    p = None
    for attempt in range(3):
        try:
            p = cache(cache_name, "https://raw.githubusercontent.com/kajweb/dict/master/book/%s" % urllib.parse.quote(zip_name), binary=True)
            return _parse_kajweb_zip(p)
        except Exception as e:
            log("  下载 %s 第%d次失败: %s" % (zip_name, attempt+1, e))
            if p and os.path.exists(p):
                try: os.remove(p)
                except Exception: pass
    log("  !! %s 无法加载，降级为空（仅损失该源词/例句）" % zip_name)
    return [], {}

def load_fanhongtao_ielts():
    p = cache("fanhongtao_ielts.txt", "https://raw.githubusercontent.com/fanhongtao/IELTS/master/IELTS%20Word%20List.txt")
    out = []
    pat = re.compile(r"^([a-zA-Z][a-zA-Z'\-]*)\s*\*?\s*(/[^/]+/|\[[^\]]+\]|\{[^}]+\})?\s*([a-z]+\.?)")
    for l in open(p, encoding="utf-8", errors="ignore"):
        l = l.rstrip()
        m = pat.match(l)
        if not m: continue
        w = m.group(1).strip()
        ipa = (m.group(2) or "").strip().strip("/[]{}").strip()
        out.append({"w": w, "ipa": ipa, "zh": ""})
    return out

def load_jimuyouyou_ielts():
    p = cache("jimuyouyou_allwords.txt", "https://raw.githubusercontent.com/jimuyouyou/all-ielts-words/master/allWords.txt")
    out = []
    for l in open(p, encoding="utf-8", errors="ignore"):
        w = l.strip()
        if re.match(r"^[a-zA-Z][a-zA-Z'\-]*$", w):
            out.append({"w": w, "ipa": "", "zh": ""})
    return out

def load_bedsdev8000():
    p = cache("bedsdev_word8000.csv", "https://raw.githubusercontent.com/bedsDev/english-wordlists/master/word8000-sorted.csv")
    out = []
    for l in open(p, encoding="utf-8", errors="ignore"):
        l = l.strip()
        if not l: continue
        w = l.split(",")[0].strip().strip('"')
        if re.match(r"^[a-zA-Z][a-zA-Z'\-]*$", w):
            out.append({"w": w, "ipa": "", "zh": ""})
    return out

# ---------------- 例句/近反义 复用（来自 .bak + kajweb） ----------------
def load_example_map():
    ex_map = {}
    # 1) .bak（v2 富化，KyleBing 原词形）
    for fn in os.listdir(BOOKS_DIR):
        if not fn.endswith(".bak"): continue
        bid = fn[:-4].replace(".js", "")
        if bid == "ogden": continue
        s = open(os.path.join(BOOKS_DIR, fn), encoding="utf-8").read()
        m = re.match(r"^\s*window\.BOOK_\w+\s*=\s*(.*?);?\s*$", s, re.S)
        if not m: continue
        body = m.group(1).rstrip()
        if body.endswith(";"): body = body[:-1]
        try: obj = json.loads(body)
        except Exception: continue
        for w in obj.get("words", []):
            k = norm(w.get("w"))
            if not k: continue
            ex, exz = w.get("ex", ""), w.get("exz", "")
            syn, ant = w.get("syn", ""), w.get("ant", "")
            prev = ex_map.get(k)
            if prev is None or (not prev[0] and ex):
                ex_map[k] = (ex, exz, syn, ant)
    # 2) kajweb 雅思/SAT/托福（考试真题例句，优先级更高）
    for zip_name, cn in [("1521164624473_IELTSluan_2.zip", "kajweb_ielts_youdao.zip"),
                         ("1521164670910_SAT_2.zip", "kajweb_sat_youdao.zip"),
                         ("1521164636496_SAT_3.zip", "kajweb_sat3.zip"),
                         ("1521164640451_TOEFL_2.zip", "kajweb_toefl_youdao.zip")]:
        try:
            _, em = load_kajweb_zip(zip_name, cn)
            for k, (ex, exz) in em.items():
                if ex:
                    prev = ex_map.get(k)
                    if prev is None or not prev[0]:
                        ex_map[k] = (ex, exz, prev[2] if prev else "", prev[3] if prev else "")
        except Exception as e:
            log("  kajweb 例句加载失败 %s: %s" % (zip_name, e))
    return ex_map

# ---------------- ECDICT 兜底音标+中文+词频 ----------------
def build_ecdict_map(needed):
    p = cache("ecdict.csv", "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv", binary=True)
    mp = {}
    with open(p, encoding="utf-8", errors="ignore") as f:
        r = csv.reader(f)
        for row in r:
            if len(row) < 4: continue
            w = row[0].strip().lower()
            if w in needed:
                ph = row[1].strip().strip("/[]").strip() if len(row) > 1 else ""
                tr = row[3].strip() if len(row) > 3 else ""
                collins = 0
                if len(row) > 5:
                    try: collins = int(row[5].strip())
                    except Exception: collins = 0
                mp[w] = (ph, tr, collins)
    return mp

# ---------------- 并集 ----------------
def union(sources, keyfunc=norm):
    d = {}
    for ent in sources:
        for e in ent:
            k = keyfunc(e.get("w"))
            if not k: continue
            if k not in d:
                d[k] = {"w": e.get("w"), "ipa": e.get("ipa", ""), "ipa_us": e.get("ipa_us", ""),
                        "ipa_uk": e.get("ipa_uk", ""), "zh": e.get("zh", ""),
                        "ex": e.get("ex", ""), "exz": e.get("exz", "")}
            else:
                cur = d[k]
                for fld in ("ipa", "ipa_us", "ipa_uk", "zh", "ex", "exz"):
                    if not cur[fld] and e.get(fld): cur[fld] = e[fld]
    return d

def main():
    log("== 1) 加载权威词集 ==")
    c4, c6 = load_cet()
    auth = {
        "chuzhong": [load_kylebing("初中-乱序.txt")],
        "gaozhong": [load_pluto3500()],
        "cet4":     [c4],
        "cet6":     [c6],
        "kaoyan":   [load_netem()],
        # 出国考试（无官方大纲）：严格采用 vocab-repo/dict 标注「有道」版本
        "ielts":    [load_kajweb_zip("1521164624473_IELTSluan_2.zip", "kajweb_ielts_youdao.zip")[0]],   # 有道雅思 3427
        "toefl":    [load_kajweb_zip("1521164640451_TOEFL_2.zip", "kajweb_toefl_youdao.zip")[0]],        # 有道托福 9213
        "sat":      [load_kajweb_zip("1521164670910_SAT_2.zip", "kajweb_sat_youdao.zip")[0]],            # 有道SAT 4423
    }
    for k, v in auth.items():
        n = sum(len(s) for s in v)
        log("  %-10s 源词条合计=%d" % (k, n))

    log("== 2) 并集 + 收集 needed ==")
    unions = {}
    needed = set()
    for bid, srcs in auth.items():
        kf = norm_case if bid == "gaozhong" else norm
        u = union(srcs, kf)
        unions[bid] = u
        needed.update(u.keys())
    log("  needed 词数(去重后各本并集键): %d" % len(needed))

    log("== 3) ECDICT 兜底音标+中文+词频 ==")
    ecd = build_ecdict_map({k.lower() for k in needed})
    log("  ECDICT 命中 needed: %d / %d" % (len(ecd), len(needed)))

    log("== 4) 例句/近反义 复用 ==")
    ex_map = load_example_map()
    log("  可复用例句词条: %d" % len(ex_map))

    log("== 5) 写出各本 ==")
    for bid, u in unions.items():
        words = []
        n_ipa = n_zh = n_ex = 0
        for k, e in u.items():
            w = e["w"].strip()
            if not w: continue
            ecd_ph, ecd_tr, ecd_col = ecd.get(k.lower(), ("", "", 0))
            ipa = e.get("ipa") or ecd_ph
            ipa_us = e.get("ipa_us") or ecd_ph
            ipa_uk = e.get("ipa_uk") or ecd_ph
            zh = e.get("zh") or ecd_tr
            ex, exz, syn, ant = ex_map.get(k.lower(), ("", "", "", ""))
            fam = root_of(w)
            o = {"w": w}
            if fam: o["root"] = fam
            if ecd_col: o["freq"] = ecd_col
            if zh: o["zh"] = zh
            if ipa: o["ipa"] = ipa
            if ipa_us: o["ipa_us"] = ipa_us
            if ipa_uk: o["ipa_uk"] = ipa_uk
            if ex: o["ex"] = ex; n_ex += 1
            if exz: o["exz"] = exz
            if syn: o["syn"] = syn
            if ant: o["ant"] = ant
            if zh: n_zh += 1
            if ipa: n_ipa += 1
            words.append(o)
        # 保持原词大小写：用源里首次出现的原始词形
        obj = {"id": bid, "words": words}
        open(os.path.join(BOOKS_DIR, bid + ".js"), "w", encoding="utf-8").write(
            "window.BOOK_%s = %s;" % (bid, json.dumps(obj, ensure_ascii=False)))
        log("  %-10s -> %d 词 | 有中文=%d 有音标=%d 有例句=%d" % (bid, len(words), n_zh, n_ipa, n_ex))

    log("== 6) 构建离线英文释义包 books/en_defs.js（断点续传，随版本增量更新）==")
    en_words = set()
    for u in unions.values():
        for k, e in u.items():
            w = norm(e["w"])              # 统一用小写 alnum 键，与前端 normJs 对齐
            if w: en_words.add(w)
    if os.environ.get("SKIP_EN_DEFS"):
        log("  (SKIP_EN_DEFS 已设置，跳过在线英文释义包重建；仅词书字段已更新)")
    else:
        build_en_defs(en_words)
    log("DONE")


def fetch_dict(w):
    """请求 dictionaryapi.dev，返回 (status, text)。区分 404(词库无) / 429(限流) / 其他。"""
    url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + urllib.parse.quote(w)
    req = urllib.request.Request(url, headers={"User-Agent": "ogden-vocab-build/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8", "ignore")
        except Exception: body = ""
        return e.code, body
    except Exception:
        return 0, ""


def parse_entry(d):
    """从 dictionaryapi.dev 响应抽取首个英文释义 + 英美发音 URL（对齐 app.js parseDict）。"""
    en, au_uk, au_us = "", "", ""
    if isinstance(d, list) and d:
        e = d[0]
        for p in (e.get("phonetics") or []):
            au = p.get("audio") or ""
            if au:
                if re.search(r"uk|au|gb", au, re.I) and not au_uk: au_uk = au
                elif re.search(r"us", au, re.I) and not au_us: au_us = au
                elif not au_us: au_us = au
        if not au_uk: au_uk = au_us
        if not au_us: au_us = au_uk
        for m in (e.get("meanings") or []):
            for df in (m.get("definitions") or []):
                if not en and df.get("definition"): en = df["definition"]
                break
            if en: break
    if len(en) > 240: en = en[:240] + "…"
    return en, au_uk, au_us


def write_en_defs(cache):
    """把已抓取条目写出为 books/en_defs.js（增量；dict 值均为 dict）。"""
    out = {w: v for w, v in cache.items() if isinstance(v, dict)}
    path = os.path.join(BOOKS_DIR, "en_defs.js")
    open(path, "w", encoding="utf-8").write(
        "window.BOOK_EN_DEFS = %s;" % json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return len(out)


def build_en_defs(words, max_new=20000):
    """把在线英文释义抓成离线包 books/en_defs.js。
    - 持久缓存 tools/en_defs_cache.json：word -> {en,audio_uk,audio_us}
    - 每次只补抓缺失词（断点续传）；纯串行 ~0.2s/请求避免 429，遇 429 退避 30s 重试，404 标记空不再重抓
    - 每 200 词即落盘缓存并写出 en_defs.js（边抓边用，不必等全量）；包随重建版本自然「增量更新」"""
    import time
    cache_path = os.path.join(ROOT, "tools", "en_defs_cache.json")
    cache = {}
    if os.path.exists(cache_path):
        try: cache = json.load(open(cache_path, encoding="utf-8"))
        except Exception: cache = {}
    todo = sorted(w for w in words if w not in cache)
    total = len(words)
    log("  缓存已含=%d / 目标=%d | 本轮最多补抓=%d" % (len(cache), total, min(max_new, len(todo))))
    done = 0
    for w in todo:
        if done >= max_new:
            log("  达到本轮上限 %d，剩余 %d 词留待下次重建补齐" % (max_new, len(todo) - done))
            break
        st, body = fetch_dict(w)
        if st == 200:
            try:
                en, uk, us = parse_entry(json.loads(body))
                cache[w] = {"en": en, "audio_uk": uk, "audio_us": us}
            except Exception:
                cache[w] = {"en": "", "audio_uk": "", "audio_us": ""}
        elif st == 404:
            cache[w] = {"en": "", "audio_uk": "", "audio_us": ""}   # 词库无：标记后不再重抓
        elif st == 429:
            log("  触发限流(429)，退避 30s 后重试该词")
            time.sleep(30)
            continue                                            # 不计入 done，重试同一词
        else:
            log("  请求异常(st=%s)，跳过留待下次" % st)
            time.sleep(3)
            continue                                            # 不计入 done，下次重建重试
        done += 1
        time.sleep(0.2)
        if done % 200 == 0:
            json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
            n = write_en_defs(cache)
            n_with = sum(1 for v in cache.values() if isinstance(v, dict) and v.get("en"))
            log("  已补抓 %d 词（en_defs.js 现 %d 条，其中含释义 %d）" % (done, n, n_with))
    json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
    n = write_en_defs(cache)
    n_with = sum(1 for v in cache.values() if isinstance(v, dict) and v.get("en"))
    log("  写出 en_defs.js：共 %d 条（含释义 %d 条，无释义 %d 条）" % (n, n_with, n - n_with))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        log("FATAL: " + repr(e))
        traceback.print_exc()
        raise
