// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_text::{FontSet, corpus};
use std::sync::Arc;
#[test]
fn corpus_both_backends() {
    let fonts = Arc::new(FontSet::discover_required().expect("required-font preflight failed"));
    let cases = corpus::cases().expect("invalid corpus");
    let names = corpus::backend_names();
    assert!(!names.is_empty(), "enable parley and/or pango features");
    let mut results = Vec::new();
    for case in &cases {
        for name in &names {
            results.push(corpus::run_case(case, name, fonts.clone()));
        }
    }
    corpus::compare_line_counts(&mut results);
    let mut failures = Vec::new();
    for result in results {
        println!(
            "{} / {}: {} {:?}",
            result.case,
            result.backend,
            if result.passed() { "PASS" } else { "FAIL" },
            result.failures
        );
        for why in result.failures {
            failures.push(format!("{} / {}: {why}", result.case, result.backend));
        }
    }
    assert!(
        failures.is_empty(),
        "corpus failures:\n{}",
        failures.join("\n")
    );
}
