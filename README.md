# qm-feishu

An independently deployable Feishu/Lark message surface for [QM](https://github.com/yc-software/qm). It communicates with QM only through source-authenticated HTTP and never imports or vendors QM source.

## Supported surface

- direct messages and explicitly mentioned group messages
- topic/reply-chain continuity
- active-run stop and ordinary follow-up steering
- durable text and attachment delivery
- proactive principal delivery when explicitly enabled
- requester-verified command approval cards

Non-goals: group history ingestion, reactions, streaming edits, user-token impersonation, cross-tenant chats, and automatic Slack/Feishu identity merging.

## Requirements

- Node.js 24 or newer
- a separately running compatible QM service
- a Feishu application configured for long-connection events

The repositories may be sibling checkouts during development, but they share no workspace, source imports, lockfile, submodule, or symlink.

## Configuration

Required environment variables:

- `CORE_API_URL`
- `CORE_SIGNING_SECRET` (at least 32 characters)
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

`FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1` is optional and declares this adapter to be the deployment's only principal-delivery consumer. Do not enable it alongside another principal surface.

See `.env.example` for a synthetic local configuration.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The QM contract suite is opt-in:

```sh
QM_CONTRACT_BASE_URL=http://127.0.0.1:18080 \
QM_CONTRACT_SIGNING_SECRET=qm-feishu-contract-secret-00000001 \
npm run test:qm-contract
```

The compatibility envelope is recorded in `package.json` and `docs/compatibility.md`. QM HTTP routes are treated as observed external contracts, not a stable upstream SDK.

## License

MIT
