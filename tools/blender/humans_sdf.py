"""Signed distance field toolkit for the human figure builder (numpy only).

Coordinates follow the runtime convention: metres, +Y up, the figure faces -Z and its
right-hand side is +X. Distances are negative inside.

Nodes evaluate on point arrays P (N, 3) float32. Every node has a bounding box so that
large grids are evaluated sparsely: a child is only evaluated on the points inside its
(margin-expanded) box, elsewhere it is treated as far away.
"""
import numpy as np

BIG = np.float32(10.0)
MARGIN = 0.06  # bbox padding: must exceed the largest blend radius + surface band


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * (k * 0.25)


def smax(a, b, k):
    return -smin(-a, -b, k)


def _inside(P, lo, hi):
    return ((P[:, 0] >= lo[0]) & (P[:, 0] <= hi[0]) & (P[:, 1] >= lo[1]) & (P[:, 1] <= hi[1])
            & (P[:, 2] >= lo[2]) & (P[:, 2] <= hi[2]))


def v3(*a):
    return np.array(a[0] if len(a) == 1 else a, dtype=np.float64)


def normalize(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def rot_frame(axis, hint):
    """Orthonormal frame (x, y, z) with y = axis and x as close as possible to hint."""
    y = normalize(axis)
    x = np.asarray(hint, dtype=np.float64) - y * np.dot(hint, y)
    if np.linalg.norm(x) < 1e-6:
        x = np.cross(y, [0, 0, 1.0])
    x = normalize(x)
    z = np.cross(x, y)
    return x, y, z


def rot_xyz(rx=0.0, ry=0.0, rz=0.0):
    """Rotation matrix (columns = local axes in world) from Euler angles in degrees (X then Y then Z)."""
    a, b, c = np.radians([rx, ry, rz])
    Rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    Ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    Rz = np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


class Spline:
    """Natural cubic spline through (t_i, v_i), clamped outside the key range."""

    def __init__(self, ts, vs):
        self.t = np.asarray(ts, dtype=np.float64)
        self.v = np.asarray(vs, dtype=np.float64)
        n = len(self.t)
        if n < 3:
            self.m = np.zeros(n)
            return
        h = np.diff(self.t)
        A = np.zeros((n, n))
        r = np.zeros(n)
        A[0, 0] = A[-1, -1] = 1
        for i in range(1, n - 1):
            A[i, i - 1] = h[i - 1]
            A[i, i] = 2 * (h[i - 1] + h[i])
            A[i, i + 1] = h[i]
            r[i] = 6 * ((self.v[i + 1] - self.v[i]) / h[i] - (self.v[i] - self.v[i - 1]) / h[i - 1])
        self.m = np.linalg.solve(A, r)

    def __call__(self, x):
        x = np.clip(np.asarray(x, dtype=np.float64), self.t[0], self.t[-1])
        i = np.clip(np.searchsorted(self.t, x) - 1, 0, len(self.t) - 2)
        t0, t1 = self.t[i], self.t[i + 1]
        h = t1 - t0
        a = (t1 - x) / h
        b = (x - t0) / h
        return (a * self.v[i] + b * self.v[i + 1]
                + ((a ** 3 - a) * self.m[i] + (b ** 3 - b) * self.m[i + 1]) * h * h / 6.0)


# ----------------------------------------------------------------------------- nodes

class Node:
    region = None
    lo = hi = None

    def bbox(self):
        return self.lo, self.hi

    def eval(self, P):
        raise NotImplementedError

    def leaves(self):
        return [self]


class Prim(Node):
    """Leaf primitive. `bones` is {bone: weight} or a callable P -> {bone: array}."""

    def __init__(self, region=None, bones=None, name=None):
        self.region = region
        self.bones = bones or {}
        self.name = name

    def bone_weights(self, P):
        if callable(self.bones):
            return self.bones(P)
        return {b: np.full(len(P), w, np.float32) for b, w in self.bones.items()}


class Ellipsoid(Prim):
    def __init__(self, c, r, R=None, **kw):
        super().__init__(**kw)
        self.c = v3(c)
        self.r = v3(r)
        self.R = np.eye(3) if R is None else np.asarray(R, dtype=np.float64)
        ext = np.abs(self.R) @ self.r
        self.lo, self.hi = self.c - ext, self.c + ext

    def eval(self, P):
        q = (P - self.c) @ self.R
        k0 = np.linalg.norm(q / self.r, axis=1)
        k1 = np.linalg.norm(q / (self.r * self.r), axis=1)
        return (k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)).astype(np.float32)


