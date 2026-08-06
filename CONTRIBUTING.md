# Contributing

## Before opening an issue

Use GitHub Security Advisories for vulnerabilities or reports containing credentials, tenant identifiers, event payloads, commands, file contents, or message contents. Follow `SECURITY.md`; do not publish sensitive data in an issue.

For ordinary bugs, search existing issues first and provide a minimal reproduction with synthetic identifiers and redacted logs.

## Development

Requirements:

- Node.js 24 or newer;
- access to the public npm registry;
- a separate QM checkout only when running the opt-in compatibility suite.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Run a focused test while developing:

```sh
node --import tsx --test test/path/to/file.test.ts
```

Do not commit `.env`, credentials, production payloads, tenant data, generated `dist/`, coverage, or logs.

## Pull requests

Keep changes focused and follow existing TypeScript style. Add a behavioral test for every new contract or bug fix. Explain user-visible behavior, security impact, and verification commands in the pull request.

Changes to QM HTTP routes or response decoding must update the pinned contract suite and `docs/01-architecture/compatibility.md`. Never import, vendor, symlink, or add a file dependency on QM source.

Release evidence must come from the exact candidate commit. Do not mark a live scenario passed without a real dedicated-tenant observation and redacted evidence.
