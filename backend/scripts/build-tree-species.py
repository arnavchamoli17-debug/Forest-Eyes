"""
Builds data/tree-species.json: growing requirements for the trees the Forest Eyes tree planner
checks, taken from the FAO ECOCROP database as packaged in the Recocrop R package
(inst/parameters/ecocrop.rds, 1710 taxa).

For each tree it keeps, in ECOCROP's own units:
  temp     [absolute min, optimal min, optimal max, absolute max]  mean temperature, °C,
           during the growing season (seasonMonths long; ECOCROP GMIN/GMAX in seasonDays)
  killC    killing temperature during rest, °C (null: ECOCROP stores 0 for "no input")
  rain     [absolute min, optimal min, optimal max, absolute max]  annual rainfall, mm
  ph       [absolute min, optimal min, optimal max, absolute max]  soil pH (water)
  light    optimal and absolute range of light classes 1-5:
           1 very bright, 2 clear skies, 3 cloudy skies, 4 light shade, 5 heavy shade
  texture  optimal and absolute soil texture: H heavy, M medium, L light, O organic
           (ECOCROP "W" = wide = H M L)
  drainage optimal drainage: P poorly, I imperfectly, W well, E excessive
Rows whose ranges are not in order (data-entry errors) are rejected.

The species list below is ours: trees only, one row each, India-first plus common trees of
other regions. Common exotics with a record of spreading outside their native range
(Prosopis juliflora, Leucaena leucocephala, Ailanthus altissima, Robinia pseudoacacia,
Acacia mearnsii, Eucalyptus spp., Casuarina, Grevillea robusta, Cinnamomum camphora)
are left out on purpose. Native ranges are added separately from Kew's WCVP
(scripts/build-native-ranges.js -> data/tree-native.json).

Usage:  python -I scripts/build-tree-species.py ecocrop.rds data/tree-species.json
Needs:  pip install rdata pandas
Data:   FAO ECOCROP, via Hijmans, R.J. Recocrop (github.com/cropmodels/Recocrop, GPL-3).
        "These parameters are expert opinion and not necessarily optimal." (Recocrop docs)
"""
import json
import sys

import rdata

