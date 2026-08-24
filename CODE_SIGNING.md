# Code signing policy

Yomi publishes installers only from automated builds of the public
[`RikaiDev/yomi`](https://github.com/RikaiDev/yomi) repository. A signature
identifies the artifact's build provenance; it does not imply endorsement by
LINE or approval of Yomi's protocol compatibility.

## Platforms

- **macOS:** the app and embedded Node runtime are signed with RikaiDev's Apple
  Developer Program organization identity, submitted to Apple's notarization
  service, and stapled before the DMG is published.
- **Windows:** the project is applying for free OSS signing through SignPath
  Foundation. Windows installers are not published as a general-user download
  until their Authenticode signature passes the release harness.

## Build and approval controls

- Source, build scripts, installer definitions, and release workflows are kept
  in this repository.
- GitHub Actions builds release artifacts on the target operating system.
- Protected release tags identify the exact source revision.
- Every installer must pass lint, tests, native quality gates, package-size
  budgets, an install or mount smoke test, and a bundled-runtime handshake.
- Signing credentials are stored outside the repository and are available only
  to the protected `desktop-release` environment.
- Release signing requires manual approval by a RikaiDev organization owner.

## Team roles

- **Committers and reviewers:** members of the
  [RikaiDev organization](https://github.com/orgs/RikaiDev/people).
- **Signing approvers:** RikaiDev organization owners.

No person may approve a signing request for an artifact built from uncommitted
or privately patched source.

## Privacy and network access

Yomi's data handling is documented in [`PRIVACY.md`](PRIVACY.md). The app
connects to LINE when the user asks it to access their account, and selected
coding tools may connect to their own providers. Yomi does not silently upload
LINE history to RikaiDev. The public npm version check can be disabled with
`YOMI_NO_UPDATE_CHECK=1`.

## Revocation and incident response

If a signing credential or release artifact is suspected to be compromised,
maintainers will stop publication, revoke the affected credential or signing
request, remove the affected download, publish a GitHub security advisory when
appropriate, and issue a replacement from reviewed source.

Windows signing, when approved, will state: "Free code signing provided by
SignPath.io, certificate by SignPath Foundation."
