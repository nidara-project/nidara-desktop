// The glass: one shape of a surface, from the blurred copy of what is under it (glass_gl.rs).
//
// LAB hooks. The glass lab (scripts/dev/glass-lab) runs this same file with glass_gl.rs's
// `LAB_ON`, which gives each hook a value from lab_params.conf; Hyalo ships it with `LAB_OFF`,
// where `LAB_ADD(i, x)` and `LAB_MUL(i, x)` are `x` and every `#ifdef GLASS_LAB` block is
// compiled out. Every value 0 is the factory glass. A new layer to try goes here, behind a hook,
// and becomes the factory's by changing the number the hook wraps (and the lab's neutral).
//   lab[0]  tone: ceiling, the WCAG luminance white is compressed to (0 = off)        block
//   lab[1]  tone: knee, the luminance below which nothing changes (0 = 0.15)          block
//   lab[2]  dim: a black veil over the backdrop before the tint, 0..1                 block
//   lab[4]  bevel profile: + to its exponent (5)                                      ADD
//   lab[5]  refraction: × (1 + it) on its strength (3 × Snell's)                      MUL
//   lab[6]  dispersion: its spread, 1 = the fringe there was until 2026-10-05          block
//   lab[8]  light: rotation of the rim's light, degrees                               block
//   lab[9]  inner glow: × it, 1 = the glow along the edge there was until 2026-10-05  block
//   lab[10] rim line: × (1 + it) on its width                                         MUL
//   lab[11] bevel corners: × (1 + it) on how much rounder they get per px of depth;
//           −1 = every contour keeps the corner's own radius (the fold, until 2026-10-05) MUL
//   lab[12] bevel width cap: + to its 80 px                                           ADD
//   lab[13] rim, the side opposite the light: × (1 + it) on its echo (0.70)           MUL
//   lab[14] rim, the line all round: × (1 + it) on its floor (0.017)                  MUL
uniform vec4 region_fb;     // the captured region, framebuffer pixels
uniform mat2 out_to_fb;     // output-pixel offsets → framebuffer-pixel offsets
uniform vec4 rect;          // the shape, output pixels
uniform float radius;
uniform float exponent;
uniform float opacity;      // the whole glass in this shape, over the plain backdrop
uniform vec4 clip;          // what of the shape may show, output px: x, y, w, h
uniform float glass;        // 1: refractive glass — the compositor paints the whole glass
uniform vec3 tint;
uniform float alpha_min;
uniform float alpha_max;
uniform float target;
uniform float refraction;   // output px
uniform float rim;
uniform float saturation;
uniform float ink_dark;     // 1: this shape holds dark content (the ink event)
uniform vec3 ink_tint;
uniform float has_pointer;  // 1: a pointer is spliced into the shape (a tooltip, a menu)
uniform vec2 ptr_a;         // the pointer's triangle, inset by its tip radius, output px
uniform vec2 ptr_b;
uniform vec2 ptr_t;
uniform float ptr_tip_r;
uniform float ptr_base_r;
varying vec2 v_out;
varying vec2 v_fb;

// A box of half size `half_size` centred on the shape, corners of radius `r`: signed
// distance in output pixels, negative inside.
float sdf_box(vec2 px, vec2 half_size, float r) {
    vec2 q = abs(px - rect.xy - rect.zw * 0.5);
    vec2 inner = half_size - vec2(r);
    if (q.x > inner.x && q.y > inner.y && r > 0.0) {
        vec2 k = (q - inner) / r;
        return (pow(pow(k.x, exponent) + pow(k.y, exponent), 1.0 / exponent) - 1.0) * r;
    }
    return max(q.x - half_size.x, q.y - half_size.y);
}
// The shape's signed distance.
float sdf(vec2 px) { return sdf_box(px, rect.zw * 0.5, radius); }