# ECOCROP SCIENTNAME (exact) → id, accepted name (when ECOCROP uses a synonym), English name,
# Indian name (None when unsure). Native ranges come from Kew (scripts/build-native-ranges.js).
SPECIES = [
    ('Azadirachta indica A. Juss.', 'neem', None, 'Neem', 'Neem'),
    ('Tectona grandis L.f.', 'teak', None, 'Teak', 'Sagwan'),
    ('Shorea robusta Gaertn. f.', 'sal', None, 'Sal', 'Sal'),
    ('Dalbergia sissoo Roxb.', 'shisham', None, 'Indian rosewood', 'Shisham'),
    ('Terminalia arjuna (Roxb.) W', 'arjun', 'Terminalia arjuna', 'Arjuna', 'Arjun'),
    ('Mangifera indica L.', 'mango', None, 'Mango', 'Aam'),
    ('Ficus benghalensis L.', 'banyan', None, 'Banyan', 'Bargad'),
    ('Cedrus deodara Loudon', 'deodar', None, 'Deodar cedar', 'Deodar'),
    ('Pinus roxburghii Sarg.', 'chir-pine', None, 'Chir pine', 'Chir'),
    ('Acacia nilotica (L.) Willd.', 'babul', 'Vachellia nilotica', 'Gum arabic tree (babul)', 'Babool'),
    ('Prosopis cineraria (L.) Dr.', 'khejri', None, 'Khejri', 'Khejri'),
    ('Anthocephalus chinensis Lam', 'kadam', 'Neolamarckia cadamba', 'Burflower tree', 'Kadam'),
    ('Delonix regia (Boj.ex Hook)', 'gulmohar', 'Delonix regia', 'Flame tree', 'Gulmohar'),
    ('Cassia fistula L.', 'amaltas', None, 'Golden shower', 'Amaltas'),
    ('Tamarindus indica L.', 'tamarind', None, 'Tamarind', 'Imli'),
    ('Albizia lebbeck (L.) Benth.', 'siris', None, 'Siris', 'Siris'),
    ('Populus deltoides Bartr.', 'poplar', None, 'Eastern cottonwood (poplar)', 'Poplar'),
    ('Juglans regia L.', 'walnut', None, 'Walnut', 'Akhrot'),
    ('Alnus nepalensis D. Don', 'utis', None, 'Nepalese alder', 'Utis'),
    ('Moringa oleifera Lam.', 'moringa', None, 'Drumstick tree', 'Sahjan'),
    ('Gmelina arborea Roxb.', 'gamhar', None, 'Gmelina', 'Gamhar'),
    ('Melia azedarach L.', 'bakain', None, 'Chinaberry', 'Bakain'),
    ('Bombax ceiba L.', 'semal', None, 'Red silk-cotton tree', 'Semal'),
    ('Butea monosperma (Lamk) Ta.', 'palash', 'Butea monosperma', 'Flame of the forest', 'Palash'),
    ('Aegle marmelos Cottea', 'bael', 'Aegle marmelos', 'Bael', 'Bael'),
    ('Phyllanthus emblica L.', 'amla', None, 'Indian gooseberry', 'Amla'),
    ('Artocarpus heterophyllus L.', 'jackfruit', None, 'Jackfruit', 'Kathal'),
    ('Michelia champaca L.', 'champa', 'Magnolia champaca', 'Champak', 'Champa'),
    ('Toona ciliata M.J. Roem', 'toon', None, 'Red cedar', 'Tun'),
    ('Acacia catechu (L.f.) Will', 'khair', 'Senegalia catechu', 'Cutch tree', 'Khair'),
    ('Morus alba  L.', 'mulberry', 'Morus alba', 'White mulberry', 'Shahtoot'),
    ('Terminalia chebula Retz.', 'harad', None, 'Chebulic myrobalan', 'Harad'),
    ('Terminalia belerica Roxb.', 'bahera', 'Terminalia bellirica', 'Belleric myrobalan', 'Bahera'),
    ('Pterocarpus marsupium Roxb.', 'bijasal', None, 'Indian kino tree', 'Bijasal'),
    ('Pterocarpus santalinus L.f.', 'red-sanders', None, 'Red sanders', 'Lal chandan'),
    ('Santalum album L.', 'sandalwood', None, 'Indian sandalwood', 'Chandan'),
    ('Hardwickia binata Roxb.', 'anjan', None, 'Hardwickia', 'Anjan'),
    ('Anogeissus latifolia Roxb.', 'axlewood', None, 'Axlewood', None),
    ('Adina cordifolia Hook. f.', 'haldu', 'Haldina cordifolia', 'Haldu', 'Haldu'),
    ('Quercus incana Roxb.', 'banj-oak', 'Quercus leucotrichophora', 'Banj oak', 'Banj'),
    ('Quercus dilatata Lindl.', 'moru-oak', 'Quercus floribunda', 'Moru oak', 'Moru'),
    ('Quercus semecarpifolia Smi.', 'kharsu-oak', 'Quercus semecarpifolia', 'Brown oak', 'Kharsu'),
    ('Picea morida Link.', 'himalayan-spruce', 'Picea smithiana', 'West Himalayan spruce', None),
    ('Abies pindrow Spach.', 'pindrow-fir', 'Abies pindrow', 'West Himalayan fir', None),
    ('Cupressus torulosa Don', 'himalayan-cypress', 'Cupressus torulosa', 'Himalayan cypress', 'Surai'),
    ('Aesculus indica Griff.', 'horse-chestnut', 'Aesculus indica', 'Indian horse chestnut', None),
    ('Pinus kesiya Royle ex Gord.', 'khasi-pine', 'Pinus kesiya', 'Khasi pine', None),
    ('Derris indica (Lam.) Bennet', 'karanj', 'Pongamia pinnata', 'Indian beech (pongamia)', 'Karanj'),
    ('Bassia latifolia Roxb.', 'mahua', 'Madhuca longifolia var. latifolia', 'Mahua', 'Mahua'),
    ('Ziziphus mauritianus Lamk.', 'ber', 'Ziziphus mauritiana', 'Indian jujube', 'Ber'),
    ('Alstonia scholaris (L)R.Br.', 'saptaparni', 'Alstonia scholaris', 'Devil tree', 'Saptaparni'),
    ('Schleichera oleosa (Lour.)', 'kusum', 'Schleichera oleosa', 'Ceylon oak', 'Kusum'),
    ('Diospyros melanoxylon Roxb.', 'tendu', None, 'Coromandel ebony', 'Tendu'),
    ('Dipterocarpus turbinatus G.', 'gurjan', 'Dipterocarpus turbinatus', 'Gurjan', 'Gurjan'),
    ('Mesua ferrea L.', 'nagkesar', None, 'Ceylon ironwood', 'Nagkesar'),
    ('Hopea odorata Roxb.', 'thingan', None, 'Thingan', None),
    ('Calophyllum inophyllum L.', 'polang', None, 'Alexandrian laurel', 'Undi'),
    ('Swietenia macrophylla King', 'mahogany', None, 'Big-leaf mahogany', None),
    ('Bertholletia excelsa H.& B.', 'brazil-nut', 'Bertholletia excelsa', 'Brazil nut', None),
    ('Cedrela odorata L.', 'spanish-cedar', None, 'Spanish cedar', None),
    ('Tabebuia rosea (Bertol.)DC.', 'pink-poui', 'Tabebuia rosea', 'Pink poui', None),
    ('Samanea saman Merrill', 'rain-tree', 'Albizia saman', 'Rain tree', None),
    ('Inga edulis von Martius', 'inga', 'Inga edulis', 'Ice-cream bean', None),
    ('Araucaria angustifolia Ber.', 'parana-pine', 'Araucaria angustifolia', 'Paraná pine', None),
    ('Ceiba pentandra (L.) Gaertn', 'kapok', 'Ceiba pentandra', 'Kapok', None),
    ('Khaya senegalensis (Desr.)', 'african-mahogany', 'Khaya senegalensis', 'African mahogany', None),
    ('Acacia albida Del.', 'winter-thorn', 'Faidherbia albida', 'Winter thorn', None),
    ('Acacia senegal (L.) Willd.', 'gum-arabic', 'Senegalia senegal', 'Gum arabic tree', None),
    ('Balanites aegyptiaca (L)Del', 'desert-date', 'Balanites aegyptiaca', 'Desert date', None),
    ('Adansonia digitata F.Muell', 'baobab', 'Adansonia digitata', 'Baobab', None),
    ('Butyrospermum paradoxum (G)', 'shea', 'Vitellaria paradoxa', 'Shea tree', None),
    ('Parkia biglobosa (Jacq.) B.', 'locust-bean', 'Parkia biglobosa', 'African locust bean', None),
    ('Terminalia superba Engl.&D.', 'limba', 'Terminalia superba', 'Limba', None),
    ('Juniperus procera Hochst.', 'african-juniper', None, 'African pencil cedar', None),
    ('Quercus suber L.', 'cork-oak', None, 'Cork oak', None),
    ('Quercus ilex L.', 'holm-oak', None, 'Holm oak', None),
    ('Olea europaea L.', 'olive', None, 'Olive', None),
    ('Pinus halepensis Mill.', 'aleppo-pine', None, 'Aleppo pine', None),
    ('Pinus pinea L.', 'stone-pine', None, 'Stone pine', None),
    ('Pinus pinaster Aiton (Port)', 'maritime-pine', 'Pinus pinaster', 'Maritime pine', None),
    ('Ceratonia siliqua L.', 'carob', None, 'Carob', None),
    ('Castanea sativa Mill.', 'sweet-chestnut', None, 'Sweet chestnut', None),
    ('Fagus sylvatica L.', 'beech', None, 'European beech', None),
    ('Pinus sylvestris L.', 'scots-pine', None, 'Scots pine', None),
    ('Prunus avium L.', 'wild-cherry', None, 'Wild cherry', None),
    ('Juglans nigra L.', 'black-walnut', None, 'Black walnut', None),
    ('Acer saccharum', 'sugar-maple', None, 'Sugar maple', None),
    ('Pinus ponderosa Dougl.', 'ponderosa-pine', 'Pinus ponderosa', 'Ponderosa pine', None),
    ('Quercus virginiana', 'live-oak', None, 'Southern live oak', None),
    ('Carya illinoensis Wangenh.', 'pecan', 'Carya illinoinensis', 'Pecan', None),
    ('Araucaria cunninghamii Ait.', 'hoop-pine', 'Araucaria cunninghamii', 'Hoop pine', None),
    ('Agathis australis (D. Don)', 'kauri', 'Agathis australis', 'Kauri', None),
]

