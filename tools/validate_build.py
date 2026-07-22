# -*- coding: utf-8 -*-
import os, re, json
ROOT = "C:/Users/chenj/WorkBuddy/2026-07-21-08-53-08/ogden-vocab"
BOOKS_DIR = os.path.join(ROOT, "books")
REGISTRY = ["ogden","chuzhong","gaozhong","cet4","cet6","kaoyan","ielts","sat","toefl"]
FULL = {"ogden","chuzhong"}

def load(id):
    p = os.path.join(BOOKS_DIR, id + ".js")
    s = open(p, encoding="utf-8").read()
    s = re.sub(r'^\s*window\.BOOK_\w+\s*=\s*', '', s).rstrip().rstrip(';')
    return json.loads(s)

def wkey(w): return re.sub(r'[^a-z0-9]', '', (w or '').lower())

books = {bid: load(bid) for bid in REGISTRY}
print("=== 各本词数 / 音标中文覆盖 ===")
for bid in REGISTRY:
    ws = books[bid]["words"]
    n = len(ws)
    has_us = sum(1 for w in ws if w.get("ipa_us"))
    has_uk = sum(1 for w in ws if w.get("ipa_uk"))
    has_zh = sum(1 for w in ws if w.get("zh"))
    has_ex = sum(1 for w in ws if w.get("ex"))
    print("  %-9s 词数=%-6d 有美音=%-6d(%.0f%%) 有英音=%-6d(%.0f%%) 有中文=%-6d(%.0f%%) 有例句=%-5d" % (
        bid, n, has_us, has_us/n*100, has_uk, has_uk/n*100, has_zh, has_zh/n*100, has_ex))

print("\n=== 增量差集链（归一化键差集，沿 REGISTRY 顺序）===")
union = set()
for bid in REGISTRY:
    ws = books[bid]["words"]
    keys = [wkey(w["w"]) for w in ws]
    if bid in FULL:
        diff = len(ws)
    else:
        diff = sum(1 for k in keys if k not in union)
    print("  %-9s 全量=%-6d  增量差集=%-6d" % (bid, len(ws), diff))
    union.update(keys)

print("\n=== 有道三本样例（检验 ipa_us/zh 字段）===")
for bid in ("ielts","sat","toefl"):
    for w in books[bid]["words"][:2]:
        print("  [%s] %s | us=%s uk=%s | zh=%s | ex=%s" % (
            bid, w.get("w"), w.get("ipa_us"), w.get("ipa_uk"),
            (w.get("zh") or "")[:40], (w.get("ex") or "")[:40]))
