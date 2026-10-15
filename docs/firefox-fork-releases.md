# Firefox fork releases

Every push to `main`, including a merged pull request, queues the **Release Firefox fork** workflow. Queued runs execute one at a time (up to GitHub's 100-run concurrency queue limit).

The fork's version lives in `fork-version.json`, independently of the upstream versions in `package.json` and `src/manifest.json`. It starts at the existing fork release, `4.9.133`. Each new run increments the minor component and resets the patch component: `4.9.133 → 4.10.0 → 4.11.0`. Firefox release builds use this version in their manifest; debug builds retain the normal debug version.

The workflow checks out current `main`, commits the version change with a marker for the triggering push, and atomically pushes that commit and its `v<version>` tag. It then installs dependencies, runs the versioning and unit tests, builds Firefox, checks the manifest version, and publishes `darkreader-firefox-<version>.xpi` to a GitHub release explicitly marked **Latest**. Each release tag identifies the source and version used for its XPI. If newer merges have arrived while a run waits, its release includes those changes too.

## Repository setup

GitHub Actions must be enabled. The workflow requests `contents: write` and uses the built-in `GITHUB_TOKEN`; no personal access token or release secret is needed. Repository or organization policies must allow this permission and allow the workflow to push its version commit to `main` and create release tags. Configure any future branch or tag rules accordingly.

Pushes made with `GITHUB_TOKEN` do not trigger another push workflow, so the version commit does not create a release loop.

## Failed runs

Rerun the failed workflow in GitHub Actions. The source marker finds the existing version commit and tag, so retries rebuild the same release instead of incrementing again. A version remains reserved if tests, the build, or publication fail after its commit is pushed. Existing published releases are left intact; an incomplete draft is uploaded and published on retry. Retrying an older release does not replace a newer release as Latest.

If another push changes `main` during version reservation, the workflow retries up to three times against current `main`. A rejected push or an existing conflicting tag fails visibly instead of overwriting history or tags.

## Building locally

Run `npm ci` and `npm run build:firefox` to create `build/release/darkreader-firefox.xpi` with the tracked fork version. Run `node tasks/fork-version.js` to increment the tracked version manually, and `npm run test:release` to test versioning.

## Firefox signing

These custom XPIs are unsigned. Normal Firefox release builds require Mozilla signing for permanent installation; development/testing installations follow [Mozilla's signing and distribution guidance](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). The upstream signatures in this repository cannot sign modified fork builds. This workflow publishes GitHub releases; it does not configure Mozilla signing or Firefox automatic updates.
