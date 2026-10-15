// SPDX-License-Identifier: LGPL-3.0-or-later
//! Run each engine in a fresh process: peak RSS must not leak across backends.
use nk_text::{FontSet, Result, corpus};
use serde::{Deserialize, Serialize};
use std::{fs, hint::black_box, process::Command, sync::Arc, time::Instant};

const REPEATS: usize = 50;
#[derive(Serialize, Deserialize)]
struct Worker {
    backend: String,
    layouts_per_pass: usize,
    init_ms: f64,
    cold_ms: f64,
    warm_median_ms: f64,
    warm_min_ms: f64,
    warm_max_ms: f64,
    baseline_rss_kib: u64,
    peak_rss_kib: u64,
    results: Vec<corpus::CaseResult>,
}
fn memory(field: &str) -> Result<u64> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|e| format!("Linux /proc memory measurement unavailable: {e}"))?;
    status
        .lines()
        .find_map(|line| line.strip_prefix(field))
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("/proc/self/status omitted {field}"))
}
fn worker(name: &str) -> Result<Worker> {
    let baseline_rss_kib = memory("VmRSS:")?;
    let fonts = Arc::new(FontSet::discover_required()?);
    let cases = corpus::cases()?;
    let started = Instant::now();
    let mut engine = corpus::backend(name, fonts.clone())?;
    let init_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut pass = || -> Result<(f64, usize)> {
        let started = Instant::now();
        let mut retained = Vec::new();
        for case in &cases {
            let style = corpus::style(case, &fonts);
            for width in &case.widths {
                retained.push(engine.layout(&case.text, &style, *width)?);
            }
        }
        // Keep the layouts and their paint runs alive together until after the
        // timing sample. Includes extraction of positioned runs and font data.
        for layout in &retained {
            black_box(layout.glyph_runs());
        }
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        black_box(&retained);
        Ok((elapsed, retained.len()))
    };
    let (cold_ms, layouts_per_pass) = pass()?;
    let mut samples = Vec::new();
    for _ in 0..REPEATS {
        samples.push(pass()?.0);
    }
    samples.sort_by(f64::total_cmp);
    let peak_rss_kib = memory("VmHWM:")?;
    eprintln!("{name}: backend initialisation {init_ms:.3} ms (excluded from layout timings)");
    // Correctness is outside the measured layout workload and its RSS sample.
    let results = cases
        .iter()
        .map(|case| corpus::run_case(case, name, fonts.clone()))
        .collect();
    Ok(Worker {
        backend: name.into(),
        layouts_per_pass,
        init_ms,
        cold_ms,
        warm_median_ms: (samples[REPEATS / 2 - 1] + samples[REPEATS / 2]) / 2.0,
        warm_min_ms: samples[0],
        warm_max_ms: samples[REPEATS - 1],
        baseline_rss_kib,
        peak_rss_kib,
        results,
    })
}
fn command(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|r| r.status.success())
        .map(|r| String::from_utf8_lossy(&r.stdout).trim().to_owned())
        .unwrap_or_else(|| "unavailable".into())
}
fn escape(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}
fn run() -> Result<bool> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let [flag, name] = args.as_slice()
        && flag == "--worker"
    {
        println!(
            "{}",
            serde_json::to_string(&worker(name)?).map_err(|e| e.to_string())?
        );
        return Ok(true);
    }
    let fonts = FontSet::discover_required()?;
    if args == ["--check-fonts"] {
        println!(
            "Required-font preflight PASS\n{}",
            serde_json::to_string_pretty(&fonts.files).map_err(|e| e.to_string())?
        );
        return Ok(true);
    }
    if !args.is_empty() && args != ["--json"] {
        return Err("usage: corpus-report [--check-fonts | --json]".into());
    }
    let mut workers = Vec::new();
    for name in corpus::backend_names() {
        let output = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(["--worker", name])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "{name} worker failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        workers.push(
            serde_json::from_slice::<Worker>(&output.stdout)
                .map_err(|e| format!("{name} worker output: {e}"))?,
        );
    }
    if workers.is_empty() {
        return Err("enable at least one backend feature".into());
    }
    let mut results: Vec<_> = workers
        .iter_mut()
        .flat_map(|w| std::mem::take(&mut w.results))
        .collect();
    corpus::compare_line_counts(&mut results);
    results.sort_by(|a, b| a.case.cmp(&b.case).then(a.backend.cmp(&b.backend)));
    let passed = results.iter().all(corpus::CaseResult::passed);
    if args == ["--json"] {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({"workers": workers, "cases": results, "fonts": fonts.files, "warm_repeats": REPEATS})).map_err(|e| e.to_string())?);
        return Ok(passed);
    }
    println!("# nk-text corpus evidence\n");
    let cpu = fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines().find_map(|line| {
                line.strip_prefix("model name")
                    .and_then(|s| s.split_once(':').map(|(_, value)| value.trim().to_string()))
            })
        })
        .unwrap_or_else(|| "unavailable".into());
    println!(
        "Run UTC: {}. CPU: {}.\n",
        command("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]),
        cpu
    );
    println!(
        "Generated on {}. `{}`; native Pango `{}`.\n",
        command("uname", &["-sm"]),
        command("rustc", &["--version"]),
        command("pkg-config", &["--modversion", "pango"])
    );
    println!(
        "| Case | Backend | Result | Why | Width → lines / native clusters |\n|---|---|---|---|---|"
    );
    for result in &results {
        let counts = result
            .widths
            .iter()
            .map(|w| format!("{} → {} / {}", w.width, w.lines, w.clusters))
            .collect::<Vec<_>>()
            .join("; ");
        println!(
            "| {} | {} | {} | {} | {} |",
            result.case,
            result.backend,
            if result.passed() { "PASS" } else { "FAIL" },
            escape(&result.failures.join("; ")),
            counts
        );
    }
    println!(
        "\n| Backend | Layouts/pass | Cold corpus (ms) | Warm median (ms) | Warm min–max (ms), {REPEATS} passes | Peak RSS (KiB) | Baseline RSS (KiB) |\n|---|---:|---:|---:|---:|---:|---:|"
    );
    for w in &workers {
        println!(
            "| {} | {} | {:.3} | {:.3} | {:.3}–{:.3} | {} | {} |",
            w.backend,
            w.layouts_per_pass,
            w.cold_ms,
            w.warm_median_ms,
            w.warm_min_ms,
            w.warm_max_ms,
            w.peak_rss_kib,
            w.baseline_rss_kib
        );
    }
    println!(
        "\nEach backend uses a fresh child process and the same files. Timing includes native layout and extraction of paint runs, excludes font discovery, backend initialisation and editing checks. All layouts for a pass are retained together. Peak RSS is Linux VmHWM after the cold + warm layout passes, before correctness checks; it includes the runtime, font bytes and native allocations. Baseline is VmRSS before loading fonts. Font caches/filesystem caches are not flushed. RSS and elapsed times are observations, not engine selection criteria on their own.\n"
    );
    println!("## Shared font manifest\n\n| Family | Face | File | SHA-256 |\n|---|---:|---|---|");
    for f in &fonts.files {
        let digest = command(
            "sha256sum",
            &[f.path.to_str().ok_or("font path is not UTF-8")?],
        );
        println!(
            "| {} | {} | {} | {} |",
            f.family,
            f.index,
            f.path.display(),
            digest.split_whitespace().next().unwrap_or("unavailable")
        );
    }
    Ok(passed)
}
fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(e) => {
            eprintln!("nk-text report/preflight: {e}");
            std::process::exit(2);
        }
    }
}
