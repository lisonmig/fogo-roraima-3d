"""Areas declared in the CAR for each rural property (Reserva Legal, APP, consolidated area, native vegetation,
administrative easement and net area), from the public layers of SIGGARR/FEMARH.
usage: python prep_car_areas.py <raw_dir> <out_dir>
Run by hand and commit docs/rel/car_areas.json: SIGGARR answers 403 to the GitHub Actions servers.
Only the CAR code and the sum of hectares per theme are kept: never the property name, user fields or outlines.
Downloaded again every 7 days; if SIGGARR fails, the last good copy in <raw_dir> is used."""
import json, os, re, shutil, sys, time, urllib.request
from datetime import date

RAW, OUT = sys.argv[1], sys.argv[2]
URL = 'https://siggarr.femarh.rr.gov.br/index.php?r=dados&c={}.geojson'
UA = {'User-Agent': 'Mozilla/5.0 (fogororaima.com.br)'}
CACHE = os.path.join(RAW, 'car_areas.json')
DEST = os.path.join(OUT, 'rel', 'car_areas.json')
CAMPOS = ['imovel', 'liquida', 'rl', 'rl_prop', 'rl_aver', 'rl_apro', 'cons', 'rem', 'app', 'serv', 'uso', 'pousio', 'nclass']
TEMAS = {
    'area_imovel': {'Área do Imovel': 'imovel'},
    'area_liquida_imovel': {'Área Líquida do Imóvel': 'liquida'},
    'reserva_legal': {'Área de Reserva Legal Total': 'rl', 'Reserva Legal Proposta': 'rl_prop', 'Reserva Legal Averbada': 'rl_aver', 'Reserva Legal Aprovada e não Averbada': 'rl_apro'},
    'cobertura_solo': {'Área Consolidada': 'cons', 'Remanescente de Vegetação Nativa': 'rem', 'Área de Pousio': 'pousio', 'Área não Classificada': 'nclass'},
    'app': {'APP Total': 'app'},
    'servidao_administrativa': {'Área de Servidão Administrativa Total': 'serv'},
    'uso_restrito': {'Área de Uso Restrito para declividade de 25 a 45 graus': 'uso'},
}
PROPS = re.compile(r'"properties"\s*:\s*(\{[^{}]*\})')


def le_camada(nome, temas, soma):
    """Reads the layer as a stream, keeping only code, theme and area; geometry and other fields are discarded."""
    n, tail = 0, ''
    with urllib.request.urlopen(urllib.request.Request(URL.format(nome), headers=UA), timeout=180) as r:
        while True:
            b = r.read(1 << 20)
            if not b: break
            s = tail + b.decode('utf-8', 'ignore'); fim = 0
            for m in PROPS.finditer(s):
                fim = m.end()
                try: p = json.loads(m.group(1))
                except ValueError: continue
                cod, campo = str(p.get('recibo') or ''), temas.get(p.get('tema'))
                if not campo or not cod.startswith('RR-'): continue
                try: ha = float(p.get('area') or 0)
                except (TypeError, ValueError): continue
                soma.setdefault(cod, {}); soma[cod][campo] = soma[cod].get(campo, 0) + ha; n += 1
            tail = s[fim:][-20000:] if fim else s[-400000:]
    return n


def publica():
    if os.path.exists(CACHE):
        os.makedirs(os.path.dirname(DEST), exist_ok=True); shutil.copyfile(CACHE, DEST)


os.makedirs(RAW, exist_ok=True)
if os.path.exists(CACHE) and time.time() - os.path.getmtime(CACHE) < 7 * 86400:
    publica(); print('car_areas: cópia de menos de 7 dias'); sys.exit(0)
soma = {}
try:
    for nome, temas in TEMAS.items():
        print('car_areas', nome, le_camada(nome, temas, soma), flush=True)
    com_area = sum(1 for v in soma.values() if v.get('imovel'))
    if com_area < 100: raise ValueError('poucos imóveis na resposta: %d' % com_area)
    J = {'fonte': 'SIGGARR/FEMARH, camadas públicas do CAR (valores declarados)', 'gerado': date.today().isoformat(), 'n': com_area, 'campos': CAMPOS,
         'imoveis': {k: [round(v.get(c, 0), 2) for c in CAMPOS] for k, v in sorted(soma.items()) if v.get('imovel')}}
    with open(CACHE + '.tmp', 'w', encoding='utf-8') as fo: json.dump(J, fo, ensure_ascii=False, separators=(',', ':'))
    os.replace(CACHE + '.tmp', CACHE)
    print('car_areas: imóveis', com_area, '| bytes', os.path.getsize(CACHE))
except Exception as e:
    print('car_areas falhou, usando a última cópia se houver:', e)
publica()
