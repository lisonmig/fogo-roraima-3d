"""Autorizações de queima controlada da FEMARH (SIGGARR), para o mapa de calor.
usage: python prep_femarh.py <raw_dir> <out_dir>
Baixa as camadas públicas do SIGGARR (https://siggarr.femarh.rr.gov.br, menu Fogo > FEMARH >
"Autorização de Uso Controlado do Fogo") e grava <out_dir>/femarh.json só com:
posição, área autorizada (ha), início e fim da autorização, tipo de queima e município.
Nunca grava nome do imóvel, endereço nem número do processo.
Se o SIGGARR não responder, usa a última cópia em <raw_dir>; sem cópia, mantém o femarh.json que já existe."""
import json, os, re, sys, time, urllib.request
from datetime import date

RAW, OUT = sys.argv[1], sys.argv[2]
URL = 'https://siggarr.femarh.rr.gov.br/index.php?r=dados&c={}.geojson'
# ano -> camada do SIGGARR (2026: a camada "_2" é a que o próprio SIGGARR mostra; contém a outra)
CAMADAS = {2023: ['controle_queimadas_2023'], 2024: ['controle_queimadas_2024'], 2025: ['controle_queimadas_2025'],
           2026: ['controle_queimadas_2026_2', 'vw_queimadas_area']}
MUNS = ['Alto Alegre', 'Amajari', 'Boa Vista', 'Bonfim', 'Cantá', 'Caracaraí', 'Caroebe', 'Iracema', 'Mucajaí',
        'Normandia', 'Pacaraima', 'Rorainópolis', 'São João da Baliza', 'São Luiz', 'Uiramutã']
TIPOS = ['Pastagem', 'Restos de exploração florestal', 'Restos de cultura', 'Outros']
W, S, E, N = -64.9, -1.6, -58.8, 5.3


def baixar(c):
    cache = os.path.join(RAW, 'femarh_' + c + '.geojson')
    if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < 86400:
        return json.load(open(cache, encoding='utf-8'))
    try:
        req = urllib.request.Request(URL.format(c), headers={'User-Agent': 'Mozilla/5.0 (fogororaima.com.br)'})
        J = json.loads(urllib.request.urlopen(req, timeout=120).read().decode('utf-8', 'replace'))
        if not isinstance(J.get('features'), list): raise ValueError('resposta sem features')
        json.dump(J, open(cache, 'w', encoding='utf-8'), ensure_ascii=False)
        return J
    except Exception as e:
        print('SIGGARR', c, 'falhou:', e)
        return json.load(open(cache, encoding='utf-8')) if os.path.exists(cache) else None


def sem_acento(s):
    s = s.upper()
    for a, b in zip('ÁÀÂÃÉÊÍÓÔÕÚÇ', 'AAAAEEIOOOUC'): s = s.replace(a, b)
    return s


def municipio(txt):
    # o SIGGARR troca as letras acentuadas por '�': compara com '.' no lugar delas
    t = sem_acento((txt or '').strip())
    pad = re.compile('^' + re.escape(t).replace('�', '.') + '$') if t else None
    for k, m in enumerate(MUNS):
        alvo = sem_acento(m)
        if pad and (pad.match(alvo) or pad.match(alvo.replace('SAO LUIZ', 'SAO LUIZ DO ANAUA'))): return k
    for k, m in enumerate(MUNS):
        if t and sem_acento(m)[:6].replace('�', '') in t.replace('�', 'A'): return k
    return -1


def tipo(txt):
    t = sem_acento(txt or '')
    if 'PAST' in t: return 0
    if 'EXPLORA' in t: return 1
    if 'CULTURA' in t: return 2
    return 3


def dia(v):
    m = re.match(r'(\d{4}-\d{2}-\d{2})', str(v or ''))
    return m.group(1) if m else ''


def centro(g):
    if not g: return None
    if g['type'] == 'Point': return g['coordinates'][:2]
    pts = []
    def walk(c):
        if isinstance(c[0], (int, float)): pts.append(c)
        else:
            for x in c: walk(x)
    walk(g['coordinates'])
    return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)] if pts else None


