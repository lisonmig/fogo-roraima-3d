"""Layers used only by the per-area report ("Relatório da área"), clipped to Roraima, in light files under docs/rel/.
usage: python prep_relatorio.py <raw_dir> <out_dir> [--fixas] [--dinamicas]
  --fixas      layers that change rarely (run by hand, about once a year): public forests (SFB/CNFP),
               conservation units (MMA/CNUC), soils and geology (IBGE), population grid (IBGE Census 2022),
               health units (CNES), fire recurrence 2003-2025 (INPE reference satellite), and the fires of each year
               (rel/anos/<ano>.json, used when a year is clicked in the report).
               Needs the raw files already in <raw_dir> (see RAW_FILES) and the packages pyshp and pyproj.
  --dinamicas  IBAMA embargoes and SINAFLOR vegetation removal permits; downloaded again every 30 days.
  --anos       only the fires of each year 2003-2025 (rel/anos/), from the raw INPE reference-satellite files.
With no option, runs both. Personal data (names, CPF/CNPJ, property names, free-text descriptions) is never written."""
import csv, io, json, os, re, sys, time, zipfile, urllib.request, datetime as dt
from shapely.geometry import shape, Polygon, MultiPolygon, box
from shapely import wkt

RAW, OUT = sys.argv[1], os.path.join(sys.argv[2], 'rel')
os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
ARGS = set(sys.argv[3:])
DO_FIX = '--fixas' in ARGS or not ARGS & {'--fixas', '--dinamicas', '--anos'}
DO_DYN = '--dinamicas' in ARGS or not ARGS & {'--fixas', '--dinamicas', '--anos'}
DO_ANOS = DO_FIX or '--anos' in ARGS
W, E, S, N = -64.85, -58.85, -1.6, 5.3
BB = box(W, S, E, N)
UA = {'User-Agent': 'uerr-extensao-fire-map/1.0'}
Q = 1e4  # coordinates stored as integers of 0.0001 degree (~11 m), delta-encoded

def rr_shape():
    for p in [os.path.join(RAW, 'rr.geojson'), os.path.join(os.path.dirname(RAW.rstrip('/\\')), 'dados-3d', 'rr.geojson'), 'dados-3d/rr.geojson']:
        if os.path.exists(p):
            b = open(p, 'rb').read()
            if b[:2] == b'\x1f\x8b':
                import gzip; b = gzip.decompress(b)
            g = json.loads(b.decode('utf-8'))
            g = g['features'][0]['geometry'] if 'features' in g else g.get('geometry', g)
            return shape(g).buffer(0.02)
    return BB
RR = rr_shape()

def enc(g, tol):
    """Polygon or MultiPolygon -> list of delta-encoded integer rings (outer rings only, like car_todos.json)."""
    g = g.simplify(tol, preserve_topology=True)
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    rings = []
    for p in polys:
        cs = [(round((x - W) * Q), round((y - S) * Q)) for x, y in p.exterior.coords]
        cs = [v for k, v in enumerate(cs) if k == 0 or v != cs[k - 1]]
        if len(cs) < 4: continue
        flat = [cs[0][0], cs[0][1]]
        for (x0, y0), (x1, y1) in zip(cs, cs[1:]): flat += [x1 - x0, y1 - y0]
        rings.append(flat)
    return rings