// The outline moved `t` inward, its corners rounder by as much (radius r + t, until the shape
// is too thin for it): the bevel's contour at depth t. At t = 0 it is the corner itself.
float inset_sdf(vec2 px, float t) {
    vec2 h = rect.zw * 0.5 - vec2(t);
    return sdf_box(px, h, max(min(radius + LAB_MUL(11, t), min(h.x, h.y)), 0.0));
}

// How deep into the bevel a point is: the t whose contour passes through it, up to w.
float lens_depth(vec2 px, float w) {
    vec2 h = rect.zw * 0.5;
    vec2 q = abs(px - rect.xy - h);
    float r = min(radius + LAB_MUL(11, w), min(h.x, h.y));
    // Clear of every corner at every depth up to w (the deepest contour's is the roundest):
    // the distance to the nearest side.
    if (q.x <= h.x - w - r || q.y <= h.y - w - r) return clamp(min(h.x - q.x, h.y - q.y), 0.0, w);
    if (inset_sdf(px, 0.0) >= 0.0) return 0.0;
    if (inset_sdf(px, w) < 0.0) return w;
    float lo = 0.0;
    float hi = w;
    for (int i = 0; i < 12; i++) {
        float m = 0.5 * (lo + hi);
        if (inset_sdf(px, m) < 0.0) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
}

// WCAG relative luminance of an sRGB-encoded colour (glass-legibility.ts's `luminance`).
float to_linear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
#ifdef GLASS_LAB
float to_encoded(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
#endif
float luminance(vec3 c) {
    return 0.2126 * to_linear(c.r) + 0.7152 * to_linear(c.g) + 0.0722 * to_linear(c.b);
}

// A triangle's signed distance (Inigo Quilez's, exact): negative inside, either winding.
float sd_triangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}

// The whole silhouette: the shape, and its pointer if it has one — the inset triangle grown
// back by the tip radius (a round tip, straight sides where they were), joined to the body
// by a concave arc of the base radius (hg_sdf's round union).
float shape_sdf(vec2 px) {
    float d = sdf(px);
    if (has_pointer > 0.5) {
        float p = sd_triangle(px, ptr_a, ptr_b, ptr_t) - ptr_tip_r;
        vec2 u = max(vec2(ptr_base_r - d, ptr_base_r - p), vec2(0.0));
        d = max(ptr_base_r, min(d, p)) - length(u);
    }
    return d;
}

uniform float noise;
uniform float brightness;
float noise_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 1689.1984);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Framebuffer pixels → the blurred copy (level 1, half size).
vec2 to_src(vec2 fb_px) { return (fb_px - region_fb.xy) * 0.5; }
vec4 backdrop(vec2 out_offset) { return up(to_src(v_fb + out_to_fb * out_offset)); }

