# -*- coding: utf-8 -*-
"""freq_builder.py —— 用 wordfreq 统一计算所有词库的 Collins 风格星级 (1-5)。"""
import sys, os, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOKS_DIR = os.path.join(ROOT, "books")

def zipf_to_stars(z):
    """wordfreq zipf → 5 级星级"""
    if z > 5.5:  return 5
    if z > 4.5:  return 4
    if z > 3.5:  return 3
    if z > 2.5:  return 2
    return 1

def inject_freq(words):
    """对 words 列表中每个词计算 freq，覆盖已有值。"""
    from wordfreq import zipf_frequency
    n = 0
    for ent in words:
        w = ent.get("w", "")
        if not w:
            continue
        z = zipf_frequency(w, "en")
        ent["freq"] = zipf_to_stars(z)
        n += 1
    return n

def rebuild_book(book_id):
    """重建单个词库的 freq 字段。"""
    js_path = os.path.join(BOOKS_DIR, book_id + ".js")
    if not os.path.exists(js_path):
        print(f"  {book_id}: 文件不存在，跳过")
        return
    with open(js_path, "r", encoding="utf-8") as f:
        code = f.read()
    m = re.search(r"window\.BOOK_\w+\s*=\s*(\{.*?\});?\s*$", code, re.DOTALL)
    if not m:
        print(f"  {book_id}: 无法解析 JSON")
        return
    obj = json.loads(m.group(1))
    words = obj.get("words", [])
    n = inject_freq(words)
    new_code = "window.BOOK_%s = %s;" % (book_id, json.dumps(obj, ensure_ascii=False))
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(new_code)
    print(f"  {book_id}: {n} 词 freq 已更新")

def main():
    books = ["ogden", "chuzhong", "gaozhong", "cet4", "cet6", "kaoyan", "ielts", "sat", "toefl"]
    print("freq_builder: wordfreq zipf → 5级星级 (全部覆盖)")
    for bid in books:
        rebuild_book(bid)
    print("DONE")

if __name__ == "__main__":
    main()