def save(name, obj):
    path = os.path.join(OUT, name)
    json.dump(obj, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print(f'{name}: {os.path.getsize(path) // 1024} KB')

def clip(g):
    if not g.is_valid: g = g.buffer(0)
    if not g.intersects(RR): return None
    g = g.intersection(RR)
    return None if g.is_empty or g.area < 1e-7 else g

def txt(v):
    return ' '.join(str(v).split()) if v not in (None, '') else ''

def num(v):
    try: return float(str(v).replace(',', '.'))
    except Exception: return None

def get(url, path, max_age_days=None, timeout=1800):
    fresh = os.path.exists(path) and os.path.getsize(path) > 0 and (max_age_days is None or time.time() - os.path.getmtime(path) < max_age_days * 86400)
    if not fresh:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r, open(path + '.part', 'wb') as fo:
            while True:
                b = r.read(1 << 20)
                if not b: break
                fo.write(b)
        os.replace(path + '.part', path)
    return path

TODAY = dt.date.today().isoformat()

# ======================= fixed layers =======================
def fire_years():
    """Fires of the INPE reference satellite in Roraima, one file per year (rel/anos/2003.json ... 2025.json).
    Each fire is 4 integers: ~1 km cell (ix, iy, same grid as recorrencia.json), day of the year and hour (UTC).
    The report loads only the year that is clicked and sums the fires inside the area."""
    G = 0.01; d = os.path.join(OUT, 'anos'); os.makedirs(d, exist_ok=True)
    for y in range(2003, 2026):
        zp = os.path.join(RAW, f'focos_ref_{y}.zip')
        if not os.path.exists(zp): continue
        f = []; z = zipfile.ZipFile(zp)
        with z.open(z.namelist()[0]) as fh:
            for r in csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', errors='replace')):
                if 'RORAIMA' not in (r.get('estado') or '').upper(): continue
                lat, lon = num(r['lat']), num(r['lon'])
                if lat is None or lon is None: continue
                try: t = dt.datetime.strptime((r.get('data_pas') or '').strip()[:16], '%Y-%m-%d %H:%M')
                except ValueError: continue
                f += [round((lon - W) / G), round((lat - S) / G), t.timetuple().tm_yday, t.hour]
        json.dump({'ano': y, 'fonte': 'INPE, Programa Queimadas, focos do satélite de referência', 'gerado': TODAY, 'g': G, 'origin': [W, S],
                   'campos': ['ix', 'iy', 'dia_do_ano', 'hora_utc'], 'f': f}, open(os.path.join(d, f'{y}.json'), 'w', encoding='utf-8'), separators=(',', ':'))
        print(f'anos/{y}.json: {len(f) // 4} focos, {os.path.getsize(os.path.join(d, f"{y}.json")) // 1024} KB')

if DO_ANOS:
    try: fire_years()
    except Exception as e: print('fire years failed:', e)

if DO_FIX:
    import shapefile  # pyshp

    def shp_layer(path, tol, keep, enc_name='utf-8'):
        r = shapefile.Reader(path, encoding=enc_name, encodingErrors='replace')
        names = [f[0] for f in r.fields[1:]]
        out = []
        for sr in r.iterShapeRecords(bbox=[W, S, E, N]):
            if not sr.shape.points: continue
            g = clip(shape(sr.shape.__geo_interface__))
            if g is None: continue
            rec = dict(zip(names, sr.record))
            row = keep(rec, g)
            if row is None: continue
            rings = enc(g, tol)
            if rings: out.append(row + [rings])
        return out

    # ---- public forests (Cadastro Nacional de Florestas Públicas 2025, Serviço Florestal Brasileiro)
    # includes indigenous lands, conservation units, settlements and public land not yet assigned ("sem destinação")
    try:
        cnfp = shp_layer(os.path.join(RAW, 'cnfp', 'CNFP_2025'), 0.0008, lambda p, g: [txt(p['nome']), txt(p['categoria']), txt(p['protecao']), txt(p['tipo']), txt(p['governo']),
                         txt(p['classe']), txt(p['orgao']), txt(p['estagio']), round(g.area * 111.32 * 110.57 * 100 * 0.9988)])
        save('florestas_publicas.json', {'q': Q, 'origin': [W, S], 'fonte': 'Cadastro Nacional de Florestas Públicas 2025, Serviço Florestal Brasileiro', 'gerado': TODAY,
              'campos': ['nome', 'categoria', 'protecao', 'tipo', 'governo', 'classe', 'orgao', 'estagio', 'ha_aprox_em_RR', 'aneis'], 'itens': cnfp})
    except Exception as e: print('CNFP failed:', e)

    # ---- conservation units (CNUC, Ministério do Meio Ambiente, Aug 2025)
    try:
        ucs = shp_layer(os.path.join(RAW, 'cnuc', 'cnuc_2025_08'), 0.0008, lambda p, g: [txt(p['nome_uc']).title(), txt(p['categoria']), txt(p['grupo']), txt(p['esfera']),
                        txt(p['cria_ano'])[-4:], txt(p['cria_ato']), txt(p['org_gestor']).title(), txt(p['pl_manejo']), num(p['ha_total'])])
        save('ucs.json', {'q': Q, 'origin': [W, S], 'fonte': 'Cadastro Nacional de Unidades de Conservação (MMA), agosto de 2025', 'gerado': TODAY,
              'campos': ['nome', 'categoria', 'grupo', 'esfera', 'ano', 'ato', 'gestor', 'plano_manejo', 'ha', 'aneis'], 'itens': ucs})
    except Exception as e: print('CNUC failed:', e)

    # ---- soils and geology (IBGE, BDiA 1:250.000, WFS)
    for lay, fname, fn in [('pedo_area', 'solos.json', lambda p: [txt(p.get('legenda')), txt(p.get('ordem')), txt(p.get('subordem')), txt(p.get('textura')), txt(p.get('relevo'))]),
                           ('geol_area', 'geologia.json', lambda p: [txt(p.get('nm_unidade')), txt(p.get('letra_simb')), txt(p.get('nm_tempo_g')), txt(p.get('nm_provincia'))])]:
        try:
            path = get('https://geoservicos.ibge.gov.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=BDIA:' + lay +
                       f'&outputFormat=application/json&bbox={W},{S},{E},{N}', os.path.join(RAW, f'ibge_{lay}.json'))
            fc = json.load(open(path, encoding='utf-8'))
            items = []
            for f in fc['features']:
                if not f.get('geometry'): continue
                g = clip(shape(f['geometry']))
                if g is None: continue
                rings = enc(g, 0.002)
                if rings: items.append(fn(f['properties']) + [rings])
            save(fname, {'q': Q, 'origin': [W, S], 'fonte': 'IBGE, Banco de Informações Ambientais (BDiA), escala 1:250.000', 'gerado': TODAY, 'itens': items})
        except Exception as e: print(lay, 'failed:', e)

    # ---- population: IBGE statistical grid, Census 2022, 1 km cells (only the attribute table is needed: the cell name holds its position)
    try:
        from pyproj import Transformer
        # IBGE grid projection: Albers equal-area, SIRGAS 2000, central meridian -54, origin -12, standard parallels -2 and -22, false E 5000 km, false N 10000 km
        tr = Transformer.from_crs('+proj=aea +lat_0=-12 +lon_0=-54 +lat_1=-2 +lat_2=-22 +x_0=5000000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs', 'EPSG:4674', always_xy=True)
        dbf = os.path.join(RAW, 'grade', 'BR1KM.dbf')
        if not os.path.exists(dbf):
            zipfile.ZipFile(os.path.join(RAW, 'ibge_grade1km.zip')).extract('BR1KM.dbf', os.path.join(RAW, 'grade'))
        d = shapefile.Reader(dbf=open(dbf, 'rb'))
        cells = []
        for rec in d.iterRecords(fields=['nome_1KM', 'TOTAL', 'TOTAL_DOM']):
            pop = rec[1] or 0
            if pop <= 0: continue
            m = re.match(r'1KME(\d+)N(\d+)', rec[0])
            if not m: continue
            e_km, n_km = int(m.group(1)), int(m.group(2))
            lon, lat = tr.transform((e_km + 0.5) * 1000, (n_km + 0.5) * 1000)
            if W <= lon <= E and S <= lat <= N and RR.contains(Polygon([(lon - .005, lat - .005), (lon + .005, lat - .005), (lon + .005, lat + .005), (lon - .005, lat + .005)]).centroid):
                cells.append([round(lon, 4), round(lat, 4), int(pop), int(rec[2] or 0)])
        save('populacao.json', {'fonte': 'IBGE, Grade Estatística do Censo 2022 (quadrados de 1 km)', 'gerado': TODAY, 'campos': ['lon', 'lat', 'pessoas', 'domicilios'], 'itens': cells})
        print('  people in RR grid:', sum(c[2] for c in cells))
    except Exception as e: print('population grid failed:', e)

    # ---- health units (CNES): public or SUS units only; private one-person offices are left out
    try:
        rows = json.load(open(os.path.join(RAW, 'cnes_rr_full.json'), encoding='utf-8'))
        TIPOS = {'1': 'Posto de saúde', '2': 'Centro de saúde / UBS', '5': 'Hospital geral', '7': 'Hospital especializado', '15': 'Unidade mista', '20': 'Pronto-socorro geral',
                 '21': 'Pronto-socorro especializado', '32': 'Unidade móvel fluvial', '40': 'Unidade móvel terrestre', '42': 'Unidade móvel de urgência', '62': 'Hospital/dia',
                 '71': 'Centro de apoio à saúde da família', '73': 'Pronto atendimento', '74': 'Polo academia da saúde'}
        items = []
        for r in rows:
            t = str(int(r['TP_UNIDADE'])) if (r.get('TP_UNIDADE') or '').strip().isdigit() else ''
            lat, lon = num(r.get('NU_LATITUDE')), num(r.get('NU_LONGITUDE'))
            if t not in TIPOS or lat is None or lon is None or not (W <= lon <= E and S <= lat <= N): continue
            items.append([txt(r.get('NO_FANTASIA')).title(), TIPOS[t], round(lon, 5), round(lat, 5), 1 if (r.get('ST_ATEND_HOSPITALAR') or '') == '1' else 0])
        save('saude.json', {'fonte': 'Cadastro Nacional de Estabelecimentos de Saúde (CNES/DATASUS)', 'gerado': TODAY, 'campos': ['nome', 'tipo', 'lon', 'lat', 'internacao'], 'itens': items})
    except Exception as e: print('CNES failed:', e)

    # ---- fire recurrence 2003-2025: in which years each ~1 km cell had a fire from the INPE reference satellite (comparable across years)
    try:
        G = 0.01; cells = {}; years = []
        for y in range(2003, 2026):
            zp = os.path.join(RAW, f'focos_ref_{y}.zip')
            if not os.path.exists(zp): continue
            years.append(y); bit = 1 << (y - 2003)
            z = zipfile.ZipFile(zp)
            with z.open(z.namelist()[0]) as fh:
                for r in csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', errors='replace')):
                    if 'RORAIMA' not in (r.get('estado') or '').upper(): continue
                    lat, lon = num(r['lat']), num(r['lon'])
                    if lat is None: continue
                    k = (round((lon - W) / G), round((lat - S) / G))
                    cells[k] = cells.get(k, 0) | bit
        save('recorrencia.json', {'fonte': 'INPE, Programa Queimadas, focos do satélite de referência (AQUA tarde / NOAA)', 'gerado': TODAY, 'g': G, 'origin': [W, S], 'ano0': 2003,
              'anos': years, 'campos': ['ix', 'iy', 'anos_bits'], 'itens': [[k[0], k[1], v] for k, v in cells.items()]})
    except Exception as e: print('recurrence failed:', e)

# ======================= dynamic layers (every 30 days) =======================
# The results are also kept in <raw_dir>/rel_cache (saved between GitHub Actions runs), so the 200 MB IBAMA file
# is read again only when the 30 days are over; in between, the saved results are just copied to docs/rel.
DYN_FILES = ['embargos.json', 'asv.json']
CACHE_DIR = os.path.join(RAW, 'rel_cache')
if DO_DYN:
    import shutil
    stamp = os.path.join(CACHE_DIR, 'feito_em.txt')
    if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 30 * 86400 and all(os.path.exists(os.path.join(CACHE_DIR, f)) for f in DYN_FILES):
        for f in DYN_FILES: shutil.copy(os.path.join(CACHE_DIR, f), os.path.join(OUT, f))
        print('embargoes and permits: using the copy saved on', open(stamp).read().strip())
        DO_DYN = False
if DO_DYN:
    # ---- IBAMA embargoes in Roraima, with the embargoed polygon when published. No names, CPF/CNPJ, property name or free text.
    try:
        p = get('https://stibamadadosabertosprd.blob.core.windows.net/dados-abertos/dados/TERMOS_DE_EMBARGO/TERMO_EMBARGO/termo_de_embargo.csv',
                os.path.join(RAW, 'ibama_embargo.csv'), max_age_days=30)
        items = []
        csv.field_size_limit(1 << 30)
        with open(p, encoding='utf-8-sig', errors='replace') as fh:
            for r in csv.DictReader(fh, delimiter=';'):
                if r.get('UF') != 'RR' or r.get('SIT_CANCELADO') == 'S': continue
                g = None
                if (r.get('GEOM_AREA_EMBARGADA') or '').strip():
                    try: g = clip(wkt.loads(r['GEOM_AREA_EMBARGADA']))
                    except Exception: g = None
                lon, lat = num(r.get('NUM_LONGITUDE_TAD')), num(r.get('NUM_LATITUDE_TAD'))
                if g is None and (lon is None or lat is None or not (W <= lon <= E and S <= lat <= N)): continue
                d = (r.get('DAT_EMBARGO') or '')[:10]
                if d[:2] not in ('19', '20'): d = ''  # some records have typing errors in the year (e.g. 2925)
                des = (r.get('SIT_DESEMBARGO') or '').strip()
                items.append([txt(r.get('NUM_TAD')), d, txt(r.get('MUNICIPIO')).title(), num(r.get('QTD_AREA_EMBARGADA')), txt(r.get('TIPO_AREA')),
                              'desembargado' if des and des.upper() not in ('N', 'NAO', 'NÃO') else 'ativo', (r.get('DAT_DESEMBARGO') or '')[:10],
                              txt(r.get('DETER_PRODES')), txt(r.get('NUM_AUTO_INFRACAO')), txt(r.get('UNID_CONTROLE')),
                              [round(lon, 5), round(lat, 5)] if lon is not None and lat is not None else None, enc(g, 0.0003) if g is not None else []])
        save('embargos.json', {'q': Q, 'origin': [W, S], 'fonte': 'IBAMA, Termos de Embargo (dados abertos), sem nomes nem CPF/CNPJ', 'gerado': TODAY,
              'campos': ['termo', 'data', 'municipio', 'ha', 'tipo_area', 'situacao', 'data_desembargo', 'origem_deter_prodes', 'auto_infracao', 'unidade', 'ponto', 'aneis'], 'itens': items})
    except Exception as e: print('IBAMA embargoes failed:', e)

    # ---- SINAFLOR vegetation removal permits (ASV) in Roraima: number, dates, purpose, area, CAR code and point. No holder names.
    try:
        p = get('https://stibamadadosabertosprd.blob.core.windows.net/dados-abertos/dados/SINAFLOR/AutSuprVegetacao/sinaflor-autorizacao-de-supressao-de-vegetacao.csv',
                os.path.join(RAW, 'sinaflor_asv.csv'), max_age_days=30)
        seen, items = set(), []
        with open(p, encoding='utf-8-sig', errors='replace') as fh:
            for r in csv.DictReader(fh, delimiter=';'):
                if r.get('UF') != 'RR': continue
                key = r.get('NRO_AUTORIZACAO')
                if key in seen: continue  # one row per technician in the source
                seen.add(key)
                lat, lon = num(r.get('LATITUDE_PONTO_CENTR_EMPREEND')), num(r.get('LONGITUDE_PONTO_CENTR_EMPREEND'))
                br = lambda s: '-'.join(reversed((s or '')[:10].split('/'))) if s else ''
                items.append([txt(key), br(r.get('DATA_DE_EMISSAO')), br(r.get('DATA_DE_VALIDADE')), txt(r.get('MUNICIPIO')).title(), txt(r.get('NRO_CAR_IMOVEL_RURAL')),
                              txt(r.get('FINALIDADE_SUPRESSAO')), num(r.get('AREA_TOTAL_PROJ')), txt(r.get('SITUACAO')), txt(r.get('ORGAO_AMBIENTAL_RESP_ANALISE')),
                              [round(lon, 5), round(lat, 5)] if lon is not None and lat is not None and W <= lon <= E and S <= lat <= N else None])
        save('asv.json', {'fonte': 'IBAMA, SINAFLOR, Autorizações de Supressão de Vegetação (dados abertos), sem nomes nem CPF/CNPJ', 'gerado': TODAY,
              'campos': ['autorizacao', 'emissao', 'validade', 'municipio', 'car', 'finalidade', 'ha', 'situacao', 'orgao', 'ponto'], 'itens': items})
    except Exception as e: print('SINAFLOR failed:', e)

    # keep a copy for the next runs (see CACHE_DIR above)
    if all(os.path.exists(os.path.join(OUT, f)) for f in DYN_FILES):
        os.makedirs(CACHE_DIR, exist_ok=True)
        for f in DYN_FILES: shutil.copy(os.path.join(OUT, f), os.path.join(CACHE_DIR, f))
        open(os.path.join(CACHE_DIR, 'feito_em.txt'), 'w').write(TODAY)
