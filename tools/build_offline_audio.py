"""批量生成离线音频 v3：有道下载 → ffmpeg stdin/stdout 压缩（32kbps mono）→ 直接写文件
无 tmp 文件、无删除操作，避免沙箱拦截"""
import http.client, json, os, re, subprocess, time, glob, sys, io
from concurrent.futures import ThreadPoolExecutor

import imageio_ffmpeg
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(BASE, 'books', 'audio')

RESERVED = {'con', 'prn', 'aux', 'nul'} | {f'com{i}' for i in range(1, 10)} | {f'lpt{i}' for i in range(1, 10)}

def safe_name(w):
    """文件名安全化：小写+字母数字保留，其余替换为 _；Windows 保留名加 _ 后缀"""
    s = re.sub(r'[^a-z0-9]', '_', w)
    if s in RESERVED:
        s += '_'
    return s

LIMIT = int(os.environ.get('LIMIT', '0'))  # 调试用：只处理前 N 个词

# ---------- 1. 收集全部唯一词 ----------
words = set()
for f in glob.glob(os.path.join(BASE, 'books', '*.js')):
    name = os.path.basename(f)
    if name in ('manifest.js', 'en_defs.js'):
        continue
    with open(f, encoding='utf-8') as fh:
        content = fh.read()
    m = re.search(r'= (\{.*\})', content, re.S)
    if not m:
        continue
    try:
        data = json.loads(m.group(1))
        for w in data.get('words', []):
            if w.get('w'):
                words.add(w['w'].lower())
    except Exception:
        pass
words = sorted(words)
if LIMIT:
    words = words[:LIMIT]
print('唯一词总数:', len(words), flush=True)

os.makedirs(os.path.join(AUDIO_DIR, 'us'), exist_ok=True)
os.makedirs(os.path.join(AUDIO_DIR, 'uk'), exist_ok=True)

todo = []
for w in words:
    safe = safe_name(w)
    need = []
    for tag in ('us', 'uk'):
        p = os.path.join(AUDIO_DIR, tag, safe + '.mp3')
        if not (os.path.exists(p) and os.path.getsize(p) > 100):
            need.append(tag)
    if need:
        todo.append((w, need))
print('待处理词数:', len(todo), flush=True)

def download(audio, typ):
    for attempt in range(2):
        try:
            conn = http.client.HTTPSConnection('dict.youdao.com', 443, timeout=8)
            conn.request('GET', '/dictvoice?audio=' + audio + '&type=' + str(typ),
                         headers={'User-Agent': 'Mozilla/5.0'})
            r = conn.getresponse(); body = r.read(); conn.close()
            if r.status == 200 and len(body) > 100:
                return body
        except Exception:
            pass
        time.sleep(0.4)
    return None

def compress(data):
    """ffmpeg stdin→stdout 压缩，返回 bytes 或 None"""
    try:
        p = subprocess.run(
            [FFMPEG, '-y', '-i', 'pipe:0', '-ac', '1', '-b:a', '32k', '-f', 'mp3', 'pipe:1'],
            input=data, capture_output=True, timeout=20)
        out = p.stdout
        return out if out and len(out) > 100 else None
    except Exception:
        return None

def process_one(word, need):
    """下载并压缩一个词，写文件。返回该词完成的声道数"""
    safe = safe_name(word)
    made = 0
    for tag in need:
        typ = 2 if tag == 'us' else 1
        data = download(word, typ)
        if not data:
            continue
        out = compress(data)
        if not out:
            continue
        dst = os.path.join(AUDIO_DIR, tag, safe + '.mp3')
        with open(dst, 'wb') as f:
            f.write(out)
        made += 1
    return made

t0 = time.time()
stats = {'ok': 0, 'partial': 0, 'none': 0, 'files': 0}
with ThreadPoolExecutor(max_workers=6) as ex:
    results = ex.map(lambda t: (t[0], process_one(t[0], t[1])), todo)
    for i, (w, made) in enumerate(results):
        if made == 2:
            stats['ok'] += 1
        elif made == 1:
            stats['partial'] += 1
        else:
            stats['none'] += 1
        stats['files'] += made
        if (i + 1) % 200 == 0:
            print(f'进度 {i+1}/{len(todo)} 完成词 {stats["ok"]} 部分 {stats["partial"]} 失败 {stats["none"]} '
                  f'耗时 {int(time.time()-t0)}s', flush=True)

print('完成!', stats, '总耗时', int(time.time()-t0), 's', flush=True)
total = 0
for tag in ('us', 'uk'):
    files = glob.glob(os.path.join(AUDIO_DIR, tag, '*.mp3'))
    size = sum(os.path.getsize(f) for f in files)
    print(f'{tag}: {len(files)} 个文件, {size/1024/1024:.1f} MB', flush=True)
    total += size
print(f'总计 {total/1024/1024:.1f} MB', flush=True)
