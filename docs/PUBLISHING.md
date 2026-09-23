# Public source checks

Mochi is source available under the PolyForm Noncommercial license. The intended repository is `mochi-oracle/mochi`. First-party local Git metadata uses the neutral identity `Mochi Project <source@mochi.invalid>`; this metadata does not hide the identity of anyone who publishes or interacts with the repository.

## Local setup and checks

From the repository root, install the repository-local identity settings and hooks, then run the local candidate check:

```sh
bun scripts/install-identity-hooks.ts
bun scripts/publish-public.ts --check
```

The installer configures only this repository. It sets the neutral author and committer identity, disables commit and tag signing, clears the repository-local credential helper, and enables the hooks in `.githooks`. Keep any additional private identifiers in the untracked `.git/info/identity-denylist`, one value per line. The scanner checks those values against file paths and raw file bytes; never commit or share the denylist.

The staged scan reads Git index blobs. The full scan reads tracked blobs, and the history scan checks reachable commit and tag identities, messages, and historical file contents. Gitlinks are rejected because this export uses vendored source files. Email checks permit reserved example addresses and preserve third-party attribution; attribution and license notices must remain intact.

## Publication

Publication uses the explicitly approved personal GitHub account, while all first-party commits retain neutral project authorship. Contributor attribution is the protected boundary; push activity may identify the publishing account. No GitHub App is required.

Keep the approved account login and numeric account ID only in repository-local Git config (`mochi.publisherLogin` and `mochi.publisherId`). The publisher selects that account's existing GitHub CLI credential and verifies both fields through GitHub before transport. Do not commit account settings or tokens. The second developer uses the same neutral commit setup; changes to the approved publishing account require explicit authorization.

Run `bun scripts/publish-public.ts main` from a clean checkout. The publisher scans source and all history, checks the exact organization remote, pins the approved credential for transport, and pushes one explicit branch without force or tags. The pre-push hook rechecks the authenticated account, content, history and fast-forward requirement. Local `--check` needs no GitHub credential.

## Limits

These checks are safeguards, not a guarantee of anonymity or a security boundary. Git hooks can be bypassed, local settings can be changed, and other Git clients can publish without these scripts. Neutral commit metadata does not conceal the pusher or repository activity. Replacing or rewriting Git history does not erase GitHub events, account activity, server timestamps, network metadata, or copies already made by others. Scanners can miss new secret formats or personal identifiers that are not present in the local denylist.
