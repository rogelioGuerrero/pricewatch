"""Auxiliar de tests/frontend/gen_verdicts_golden.js: recibe en argv[1]
un JSON {name: {series, generated}} con las series de cada caso del
fixture del front y escribe en argv[2] {name: agg} — el agg REAL que
build_site publicaria (compute_agg + price_verdict sobre la serie en
forma exportada)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from verdicts import compute_agg, price_verdict


def main():
    src, dst = sys.argv[1], sys.argv[2]
    cases = json.load(open(src, encoding="utf-8"))
    out = {}
    for name, c in cases.items():
        series = {s: [list(r) for r in v]
                  for s, v in c["series"].items()}
        latest = {s: {"sku": s} for s in series}
        agg = compute_agg(series, latest)
        for s, a in agg.items():
            v = price_verdict(a, series.get(s) or [],
                              c.get("generated") or "")
            if v:
                a.update(v)
        out[name] = agg
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
