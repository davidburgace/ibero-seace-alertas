# Genera los JSON por región del Selector IOARR (ver README.md de esta carpeta).
#
# Uso:
#   pip install dbfread
#   python3 scripts/selector-ioarr/build_national.py \
#       --padron  ruta/Padron.dbf \
#       --aulas   ruta/Loc_P61_Aulas.dbf \
#       --anio    2025
#
# Escribe src/public/data/selector-ioarr/<anio>/<region>.json e index.json.
#
# Esquema de cada <region>.json:
#   region, dpto, provs[], ugels[]
#   dists[i] = [nombre, ubigeo, iProvincia]
#   locs[i]  = [codLocal, iDist, iUgel, centroPoblado, rural(0|1), dirección, lat, lon]
#   svcs[i]  = [codModular, nombre, nivel(I|P|S|E), iLocal, convenio(0|1), secciones, alumnos, turno]
#   aulas[i] = [iLocal, iSvc, edificación, piso, número, grado, sección, turno, estudiantes,
#               compartida(0|1), variosServiciosDelNivel(0|1), f0..f19]
#   f: 0-2 mesa unip. B/R/M · 3-5 mesa múltiple B/R/M · 6 carpeta unip. · 7 carpeta bip.
#      8-10 silla B/R/M · 11-13 escritorio · 14-16 silla docente · 17-19 armario/estante
import argparse, json, os, re, unicodedata, collections
from dbfread import DBF

ap = argparse.ArgumentParser(description='Datos del Selector IOARR (Padrón ESCALE + Censo Educativo, pregunta 6.1)')
ap.add_argument('--padron', required=True, help='Padron.dbf de ESCALE')
ap.add_argument('--aulas', required=True, help='Loc_P61_Aulas.dbf del Censo Educativo (Local escolar)')
ap.add_argument('--anio', required=True, type=int, help='año del censo; es el nombre de la carpeta de salida')
ap.add_argument('--fuente', default=None, help='texto de fuentes para index.json')
ap.add_argument('--salida', default=None, help='carpeta de salida (por defecto src/public/data/selector-ioarr/<anio>/)')
args = ap.parse_args()
RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = (args.salida or os.path.join(RAIZ, 'src', 'public', 'data', 'selector-ioarr', str(args.anio))).rstrip('/') + '/'
os.makedirs(OUT, exist_ok=True)

def slug(s): return re.sub(r'[^a-z0-9]+','-',unicodedata.normalize('NFD',s).encode('ascii','ignore').decode().lower()).strip('-')
def title(s):
    ws = s.lower().split()
    return ' '.join(w.capitalize() if (len(w)>2 or i==0) else w for i,w in enumerate(ws))
REGN = {'ANCASH':'Áncash','APURIMAC':'Apurímac','HUANUCO':'Huánuco','JUNIN':'Junín','SAN MARTIN':'San Martín','LA LIBERTAD':'La Libertad'}
def rname(d): return REGN.get(d, title(d))

NIV = {'Inicial - Jardín':'I','Inicial - Cuna-jardín':'I','Primaria':'P','Secundaria':'S','Básica Especial-Primaria':'E','Básica Especial-Inicial':'E','Básica Especial':'E'}
LVC = {'A1':'I','A2':'I','A3':'I','B0':'P','F0':'S','E1':'E','E2':'E'}

# ---- padrón nacional (público, escolarizado, niveles en alcance)
svcs = {}
for r in DBF(args.padron, encoding='latin-1', load=False):
    if not r['D_GESTION'].startswith('Pública') or r['D_FORMA']!='Escolarizada' or r['D_ESTADO']!='Activo': continue
    nv = NIV.get(r['D_NIV_MOD'])
    if not nv: continue
    svcs[r['COD_MOD']] = dict(mod=r['COD_MOD'].strip(), nom=r['CEN_EDU'].strip(), niv=nv, loc=r['CODLOCAL'].strip(),
        ges=0 if r['D_GESTION']=='Pública de gestión directa' else 1, tsec=int(r['TSEC'] or 0), talum=int(r['TALUM'] or 0),
        tur=r['D_COD_TUR'].strip(), dpto=r['D_DPTO'].strip(), prov=r['D_PROV'].strip(), dist=r['D_DIST'].strip(), ubi=r['CODGEO'].strip(),
        ugel=r['D_DREUGEL'].strip(), cp=r['CEN_POB'].strip(), area=1 if r['DAREACENSO'].strip()=='Rural' else 0,
        dir=r['DIR_CEN'].strip(), lat=r['NLAT_IE'].strip(), lon=r['NLONG_IE'].strip())
print('servicios en alcance (nacional):', len(svcs))

# ---- aulas nacionales de los locales en alcance
byloc = collections.defaultdict(dict)   # loc -> nivel -> [cod_mod]
for s in svcs.values(): byloc[s['loc']].setdefault(s['niv'], []).append(s['mod'])
def n(d,k):
    try: return int(d[k] or 0)
    except: return 0
def grado(niv, g):
    g=(g or '').strip()
    if not g: return ''
    if niv=='I': return {'3':'Inicial 3 años','4':'Inicial 4 años','5':'Inicial 5 años'}.get(g,'Inicial multiedad')
    if niv=='P' and g in list('123456'): return f'{g}° Primaria'
    if niv=='S' and g in list('12345'): return f'{g}° Secundaria'
    return 'Multigrado'