CODES_TEXTURE = {'H', 'M', 'L', 'O'}


def num(v):
    return None if v is None or v != v else float(v)  # NaN → None


def ordered(xs):
    return all(x is not None for x in xs) and all(a <= b for a, b in zip(xs, xs[1:]))


def light(code):
    """'1 2' → [1, 2]"""
    vals = sorted(int(c) for c in str(code).split() if c.isdigit() and 1 <= int(c) <= 5)
    return [vals[0], vals[-1]] if vals else None


def texture(code):
    letters = set(str(code).upper().split())
    if 'W' in letters:
        letters |= {'H', 'M', 'L'}
    return ''.join(c for c in 'LMHO' if c in letters & CODES_TEXTURE) or None


def main(src, out):
    d = rdata.conversion.convert(rdata.parser.parse_file(src))
    rows = {str(r['SCIENTNAME']).strip(): r for _, r in d.iterrows()}
    result, problems = [], []
    for sci, sid, accepted, english, local in SPECIES:
        r = rows.get(sci.strip())
        if r is None:
            problems.append(f'{sci}: not in ECOCROP')
            continue
        temp = [num(r[k]) for k in ('TMIN', 'TOPMN', 'TOPMX', 'TMAX')]
        rain = [num(r[k]) for k in ('RMIN', 'ROPMN', 'ROPMX', 'RMAX')]
        ph = [num(r[k]) for k in ('PHMIN', 'PHOPMN', 'PHOPMX', 'PHMAX')]
        bad = [n for n, xs in (('temperature', temp), ('rainfall', rain), ('pH', ph)) if not ordered(xs)]
        if bad:
            problems.append(f'{sci}: {", ".join(bad)} range out of order')
            continue
        kill = num(r['KTMP'])
        gmin, gmax = num(r['GMIN']), num(r['GMAX'])
        # Growing season as Recocrop's ecocropPars: GMIN plus up to one month, in whole months
        season = max(1, min(12, round((gmin + min(30, gmax - gmin)) / 30)))
        result.append({
            'id': sid,
            'name': english,
            'localName': local,
            'scientific': accepted or ' '.join(sci.split()[:2]),
            'ecocropName': sci,
            'family': str(r['FAMNAME']).strip(),
            'temp': temp,
            'seasonDays': [gmin, gmax],
            'seasonMonths': season,
            'killC': None if kill in (None, 0.0) else kill,
            'rain': rain,
            'ph': ph,
            'light': {'optimal': light(r['LIG']), 'absolute': light(r['LIGR'])},
            'texture': {'optimal': texture(r['TEXT']), 'absolute': texture(r['TEXTR'])},
            'drainage': [c for c in str(r['DRA']).upper().split() if c in 'PIWE'] or None,
        })
    for p in problems:
        print('skipped', p, file=sys.stderr)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({
            'source': 'FAO ECOCROP via Recocrop (Hijmans, github.com/cropmodels/Recocrop)',
            'note': 'Expert-opinion ranges, not field-validated optima.',
            'species': result,
        }, f, ensure_ascii=False, indent=1)
    print(f'{len(result)} species -> {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
