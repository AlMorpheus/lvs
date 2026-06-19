#!/usr/bin/env python3
"""
Строит data/official-positions.json (API player id -> позиция) из официального
PDF заявок FIFA (SquadLists-English.pdf). Позиции этого файла — высший авторитет
над данными API (см. update.mjs: normPos / posMap). Уже сыгранные матчи он НЕ
меняет (их держит data/scorer-pos.json — «только вперёд»).

Запуск:  python3 scripts/build-official-positions.py /path/to/SquadLists-English.pdf
Требует: pip install --user pypdf

Сопоставление точное (precision-first): матчим по фамилии в рамках команды;
неоднозначные однофамильцы пропускаем (остаётся позиция из API) — лучше пропустить,
чем проставить неверную позицию.
"""
import sys, re, json, unicodedata
from pathlib import Path
import pypdf

ROOT = Path(__file__).resolve().parent.parent
PDF = sys.argv[1] if len(sys.argv) > 1 else str(Path.home() / 'Downloads' / 'SquadLists-English.pdf')

# FIFA код (из PDF) -> наш team id (API-Football)
CODE2ID = {'ALG':1532,'ARG':26,'AUS':20,'AUT':775,'BEL':1,'BIH':1113,'BRA':6,'CPV':1533,'CAN':5529,
 'COL':8,'COD':1508,'CIV':1501,'CRO':3,'CUW':5530,'CZE':770,'ECU':2382,'EGY':32,'ENG':10,'FRA':2,
 'GER':25,'GHA':1504,'HAI':2386,'IRN':22,'IRQ':1567,'JPN':12,'JOR':1548,'KOR':17,'MEX':16,'MAR':31,
 'NED':1118,'NZL':4673,'NOR':1090,'PAN':11,'PAR':2380,'POR':27,'QAT':1569,'KSA':23,'SCO':1108,
 'SEN':13,'RSA':1531,'ESP':9,'SWE':5,'SUI':15,'TUN':28,'TUR':777,'URU':7,'USA':2384,'UZB':1568}
POSMAP = {'GK':'Goalkeeper','DF':'Defender','MF':'Midfielder','FW':'Attacker'}
STOP = {'JR','JNR','JUNIOR','II','III'}

def fold(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^A-Za-z]', '', s).upper()
def tr(f):  # ue->u oe->o ae->a ss->s (немецкие и пр. транслитерации фамилий)
    return f.replace('UE','U').replace('OE','O').replace('AE','A').replace('SS','S')
def is_caps(tok):
    f = fold(tok); return len(f) >= 2 and tok == tok.upper() and f.isalpha()

reader = pypdf.PdfReader(PDF)
pdf = {}
for pg in reader.pages:
    txt = pg.extract_text()
    cm = re.search(r'\(([A-Z]{3})\)', txt.split('\n', 1)[0])
    if not cm: continue
    players = []
    for line in txt.split('\n'):
        m = re.match(r'^(GK|DF|MF|FW)(.+)$', line)
        if not m: continue
        sur, first = [], ''
        for t in m.group(2).split(' '):
            if is_caps(t): sur.append(fold(t))
            else: first = re.sub(r'[^A-Za-z].*', '', t); break
        sur = [s for s in sur if s not in STOP]
        if sur: players.append((m.group(1), sur, fold(first)))
    pdf[cm.group(1)] = players

squads = json.loads((ROOT / 'data/squads.json').read_text())
def ptoks(n): return [fold(t) for t in n.split(' ') if fold(t)]
def lastmatch(a, b): return a == b or tr(a) == tr(b)

official, assigned, skipped = {}, set(), []
for code, players in pdf.items():
    ours = squads.get(str(CODE2ID.get(code))) or []
    surcount = {}
    for _, sur, _ in players: surcount[sur[-1]] = surcount.get(sur[-1], 0) + 1
    for pos, sur, first in players:
        sl = sur[-1]
        cands = [p for p in ours if ptoks(p.get('name','')) and
                 (lastmatch(ptoks(p['name'])[-1], sl) or set(sur).issubset(set(ptoks(p['name']))))]
        cands = [c for c in cands if str(c['id']) not in assigned]
        pick = None
        if len(cands) == 1 and surcount[sl] == 1:
            pick = cands[0]
        else:  # неоднозначно: требуем совпадение полного имени (>2 симв.)
            fm = [c for c in cands if first and len(first) > 2 and fold(c['name'].split(' ')[0]) == first]
            if len(fm) == 1: pick = fm[0]
        if pick:
            official[str(pick['id'])] = POSMAP[pos]; assigned.add(str(pick['id']))
        else:
            skipped.append((code, ' '.join(sur), pos))

(ROOT / 'data/official-positions.json').write_text(json.dumps(official, ensure_ascii=False, indent=0) + '\n')
allp = sum(len(v) for v in pdf.values())
print(f'Назначено {len(official)}/{allp}, пропущено (оставлена позиция API) {len(skipped)}')
