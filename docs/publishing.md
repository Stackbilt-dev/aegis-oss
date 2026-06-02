# Publishing

`@stackbilt/aegis-core` is published from `web/` by the tag-triggered GitHub Actions workflow in `.github/workflows/release.yml`.

## Release trigger

Push a semver tag from `main`:

```bash
git tag v0.8.0
git push origin v0.8.0
```

The workflow installs dependencies, runs typecheck/tests, then publishes `web/package.json` to npm.

## Authentication modes

The workflow supports two publish paths.

### Preferred: npm trusted publishing

Configure npm trusted publishing for package `@stackbilt/aegis-core`:

- Provider: GitHub Actions
- Repository: `Stackbilt-dev/aegis-oss`
- Workflow filename: `release.yml`
- Environment: unset unless the workflow is updated to use a GitHub environment

When trusted publishing is active, the workflow publishes with `npm publish --access public`. npm automatically emits provenance for public packages published from public GitHub-hosted runners.

### Fallback: npm automation token

Until trusted publishing is configured and verified, set the GitHub Actions secret `NPM_TOKEN` to a package-scoped npm automation token that can publish `@stackbilt/aegis-core`.

When `NPM_TOKEN` is present, the workflow publishes with token auth:

```bash
npm publish --provenance --access public
```

Keep `id-token: write` in the workflow permissions so provenance can still be generated for the token-auth fallback.

## Validation

A release is considered healthy when the tag-triggered workflow completes green and npm shows the tagged `web/package.json` version for `@stackbilt/aegis-core`.
