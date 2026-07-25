# -*- coding: utf-8 -*-
"""给 ogden.js 补充 freq + 词族字段。"""
import os, re, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOKS_DIR = os.path.join(ROOT, "books")

ROOT_LIST = [
    'act','aud','bell','bene','bon','bio','cap','cept','cip','capt','ced','ceed','cess','chron',
    'cid','cis','civ','clar','cogn','cord','corp','cosm','cred','cruc','cub','cumb','cur','curs',
    'dem','demo','derm','dict','doc','doct','domin','duc','duct','dyn','equ','err','fac','fact',
    'fic','fect','fer','fid','fin','flagr','flam','flect','flex','flor','flu','flux','fort','forc',
    'found','form','frag','fract','frat','fus','fund','gen','gener','geo','grad','gress','gram',
    'graph','grat','grav','greg','hab','hibit','helio','heter','hom','horr','hum','hydr','hypn',
    'ign','ject','junct','jur','just','juven','lab','labor','langu','lingu','lapid','lat','lav',
    'leg','lex','lect','lev','liber','libr','lic','lin','liter','loc','loqu','log','logy','luc',
    'lum','lud','magn','man','manu','mater','matr','medi','mega','mem','mens','ment','merc','migr',
    'min','miss','mit','mob','mot','mov','mon','mono','mort','morph','multi','mut','nat','nas',
    'nav','naut','nec','neg','neur','nihil','noc','nox','nom','nomin','nov','numer','nutri','onym',
    'oper','opt','ora','ordin','orn','paci','pan','par','pare','pat','pass','path','ped','pod',
    'pel','puls','pend','pens','pet','phil','phon','photo','plat','pli','plic','ply','plex','plor',
    'pne','pol','port','pos','pon','post','pound','pot','prehend','prim','prob','prov','psych',
    'publ','pur','pyr','quer','quest','quir','quie','rad','reg','rect','rid','ris','rod','rupt',
    'sacr','sanct','sal','san','sat','satis','sci','scrib','script','sect','sed','sess','sid',
    'sens','sent','sequ','secu','sert','sig','sign','simil','simul','sol','son','soph','spec',
    'spic','sper','spir','stell','struct','suad','sum','super','syn','sym','tang','tact','techn',
    'tele','tem','ten','tend','term','terr','test','tex','the','theo','therm','tim','tom','ton',
    'tort','tract','trib','trop','tru','turb','typ','uni','urb','vac','van','val','vari',
    'ven','vent','ver','verb','vers','vert','viv','vic','vict','vid','vis','voc','vok','vol','volv',
    'vor','vuln','zo',
    # Germanic base forms
    'beauty','busy','happy','quick','slow','every','another','break','bring','build','burn',
    'call','care','carry','catch','cause','change','check','clean','clear','climb','close',
    'come','cook','cool','count','cover','cross','cut','dance','deal','deep','draw','dream',
    'drink','drive','drop','eat','fall','feed','feel','fight','fill','find','fire','fish',
    'flow','freeze','follow','free','get','give','grow','hand','hang','have','head','hear',
    'heart','help','hide','hit','hold','hope','keep','kick','kill','know','land','last',
    'laugh','lead','learn','leave','let','lie','lift','light','live','look','lose',
    'love','make','mark','mean','meet','mind','miss','move','name','need','open','pass',
    'pay','pick','place','play','point','pull','push','put','rain','raise','reach','read',
    'ride','ring','rise','roll','run','say','see','seek','sell','send','set','shake',
    'shine','shoot','show','shut','sing','sink','sit','sleep','smell','smile','speak',
    'spend','stand','start','stay','steal','step','stick','stop','strike','swim','swing',
    'take','talk','teach','tear','tell','think','throw','touch','train','travel','turn',
    'wait','walk','want','wash','watch','wear','win','wind','wish','work','write',
]
ROOT_LIST.sort(key=len, reverse=True)

PREFIXES = ['counter','retro','ultra','circum','hetero','hypo','macro','micro','mono','multi',
    'photo','proto','super','trans','tri','anti','auto','bi','co','de','dis','en','ex','fore','in',
    'inter','mid','mis','non','out','over','peri','post','pre','pro','re','semi','sub','tele','un',
    'under','up','with','ab','ad','com','con','contra','equi','extra','hyper','intro','para','syn',
    'sym','di','hemi','holo','iso','meta','neo','pan','poly','pseudo','supra','vice','ante','apo',
    'cata','dys','ecto','endo','eu','ortho','geo','bio','be','for','fore','mis','a']
PREFIXES.sort(key=len, reverse=True)

SUFFIXES = ['tion','sion','ness','ment','able','ible','ful','less','ous','ive','al','ial','ic',
    'ish','ly','er','est','ing','ed','s','es','en','ize','ise','ify','ate','ity','ty','ance',
    'ence','ant','ent','ure','age','dom','hood','ship','ward','wards','wise','fold','most',
    'like','proof','some','th','ery','ory','ary','ism','ist','ite','oid','ose','scope']
SUFFIXES.sort(key=len, reverse=True)

def norm(w):
    w = (w or '').strip().lower()
    w = re.sub(r'\([^)]*\)', '', w)
    w = re.sub(r"[^a-z0-9'\-]", '', w)
    return w

def word_family(w):
    w = norm(w)
    if not w or len(w) < 2: return w
    cands = [w]
    for p in PREFIXES:
        if w.startswith(p) and len(w) > len(p) + 1: cands.append(w[len(p):])
    for s in SUFFIXES:
        for c in list(cands):
            if c.endswith(s) and len(c) > len(s) + 1: cands.append(c[:-len(s)])
    for i in range(len(cands)):
        c = cands[i]
        if c.endswith('i') and len(c) > 3: cands.append(c[:-1] + 'y')
    best = ''
    for c in cands:
        for r in ROOT_LIST:
            if r in c and len(r) > len(best): best = r
    if best and len(best) >= 3: return best
    return w

def main():
    ogden_path = os.path.join(BOOKS_DIR, 'ogden.js')
    with open(ogden_path, 'r', encoding='utf-8') as f:
        code = f.read()
    m = re.search(r'window\.BOOK_\w+\s*=\s*(\{.*?\});?\s*$', code, re.DOTALL)
    og_obj = json.loads(m.group(1))
    og_words = og_obj.get('words', [])
    n = 0
    for ent in og_words:
        w = ent.get('w', '')
        if not w: continue
        fam = word_family(w)
        if fam and fam != w.lower():
            ent['root'] = fam; n += 1
    new_code = 'window.BOOK_ogden = ' + json.dumps(og_obj, ensure_ascii=False) + ';'
    with open(ogden_path, 'w', encoding='utf-8') as f:
        f.write(new_code)
    print(f'ogden: {len(og_words)} words, {n} roots added')
    samples = [(e['w'], e.get('root','')) for e in og_words[:30]]
    for w, r in samples:
        print(f'  {w:20s} -> {r}')

if __name__ == '__main__':
    main()
