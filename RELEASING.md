# Releasing

## Before the first release

1. Confirm that publishing this integration and using the Qoder name and SDK
   complies with the current Qoder Product Service Terms. Keep any written
   permission with the project records.
2. Create the public GitHub repository:
   `https://github.com/naoufalelbani/opencode-qoder-bridge`.
3. Create an npm account, enable two-factor authentication, and run `npm login`.
4. Review production dependency advisories with `npm audit --omit=dev`. Do not
   apply forced or major-version fixes without running the full integration
   suite.

## First publish

Run the complete release gate from a clean checkout:

```bash
npm ci
npm run check
npm pack --dry-run
npm publish
```

Verify the registry package and install it through OpenCode:

```bash
npm view opencode-qoder-bridge
```

```json
{
  "plugin": ["opencode-qoder-bridge"]
}
```

## Trusted publishing

After the package exists on npm:

1. Open the package settings on npmjs.com.
2. Add a GitHub Actions trusted publisher for:
   - Owner: `naoufalelbani`
   - Repository: `opencode-qoder-bridge`
   - Workflow: `publish.yml`
   - Allowed action: `npm publish`
3. Keep the repository public so npm can generate provenance.
4. Consider configuring the npm package to disallow token-based publishing
   after the trusted workflow succeeds.

## Subsequent releases

Update `version` using semantic versioning, run the release gate, commit the
change, and push a matching tag:

```bash
npm version patch
git push origin main --follow-tags
```

The tag triggers `.github/workflows/publish.yml`. Never reuse a version already
published to npm.

