"""Builds compact data files for the fire map page from INPE CSVs + IBGE layers."""
import csv, glob, gzip, json, os, sys, shutil, datetime as dt

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def load_maybe_gz(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf-8'))

# --- states
estados = load_maybe_gz(os.path.join(src, 'ufs_nomes.json'))
ufs = {str(e['id']): [e['sigla'], e['nome'], e['regiao']['sigla']] for e in estados}
geo = load_maybe_gz(os.path.join(src, 'ufs.geojson'))

def rnd(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], 3), round(c[1], 3)]
    return [rnd(x) for x in c]

for f in geo['features']:
    code = str(f['properties'].get('codarea'))
    f['properties'] = {'uf': code, 'sigla': ufs.get(code, ['?'])[0]}
    f['geometry']['coordinates'] = rnd(f['geometry']['coordinates'])
json.dump(geo, open(os.path.join(out, 'ufs.geojson'), 'w', encoding='utf-8'), separators=(',', ':'))

# --- fires
SMALL = {'de', 'da', 'do', 'das', 'dos', 'e', 'd'}
def title(s):
    parts = s.strip().lower().split(' ')
    return ' '.join(p if (i and p in SMALL) else p[:1].upper() + p[1:] for i, p in enumerate(parts))

files = sorted(glob.glob(os.path.join(src, 'focos_*.csv')))
days = [os.path.basename(f)[6:14] for f in files]
start = dt.datetime.strptime(days[0], '%Y%m%d')
sats, biomas, muns = [], [], []
sat_i, bio_i, mun_i = {}, {}, {}
def idx(v, lst, d):
    if v not in d:
        d[v] = len(lst); lst.append(v)
    return d[v]

cols = {k: [] for k in 'lat lon t s m u b f d r'.split()}
seen = set(); last = start
for f in files:
    for r in csv.DictReader(open(f, encoding='utf-8')):
        if r['id'] in seen:
            continue
        seen.add(r['id'])
        t = dt.datetime.strptime(r['data_hora_gmt'], '%Y-%m-%d %H:%M:%S')
        last = max(last, t)
        cols['lat'].append(round(float(r['lat']) * 1e4))
        cols['lon'].append(round(float(r['lon']) * 1e4))
        cols['t'].append(int((t - start).total_seconds() // 60))
        cols['s'].append(idx(r['satelite'], sats, sat_i))
        cols['m'].append(idx(title(r['municipio']) + '|' + r['estado_id'], muns, mun_i))
        cols['u'].append(int(r['estado_id']))
        cols['b'].append(idx(r['bioma'] or 'Sem bioma', biomas, bio_i))
        frp = r['frp'].strip()
        cols['f'].append(round(float(frp) * 10) if frp else -1)
        dd = r['numero_dias_sem_chuva'].strip()
        cols['d'].append(int(float(dd)) if dd and float(dd) >= 0 else -1)
        rr = r['risco_fogo'].strip()
        cols['r'].append(round(float(rr) * 100) if rr and float(rr) >= 0 else -1)

meta = {
    'start': start.strftime('%Y-%m-%d'),
    'days': [f'{d[:4]}-{d[4:6]}-{d[6:]}' for d in days],
    'last': last.strftime('%Y-%m-%dT%H:%MZ'),
    'satImage': {'file': 'sat_2026-11-07.jpg', 'date': '2026-11-07',
                 'layer': 'VIIRS NOAA-20 Corrected Reflectance (True Color)',
                 'bounds': [[-34.5, -74.5], [6.0, -33.5]]},
    'count': len(cols['t']),
}
data = {'meta': meta, 'sats': sats, 'biomas': biomas, 'muns': [m.split('|')[0] for m in muns],
        'munUf': [int(m.split('|')[1]) for m in muns], 'ufs': ufs, 'cols': cols}
json.dump(data, open(os.path.join(out, 'focos.json'), 'w', encoding='utf-8'),
          separators=(',', ':'), ensure_ascii=False)
shutil.copy(os.path.join(src, 'sat_2026-11-07.jpg'), out)
print(meta, sats, biomas, len(muns))
for n in os.listdir(out):
    print(n, os.path.getsize(os.path.join(out, n)))
