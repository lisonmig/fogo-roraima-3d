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