void main() {
    float d = shape_sdf(v_out);
    // Cut straight where the clip ends (a list scrolled under its edge), anti-aliased.
    vec2 cin = min(v_out - clip.xy, clip.xy + clip.zw - v_out);
    float clipped = clamp(min(cin.x, cin.y) + 0.5, 0.0, 1.0);
    float cov = clamp(0.5 - d, 0.0, 1.0) * clipped * opacity;
    if (cov <= 0.0) discard;
    if (glass < 0.5) {
        vec4 c = backdrop(vec2(0.0));
        // Hyprland's blurFinish: noise, then its brightness (a window's backdrop; 0 and 1 for
        // the shell's blur-only surfaces).
        c.rgb += (noise_hash(v_out) - 0.5) * noise;
        c.rgb *= min(1.0, brightness);
        gl_FragColor = vec4(c.rgb * cov, cov);
        return;
    }

    // ── Refractive glass ──────────────────────────────────────────────────
    // The outward normal, from the distance field.
    vec2 n = vec2(shape_sdf(v_out + vec2(1.0, 0.0)) - shape_sdf(v_out - vec2(1.0, 0.0)),
                  shape_sdf(v_out + vec2(0.0, 1.0)) - shape_sdf(v_out - vec2(0.0, 1.0)));
    n = length(n) > 0.0001 ? normalize(n) : vec2(0.0);
    float inside = max(-d, 0.0);
    // Refraction: the pane's edge is a convex bevel, a quarter circle W wide and W thick,
    // lying ON the backdrop. Looking straight down, a ray meets the bevel's slope at θ, bends
    // to asin(sin θ / 1.5) (glass's index, Snell) — INWARD — and crosses the glass's height h
    // there, so it lands h·tan(θ − θr) further in. The backdrop is read from INSIDE the shape,
    // never beyond it: hard against the edge the slope is steepest and lines bend; further in
    // the bevel flattens and the backdrop is magnified a little, then nothing. Until
    // 2026-10-02 the edge read from OUTSIDE, (1 − t)² × refraction over a band the corner's
    // radius wide — and once refraction grew with the shape (125 px on the app grid, its
    // band still 32), 157 px of backdrop were squeezed into 32: a window under the grid
    // showed whole and shrunk, wallpaper round it (owner-caught: "an inverted magnifier").
    // `refraction` is the most the bevel displaces: 0.231 W at W thick, so W follows from
    // it — up to half the shape's shorter side, where the whole shape is lens. Thicker
    // magnifies more (1.5 W: the dock's icons under the app grid's edge, four times their
    // height); past ≈1.7 W the far side of the peak displaces faster than 1 px per px and the
    // backdrop folds back on itself, mirrored.
    // And never wider than BEVEL_MAX: past it a pane is flat glass inside, as a slab is — the
    // centre of a large pane frosts, only its edge bends (owner, the glass lab, 2026-10-05:
    // with the bevel half the app grid's height the whole panel was one roof of four faces).
    float bevel_max = LAB_ADD(12, 80.0);
    float lens_w = max(min(min(refraction / 0.231, min(rect.z, rect.w) * 0.5), bevel_max), 1.0);
    // The bevel's contours are the OUTLINE moved inward, each corner rounder by the depth
    // (`inset_sdf`, `lens_depth`), so what bends follows the corner's curve at the edge and
    // turns smoothly round it further in. Three ways it was wrong first: the outline's own
    // distance field (contours at radius r − t, a crease along the diagonal once the bevel is
    // wider than the corner is round); that field with corners max(r, W) round (2026-10-02),
    // which bent along an arc W round INSIDE the true corner and left the corner itself flat —
    // on the app grid an arc 108 px round inside a 32 px corner (owner-caught: "it bends along
    // a curve of its own, not the corner's"); then every contour keeping the corner's own
    // radius, whose normal still turned at once along the diagonal — a fold from each corner,
    // "like a flap" (owner, 2026-10-05).
    float lens_in = lens_depth(v_out, lens_w);
    vec2 ln = vec2(inset_sdf(v_out + vec2(1.0, 0.0), lens_in) - inset_sdf(v_out - vec2(1.0, 0.0), lens_in),
                   inset_sdf(v_out + vec2(0.0, 1.0), lens_in) - inset_sdf(v_out - vec2(0.0, 1.0), lens_in));
    ln = length(ln) > 0.0001 && lens_in < lens_w ? normalize(ln) : vec2(0.0);
    // The profile, then the strength, as the owner set them in the glass lab (2026-10-05,
    // preset "OK 2"): the quarter circle's height to the 5th power — the bend gathers at the
    // edge and the inside stays nearly flat — and three times Snell's displacement.
    float v = pow(1.0 - clamp(lens_in / lens_w, 0.0, 1.0), LAB_ADD(4, 5.0));
    float q = max(1.0 - v * v, 1e-4);
    float theta = atan(v / sqrt(q));
    float bend = lens_w * sqrt(q) * tan(theta - asin(sin(theta) / 1.5));
    vec2 off = -ln * bend * LAB_MUL(5, 3.0);
    // No dispersion: the colours bend together (the lab's preset; a red/blue fringe was the
    // default until then).
    vec3 bg = backdrop(off).rgb;
#ifdef GLASS_LAB
    if (lab(6) != 0.0) {
        float sp = 0.08 * max(lab(6), 0.0);
        bg = vec3(backdrop(off * (1.0 - sp)).r, bg.g, backdrop(off * (1.0 + sp)).b);
    }
#endif
    // Vibrancy: the backdrop's colour, a little stronger.
    float l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
    bg = clamp(mix(vec3(l), bg, saturation), 0.0, 1.0);
    l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
#ifdef GLASS_LAB
    // Tone: highlights compressed in linear light toward a ceiling, hue kept (C1 at the knee).
    if (lab(0) != 0.0) {
        float cap = lab(0);
        float knee = lab(1) != 0.0 ? lab(1) : 0.15;
        float lin = luminance(bg);
        if (lin > knee && cap > knee) {
            float b = ((1.0 - knee) / (cap - knee) - 1.0) / (1.0 - knee);
            float x = lin - knee;
            float k = (knee + x / (1.0 + b * x)) / lin;
            bg = clamp(vec3(to_encoded(to_linear(bg.r) * k), to_encoded(to_linear(bg.g) * k),
                            to_encoded(to_linear(bg.b) * k)), 0.0, 1.0);
        }
    }
    // Dim: an even black veil over the backdrop, before the tint.
    if (lab(2) != 0.0) bg *= 1.0 - clamp(lab(2), 0.0, 1.0);
#endif
    // The tint thickens exactly where the backdrop is too bright for white content:
    // after tinting, the luminance does not exceed target (per pixel; #673's rule, on the GPU).
    // target is a WCAG relative luminance — LINEAR light — while the tint is mixed into the
    // encoded colour, so the least alpha is searched for, not solved for. Comparing the
    // ENCODED luma with it darkened a white backdrop to 10:1 where 4.5:1 was asked (owner-
    // caught 2026-10-01: "with a white background everything looks dark").
    vec3 c;
    if (ink_dark > 0.5) {
        // Dark content (the ink event): the backdrop under it is bright everywhere, so the
        // glass stops darkening it for white content — a light veil instead.
        c = mix(bg, ink_tint, alpha_min);
    } else {
        float a = 0.0;
        if (luminance(bg) > target) {
            float lo = 0.0;
            float hi = alpha_max;
            for (int i = 0; i < 8; i++) {
                float m = 0.5 * (lo + hi);
                if (luminance(mix(bg, tint, m)) > target) lo = m; else hi = m;
            }
            a = hi;
        }
        a = clamp(a, alpha_min, alpha_max);
        c = mix(bg, tint, a);
    }
    // Specular rim: a thin line of light along the edge, brightest where the edge faces the
    // light (top-left) and again on the opposite side, almost nothing between — two highlights
    // across a diagonal, as the reference material's (the lab, 2026-10-05: the echo 0.35 → 0.70,
    // the line all round 0.18 → 0.017). No inner glow at rest: in the reference the light
    // inside a pane is feedback to a press (#744); a glow along the edge was ours until then.
    vec2 light = normalize(vec2(-0.55, -0.85));
#ifdef GLASS_LAB
    if (lab(8) != 0.0) {
        float an = radians(lab(8));
        light = vec2(cos(an) * light.x - sin(an) * light.y, sin(an) * light.x + cos(an) * light.y);
    }
#endif
    float edge = 1.0 - smoothstep(0.0, LAB_MUL(10, 1.6), inside);
    float facing = max(dot(n, light), 0.0);
    float back = max(dot(n, -light), 0.0);
    float spec = edge * (LAB_MUL(14, 0.017) + 0.82 * facing * facing + LAB_MUL(13, 0.70) * back) * rim;
#ifdef GLASS_LAB
    // The inner glow there was until 2026-10-05: wider than the rim, brighter facing the light.
    if (lab(9) != 0.0) {
        float band = max(min(radius, min(rect.z, rect.w) * 0.5), 1.0);
        spec += max(lab(9), 0.0) * (1.0 - smoothstep(0.0, band * 0.6, inside)) * (0.10 + 0.25 * facing) * rim;
    }
#endif
    c = c + spec * (1.0 - c);
    gl_FragColor = vec4(c * cov, cov);
}
