"""断点续传补抓 en_defs：只抓缓存里缺失的词，写回 cache + books/en_defs.js。
复用 rebuild_v3 的 fetch_dict/parse_entry/write_en_defs。
"""
import os, re, glob, json, time
import rebuild_v3 as R

BOOKS_DIR = R.BOOKS_DIR
ROOT = R.ROOT

# 1) 重新收集全书库去重归一化词（与 build_en_defs 同源，结果应=14259）
def collect_en_words():
    words = set()
    for f in glob.glob(os.path.join(BOOKS_DIR, "*.js")):
        fn = os.path.basename(f)
        if fn in ("manifest.js", "en_defs.js"):
            continue
        s = open(f, encoding="utf-8").read()
        s2 = re.sub(r'^window\.BOOK_\w+\s*=\s*', '', s.strip()).strip().rstrip(';').strip()
        try:
            o = json.loads(s2)
        except Exception:
            continue
        arr = o.get("words", []) if isinstance(o, dict) else o
        for e in arr:
            w = e.get("w") if isinstance(e, dict) else e
            if w:
                words.add(R.norm(w))
    return words

def main():
    en_words = collect_en_words()
    cache_path = os.path.join(ROOT, "tools", "en_defs_cache.json")
    cache = {}
    if os.path.exists(cache_path):
        try: cache = json.load(open(cache_path, encoding="utf-8"))
        except Exception: cache = {}
    todo = sorted(w for w in en_words if w not in cache)
    print("目标=%d | 缓存=%d | 缺失=%d" % (len(en_words), len(cache), len(todo)))
    if not todo:
        print("已全部抓完，直接重写 en_defs.js")
        n = R.write_en_defs(cache)
        print("en_defs.js 条数=%d" % n)
        return
    done = 0
    for w in todo:
        st, body = R.fetch_dict(w)
        if st == 200:
            try:
                en, uk, us = R.parse_entry(json.loads(body))
                cache[w] = {"en": en, "audio_uk": uk, "audio_us": us}
            except Exception:
                cache[w] = {"en": "", "audio_uk": "", "audio_us": ""}
        elif st == 404:
            cache[w] = {"en": "", "audio_uk": "", "audio_us": ""}
        elif st == 429:
            print("  429 限流，退避 30s 重试 %s" % w)
            time.sleep(30)
            continue
        else:
            print("  异常 st=%s，跳过 %s" % (st, w))
            time.sleep(3)
            continue
        done += 1
        time.sleep(0.2)
        if done % 50 == 0:
            json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
            R.write_en_defs(cache)
            print("  已补 %d / %d" % (done, len(todo)))
    json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
    n = R.write_en_defs(cache)
    n_with = sum(1 for v in cache.values() if isinstance(v, dict) and v.get("en"))
    print("DONE 缓存=%d  en_defs.js=%d（含释义 %d）" % (len(cache), n, n_with))

if __name__ == "__main__":
    main()
