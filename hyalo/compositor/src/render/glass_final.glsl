// The glass: one shape of a surface — or one fusion group of them, drawn as one silhouette —
// from the blurred copy of what is under it (glass_gl.rs).
//
// LAB hooks. The glass lab (scripts/dev/glass-lab) runs this same file with glass_gl.rs's
// `LAB_ON`, which gives each hook a value from lab_params.conf; Hyalo ships it with `LAB_OFF`,
// where `LAB_ADD(i, x)` and `LAB_MUL(i, x)` are `x` and every `#ifdef GLASS_LAB` block is
// compiled out. Every value 0 is the factory glass. A new layer to try goes here, behind a hook,
// and becomes the factory's by changing the number the hook wraps (and the lab's neutral).
//   lab[0]  tone: ceiling, the WCAG luminance white is compressed to (0 = off)        block
//   lab[1]  tone: knee, the luminance below which nothing changes (0 = 0.15)          block
//   lab[2]  Regular trial: begin removing adaptive dark tint at this backdrop luminance
//   lab[3]  Regular trial: finish removing it at the ink's dark threshold (0 = off)
//   lab[4]  bevel profile: + to its exponent (5)                                      ADD
//   lab[5]  refraction: × (1 + it) on its strength (3 × Snell's)                      MUL
//   lab[6]  dispersion: its spread, 1 = the fringe there was until 2026-10-05          block
//   lab[7]  Regular trial: light veil when the ink event turns its content dark
//   lab[8]  light: rotation of the rim's light, degrees                               block
//   lab[9]  inner glow: × it, 1 = the glow along the edge there was until 2026-10-05  block
//   lab[10] rim line: × (1 + it) on its width                                         MUL
//   lab[11] bevel corners: × (1 + it) on how much rounder they get per px of depth;
//           −1 = every contour keeps the corner's own radius (the fold, until 2026-10-05) MUL
//   lab[12] bevel width cap: + to its 80 px                                           ADD
//   lab[13] rim, the side opposite the light: × (1 + it) on its echo (0.70)           MUL
//   lab[14] rim, the line all round: + to its floor (0; 0.18 until 2026-10-05)           ADD
//   lab[15] dark contour: a 1 px line along the outline, darkened by it, 0..1           block
uniform vec4 region_fb;     // the captured region, framebuffer pixels
uniform mat2 out_to_fb;     // output-pixel offsets → framebuffer-pixel offsets
uniform vec4 rect;          // the shape, output pixels
uniform float radius;
uniform float exponent;
uniform float opacity;      // how FORMED the glass is in this shape, 0..1 (#764): not a coverage
uniform vec4 clip;          // what of the shape may show, output px: x, y, w, h
uniform float glass;        // 1: refractive glass — the compositor paints the whole glass
uniform vec3 tint;
uniform float alpha_min;
uniform float alpha_max;
uniform float target;
uniform float refraction;   // output px
uniform float px_scale;     // output px per logical px: the widths below are logical
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
// A fusion group (`set_fusion`): f_count shapes drawn as ONE silhouette, the smooth union of
// their outlines (glass_gl.rs `draw_plan`). The single-shape uniforms above then describe its
// first member and are not what is drawn.
#define FUSE_MAX 8
uniform float fused;        // 1: a fusion group
uniform float f_count;
uniform float f_k;          // the smooth union's width, output px (twice the group's spacing)
uniform vec4 f_env;         // the group's envelope (set_fusion_merge): x, y, w, h, output px
uniform vec4 f_env_par;     // its corner radius, exponent; the merge (0..1); its refraction
uniform vec4 f_rect[FUSE_MAX];   // each member, output px: x, y, w, h
uniform vec4 f_par[FUSE_MAX];    // radius, exponent, formed (`opacity`), ink_dark
uniform vec4 f_clip[FUSE_MAX];   // what of it may show, output px; w 0 = no clip
uniform float f_refr[FUSE_MAX];  // its refraction, output px
varying vec2 v_out;
varying vec2 v_fb;

