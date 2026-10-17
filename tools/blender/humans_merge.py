"""Merges figure builds made per base body (humans_build.py --bases X --out dirX) into one
humans.json + humans.bin, so the bases can be built in parallel:

  python3 tools/blender/humans_merge.py --out assets/humans .work/hb/male .work/hb/female ...

Every input must come from the same builder version (same bones, regions, part ids, scales).
"""
import os
import sys
import json
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('dirs', nargs='+')
    a = ap.parse_args()
    meta = None
    buf = bytearray()
    for d in a.dirs:
        with open(os.path.join(d, 'humans.json')) as f:
            m = json.load(f)
        with open(os.path.join(d, 'humans.bin'), 'rb') as f:
            b = f.read()
        while len(buf) % 4:
            buf.append(0)
        base_off = len(buf)
        buf += b
        if meta is None:
            meta = {k: v for k, v in m.items() if k not in ('bases', 'byteLength')}
            meta['bases'] = {}
        else:
            for k in ('bones', 'regions', 'parts', 'morphScale', 'shapeScale', 'version'):
                if m.get(k) != meta.get(k):
                    sys.exit(f'{d}: {k} differs from the first build')
        for name, base in m['bases'].items():
            for lod in base['lods']:
                lod['index']['offset'] += base_off
                for at in lod['attributes'].values():
                    at['offset'] += base_off
            meta['bases'][name] = base
    meta['byteLength'] = len(buf)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'humans.bin.tmp'), 'wb') as f:
        f.write(buf)
    with open(os.path.join(a.out, 'humans.json.tmp'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))
    os.replace(os.path.join(a.out, 'humans.bin.tmp'), os.path.join(a.out, 'humans.bin'))
    os.replace(os.path.join(a.out, 'humans.json.tmp'), os.path.join(a.out, 'humans.json'))
    print(f'merged {", ".join(meta["bases"])}: {len(buf) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
