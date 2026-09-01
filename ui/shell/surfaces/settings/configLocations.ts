// Where each setting LIVES, derived from the page manifest.
//
// `describeConfig` answers "what can I change"; without this it could not answer
// "and where does the user see it". That second question is the one an agent gets
// asked in practice — "turn night light on" is easy, "where do I change it myself"
// used to be unanswerable from data, so the answer was guessed from the key's
// prefix. `nightlight.*` lives on the APPEARANCE page: the prefix was a lie there,
// and a plausible lie is worse than a blank.
//
// ⚠️ Pure data, like `manifest.ts` itself: no `gi://`, so the CI check can import
// it. It is wired in `app.ts` (never from `core/`, which must not import surfaces).
import { manifest, type ItemDecl, type PageDecl } from "./manifest.ts"
import type { ConfigLocation } from "../../core/ConfigRegistry"

/** key → { page, group } for every setting a page draws, including the ones a
 *  bespoke control owns (`{ custom, key }`) and the ones nested in a disclosure. */
export function configLocations(): Record<string, ConfigLocation> {
    const out: Record<string, ConfigLocation> = {}

    const put = (key: string, page: string, group?: string) => {
        // First declaration wins and the CI contract forbids a second one, so a
        // duplicate here would be a manifest bug, not something to paper over.
        if (!out[key]) out[key] = group ? { page, group } : { page }
    }

    const walk = (items: readonly ItemDecl[] | undefined, page: string, group?: string) => {
        for (const item of items ?? []) {
            if (typeof item === "string") put(item, page, group)
            else if ("disclosure" in item) walk(item.items, page, group)
            else if ("custom" in item) { if (item.key) put(item.key, page, group) }
            else if ("key" in item) put(item.key, page, group)
        }
    }

    for (const page of manifest as readonly PageDecl[]) {
        for (const g of page.groups ?? []) {
            // A headerless group has no name to give; the page is the whole answer.
            walk(g.items, page.id, g.i18n || undefined)
        }
    }
    return out
}
