# Releasing

## Before a public release

1. Confirm that publishing this integration and using the Qoder name and SDK
   complies with the current Qoder Product Service Terms. Keep any written
   permission with the project records.
2. Confirm the public GitHub repository is available:
   `https://github.com/naoufalelbani/opencode-qoder-bridge`.
3. Create an npm account, enable two-factor authentication, and run `npm login`.
4. Review production dependency advisories with `npm audit --omit=dev`. Do not
   apply forced or major-version fixes without running the full integration
   suite.

## Public publish

Run the complete release gate from a clean checkout:

```bash
npm ci
npm run check
npm run test:stress
QODER_E2E=1 npm run test:e2e   # requires qoder login; consumes quota
npm pack --dry-run
npm publish --access public
```

The end-to-end gate is mandatory for any release that touches
`src/language-model.ts`, `src/models.ts`, or `src/usage.ts`: unit tests mock
the SDK, so only `QODER_E2E=1` exercises real streaming, tool calls, provider
metadata, and live model discovery. Verify before publishing that the dry-run
tarball contains `dist/` (including `errors.js`, `logger.js`,
`state-dir.js`) and both `bin/` scripts, and nothing else unexpected.

Verify the registry package and install it through OpenCode:

```bash
npm view opencode-qoder-bridge
```

When validating a clean consumer with npm 12, transitive install scripts may be
blocked by the consumer's policy. Approve the SDK script and rebuild it when
the bundled Worker runtime is required:

```bash
npm install-scripts approve @qoder-ai/qoder-agent-sdk@1.0.31
npm rebuild @qoder-ai/qoder-agent-sdk
```

```json
{
  "plugin": ["opencode-qoder-bridge"]
}
```

## Trusted publishing

The repository publishes to npm automatically when a GitHub Release is
published. `.github/workflows/publish.yml` checks out the release tag, verifies
that the tag version matches `package.json`, runs `npm ci`, `npm run check`,
`npm run test:stress`, validates the tarball, and publishes with npm provenance.

One-time npm configuration is required after the package exists on npm:

1. Open the package settings on npmjs.com.
2. Add a GitHub Actions trusted publisher for:
   - Owner: `naoufalelbani`
   - Repository: `opencode-qoder-bridge`
   - Workflow filename: `.github/workflows/publish.yml`
   - Environment: leave blank unless the workflow is later changed to use one.
3. Keep the repository public so npm can generate provenance.
4. Do not add an `NPM_TOKEN`; the workflow uses GitHub OIDC trusted publishing.
5. Optionally configure npm to disallow token-based publishing after the
   trusted workflow succeeds.

The workflow requires the `id-token: write` permission and npm CLI 11.5.1 or
newer. A failed publish is safe to retry by publishing the same GitHub Release
again only after confirming npm does not already contain that version.

## Subsequent releases

Update `version` using semantic versioning, document the release in
`CHANGELOG.md`, run the release gate, commit the change, and push a matching
tag. Then publish the GitHub Release; npm publication happens automatically:

```bash
npm version patch --no-git-tag-version
# update CHANGELOG.md
npm ci
npm run check
npm run test:stress
git add package.json package-lock.json CHANGELOG.md dist src test
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
gh release create vX.Y.Z --target vX.Y.Z --generate-notes
```

The release event triggers `.github/workflows/publish.yml`. Never reuse a
version already published to npm.

## Recovery from a bad release

Never delete or overwrite a published version. If a release is defective:

1. Publish a corrected patch version and mark the defective GitHub release as
   deprecated in its notes.
2. If the package must be blocked, run `npm deprecate
   opencode-qoder-bridge@X.Y.Z "Use X.Y.Z+1: <short reason>"` with an
   authenticated npm account.
3. Update the README and changelog with the replacement version.
4. Re-run the complete release workflow and verify the replacement version on
   npm before announcing it.
