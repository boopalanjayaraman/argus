# UX port map — read before touching any page

Source of truth: `docs/ux/Argus click-through-html/Main.dc.html` (markup + data
builders) and `ds/argus/components/bundle.css` (all styling). The single-page
export `docs/ux/Argus single page click-through.html` is the same design
flattened; use whichever is easier to extract from.

## Rule (no exceptions)

1. Extract the exact DOM for the page/tab/state from the source above.
2. Keep every class name and structure byte-identical; bind real data into
   the existing slots only. Never invent a class, layout, or component.
3. A page is not "done" until a screenshot of the built page and a render of
   the mockup at the same viewport have been compared side by side.
4. `npm run check:ux` (also part of `npm test`) fails the build if App.tsx
   uses an `ar-*` class that exists in neither bundle.css nor Main.dc.html.

## Map (Main.dc.html line ranges)

| Surface | Source |
|---|---|
| App shell / header | `ar-top`, lines 21-35 |
| Home | `isHome`, lines 37-118 |
| Reports | `isReports`, lines 120-165 |
| Inspection Rules | `isRules`, lines 167-245 |
| Session header + tabs | `ar-ihead`, lines 247-272 |
| Live (waiting/receiving/analyzing/ready/closed) | `tabLive`, lines 274-438 |
| Applicable Rules tab | `tabRules`, lines 440-506 |
| Documents tab | `tabDocs`, lines 508-543 |
| Dossier tab | `tabDossier`, lines 545-590 |
| End / Terminate dialogs | lines 592-625 |

Deep links for screenshot checks: `#session/<id>`, `#session/<id>/rules`,
`#session/<id>/documents`, `#session/<id>/dossier`.
