// SPDX-License-Identifier: LGPL-3.0-or-later
// The desktop's one corner (crates/nidara-corner): `quadrant` and `sdf` in lib.rs, step for
// step, in GLSL ES 1.00. Read the Rust first; a change goes in both. `nidara_corner::glsl()`
// hands this out with the numbers filled in from the Rust.
//   float corner_sdf(vec2 p, vec2 h, float r)
// p relative to the box's centre, h its half size, r its corner radius: the signed distance,
// negative inside.
#define NC_K_SYM @NC_K_SYM@
#define NC_N_SYM @NC_N_SYM@
#define NC_K_PILL @NC_K_PILL@
#define NC_N_PILL @NC_N_PILL@
#define NC_MAX_REACH @NC_MAX_REACH@

// The corner of a wide box (l >= s): (a, b, p, q) of (x/a)^p + (y/b)^q = 1.
vec4 nc_quadrant(float l, float s, float r) {
    if (r * NC_K_SYM <= s) return vec4(NC_K_SYM * r, NC_K_SYM * r, NC_N_SYM, NC_N_SYM);
    float t = clamp((r - s / NC_K_SYM) / (s - s / NC_K_SYM), 0.0, 1.0);
    float room = clamp((l - s) / ((NC_K_PILL - 1.0) * s), 0.0, 1.0);
    return vec4(s + room * t * (NC_K_PILL - 1.0) * s, s,
                mix(mix(NC_N_SYM, 2.0, t), mix(NC_N_SYM, NC_N_PILL, t), room),
                mix(NC_N_SYM, 2.0, t));
}

float corner_sdf(vec2 p, vec2 h, float r) {
    vec2 q = abs(p);
    float d_box = max(q.x - h.x, q.y - h.y);
    // A tall box is measured as the wide one it is turned, with the point turned too.
    if (h.y > h.x) { q = q.yx; h = h.yx; }
    if (r <= 1e-6 || h.y <= 1e-6) return d_box;
    vec4 c = nc_quadrant(h.x, h.y, r);
    vec2 o = h - c.xy;
    if (q.x <= o.x || q.y <= o.y) return d_box;
    vec2 k = (q - o) / c.xy;
    float f = pow(k.x, c.z) + pow(k.y, c.w);
    // f^(1/m) grows like the distance, so the estimate holds away from the outline too.
    float m = max(c.z, c.w);
    float g = pow(f, 1.0 / m);
    vec2 grad = vec2(c.z * pow(k.x, c.z - 1.0) / c.x, c.w * pow(k.y, c.w - 1.0) / c.y);
    float grad_g = g / (m * max(f, 1e-12)) * length(grad);
    return (g - 1.0) / max(grad_g, 1e-9);
}
