import re
"""Gera docs/leve.json: dados pequenos para a versão 2D. Uso: prep_leve.py <pasta_dados_docs>"""
import json, os, sys
from datetime import datetime, timedelta, timezone
P = sys.argv[1]
def J(n):
    try:
        with open(os.path.join(P, n), encoding='utf-8') as f: return json.load(f)
    except Exception: return None
def simp(pts, tol):
    if len(pts) < 3: return pts
    keep = {0, len(pts)-1}; st = [(0, len(pts)-1)]
    while st:
        a, b = st.pop(); ax, ay = pts[a]; bx, by = pts[b]; dx, dy = bx-ax, by-ay; n = dx*dx+dy*dy; m, w = 0, -1
        for i in range(a+1, b):
            x, y = pts[i]
            d = abs(dy*(x-ax)-dx*(y-ay))/n**.5 if n else ((x-ax)**2+(y-ay)**2)**.5
            if d > m: m, w = d, i
        if m > tol: keep.add(w); st += [(a, w), (w, b)]
    return [pts[i] for i in sorted(keep)]
def flat(pts, nd=3):
    o = []
    for x, y in pts: o += [round(x, nd), round(y, nd)]
    return o
def ring(r, tol=.002, nd=4):
    pts = [[r[i], r[i+1]] for i in range(0, len(r)-1, 2)]; s = simp(pts, tol)
    return flat(s if len(s) >= 4 else pts, nd)
D = J('roraima3d.json'); T0 = datetime.fromisoformat(D['meta']['t0'].replace('Z', '+00:00')); F = D['fires']
last = max(F['t']); now = T0 + timedelta(minutes=last); hoje = (now - timedelta(hours=4)).date()
gen = datetime.fromisoformat(D['meta']['generated'].replace('Z', '+00:00')); gm = (gen - T0).total_seconds() / 60; SC = 0.003375
fires, cells = [], {}
for la, lo, t in zip(F['lat'], F['lon'], F['t']):
    h = max(0, (gm-t)/60)
    if h <= 48: fires += [round(lo, 3), round(la, 3), int(h)]
    if last-t <= 86400:
        kc = (round(lo/SC), round(la/SC)); qc = cells.get(kc)
        cells[kc] = [t, t] if qc is None else [min(qc[0], t), max(qc[1], t)]
sc = []; px = py = 0
for lo, la in sorted(cells): sc += [lo-px, la-py]; px, py = lo, la
ev, nomes, cnt = [], [], {'burn': 0, 'obs': 0}
E = J('eventos_inpe.json') or {'events': []}
for e in E['events']:
    d1 = datetime.fromisoformat(e['d1']).date(); fim = d1 + timedelta(days=1) if e.get('atual') and e.get('status') != 'Observação' else d1
    s = 'burn' if hoje <= fim else 'obs' if (hoje-d1).days <= 7 else ''
    if not s or datetime.fromisoformat(e['d0']).date() > hoje: continue
    cnt[s] += 1
    ev.append({'s': s, 'ti': e.get('tipo'), 'ha': round(e.get('ha') or 0), 'm': e.get('mun'), 'a': e['d0'], 'b': e['d1'], 'c': [round(e['c'][0], 3), round(e['c'][1], 3)], 'r': [ring(r) for r in e['r']]})
ev.sort(key=lambda e: (e['s'] != 'burn', -e['ha']))
R = J('rios.json'); rios = []
if R:
    ox, oy = R['origin']; q = R['q']
    def dec(f):
        x, y = f[0], f[1]; o = [[ox+x/q, oy+y/q]]
        for k in range(2, len(f), 2): x += f[k]; y += f[k+1]; o.append([ox+x/q, oy+y/q])
        return o
    for l in R['lines']:
        if l[0]: rios.append(flat(simp(dec(l[2:]), .006)))
    for a in R['areas']:
        p = simp(dec(a[1:]), .008)
        if len(p) > 3: rios.append(flat(p))
au = {'q': [], 'f': []}; lo_d, hi_d = str(hoje-timedelta(days=30)), str(hoje+timedelta(days=30))
Q = J('femarh.json')
if Q:
    for rows in Q['anos'].values():
        for r in rows:
            if r[3] and r[4] and r[3] <= hi_d and r[4] >= lo_d: au['q'].append([r[0], r[1], r[2], r[3], r[4]])
FL = J('femarh_florestal.json')
if FL:
    for a in FL['areas']:
        if (not a[1] or a[1] <= hi_d) and (not a[2] or a[2] >= lo_d):
            au['f'].append({'t': FL['tipos'][a[0]], 'a': a[1], 'b': a[2], 'ha': a[4], 'r': [ring(r, .001) for r in a[3]]})
