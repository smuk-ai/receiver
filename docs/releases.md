# Releasing the receiver

1. Update package.json, package-lock.json and CHANGELOG.md with a new version. Never reuse a published version or replace its assets.
2. Run npm ci, npm run build, npm run coverage, npm run e2e and npm run mutation. Review the diff independently and wait for CI on the release commit.
3. Run npm pack. Inspect the tarball allowlist: built dist files, public documentation, license/notice files and examples only. No credentials, user data, tests, source maps or private repository history belong in the release package.
4. Create the matching vVERSION tag on the tested commit. Create a GitHub release with the standalone dist/smuk-receiver.mjs, the npm package tarball, LICENSE and SHA256SUMS. The package tarball supports consumers without requiring an npm-registry publication. LICENSE is included when the project has adopted a license.
5. The SMUK application updates its dependency to the exact versioned package asset URL and commits package-lock.json integrity. Its build copies the package executable to /downloads/smuk-receiver.mjs and tests real deliveries against it. Release updates reach existing users only when they deliberately download the new executable; no automatic updater runs on their computer.

The public repository owns receiver logic, protocol definitions and signing helpers. The SMUK application owns routing, editor configuration and the visual setup guide. Keep the wire schema compatible or version it deliberately.

Keep Vite and Vitest on the tested pinned versions when updating development tools. Generate and commit the lockfile deliberately; fresh optional-peer resolution in npm 10 can fail even when the tested locked graph installs correctly. Verify every lockfile change with a clean npm ci.
