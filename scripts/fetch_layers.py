import math, sys, urllib.request, urllib.parse, os
out = sys.argv[1]
W, S, E, N = -74.5, -34.5, -33.5, 6.0
R = 6378137.0
mx = lambda lon: R * math.radians(lon)
my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
bbox = (mx(W), my(S), mx(E), my(N))
width = 3200
height = round(width * (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]))
print('size', width, height)

def get(url, path):
    req = urllib.request.Request(url, headers={'User-Agent': 'fire-map-builder/1.0'})
    with urllib.request.urlopen(req, timeout=180) as r, open(path, 'wb') as f:
        data = r.read(); f.write(data)
    print(path, len(data), r.headers.get('Content-Type'))

for date in sys.argv[2:]:
    q = urllib.parse.urlencode({
        'SERVICE': 'WMS', 'REQUEST': 'GetMap', 'VERSION': '1.3.0',
        'LAYERS': 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'STYLES': '',
        'CRS': 'EPSG:3857', 'BBOX': ','.join(f'{v:.2f}' for v in bbox),
        'WIDTH': width, 'HEIGHT': height, 'FORMAT': 'image/jpeg', 'TIME': date})
    get('https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?' + q,
        os.path.join(out, f'sat_{date}.jpg'))

get('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=UF',
    os.path.join(out, 'ufs.geojson'))
get('https://servicodados.ibge.gov.br/api/v1/localidades/estados',
    os.path.join(out, 'ufs_nomes.json'))