class RoundCone(Prim):
    """Capsule with radius r1 at a and r2 at b (exact distance)."""

    def __init__(self, a, b, r1, r2=None, **kw):
        super().__init__(**kw)
        self.a, self.b = v3(a), v3(b)
        self.r1 = float(r1)
        self.r2 = float(r1 if r2 is None else r2)
        rm = max(self.r1, self.r2)
        self.lo = np.minimum(self.a, self.b) - rm
        self.hi = np.maximum(self.a, self.b) + rm

    def eval(self, P):
        a, b, r1, r2 = self.a, self.b, self.r1, self.r2
        ba = b - a
        l2 = float(ba @ ba)
        rr = r1 - r2
        a2 = l2 - rr * rr
        il2 = 1.0 / l2
        pa = P - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - np.outer(y, ba)
        x2 = np.einsum('ij,ij->i', xv, xv)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d = np.where(
            np.sign(z) * a2 * z2 > k, np.sqrt(x2 + z2) * il2 - r2,
            np.where(np.sign(y) * a2 * y2 < k, np.sqrt(x2 + y2) * il2 - r1,
                     (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1))
        return d.astype(np.float32)


class Loft(Prim):
    """Generalised cylinder from A to B: superelliptic cross-section whose half-widths
    rx (along the frame x axis) and rz (frame z axis) and centre offsets ox/oz follow
    splines in t (0 at A, 1 at B). Flat caps (they get rounded by the blends)."""

    def __init__(self, A, B, xhint, keys, n=2.0, capr=1.0, **kw):
        super().__init__(**kw)
        self.A, self.B = v3(A), v3(B)
        d = self.B - self.A
        self.L = float(np.linalg.norm(d))
        self.ax, self.ay, self.az = rot_frame(d, xhint)
        keys = np.asarray(keys, dtype=np.float64)  # rows: t, rx, rz, ox, oz
        if keys.shape[1] == 3:
            keys = np.hstack([keys, np.zeros((len(keys), 2))])
        self.srx = Spline(keys[:, 0], keys[:, 1])
        self.srz = Spline(keys[:, 0], keys[:, 2])
        self.sox = Spline(keys[:, 0], keys[:, 3])
        self.soz = Spline(keys[:, 0], keys[:, 4])
        self.n = n
        self.capr = capr
        rmax = float(np.max(np.abs(keys[:, 1:3])) + np.max(np.abs(keys[:, 3:5])))
        self.lo = np.minimum(self.A, self.B) - rmax
        self.hi = np.maximum(self.A, self.B) + rmax

    def eval(self, P):
        pa = P - self.A
        traw = (pa @ self.ay) / self.L
        t = np.clip(traw, 0.0, 1.0)
        rx, rz = self.srx(t), self.srz(t)
        qx = pa @ self.ax - self.sox(t)
        qz = pa @ self.az - self.soz(t)
        n = self.n
        ux, uz = np.abs(qx) / rx, np.abs(qz) / rz
        # axial overshoot past either end; ends are closed with half-ellipsoid caps
        e = np.maximum(np.maximum(-traw, traw - 1.0), 0.0) * self.L
        rc = np.minimum(rx, rz) * self.capr
        if n == 2.0:
            k0 = np.sqrt(ux * ux + uz * uz + (e / rc) ** 2)
            k1 = np.sqrt((qx / (rx * rx)) ** 2 + (qz / (rz * rz)) ** 2 + (e / (rc * rc)) ** 2)
            out = k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
        else:
            k0 = (ux ** n + uz ** n) ** (1.0 / n)
            k0 = np.sqrt(k0 * k0 + (e / rc) ** 2)
            out = (k0 - 1.0) * np.minimum(rx, rz)
        return out.astype(np.float32)


class RoundBox(Prim):
    def __init__(self, c, half, radius, R=None, **kw):
        super().__init__(**kw)
        self.c = v3(c)
        self.h = v3(half)
        self.rad = float(radius)
        self.R = np.eye(3) if R is None else np.asarray(R, dtype=np.float64)
        ext = np.abs(self.R) @ (self.h + self.rad)
        self.lo, self.hi = self.c - ext, self.c + ext

    def eval(self, P):
        q = np.abs((P - self.c) @ self.R) - self.h
        out = np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(np.max(q, axis=1), 0) - self.rad
        return out.astype(np.float32)


class Shell(Node):
    """Thin shell |d(child) - offset| - thickness/2 (used for hair caps, garments)."""

    def __init__(self, child, offset, thickness):
        self.child, self.off, self.th = child, offset, thickness
        pad = abs(offset) + thickness
        self.lo, self.hi = child.lo - pad, child.hi + pad

    def eval(self, P):
        return (np.abs(self.child.eval(P) - self.off) - self.th * 0.5).astype(np.float32)

    def leaves(self):
        return self.child.leaves()


class Offset(Node):
    def __init__(self, child, off):
        self.child, self.off = child, off
        self.lo, self.hi = child.lo - max(off, 0), child.hi + max(off, 0)

    def eval(self, P):
        return (self.child.eval(P) - self.off).astype(np.float32)

    def leaves(self):
        return self.child.leaves()


class Xform(Node):
    """Uniformly scaled + translated child: d(p) = s * child((p - t) / s)."""

    def __init__(self, child, scale=1.0, translate=(0, 0, 0)):
        self.child, self.s, self.t = child, float(scale), v3(translate)
        self.lo = child.lo * self.s + self.t
        self.hi = child.hi * self.s + self.t

    def eval(self, P):
        return (self.s * self.child.eval(((P - self.t) / self.s).astype(np.float32))).astype(np.float32)

    def leaves(self):
        return [XformLeaf(l, self) for l in self.child.leaves()]


class XformLeaf(Prim):
    """A leaf seen through an Xform (for per-primitive queries such as bone weights)."""

    def __init__(self, leaf, xf):
        super().__init__(region=leaf.region, bones=None, name=leaf.name)
        self.leaf, self.xf = leaf, xf
        self.lo = leaf.lo * xf.s + xf.t
        self.hi = leaf.hi * xf.s + xf.t

    def eval(self, P):
        return (self.xf.s * self.leaf.eval(((P - self.xf.t) / self.xf.s).astype(np.float32))).astype(np.float32)

    def bone_weights(self, P):
        return self.leaf.bone_weights(((P - self.xf.t) / self.xf.s).astype(np.float32))


class Union(Node):
    def __init__(self, children, k=0.0):
        self.children = [c for c in children if c is not None]
        self.k = k
        self.lo = np.min([c.lo for c in self.children], axis=0)
        self.hi = np.max([c.hi for c in self.children], axis=0)

    def eval(self, P):
        d = np.full(len(P), BIG, np.float32)
        for c in self.children:
            m = _inside(P, c.lo - MARGIN, c.hi + MARGIN)
            if not m.any():
                continue
            d[m] = smin(d[m], c.eval(P[m]), self.k)
        return d

    def leaves(self):
        return [l for c in self.children for l in c.leaves()]


class Subtract(Node):
    """a minus b with blend radius k."""

    def __init__(self, a, b, k=0.0):
        self.a, self.b, self.k = a, b, k
        self.lo, self.hi = a.lo, a.hi

    def eval(self, P):
        d = self.a.eval(P)
        m = _inside(P, self.b.lo - MARGIN, self.b.hi + MARGIN)
        if m.any():
            d[m] = smax(d[m], -self.b.eval(P[m]), self.k)
        return d

    def leaves(self):
        return self.a.leaves()


class Intersect(Node):
    def __init__(self, a, b, k=0.0):
        self.a, self.b, self.k = a, b, k
        self.lo = np.maximum(a.lo, b.lo)
        self.hi = np.minimum(a.hi, b.hi)

    def eval(self, P):
        return smax(self.a.eval(P), self.b.eval(P), self.k)

    def leaves(self):
        return self.a.leaves()


class HalfSpace(Prim):
    """Signed distance to the plane through c with outward normal n (inside = behind)."""

    def __init__(self, c, n, **kw):
        super().__init__(**kw)
        self.c, self.n = v3(c), normalize(n)
        self.lo, self.hi = np.full(3, -5.0), np.full(3, 5.0)

    def eval(self, P):
        return ((P - self.c) @ self.n).astype(np.float32)


class Fn(Prim):
    """Arbitrary vectorised distance function with an explicit box."""

    def __init__(self, f, lo, hi, **kw):
        super().__init__(**kw)
        self.f = f
        self.lo, self.hi = v3(lo), v3(hi)

    def eval(self, P):
        return self.f(P).astype(np.float32)


# ----------------------------------------------------------------------------- meshing

def eval_grid(node, lo, hi, h, slab=24):
    """Sample node on a regular grid (returns field, origin)."""
    lo = np.floor(np.asarray(lo) / h) * h
    n = np.ceil((np.asarray(hi) - lo) / h).astype(int) + 1
    xs = lo[0] + h * np.arange(n[0])
    ys = lo[1] + h * np.arange(n[1])
    zs = lo[2] + h * np.arange(n[2])
    F = np.empty((n[0], n[1], n[2]), np.float32)
    XX, ZZ = np.meshgrid(xs, zs, indexing='ij')
    for j0 in range(0, n[1], slab):
        j1 = min(n[1], j0 + slab)
        YY = ys[j0:j1]
        P = np.empty((n[0], j1 - j0, n[2], 3), np.float32)
        P[..., 0] = XX[:, None, :]
        P[..., 1] = YY[None, :, None]
        P[..., 2] = ZZ[:, None, :]
        F[:, j0:j1, :] = node.eval(P.reshape(-1, 3)).reshape(n[0], j1 - j0, n[2])
    return F, lo


def surface_nets(F, origin, h):
    """Naive surface nets. Returns (verts float64 (V,3), tris int32 (T,3))."""
    inside = F < 0
    nx, ny, nz = F.shape
    # active cells: corners not all equal
    cnt = np.zeros((nx - 1, ny - 1, nz - 1), np.int8)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                cnt += inside[dx:dx + nx - 1, dy:dy + ny - 1, dz:dz + nz - 1]
    act = (cnt > 0) & (cnt < 8)
    ci = np.argwhere(act)  # (C, 3)
    corners = np.array([[dx, dy, dz] for dx in (0, 1) for dy in (0, 1) for dz in (0, 1)])
    vals = np.stack([F[ci[:, 0] + c[0], ci[:, 1] + c[1], ci[:, 2] + c[2]] for c in corners], axis=1)
    edges = []
    for a in range(8):
        for b in range(a + 1, 8):
            if np.abs(corners[a] - corners[b]).sum() == 1:
                edges.append((a, b))
    acc = np.zeros((len(ci), 3))
    num = np.zeros(len(ci))
    for a, b in edges:
        fa, fb = vals[:, a], vals[:, b]
        m = (fa < 0) != (fb < 0)
        t = np.where(m, fa / np.where(m, fa - fb, 1.0), 0.0)
        p = corners[a][None, :] + t[:, None] * (corners[b] - corners[a])[None, :]
        acc += np.where(m[:, None], p, 0.0)
        num += m
    verts = origin + h * (ci + acc / np.maximum(num, 1)[:, None])
    lin = np.ravel_multi_index(ci.T, (nx - 1, ny - 1, nz - 1))
    order = np.argsort(lin)
    lin_sorted = lin[order]

    def vid(i, j, k):
        l = np.ravel_multi_index((i, j, k), (nx - 1, ny - 1, nz - 1))
        pos = np.searchsorted(lin_sorted, l)
        return order[pos]

    quads = []
    # x edges: (i,j,k)-(i+1,j,k); cells (i, j-1..j, k-1..k), ordered so normal = +x
    for axis in range(3):
        sl0 = [slice(None)] * 3
        sl1 = [slice(None)] * 3
        sl0[axis] = slice(0, -1)
        sl1[axis] = slice(1, None)
        e = inside[tuple(sl0)] != inside[tuple(sl1)]
        idx = np.argwhere(e)
        lower_inside = inside[tuple(sl0)][e]
        u, w = [(1, 2), (2, 0), (0, 1)][axis]  # quad spans axes u then w: normal = u x w = +axis
        dims = [nx, ny, nz]
        ok = (idx[:, u] >= 1) & (idx[:, u] <= dims[u] - 2) & (idx[:, w] >= 1) & (idx[:, w] <= dims[w] - 2)
        idx, lower_inside = idx[ok], lower_inside[ok]
        cs = []
        for du, dw in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            c = idx.copy()
            c[:, u] += du
            c[:, w] += dw
            cs.append(vid(c[:, 0], c[:, 1], c[:, 2]))
        q = np.stack(cs, axis=1)
        q[~lower_inside] = q[~lower_inside][:, ::-1]
        quads.append(q)
    quads = np.concatenate(quads)
    # split along the shorter diagonal
    p = verts[quads]
    d02 = np.linalg.norm(p[:, 0] - p[:, 2], axis=1)
    d13 = np.linalg.norm(p[:, 1] - p[:, 3], axis=1)
    use02 = d02 <= d13
    t1 = np.where(use02[:, None], quads[:, [0, 1, 2]], quads[:, [0, 1, 3]])
    t2 = np.where(use02[:, None], quads[:, [0, 2, 3]], quads[:, [1, 2, 3]])
    tris = np.concatenate([t1, t2]).astype(np.int32)
    return verts, tris


def gradient(node, P, eps=4e-4):
    g = np.empty_like(P, dtype=np.float64)
    for a in range(3):
        o = np.zeros(3, np.float32)
        o[a] = eps
        g[:, a] = (node.eval(P + o).astype(np.float64) - node.eval(P - o)) / (2 * eps)
    return g


def project(node, P, iters=3):
    """Newton steps onto the zero level set."""
    P = np.asarray(P, np.float32).copy()
    for _ in range(iters):
        d = node.eval(P).astype(np.float64)
        g = gradient(node, P)
        gg = np.maximum((g * g).sum(1), 1e-6)
        step = (d / gg)[:, None] * g
        # limit step length to keep thin features stable
        sl = np.linalg.norm(step, axis=1, keepdims=True)
        step *= np.minimum(1.0, 0.004 / np.maximum(sl, 1e-12))
        P = (P - step).astype(np.float32)
    return P


def normals(node, P):
    g = gradient(node, P)
    return g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)


def sdf_ao(node, P, N, steps=(0.01, 0.02, 0.04, 0.07, 0.11)):
    """Classic SDF ambient occlusion estimate (1 = open, 0 = fully occluded)."""
    occ = np.zeros(len(P))
    w = 1.0
    tot = 0.0
    for s in steps:
        d = node.eval((P + N * s).astype(np.float32)).astype(np.float64)
        occ += w * np.clip(s - d, 0, None) / s
        tot += w
        w *= 0.75
    return np.clip(1.0 - 1.1 * occ / tot, 0.0, 1.0)


def fix_winding(node, verts, tris):
    """Orient triangles so their normal agrees with the field gradient."""
    p = verts[tris]
    fn = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    c = p.mean(1).astype(np.float32)
    g = gradient(node, c)
    flip = (fn * g).sum(1) < 0
    tris = tris.copy()
    tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris, int(flip.sum())
