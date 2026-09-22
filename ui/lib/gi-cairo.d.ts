// The installer, the greeter and the lock screen are typechecked against the
// shell's real GI typings (each tsconfig.json includes ../shell/@girs and this
// file). This file shims ONLY what those typings get wrong.
//
// ⚠️ It must come FIRST in each tsconfig's `include`. @girs declares
// `gi://cairo` too, the two ambient declarations merge, and the one tsc reads
// first decides the default export — listed after @girs, this file is silently
// ignored (measured 2026-09-22: 4 LinearGradient errors in the installer).
//
// `gi://cairo`: ts-for-gir types it as the cairo-1.0 GIR — bare structs, no
// `LinearGradient`, no `Context` methods — while GJS answers that import with its
// own hand-written cairo module. Typed from the GIR, every gradient is an error.
//
// Nothing else belongs here. A module declared `any` is a module tsc stops
// reading: GLib was one until 2026-09-22, and `GLib.strdup_printf` — varargs, so
// absent from the GIR and `undefined` in GJS — threw on every machine with a
// Turing-or-newer NVIDIA GPU, on the System page and again on the Summary.
declare module "gi://cairo" { const v: any; export default v; }