aulas = collections.defaultdict(list)   # cod_mod elegido -> filas
stat = collections.Counter()
for d in DBF(args.aulas, encoding='latin-1', load=False):
    loc = d['CODLOCAL'].strip()
    if loc not in byloc: continue
    if d['P61_3']!='1': stat['no_en_uso']+=1; continue
    cand=[]
    for k,t in ((1,'Mañana'),(2,'Tarde'),(3,'Noche')):
        code=d[f'P61_5_{k}1'].strip()
        if code in LVC and LVC[code] in byloc[loc]:
            cand.append((t, LVC[code], d[f'P61_5_{k}2'].strip(), d[f'P61_5_{k}3'].strip(), n(d,f'P61_5_{k}4')))
    if not cand: stat['fuera_alcance']+=1; continue
    best = max(cand, key=lambda x:(x[4], -cand.index(x)))
    t,lv,g,sec,num = best
    mods = byloc[loc][lv]; mod = mods[0]
    tset=[]
    for x in cand:
        if x[0] not in tset: tset.append(x[0])
    f = [n(d,'P61_16_2'),n(d,'P61_16_3'),n(d,'P61_16_4'), n(d,'P61_17_2'),n(d,'P61_17_3'),n(d,'P61_17_4'), n(d,'P61_18'), n(d,'P61_19'),
         n(d,'P61_20_2'),n(d,'P61_20_3'),n(d,'P61_20_4'), n(d,'P61_22_11'),n(d,'P61_22_12'),n(d,'P61_22_13'),
         n(d,'P61_22_21'),n(d,'P61_22_22'),n(d,'P61_22_23'),
         n(d,'P61_22_31')+n(d,'P61_22_41'), n(d,'P61_22_32')+n(d,'P61_22_42'), n(d,'P61_22_33')+n(d,'P61_22_43')]
    aulas[mod].append([loc, d['ID_EDIF'].strip(), n(d,'P61_2'), str(int(d['NUMERO'])), grado(lv,g), sec,
                       tset[0] if len(tset)==1 else 'Mañana y tarde', max(x[4] for x in cand), 1 if len(cand)>1 else 0,
                       1 if len(mods)>1 else 0] + f)
    stat['cargadas']+=1
print(dict(stat))

# ---- un archivo por región
regs = collections.defaultdict(list)
for s in svcs.values(): regs[s['dpto']].append(s)
index=[]
def ok(lat,lon):
    try: a=float(lat); b=float(lon)
    except: return None
    return (round(a,5),round(b,5)) if -19<a<1 and -82<b<-68 else None
for dpto, lst in sorted(regs.items()):
    lst.sort(key=lambda s:(s['prov'],s['dist'],s['loc'],s['niv'],s['mod']))
    provs=sorted({s['prov'] for s in lst}); ugels=sorted({s['ugel'] for s in lst})
    dists=sorted({(s['dist'],s['ubi'],s['prov']) for s in lst})
    di={(a,b,c):i for i,(a,b,c) in enumerate(dists)}
    locs=[]; li={}
    for s in lst:
        if s['loc'] in li: continue
        li[s['loc']]=len(locs)
        same=[x for x in lst if x['loc']==s['loc']]
        pts=[p for p in (ok(x['lat'],x['lon']) for x in same) if p]
        lat=round(sum(p[0] for p in pts)/len(pts),5) if pts else None; lon=round(sum(p[1] for p in pts)/len(pts),5) if pts else None
        locs.append([s['loc'], di[(s['dist'],s['ubi'],s['prov'])], ugels.index(s['ugel']), s['cp'], s['area'], s['dir'], lat, lon])
    sl=[]; si={}
    for s in lst:
        si[s['mod']]=len(sl)
        sl.append([s['mod'], s['nom'], s['niv'], li[s['loc']], s['ges'], s['tsec'], s['talum'], s['tur']])
    al=[]
    for s in lst:
        for a in aulas.get(s['mod'],[]):
            al.append([li[a[0]], si[s['mod']]] + a[1:])
    data={'region':rname(dpto),'dpto':dpto,'provs':[title(p) for p in provs],'ugels':[title(u).replace('Ugel','UGEL').replace('Gre ','GRE ').replace('Dre ','DRE ') for u in ugels],
          'dists':[[title(a),b,provs.index(c)] for a,b,c in dists],'locs':locs,'svcs':sl,'aulas':al}
    fn=slug(dpto)+'.json'
    json.dump(data, open(OUT+fn,'w',encoding='utf-8'), ensure_ascii=False, separators=(',',':'))
    index.append({'nombre':rname(dpto),'archivo':fn,'locales':len(locs),'servicios':len(sl),'aulas':len(al),'kb':os.path.getsize(OUT+fn)//1024})
fuente = args.fuente or f'Padrón de ESCALE – Minedu y Censo Educativo {args.anio} (Local escolar, pregunta 6.1)'
json.dump({'fuente':fuente,'anio':args.anio,'regiones':index}, open(OUT+'index.json','w',encoding='utf-8'), ensure_ascii=False, separators=(',',':'))
for r in index: print(r)
print('total MB:', sum(r['kb'] for r in index)/1024)
