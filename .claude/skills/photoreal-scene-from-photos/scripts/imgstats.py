#!/usr/bin/env python3
"""Image statistics for judging renders against reference photos with numbers, not adjectives.

  imgstats.py stats render.png [more renders] --ref reference/*.jpg [--region sky=0,0,1,0.25 ...] [--json]
  imgstats.py diff frames/*.jpg --region vp=0.4,0.3,0.6,0.5      (frame-to-frame change: LOD pop-in)
  imgstats.py sheet a.png b.png --out ab.jpg --labels L,R         (side-by-side for a blind comparison)
  imgstats.py crop shot.png crop.png 0.4 0.3 0.6 0.5 --scale 2    (zoomed crop for close inspection)
  imgstats.py jpeg shot.png shot.jpg --width 1600 --quality 85    (phone-sized JPEG, no metadata)

Every image is first resized to --width (default 1000) px wide, so renders and photos of any
size are compared on the same scale (detail metrics depend strongly on scale). Regions are
x0,y0,x1,y1 as fractions of the frame (all values <= 1) or as pixels of the ORIGINAL image.

Full-frame metrics (Y' = Rec.709 luma of the sRGB-encoded values, 0-255):
  mean, p2, p10, p50, p90, p98   tone: photos of sunny streets ran mean 110-144, p50 115-169,
                                 p98 200-249; renders that sat 0.75-1 EV under them read as dull
  black%  share with Y' <= --black (10): crushed shadows (refs 0.1-5 %, bad renders 15-28 %)
  clip%   share with max(R,G,B) >= --clip (250): blown highlights (refs 0.05-11.6 %, median 1.35 %)
  colourf Hasler-Suesstrunk colourfulness (refs 28-60; washed-out renders 16-35)
  sat     mean HSV saturation (refs 0.22-0.52; renders that read grey 0.14-0.22)
  R/B     mean red over mean blue: white balance (warm > 1, cool < 1)
  blk16   median std of Y' in 16 px blocks: mid-scale texture (refs 18.5-42)
  hp1     mean |Y' - blur(sigma 1)|: fine detail / sharpness (refs 6.8-16; soft renders 4.9-7.6)
Region metrics: mean sRGB, R/B, Y' mean and p50, linear luminance, and EV against the first
region (e.g. sun vs shade on the same stone: references showed -3.3 to -3.45 EV). Regions are
the same box on every image, so they suit renders of one view (A/B); for a reference photo with
another composition run a separate `stats` call with its own boxes (or pass --ref-regions).
With --ref, each metric of each render is printed next to the references' min-max range and
flagged LOW / HIGH when outside it. Needs numpy and Pillow (or run it through scripts/dk).
"""
import argparse, glob, json, os, sys

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("imgstats.py needs numpy and Pillow: pip install numpy pillow, or run it as: scripts/dk python3 scripts/imgstats.py ...")

FULL = ["mean", "p2", "p10", "p50", "p90", "p98", "black%", "clip%", "colourf", "sat", "R/B", "blk16", "hp1"]
REG = ["Y'", "Y'p50", "R", "G", "B", "R/B", "lin", "EV"]


def load(path, width):
    im = Image.open(path).convert("RGB")
    ow, oh = im.size
    if width and ow != width:
        im = im.resize((width, max(1, round(oh * width / ow))), Image.LANCZOS)
    return np.asarray(im).astype(np.float64), (ow, oh)


