# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Genjorbacor/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Genjorbacor/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP, REST v3, GraphQL and MCP over its own in-memory store. No dependencies, no database, no UI — just one process an agent can start inside a sandbox. It passes the make.fun suite's 120 conformance checks (git, repos, issues, pulls, protocol, GraphQL, MCP) and scores 966/1000 locally against the kit's sealed runner.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: it binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, and exits when the suite says the trial is done. For local testing against the kit's runner:

```sh
PORT=8090 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types local.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8090 --token test-token --perf
```

Node 22 or newer, standard library only. The forge keeps everything in memory for the life of the process and stamps server-created objects from `MAKEFUN_TRIAL_NOW` plus a monotonic counter, so a run replays deterministically.

## Layout

- `main.ts` — entry lifecycle (register, wait for done, exit), unchanged from the kit starter.
- `app.ts` — HTTP server: routing, bearer auth, REST v3, GraphQL/MCP/git dispatch.
- `store.ts` — in-memory store: git object model, pack read/write, repos, issues, pull requests, three-way merge.
- `git.ts` — git smart HTTP v0 and v2 (advertise, ls-refs, fetch, receive-pack).
- `graphql.ts` — GraphQL executor for the suite's documents, introspection and batching.
- `mcp.ts` — MCP endpoint (`server/discover` plus legacy `initialize`) with the six tools.
- `local.ts` — local-only test entrypoint; never used by grading.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x0ms2tey&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