os.makedirs(RAW, exist_ok=True)
anos, falhas, vistos = {}, 0, set()
for ano, camadas in CAMADAS.items():
    for c in camadas:
        J = baixar(c)
        if J is None: falhas += 1; continue
        for f in J['features']:
            p = f.get('properties') or {}
            xy = centro(f.get('geometry'))
            if not xy: continue
            lon, lat = xy
            if not (W < lon < E and S < lat < N): continue
            chave = (str(p.get('proces_sei') or '').strip() or None, round(lon, 4), round(lat, 4))
            if chave in vistos: continue
            vistos.add(chave)
            di, df = dia(p.get('data_i')), dia(p.get('data_f'))
            a = int(di[:4]) if di else ano
            anos.setdefault(str(a), []).append([round(lon, 4), round(lat, 4), round(float(p.get('area_lic') or 0), 1), di, df,
                                                tipo(p.get('atividade')), municipio(p.get('municip'))])


# ---------- áreas com autorização florestal da FEMARH (SIGGARR, menu Licenciamento > Autorização de Exploração)
# grava <out_dir>/femarh_florestal.json só com: tipo (AUAS, ASV, PMFS, POA), início e fim da vigência e o contorno simplificado.
# Nunca grava nome do imóvel, empreendedor, CPF/CNPJ, CAR, número da licença nem do processo.
FLOR_TIPOS = ['AUAS', 'ASV', 'PMFS', 'POA']


def simplifica(pts, tol):
    if len(pts) < 4: return pts
    a, b = pts[0], pts[-1]; dmax, k = 0, 0
    for i in range(1, len(pts) - 1):
        p = pts[i]; dx, dy = b[0] - a[0], b[1] - a[1]; L = (dx * dx + dy * dy) ** 0.5
        d = abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / L if L else ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2) ** 0.5
        if d > dmax: dmax, k = d, i
    if dmax <= tol: return [a, b]
    return simplifica(pts[:k + 1], tol)[:-1] + simplifica(pts[k:], tol)


def florestal():
    J = baixar('view_autorizacao_florestal_geral')
    fpath = os.path.join(OUT, 'femarh_florestal.json')
    if J is None:
        print('FEMARH florestal: sem dados novos; mantém', fpath if os.path.exists(fpath) else '(sem arquivo)'); return
    out = []
    for f in J['features']:
        p, g = f.get('properties') or {}, f.get('geometry')
        if not g or g['type'] not in ('Polygon', 'MultiPolygon'): continue
        t = str(p.get('tipo_lic') or p.get('tipo_proj') or '').upper()
        if t not in FLOR_TIPOS: continue
        di, df = dia(p.get('vig_inicia')), dia(p.get('vig_fim'))
        if di.startswith('2000-01-01'): di = ''
        if df.startswith('2000-01-01'): df = ''
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        rings = []
        for poly in polys:
            ring = simplifica([c[:2] for c in poly[0]], 0.0004)  # só o contorno externo, ~45 m de tolerância
            if len(ring) >= 4 and all(W < x < E and S < y < N for x, y in ring):
                rings.append([v for x, y in ring for v in (round(x, 4), round(y, 4))])
        if rings: out.append([FLOR_TIPOS.index(t), di, df, rings])
    if not out:
        print('FEMARH florestal: nenhuma área válida; mantém o arquivo'); return
    json.dump({'fonte': 'FEMARH, SIGGARR (Autorização de Exploração Florestal)', 'url': 'https://siggarr.femarh.rr.gov.br/',
               'atualizado': date.today().isoformat(), 'campos': ['tipo', 'inicio', 'fim', 'aneis'], 'tipos': FLOR_TIPOS,
               'nomes': ['Autorização de Uso Alternativo do Solo', 'Autorização de Supressão Vegetal', 'Plano de Manejo Florestal Sustentável', 'Plano Operacional Anual'],
               'areas': out}, open(fpath, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'), ensure_ascii=False)
    print('FEMARH áreas florestais autorizadas', len(out), '| arquivo', os.path.getsize(fpath))


florestal()
path = os.path.join(OUT, 'femarh.json')
if not anos:
    print('FEMARH: nenhum dado novo; mantém', path if os.path.exists(path) else '(sem arquivo)')
    sys.exit(0)
for v in anos.values(): v.sort(key=lambda r: r[3])
json.dump({'fonte': 'FEMARH, SIGGARR (Autorização de Uso Controlado do Fogo)', 'url': 'https://siggarr.femarh.rr.gov.br/',
           'atualizado': date.today().isoformat(), 'campos': ['lon', 'lat', 'area_ha', 'inicio', 'fim', 'tipo', 'mun'],
           'tipos': TIPOS, 'muns': MUNS, 'anos': dict(sorted(anos.items()))},
          open(path, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'), ensure_ascii=False)
print('FEMARH autorizações', {k: len(v) for k, v in sorted(anos.items())}, '| camadas com falha', falhas, '| arquivo', os.path.getsize(path))
