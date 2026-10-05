## Summary

<!-- What changed, why, and the impact on users of Nextbrowser or the CLI. -->

-

## Related issues

Closes #

## Change type

- [ ] Bug fix
- [ ] Change to what is read from linkedin.com (page scripts)
- [ ] Change to mention, company and keyword matching, search, or urgency triage
- [ ] Feature or enhancement
- [ ] Documentation or translation
- [ ] Maintenance or tooling

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Checked live against linkedin.com (describe the profile, the page and the result below)

```text
Commands and results:

```

## Page script changes

<!-- For changes to src/scripts.ts: the page, what LinkedIn drew and the date, and the trimmed fixture added. Write "Not applicable" otherwise. -->

## Checklist

- [ ] The engine stays read-only, clicks nothing, and keeps its pacing limits.
- [ ] Selectors lean on URNs, links and labels; any class name has a fallback and is listed in `src/scripts.ts`.
- [ ] Nothing outside `src/node/` imports Node.
- [ ] README translations are synchronized, if the README changed.
- [ ] No credentials, cookies, personal data, or generated `dist/` output are committed.
