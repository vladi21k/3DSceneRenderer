// Small hot-path helpers for chunk builds.

/** Signed route distance from a to b on a closed loop of length L (same result as
 *  route.delta, without the floating-point modulo that dominates tight loops). */
export function makeDelta(L) {
  const h = L / 2;
  return (a, b) => {
    let d = b - a;
    while (d > h) d -= L;
    while (d < -h) d += L;
    return d;
  };
}
