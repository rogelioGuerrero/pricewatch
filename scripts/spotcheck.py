"""Spot-check temporal: snapshot de hoy vs API getProduct en vivo."""
import json
import random
from urllib.request import Request, urlopen

snap = json.load(open('data/snapshots/2026-09-29.json',
                      encoding='utf-8'))['products']
oferta = next((s for s, p in snap.items() if (p.get('saving_usd') or 0) > 0),
              None)
skus = random.sample(list(snap), 6) + ([oferta] if oferta else [])
print('skus a verificar:', skus)

body = [{'skus': skus},
        {'products': 'getProductBySKU',
         'metadata': {'channelId': '1bad5650-9b56-4490-b3c5-2d50f86c6716'}}]
req = Request('https://www.pricesmart.com/api/ct/getProduct',
              data=json.dumps(body).encode(),
              headers={'content-type': 'application/json',
                       'cookie': 'vsf-locale=es-sv; vsf-currency=USD; '
                       'vsf-country=sv; vsf-store=SV; '
                       'vsf-channel=1bad5650-9b56-4490-b3c5-2d50f86c6716',
                       'accept': 'application/json'})
res = json.load(urlopen(req, timeout=60))['data']['products']['results']

print()
hdr = ('sku', 'snap$', 'api$', 'snap_stk', 'api_stk')
print(' | '.join(f'{h:>8}' for h in hdr))
ok = mism = 0
seen = set()
for prod in res:
    for v in prod['masterData']['current']['allVariants']:
        sku = v['sku']
        if sku not in snap or sku in seen:
            continue
        seen.add(sku)
        try:
            api_price = v['price']['value']['centAmount']
        except Exception:
            api_price = None
        chans = (v.get('availability') or {}).get('channels',
                                                 {}).get('results', [])
        api_stock = any(c['availability']['isOnStock']
                        for c in chans if c['channel']['key'].startswith('67'))
        p = snap[sku]
        sp = p.get('price_SV')
        ss = p.get('inventory_SV') == 'in stock'
        flag = 'OK' if (sp == api_price and ss == api_stock) else 'MISMATCH'
        ok += flag == 'OK'
        mism += flag != 'OK'
        vals = (sku, sp / 100 if sp else '-', api_price / 100
                if api_price else '-', ss, api_stock)
        print(' | '.join(f'{x!s:>8}' for x in vals) + f'  {flag}')
print(f'\n{ok} OK / {mism} mismatch / {len(seen)} verificados')
