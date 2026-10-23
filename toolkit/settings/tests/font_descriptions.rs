// SPDX-License-Identifier: LGPL-3.0-or-later
//! Independent metadata oracle: Pango parses the serialized Config1 boundary;
//! rendering remains exclusively Parley. No font map or enumeration is created.
use nk_settings::font_description::Description;
use nk_text::Slant;
use std::process::Command;

#[test]
fn descriptions_agree_with_installed_pango_metadata() {
    let cases = [
        "Noto Sans Bold Italic 12",
        "Noto Sans Normal Italic 12",
        "Noto Sans Bold Light 12",
        "Noto Sans 12.1234",
        "Noto Sans Italic Light 13.5",
        "Noto Sans SemiBold Condensed 11",
        "日本語 12.5",
        "Studio Bold, 16px",
        "Studio 123, 12",
        "North, Italic 12",
        "North Star Roman 12",
        "Noto Sans Ultra-Black 12",
        "Noto Sans Book 12 @wght=380",
        "Noto Sans Ultra-Light Extra-Expanded Oblique 10",
        "Inter 12 @wght=725,wdth=90",
        "Inter 12 @wght=725.0,wdth=9.0e1",
    ];
    let canonical: Vec<_> = cases
        .iter()
        .map(|raw| Description::parse(raw).unwrap().canonical().unwrap())
        .collect();
    let output = Command::new("python3").args(["-c", r#"
import ctypes as c,json,sys
p=c.CDLL('libpango-1.0.so.0');g=c.CDLL('libglib-2.0.so.0')
p.pango_font_description_from_string.argtypes=[c.c_char_p];p.pango_font_description_from_string.restype=c.c_void_p
p.pango_font_description_free.argtypes=[c.c_void_p]
p.pango_font_description_get_family.argtypes=[c.c_void_p];p.pango_font_description_get_family.restype=c.c_char_p
p.pango_font_description_get_variations.argtypes=[c.c_void_p];p.pango_font_description_get_variations.restype=c.c_char_p
for n in ['weight','style','stretch','size','size_is_absolute']:
 f=getattr(p,'pango_font_description_get_'+n);f.argtypes=[c.c_void_p];f.restype=c.c_int
def parse(s):
 d=p.pango_font_description_from_string(s.encode());result={'family':p.pango_font_description_get_family(d).decode()}
 for n in ['weight','style','stretch','size','size_is_absolute']:result[n]=getattr(p,'pango_font_description_get_'+n)(d)
 axes=(p.pango_font_description_get_variations(d) or b'').decode()
 result['axes']={tag:float(value) for tag,value in (s.split('=') for s in axes.split(',') if s)}
 p.pango_font_description_free(d);return result
print(json.dumps([[parse(a),parse(b)] for a,b in zip(json.loads(sys.argv[1]),json.loads(sys.argv[2]))]))
"#, &serde_json::to_string(&cases).unwrap(), &serde_json::to_string(&canonical).unwrap()]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for (i, raw) in cases.iter().enumerate() {
        let d = Description::parse(raw).unwrap();
        let original = &rows[i][0];
        let roundtrip = &rows[i][1];
        for k in ["family", "weight", "style", "stretch", "axes"] {
            assert_eq!(original[k], roundtrip[k], "{raw} -> {}: {k}", canonical[i]);
        }
        assert_eq!(original["family"].as_str().unwrap(), d.family);
        assert_eq!(
            original["weight"].as_f64().unwrap() as f32,
            d.attributes.weight
        );
        assert_eq!(
            original["style"].as_i64().unwrap(),
            match d.attributes.slant {
                Slant::Normal => 0,
                Slant::Oblique => 1,
                Slant::Italic => 2,
            }
        );
        let widths = [50., 62.5, 75., 87.5, 100., 112.5, 125., 150., 200.];
        assert_eq!(
            widths[original["stretch"].as_u64().unwrap() as usize],
            d.attributes.width
        );
        let points = original["size"].as_f64().unwrap() / 1024.
            * if original["size_is_absolute"] == 1 {
                72. / 96.
            } else {
                1.
            };
        assert_eq!(
            (points * 1024.).round() as i64,
            roundtrip["size"].as_i64().unwrap()
        );
        assert_eq!(roundtrip["size_is_absolute"], 0);
        let rendered = nk_settings::styles::font_style(raw, 1.25, 1.3).unwrap();
        assert_eq!(rendered.family, d.family);
        assert_eq!(rendered.weight, original["weight"].as_f64().unwrap() as f32);
        assert_eq!(rendered.slant, d.attributes.slant);
        assert_eq!(
            rendered.width,
            widths[original["stretch"].as_u64().unwrap() as usize]
        );
        for setting in &rendered.variations {
            let tag = std::str::from_utf8(&setting.axis).unwrap();
            assert_eq!(
                setting.value,
                original["axes"][tag].as_f64().unwrap() as f32
            );
        }
        assert_eq!(rendered.variations, d.attributes.variations);
        assert_eq!(rendered.size, d.points * (96. / 72.) * 1.25);
        assert_eq!(Description::parse(&canonical[i]).unwrap(), d);
    }
}