// A box of half size `half_size` centred on `c`, corners superellipse quadrants of radius `r`
// and exponent `e`: signed distance in output pixels, negative inside.
float box_sdf(vec2 px, vec2 c, vec2 half_size, float r, float e) {
    vec2 q = abs(px - c);
    vec2 inner = half_size - vec2(r);
    if (q.x > inner.x && q.y > inner.y && r > 0.0) {
        vec2 k = (q - inner) / r;
        return (pow(pow(k.x, e) + pow(k.y, e), 1.0 / e) - 1.0) * r;
    }
    return max(q.x - half_size.x, q.y - half_size.y);
}
// The same, centred on the shape and with its corners' exponent.
float sdf_box(vec2 px, vec2 half_size, float r) {
    return box_sdf(px, rect.xy + rect.zw * 0.5, half_size, r, exponent);
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

// ── Fusion ──────────────────────────────────────────────────────────────────
// The polynomial smooth minimum (Inigo Quilez's): min(a, b) where they are k apart or more,
// lowered by up to k/4 where they are close — so two outlines less than k/2 apart are joined
// by a bridge, and the join is round.
float smin(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / max(k, 1e-4);
    return min(a, b) - h * h * k * 0.25;
}
// How wide a shape's bevel is: as for one shape alone (main's lens_w).
float bevel_width(vec4 r, float refr) {
    return max(min(min(refr / 0.231, min(r.z, r.w) * 0.5), LAB_ADD(12, 80.0) * px_scale), 1.0);
}
// The group's silhouette moved inward: each member's outline moved `s` of its own bevel width
// inward, corners rounder by as much (`inset_sdf`, member by member), all joined by the smooth
// union. At s = 0 it is the silhouette itself, each member cut by its clip there (the clip is a
// straight cut, not a contour: a single shape's bevel ignores it too). A member fading out
// withdraws, by up to the union's width, so a bridge to it recedes as it goes.
// ⚠️ The arrays are read only with the loop's index: in GLSL ES 1.00 a fragment shader may
// index a uniform array with nothing else.
float fused_sdf(vec2 px, float s) {
    float d = 1e6;
    for (int i = 0; i < FUSE_MAX; i++) {
        if (float(i) >= f_count) break;
        vec4 r = f_rect[i];
        vec4 p = f_par[i];
        float t = s * bevel_width(r, f_refr[i]);
        vec2 h = r.zw * 0.5 - vec2(t);
        float di = box_sdf(px, r.xy + r.zw * 0.5, h, max(min(p.x + LAB_MUL(11, t), min(h.x, h.y)), 0.0), p.y);
        vec4 c = f_clip[i];
        if (c.z > 0.0 && s <= 0.0) {
            vec2 cq = abs(px - c.xy - c.zw * 0.5) - c.zw * 0.5;
            di = max(di, max(cq.x, cq.y));
        }
        d = smin(d, di + (1.0 - p.z) * f_k, f_k);
    }
    // Towards the envelope (set_fusion_merge): a blend of two distance fields, so the silhouette
    // lies between the union and the envelope at every step — it fills the space between the
    // members from their middle outwards, never bulges past the envelope, never dents the union
    // — and at 1 it IS the envelope, its bevel inset as one shape's (one lens, one rim).
    if (f_env_par.z > 0.0) {
        float t = s * bevel_width(f_env, f_env_par.w);
        vec2 h = f_env.zw * 0.5 - vec2(t);
        float de = box_sdf(px, f_env.xy + f_env.zw * 0.5, h,
                           max(min(f_env_par.x + LAB_MUL(11, t), min(h.x, h.y)), 0.0), f_env_par.y);
        d = mix(d, de, f_env_par.z);
    }
    return d;
}
// What of the members a pixel takes — its bevel's width, its opacity, its ink — each member
// weighted by how near it is, the nearest whole, one f_k further away nothing.
vec3 fused_blend(vec2 px) {
    float dmin = 1e6;
    for (int i = 0; i < FUSE_MAX; i++) {
        if (float(i) >= f_count) break;
        vec4 r = f_rect[i];
        dmin = min(dmin, box_sdf(px, r.xy + r.zw * 0.5, r.zw * 0.5, f_par[i].x, f_par[i].y));
    }
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < FUSE_MAX; i++) {
        if (float(i) >= f_count) break;
        vec4 r = f_rect[i];
        vec4 p = f_par[i];
        float di = box_sdf(px, r.xy + r.zw * 0.5, r.zw * 0.5, p.x, p.y);
        float w = clamp(1.0 - (di - dmin) / max(f_k, 1.0), 0.0, 1.0);
        acc += w * vec3(bevel_width(r, f_refr[i]), p.z, p.w);
        wsum += w;
    }
    return acc / max(wsum, 1e-4);
}
// How deep into the group's bevel a point is, as a fraction of it: the s whose contour passes
// through it.
float fused_depth(vec2 px) {
    if (fused_sdf(px, 0.0) >= 0.0) return 0.0;
    if (fused_sdf(px, 1.0) < 0.0) return 1.0;
    float lo = 0.0;
    float hi = 1.0;
    for (int i = 0; i < 12; i++) {
        float m = 0.5 * (lo + hi);
        if (fused_sdf(px, m) < 0.0) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
}
// The silhouette, whichever it is.
float silhouette(vec2 px) { return fused > 0.5 ? fused_sdf(px, 0.0) : shape_sdf(px); }

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

// ── Glass that forms (#764) ─────────────────────────────────────────────────
// Glass has no opacity: a pane appearing MATERIALIZES — its blur, refraction, tint and rim grow
// from nothing — and is never the finished glass cross-faded over the sharp backdrop. The blur
// is grown in the capture (glass_gl.rs `formed_blur`: fewer passes, a shorter reach); what is
// left here is the sharp copy (level 0, full size) under one pass's least blur (`sharp_mix`),
// and, in a fusion group blurred for its most formed member, the members formed less.
uniform sampler2D sharp;
uniform vec2 sharp_size;
uniform float sharp_mix;
uniform float blur_formed;  // how formed the glass the blur was captured for is
vec3 sharp_at(vec2 out_offset) {
    vec2 fb = v_fb + out_to_fb * out_offset;
    return texture2D(sharp, clamp((fb - region_fb.xy) / sharp_size, 0.5 / sharp_size, 1.0 - 0.5 / sharp_size)).rgb;
}
// The backdrop as glass formed `formed` of the way sees it.
vec3 formed_backdrop(vec2 out_offset, float formed) {
    vec3 blurred = backdrop(out_offset).rgb;
    float w = (1.0 - sharp_mix) * clamp(formed / max(blur_formed, 1e-4), 0.0, 1.0);
    return w >= 0.999 ? blurred : mix(sharp_at(out_offset), blurred, w);
}

void main() {
    float d = silhouette(v_out);
    // A fusion group's width of bevel, how formed it is and its ink at this pixel (fused_blend); a single
    // shape's are its own.
    vec3 fb = fused > 0.5 ? fused_blend(v_out) : vec3(0.0, opacity, ink_dark);
    // Cut straight where the clip ends (a list scrolled under its edge), anti-aliased. (A fusion
    // group's members are cut inside `fused_sdf`; its clip uniform is none.)
    vec2 cin = min(v_out - clip.xy, clip.xy + clip.zw - v_out);
    float clipped = clamp(min(cin.x, cin.y) + 0.5, 0.0, 1.0);
    // Coverage is the silhouette and the clip only; how formed the glass is, is `formed`.
    float formed = fb.y;
    float cov = clamp(0.5 - d, 0.0, 1.0) * clipped;
    if (cov <= 0.0 || formed <= 0.0) discard;
    if (glass < 0.5) {
        vec3 c = formed_backdrop(vec2(0.0), formed);
        // Hyprland's blurFinish: noise, then its brightness (a window's backdrop; 0 and 1 for
        // the shell's blur-only surfaces).
        c += (noise_hash(v_out) - 0.5) * noise * formed;
        c *= mix(1.0, min(1.0, brightness), formed);
        gl_FragColor = vec4(c * cov, cov);
        return;
    }

    // ── Refractive glass ──────────────────────────────────────────────────
    // The outward normal, from the distance field.
    vec2 n = vec2(silhouette(v_out + vec2(1.0, 0.0)) - silhouette(v_out - vec2(1.0, 0.0)),
                  silhouette(v_out + vec2(0.0, 1.0)) - silhouette(v_out - vec2(0.0, 1.0)));
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
    float bevel_max = LAB_ADD(12, 80.0) * px_scale;
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
    float lens_in;
    vec2 ln;
    if (fused > 0.5) {
        // A fusion group: the bevel of the whole silhouette, the members' contours joined at
        // every depth, so it bends round a bridge as it does round a corner.
        lens_w = fb.x;
        float sd = fused_depth(v_out);
        lens_in = sd * lens_w;
        ln = vec2(fused_sdf(v_out + vec2(1.0, 0.0), sd) - fused_sdf(v_out - vec2(1.0, 0.0), sd),
                  fused_sdf(v_out + vec2(0.0, 1.0), sd) - fused_sdf(v_out - vec2(0.0, 1.0), sd));
        ln = length(ln) > 0.0001 && sd < 1.0 ? normalize(ln) : vec2(0.0);
    } else {
        lens_in = lens_depth(v_out, lens_w);
        ln = vec2(inset_sdf(v_out + vec2(1.0, 0.0), lens_in) - inset_sdf(v_out - vec2(1.0, 0.0), lens_in),
                  inset_sdf(v_out + vec2(0.0, 1.0), lens_in) - inset_sdf(v_out - vec2(0.0, 1.0), lens_in));
        ln = length(ln) > 0.0001 && lens_in < lens_w ? normalize(ln) : vec2(0.0);
    }
    // The profile, then the strength, as the owner set them in the glass lab (2026-10-05,
    // preset "OK 2"): the quarter circle's height to the 5th power — the bend gathers at the
    // edge and the inside stays nearly flat — and three times Snell's displacement.
    float v = pow(1.0 - clamp(lens_in / lens_w, 0.0, 1.0), LAB_ADD(4, 5.0));
    float q = max(1.0 - v * v, 1e-4);
    float theta = atan(v / sqrt(q));
    float bend = lens_w * sqrt(q) * tan(theta - asin(sin(theta) / 1.5));
    // The bend grows with the glass (#764).
    vec2 off = -ln * bend * LAB_MUL(5, 3.0) * formed;
    // No dispersion: the colours bend together (the lab's preset; a red/blue fringe was the
    // default until then).
    vec3 bg = formed_backdrop(off, formed);
#ifdef GLASS_LAB
    if (lab(6) != 0.0) {
        float sp = 0.08 * max(lab(6), 0.0);
        bg = vec3(backdrop(off * (1.0 - sp)).r, bg.g, backdrop(off * (1.0 + sp)).b);
    }
#endif
    // Vibrancy: the backdrop's colour, a little stronger — as much as the glass is formed.
    float l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
    bg = clamp(mix(vec3(l), bg, mix(1.0, saturation, formed)), 0.0, 1.0);
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
#endif
    // The tint thickens exactly where the backdrop is too bright for white content:
    // after tinting, the luminance does not exceed target (per pixel; #673's rule, on the GPU).
    // target is a WCAG relative luminance — LINEAR light — while the tint is mixed into the
    // encoded colour, so the least alpha is searched for, not solved for. Comparing the
    // ENCODED luma with it darkened a white backdrop to 10:1 where 4.5:1 was asked (owner-
    // caught 2026-10-01: "with a white background everything looks dark").
    vec3 c;
    if (fb.z > 0.5) {
        // Dark content (the ink event): the backdrop under it is bright everywhere, so the
        // glass stops darkening it for white content — a light veil instead.
        float light_veil = alpha_min;
#ifdef GLASS_LAB
        // The Lab's backdrop-driven Regular uses this same ink event for its logo, veil and
        // elevation. The mode-bound light recipe already has alpha_min = modeLightVeil.
        light_veil = max(light_veil, lab(7));
#endif
        c = mix(bg, ink_tint, light_veil * formed);
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
        // The tint thickens as the glass forms.
        a = clamp(a, alpha_min, alpha_max) * formed;
#ifdef GLASS_LAB
        // Trial only: on a uniformly brightening backdrop, the old ink event took
        // the whole shape from darkened glass to a light veil in one frame. Let the
        // dark tint vanish continuously before that event. The ink itself remains
        // the protocol's boolean decision; this does not make text continuously adaptive.
        if (lab(2) > 0.0 && lab(3) > lab(2))
            a *= 1.0 - smoothstep(lab(2), lab(3), luminance(bg));
#endif
        c = mix(bg, tint, a);
    }
    // Specular rim: a band of light along the edge where it faces the light (top-left) and again
    // on the opposite side, nothing between — two highlights across a diagonal, as the reference
    // material's (the lab, 2026-10-05: the echo 0.35 → 0.70, the line all round 0.18 → 0). No
    // inner glow (owner, 2026-10-05: "the material has to be defined — without inner glow, then
    // without inner glow"); in the reference the light inside a pane is feedback to a press (#744).
    vec2 light = normalize(vec2(-0.55, -0.85));
#ifdef GLASS_LAB
    if (lab(8) != 0.0) {
        float an = radians(lab(8));
        light = vec2(cos(an) * light.x - sin(an) * light.y, sin(an) * light.x + cos(an) * light.y);
    }
#endif
    // 3.2 px of fade inward: a band of light with thickness, not a hairline (1.6 until the owner's
    // "OK 4", 2026-10-05), and not a frame either — 6.4 on the desktop read "too intense or wide",
    // and the lab's side by side settled it (owner, 2026-10-06: "3.2 without the halo looks best").
    float edge = 1.0 - smoothstep(0.0, LAB_MUL(10, 3.2) * px_scale, inside);
    float facing = max(dot(n, light), 0.0);
    float back = max(dot(n, -light), 0.0);
    float spec = edge * (LAB_ADD(14, 0.0) + 0.82 * facing * facing + LAB_MUL(13, 0.70) * back) * rim;
#ifdef GLASS_LAB
    // The inner glow there was until 2026-10-05: wider than the rim, brighter facing the light.
    if (lab(9) != 0.0) {
        float band = max(min(radius, min(rect.z, rect.w) * 0.5), 1.0);
        spec += max(lab(9), 0.0) * (1.0 - smoothstep(0.0, band * 0.6, inside)) * (0.10 + 0.25 * facing) * rim;
    }
#endif
    c = c + spec * formed * (1.0 - c);
#ifdef GLASS_LAB
    // A dark line along the outline, one logical px: the reference material's edge at rest, where
    // its rim of light is off (glass-probe, 2026-10-08: the line at ≈0.63 of the glass inside it,
    // i.e. lab[15] ≈ 0.37).
    if (lab(15) != 0.0) c *= 1.0 - clamp(lab(15), 0.0, 1.0) * (1.0 - smoothstep(0.0, px_scale, inside)) * formed;
#endif
    gl_FragColor = vec4(c * cov, cov);
}
