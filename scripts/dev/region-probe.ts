// region-probe — does `ui/installer/lib/region.ts` derive sane answers from the
// four system tables it reads?
//
//   ./scripts/bundle.sh scripts/dev/region-probe.ts /tmp/region-probe && /tmp/region-probe
//
// It exists because the first version of that file was wrong twice and both faults
// looked like working code. Sorting a country's locales by their CODE put Aragonese
// first for Spain, Hunsrik for Brazil, Cherokee for the United States and Welsh for
// the United Kingdom — every one a real locale of that country, none of them the
// answer. And `zone1970.tab`'s order is not a population ranking: Brazil begins at
// an island of three thousand people. Neither shows up in a type, a bundle or a
// screenshot; both show up here, in one line each.
//
// The last block is a control: the four xkb/console mismatches that were fixed by
// hand before this file existed. If the parsing breaks, they stop matching.
import { countries, allTimezones, allLocales, allKeyboards, timezonesFor, localesFor, keyboardsFor, defaultsFor } from "../../ui/installer/lib/region"
import { countryName } from "../../ui/lib/locale-names"

print(`countries      ${countries().length}`)
print(`timezones      ${allTimezones().length}`)
print(`locales        ${allLocales().length}`)
print(`keyboards      ${allKeyboards().length}`)
print("")
for (const code of ["ES", "BR", "GB", "IN", "JP", "US", "AR", "CH", "AQ"]) {
  const c = countries().find(x => x.code === code)
  const d = defaultsFor(code)
  print(`${code} ${c?.name ?? "?"}`)
  print(`   zonas    ${timezonesFor(code).length}  → ${d.timezone}`)
  print(`   locales  ${localesFor(code).length}  → ${d.locale}`)
  print(`   teclado  ${keyboardsFor(code).length}  → ${d.keyboard ? `${d.keyboard.layout}/${d.keyboard.keymap} (${d.keyboard.label})` : "ninguno"}`)
}
print("")
print("— nombres: el país en el idioma del lector, el teclado por endónimo —")
for (const ui of ["es", "en", "de"]) {
  const names = ["ES", "DE", "GB", "BR"].map(c => {
    const f = countries().find(x => x.code === c)!
    return countryName(c, ui, f.name)
  })
  print(`   UI=${ui.padEnd(3)} ${names.join(" · ")}`)
}
for (const l of ["es", "gb", "latam", "br", "jp"]) {
  const k = allKeyboards().find(x => x.layout === l && !x.variant)
  print(`   teclado ${l.padEnd(6)} → ${k ? k.label : "?"}`)
}
print("")
print("— control: los 4 desajustes xkb/consola que arreglamos a mano —")
for (const l of ["gb", "latam", "pt", "br"]) {
  const k = allKeyboards().find(x => x.layout === l && !x.variant)
  print(`   xkb ${l.padEnd(6)} → keymap ${k ? k.keymap : "NO ENCONTRADO"}`)
}