W = D['weather']; kw = min(W['n']-1, int(gm // W['stepMin'])); ws, wd = W['ws'][kw], W['wd'][kw]; vento = []
for j, la in enumerate(W['lats']):
    for i, lo in enumerate(W['lons']):
        k = j*W['cols']+i; vento.append([lo, la, ws[k], wd[k]])
S = J('seca.json'); seca = [{'n': s['name'], 'r': s['river'], 'c': [s['lon'], s['lat']], 'cm': (s.get('last') or {}).get('cm'), 'k': s.get('risk')} for s in (S or {}).get('stations', [])]
O = {'u': gen.strftime('%Y-%m-%dT%H:%MZ'), 'f': fires, 'sc': sc, 'ev': ev, 'rios': rios, 'au': au, 'v': vento, 'seca': seca, 'n': cnt}
_rr = D['rr']
if _rr and isinstance(_rr[0], list) and len(_rr[0]) == 2 and not isinstance(_rr[0][0], list): _rr = [[v for q in _rr for v in q]]
elif _rr and not isinstance(_rr[0], list): _rr = [_rr]
O['rr'] = [ring(r, .001) for r in _rr]  # contorno do estado: a página cobre o que fica fora
with open(os.path.join(P, 'leve.json.tmp'), 'w', encoding='utf-8', newline='\n') as f: json.dump(O, f, ensure_ascii=False, separators=(',', ':'))
os.replace(os.path.join(P, 'leve.json.tmp'), os.path.join(P, 'leve.json'))
print('leve.json', os.path.getsize(os.path.join(P, 'leve.json')), {k: len(json.dumps(v, separators=(',', ':'))) for k, v in O.items()})

# ---------- filtros de "Mais opções": cada um em arquivo próprio, baixado só ao ligar
def salva(nome, v):
    if v is None: return
    a = os.path.join(P, 'leve_' + nome + '.json')
    with open(a + '.tmp', 'w', encoding='utf-8', newline='\n') as f: json.dump(v, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(a + '.tmp', a)
def delta(f, ox, oy, q):
    x, y = f[0], f[1]; o = [[ox+x/q, oy+y/q]]
    for k in range(2, len(f), 2): x += f[k]; y += f[k+1]; o.append([ox+x/q, oy+y/q])
    return o
def fino(pts, tol, nd=4):
    s = simp(pts, tol)
    return flat(s if len(s) >= 4 or len(pts) < 4 else pts, nd)
salva('ti', [{'n': t['nome'], 'e': t.get('etnia'), 'f': t.get('fase'), 'r': [ring(r, .004) for r in t['r']]} for t in D['tis']])
salva('mun', [{'n': m['nome'], 'r': [ring(r, .005) for r in m['r']]} for m in D['munis']])
salva('deter', [{'d': x['d'], 'k': x['km2'], 'r': [ring(r, .0005) for r in x['r']]} for x in D['deter']])
salva('queim', [{'d': x['d'], 'k': x['km2'], 'r': [ring(r, .0005) for r in x['r']]} for x in D['queim']])
PR_ = J('prodes.json')
if PR_:
    ox, oy = PR_['origin']; q = PR_['q']
    salva('prodes', [{'y': c[0], 'k': c[1], 'r': [fino(delta(r, ox, oy, q), .0006) for r in c[3]]} for c in PR_['p']])
def sit_car(t):
    t = (t or '').lower()
    return 4 if t.startswith('cancel') else 3 if t.startswith('analisado') else 2 if t.startswith('em an') else 1 if 'revis' in t else 0
CT_ = J('car_todos.json')
if CT_:
    ox, oy = CT_['origin']; q = CT_['q']
    salva('car', {'m': CT_['muns'], 'c': [[c[1], c[2], c[3], [fino(delta(r, ox, oy, q), .0006) for r in c[5]], 0, sit_car(c[4])] for c in CT_['cars']]})
ES_ = J('estradas.json')
if ES_:
    ox, oy = ES_['origin']; q = ES_['q']
    salva('estradas', [[w[0], fino(delta(w[3:], ox, oy, q), .002, 3)] for w in ES_['ways'] if w[0] <= 1])
    salva('vicinais', [[w[0], fino(delta(w[3:], ox, oy, q), .0012, 3)] for w in ES_['ways'] if w[0] >= 2])
    PRIV = re.compile(r'fazenda|s[ií]tio|ch[aá]cara|retiro|est[aâ]ncia|haras|granja', re.I)  # nunca nome de imóvel
    lug = {}
    for x in ES_['places']:
        if x[1] != 5 and not PRIV.search(x[0]): lug.setdefault(x[0], [x[0], round(ox + x[2] / q, 4), round(oy + x[3] / q, 4), 0])
    via = {}
    for w in ES_['ways']:
        if w[1] >= 0 and len(w) > len(via.get(w[1], [])): via[w[1]] = w
    for k, w in via.items():
        nome = ES_['names'][k]
        if PRIV.search(nome) or nome in lug: continue
        pts = delta(w[3:], ox, oy, q); m = pts[len(pts) // 2]
        lug[nome] = [nome, round(m[0], 4), round(m[1], 4), 1]
    for t in D['tis']:
        xs = [v for r in t['r'] for v in r[0::2]]; ys = [v for r in t['r'] for v in r[1::2]]
        nome = 'TI ' + t['nome']; lug[nome] = [nome, round((min(xs) + max(xs)) / 2, 4), round((min(ys) + max(ys)) / 2, 4), 2]
    salva('lugares', sorted(lug.values(), key=lambda v: (v[3], v[0])))
sem = []
for e in E['events']:
    n = (hoje-datetime.fromisoformat(e['d1']).date()).days
    if 7 < n <= 60: sem.append({'ti': e.get('tipo'), 'ha': round(e.get('ha') or 0), 'm': e.get('mun'), 'a': e['d0'], 'b': e['d1'], 'r': [ring(r) for r in e['r']]})
salva('inpe', sem)
dia_c = lambda t: (T0 + timedelta(minutes=t-240)).date()
if cells:
    base_c = min(dia_c(v[0]) for v in cells.values()); ord_c = sorted(cells)  # mesma ordem de 'sc' no leve.json
    salva('cicatriz', {'d0': base_c.isoformat(), 'a': [(dia_c(cells[k][0])-base_c).days for k in ord_c], 'b': [(dia_c(cells[k][1])-base_c).days for k in ord_c]})
if Q: salva('calor', [[r[0], r[1]] for rows in Q['anos'].values() for r in rows])
for n in 'ti mun deter queim prodes car estradas inpe calor lugares vicinais cicatriz'.split():
    a = os.path.join(P, 'leve_' + n + '.json')
    if os.path.exists(a): print(n, os.path.getsize(a))
