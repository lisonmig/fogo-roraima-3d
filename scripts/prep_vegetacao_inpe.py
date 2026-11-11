"""Map background "Floresta e desmatamento (INPE)": a light class image of Roraima built from the PRODES WMS (TerraBrasilis).
usage: python prep_vegetacao_inpe.py <out_dir>      (run by hand about once a year, after PRODES publishes a new year)
Classes: forest (everything PRODES does not mark), natural non-forest vegetation (lavrado, campinarana: layer no_forest),
deforested up to the last PRODES year (accumulated_deforestation_2007 + yearly_deforestation + residual), water (hydrography).
PRODES covers only Brazil, so everything outside Roraima (outline from <out_dir>/roraima3d.json) is painted as "no data".
Palette with no orange or red: on the map, red is only for fire. Needs numpy and pillow."""
import io, json, os, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image, ImageDraw

OUT = sys.argv[1]
W, S, E, N = -64.85, -1.6, -58.85, 5.3
PW, PH = 1200, 1380   # same size as cobertura.png (MODIS)
COLORS = {'forest': (38, 92, 52), 'nonforest': (176, 168, 118), 'deforested': (196, 196, 196), 'water': (70, 130, 190), 'outside': (60, 62, 66)}

def layer(name):
    q = {'service': 'WMS', 'version': '1.1.1', 'request': 'GetMap', 'layers': 'prodes-legal-amz:' + name, 'styles': '', 'srs': 'EPSG:4326',
         'bbox': f'{W},{S},{E},{N}', 'width': PW, 'height': PH, 'format': 'image/png', 'transparent': 'true'}
    u = 'https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/ows?' + urllib.parse.urlencode(q)
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'uerr-extensao-fire-map/1.0'}), timeout=180) as r:
        data = r.read()
    if not data.startswith(b'\x89PNG'): raise RuntimeError(name + ': ' + data[:200].decode('utf-8', 'replace'))
    return np.array(Image.open(io.BytesIO(data)).convert('RGBA'))[..., 3] > 127

ring = json.load(open(os.path.join(OUT, 'roraima3d.json'), encoding='utf-8'))['rr']
mask_img = Image.new('L', (PW, PH), 0)
ImageDraw.Draw(mask_img).polygon([((x - W) / (E - W) * PW, (N - y) / (N - S) * PH) for x, y in ring], fill=255)
inside = np.array(mask_img) > 127

cls = np.zeros((PH, PW), np.uint8)          # 0 forest
cls[layer('no_forest')] = 1
cls[layer('accumulated_deforestation_2007') | layer('yearly_deforestation') | layer('residual')] = 2
cls[layer('hydrography')] = 3
cls[~inside] = 4
pal = [COLORS[k] for k in ('forest', 'nonforest', 'deforested', 'water', 'outside')]
img = Image.fromarray(cls, 'P'); img.putpalette([v for c in pal for v in c] + [0] * (768 - 3 * len(pal)))
path = os.path.join(OUT, 'vegetacao_inpe.png'); img.save(path, optimize=True)
share = np.bincount(cls[inside], minlength=4)[:4] / inside.sum()
print('share in Roraima: forest %.2f non-forest %.2f deforested %.2f water %.2f' % tuple(share), '| file', os.path.getsize(path))
