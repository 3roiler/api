<!--
  PR-Template für 3roiler/api.

  Hinweise:
  - Wenn der Change einen IDEA-NN aus ROADMAP.md adressiert, im Titel
    referenzieren (z. B. "feat(seo): … (IDEA-31)").
  - Bei DB-Migrationen den Rollback-Pfad explizit beschreiben (es gibt
    keinen automatischen Rollback nach Deploy).
  - SonarCloud + CodeQL laufen automatisch — keine manuelle Triggerung.
-->

## Summary

<!-- 1–3 Sätze: was ändert sich und warum. -->

## Changes

<!-- Bullet-Liste der konkreten Code-Änderungen. Bei Migrationen den
     Spalten-/Index-Namen nennen. -->

-

## Test plan

<!-- Was wurde lokal geprüft? Was muss nach Deploy verifiziert werden?
     Mindestens: typecheck/build clean, plus manueller Smoke-Test. -->

- [ ] `npm run build` clean
- [ ] `npm run lint` clean
- [ ]

## Deploy notes

<!-- Optional. Migration first? Caddyfile-Change im Companion-Repo?
     Reihenfolge wenn beide Repos angefasst sind. Sonst löschen. -->

## Roadmap reference

<!-- Wenn dieser PR einen IDEA-NN aus ROADMAP.md schließt oder anstößt. -->

Closes IDEA-NN <!-- oder: Part of IDEA-NN, Blocked-by IDEA-NN -->