def luma(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def linear(a):
    c = a / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def blur1(y):
    """Separable Gaussian, sigma 1 (radius 3), edge-padded."""
    k = np.exp(-0.5 * (np.arange(-3, 4) ** 2))
    k /= k.sum()
    p = np.pad(y, ((0, 0), (3, 3)), mode="edge")
    h = sum(k[i] * p[:, i:i + y.shape[1]] for i in range(7))          # horizontal pass
    p = np.pad(h, ((3, 3), (0, 0)), mode="edge")
    return sum(k[i] * p[i:i + y.shape[0], :] for i in range(7))       # vertical pass


def box(spec, size, orig):
    """Region spec 'x0,y0,x1,y1' (fractions, or pixels of the original image) -> pixel box."""
    v = [float(x) for x in spec.split(",")]
    w, h = size
    if max(v) <= 1.0:
        x0, y0, x1, y1 = v[0] * w, v[1] * h, v[2] * w, v[3] * h
    else:
        sx, sy = w / orig[0], h / orig[1]
        x0, y0, x1, y1 = v[0] * sx, v[1] * sy, v[2] * sx, v[3] * sy
    x0, x1 = sorted((int(round(x0)), int(round(x1))))
    y0, y1 = sorted((int(round(y0)), int(round(y1))))
    return max(0, x0), max(0, y0), min(w, max(x1, x0 + 1)), min(h, max(y1, y0 + 1))


def full_stats(a, black, clip):
    y = luma(a)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(axis=2), a.min(axis=2)
    rg, yb = r - g, 0.5 * (r + g) - b
    colourf = np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0).mean()
    H, W = (y.shape[0] // 16) * 16, (y.shape[1] // 16) * 16
    blocks = y[:H, :W].reshape(H // 16, 16, W // 16, 16).std(axis=(1, 3))
    p = np.percentile(y, [2, 10, 50, 90, 98])
    return {"mean": y.mean(), "p2": p[0], "p10": p[1], "p50": p[2], "p90": p[3], "p98": p[4],
            "black%": 100 * (y <= black).mean(), "clip%": 100 * (mx >= clip).mean(),
            "colourf": colourf, "sat": sat, "R/B": r.mean() / max(b.mean(), 1e-6),
            "blk16": float(np.median(blocks)), "hp1": np.abs(y - blur1(y)).mean()}


def region_stats(a, bx, ref_lin=None):
    x0, y0, x1, y1 = bx
    c = a[y0:y1, x0:x1]
    m = c.reshape(-1, 3).mean(0)
    y = luma(c)
    lin = float((linear(c) @ np.array([0.2126, 0.7152, 0.0722])).mean())
    ev = np.log2(max(lin, 1e-6) / max(ref_lin, 1e-6)) if ref_lin else 0.0
    return {"Y'": y.mean(), "Y'p50": float(np.median(y)), "R": m[0], "G": m[1], "B": m[2],
            "R/B": m[0] / max(m[2], 1e-6), "lin": lin, "EV": ev}


def short(path, n=30):
    b = os.path.basename(path)
    return b if len(b) <= n else b[:n - 3] + "..."


def measure(path, a, regions=True):
    arr, orig = load(path, a.width)
    out = {"file": path, "full": full_stats(arr, a.black, a.clip), "regions": {}}
    first = None
    for spec in (a.region or []) if regions else []:
        name, _, coords = spec.partition("=")
        r = region_stats(arr, box(coords, (arr.shape[1], arr.shape[0]), orig), first)
        if first is None:
            first = r["lin"]
        out["regions"][name] = r
    return out


def fmt(v):
    return f"{v:.3f}" if abs(v) < 2 else f"{v:.1f}"


def cmd_stats(a):
    files = [f for p in a.images for f in sorted(glob.glob(p)) or [p]]
    refs = [f for p in (a.ref or []) for f in sorted(glob.glob(p)) or [p]]
    R = [measure(f, a) for f in files]
    F = [measure(f, a, a.ref_regions) for f in refs]
    if a.json:
        print(json.dumps({"renders": R, "refs": F}, default=float, indent=1))
        return 0

    def rng(key, sub=None):
        vals = [(x["full"][key] if sub is None else x["regions"].get(sub, {}).get(key)) for x in F]
        vals = [v for v in vals if v is not None]
        return (min(vals), max(vals)) if vals else None

    w = max([len(short(x["file"])) for x in R + F] + [9])
    print(f"{'image':<{w}} " + " ".join(f"{k:>8}" for k in FULL))
    for x in F:
        print(f"{short(x['file']):<{w}} " + " ".join(f"{fmt(x['full'][k]):>8}" for k in FULL) + "  (ref)")
    if F:
        print(f"{'ref range':<{w}} " + " ".join(f"{fmt(rng(k)[0]) + '-' + fmt(rng(k)[1]):>8}" for k in FULL))
    for x in R:
        print(f"{short(x['file']):<{w}} " + " ".join(f"{fmt(x['full'][k]):>8}" for k in FULL))
        if F:
            flags = []
            for k in FULL:
                lo, hi = rng(k)
                v = x["full"][k]
                if v < lo:
                    flags.append(f"{k} LOW ({fmt(v)} < {fmt(lo)})")
                elif v > hi:
                    flags.append(f"{k} HIGH ({fmt(v)} > {fmt(hi)})")
            print(f"{'':<{w}} outside the references: " + ("; ".join(flags) or "none"))
    for name in (R[0]["regions"] if R else {}):
        print(f"\nregion {name}: " + "  ".join(f"{k:>6}" for k in REG))
        for x in F + R:
            r = x["regions"].get(name)
            if r:
                tag = " (ref)" if x in F else ""
                print(f"  {short(x['file']):<{w}} " + "  ".join(f"{fmt(r[k]):>6}" for k in REG) + tag)
    return 0


def cmd_diff(a):
    files = [f for p in a.images for f in sorted(glob.glob(p)) or [p]]
    prev, d = None, []
    for f in files:
        arr, orig = load(f, a.width)
        bx = box(a.region.partition("=")[2] if a.region else "0,0,1,1", (arr.shape[1], arr.shape[0]), orig)
        y = luma(arr[bx[1]:bx[3], bx[0]:bx[2]])
        if prev is not None:
            d.append((f, float(np.abs(y - prev).mean())))
        prev = y
    if not d:
        print("need at least two frames")
        return 1
    v = np.array([x[1] for x in d])
    med = float(np.median(v))
    print(f"{len(d)} frame pairs: mean |dY'| median {med:.2f}, p95 {np.percentile(v, 95):.2f}, max {v.max():.2f}")
    for f, x in d:
        if x > a.spike * max(med, 0.5):
            print(f"  spike {x:.2f} ({x / max(med, 1e-6):.1f}x median) at {os.path.basename(f)}: a pop, a cut or a camera jolt; look at it")
    return 0


def cmd_sheet(a):
    ims = [Image.open(p).convert("RGB") for p in a.images]
    ims = [im.resize((a.width, round(im.height * a.width / im.width)), Image.LANCZOS) for im in ims]
    gap, labels = 8, (a.labels.split(",") if a.labels else [])
    h = max(im.height for im in ims)
    W = a.width * len(ims) + gap * (len(ims) - 1) if not a.vertical else a.width
    Hh = h if not a.vertical else sum(im.height for im in ims) + gap * (len(ims) - 1)
    sheet = Image.new("RGB", (W, Hh), (20, 20, 20))
    dr = ImageDraw.Draw(sheet)
    x = y = 0
    for i, im in enumerate(ims):
        sheet.paste(im, (x, y))
        if i < len(labels):
            dr.rectangle((x + 6, y + 6, x + 34, y + 30), fill=(0, 0, 0))
            dr.text((x + 14, y + 11), labels[i], fill=(255, 255, 255))
        if a.vertical:
            y += im.height + gap
        else:
            x += a.width + gap
    sheet.save(a.out, quality=a.quality)
    print("wrote", a.out)
    return 0


def cmd_crop(a):
    im = Image.open(a.input).convert("RGB")
    bx = box(",".join(a.box), im.size, im.size)
    c = im.crop(bx)
    if a.scale != 1:
        c = c.resize((round(c.width * a.scale), round(c.height * a.scale)), Image.LANCZOS)
    c.save(a.output, quality=a.quality) if a.output.lower().endswith((".jpg", ".jpeg")) else c.save(a.output)
    print("wrote", a.output, c.size)
    return 0


def cmd_jpeg(a):
    im = Image.open(a.input).convert("RGB")   # (a fresh image: no EXIF, XMP or comments are written)
    if a.width and im.width > a.width:
        im = im.resize((a.width, round(im.height * a.width / im.width)), Image.LANCZOS)
    im.save(a.output, "JPEG", quality=a.quality, optimize=True)
    print(f"wrote {a.output} {im.size[0]}x{im.size[1]} {os.path.getsize(a.output) / 1048576:.2f} MB")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stats")
    s.add_argument("images", nargs="+")
    s.add_argument("--ref", nargs="+", help="reference photos (globs ok)")
    s.add_argument("--region", action="append", help="name=x0,y0,x1,y1 (repeatable; the first is the EV base)")
    s.add_argument("--ref-regions", action="store_true",
                   help="measure the regions on the references too (only meaningful when they share the composition)")
    s.add_argument("--width", type=int, default=1000)
    s.add_argument("--black", type=float, default=10)
    s.add_argument("--clip", type=float, default=250)
    s.add_argument("--json", action="store_true")
    d = sub.add_parser("diff")
    d.add_argument("images", nargs="+")
    d.add_argument("--region", default=None, help="name=x0,y0,x1,y1")
    d.add_argument("--width", type=int, default=1000)
    d.add_argument("--spike", type=float, default=3.0, help="flag pairs above this multiple of the median")
    sh = sub.add_parser("sheet")
    sh.add_argument("images", nargs="+")
    sh.add_argument("--out", required=True)
    sh.add_argument("--labels", default=None, help="comma-separated, e.g. L,R (keep them neutral for blind tests)")
    sh.add_argument("--width", type=int, default=1600)
    sh.add_argument("--vertical", action="store_true")
    sh.add_argument("--quality", type=int, default=88)
    c = sub.add_parser("crop")
    c.add_argument("input")
    c.add_argument("output")
    c.add_argument("box", nargs=4)
    c.add_argument("--scale", type=float, default=2.0)
    c.add_argument("--quality", type=int, default=90)
    j = sub.add_parser("jpeg")
    j.add_argument("input")
    j.add_argument("output")
    j.add_argument("--width", type=int, default=0)
    j.add_argument("--quality", type=int, default=85)
    a = ap.parse_args()
    return {"stats": cmd_stats, "diff": cmd_diff, "sheet": cmd_sheet, "crop": cmd_crop, "jpeg": cmd_jpeg}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
