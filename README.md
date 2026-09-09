# Wrangler Config Doctor

Find common Wrangler configuration mistakes before you deploy. An offline v0.1 beta with a CLI and one local MCP tool. Independent software by Valen Systems; not affiliated with Cloudflare.

## Try it

Install Node.js 22.13 or newer, extract the ZIP, then run:

```sh
node wrangler-config-doctor.mjs --help
node wrangler-config-doctor.mjs check examples/wrangler.jsonc
```

For your own project, run from its directory:

```sh
node /path/to/wrangler-config-doctor.mjs check wrangler.jsonc
node /path/to/wrangler-config-doctor.mjs check wrangler.toml --env staging --strict
```

Paths are relative to the current directory. Select exactly `wrangler.toml`, `wrangler.json`, or `wrangler.jsonc`, optionally in a subdirectory. The tool reads only that file. It does not discover parent configurations, resolve `$schema`, load environment files, execute build commands, contact Cloudflare, or change files.

## What it checks

| Code | Finding |
| --- | --- |
| WCD001 | Missing/invalid compatibility date, or a date beyond the rule pack |
| WCD002 | Both route and routes in the same configuration scope |
| WCD003 | Duplicate names or malformed fields in supported bindings and vars |
| WCD004 | Selected environment omits a top-level category that does not inherit |
| WCD005 | Duplicate migration tags or conflicting operations in one migration |
| WCD006 | Assets/site conflict or assets directory problem |
| WCD007 | Invalid observability enabled/sampling configuration |
| WCD008 | Possible credential keys in vars |

WCD004 and WCD008 are warnings. A missing assets directory is also a warning because build plugins can supply it. Routes and triggers inherit; bindings and vars do not. Migration operations are compared within each migration, so creating a class in one migration and deleting it later is valid.

JSON output is deterministic. Diagnostics contain fixed messages and schema paths, with no config values, binding names, routes, or secret keys. The input path, selected environment, byte count, and input SHA-256 are included. Treat receipts as private if those identifiers are sensitive; the hash is an integrity check, not encryption.

Exit codes: `0` passes the selected policy; `2` has errors (or warnings with `--strict`); `64` is invalid input; `70` is an internal failure. Input failures produce a fixed error code on stderr and no receipt. Parse errors and duplicate keys fail before analysis.

## Local MCP

```json
{
  "mcpServers": {
    "wrangler-config-doctor": {
      "command": "node",
      "args": ["/path/to/wrangler-config-doctor.mjs", "mcp", "--root", "/path/to/project"]
    }
  }
}
```

The read-only `wrangler_config_check` tool accepts `configPath`, optional `environment`, and optional `strict`. Paths stay beneath the startup root. The root and config path must not be symlinks. Use a stable project directory; v0.1 is not a sandbox against another local process concurrently replacing directories.

## Scope

These eight checks are advisory, not complete Wrangler schema validation or proof that a deployment will succeed. Unknown properties are ignored. Supported bindings: KV, R2, D1, Vectorize, Hyperdrive, services, Analytics Engine, mTLS, dispatch namespaces, Workflows, Pipelines, Secrets Store, AI, browser, images, version metadata, Durable Objects, queue producers, email, assets, and vars. Other binding categories are outside v0.1 coverage.

Input is capped at 1 MiB, 64 environments, nesting depth 64, 50,000 parsed values, and 256 inspected binding/migration entries. Exceeding a limit fails the analysis. The assets directory is checked for configuration shape, not opened or traversed. TOML date/time values are unsupported; write compatibility dates as quoted strings. Windows execution has not yet been tested.

Rule provenance is pinned in `rule-pack.json`: Wrangler 4.130.0, its upstream commit, and the configuration schema hash. Full schema coverage and broader platform testing can follow after feedback.

## Build from source

```sh
npm ci --ignore-scripts
npm test
npm run build
```

Builds use Node, esbuild, and the host's `zip` command. The ZIP requires only Node at runtime, without a dependency install. Original code is MIT licensed; the distribution includes `THIRD_PARTY_NOTICES.md` and exact upstream license texts.
