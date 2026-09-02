# Milestone 7 Dependency-Security Audit Summary

**Date:** 2026-08-01  
**Scope:** M7.1 closure dependency evidence only  
**Decision:** Dependency risk is reduced from the preserved baseline, but dependency security is not closed. No forced fix or downgrade is authorized.

## 1. Evidence and integrity

### Preserved pre-remediation baseline

Evidence directory: `docs/evidence/m7-dependency-baseline-20260801-174604/`

| Item | Value |
| --- | --- |
| Node.js | `v22.22.2` |
| npm | `10.9.7` |
| Prisma | `6.19.3` |
| Declared Next.js | `^9.3.3` |
| Installed Next.js | `9.3.3` |
| React / React DOM | `19.2.7` / `19.2.7` |
| `package.json` SHA-256 | `d32f8aae3dfb90ed85b548cf076121d1fefe924280442c48cb7f615780dfe0ff` |
| `package-lock.json` SHA-256 | `ae617182694f9b7c57e242d6d4610a280bdddf77d89b0269edfdac0ae1fa662f` |

The before/after-audit hashes and retained `node_modules` marker show that evidence collection did not modify the baseline manifests or installed tree.

### Observed current state

The current repository and installed tree now agree on Next.js `16.2.12`:

| Item | Value |
| --- | --- |
| Declared Next.js | `16.2.12` |
| Locked Next.js | `16.2.12` |
| Installed Next.js | `16.2.12` |
| React / React DOM | `19.2.7` / `19.2.7` |
| Prisma Client / CLI | `6.19.3` / `6.19.3` |
| Current `package.json` SHA-256 | `1523bd0ed7d3357e589df0cea23a27ed173242c337e929f9c839955ba3444048` |
| Current `package-lock.json` SHA-256 | `4c8a8aa2353c7a3b959fa897a29b8320427cba28c953a7b3edbd7f50504ce146` |

Retained files `m7-npm-audit-*-after-next-16.2.12.json` show that the transition occurred before this documentation pass. The repository has no Git metadata, so this review cannot establish commit attribution or independently prove the exact command that changed the manifests. The current state is therefore recorded as an observed post-baseline state, not as an unexplained assistant-approved remediation.

## 2. Audit totals

| Audit state | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Preserved full audit | 1 | 26 | 55 | 10 | 92 |
| Preserved `--omit=dev` audit | 1 | 26 | 55 | 10 | 92 |
| Current full audit | 0 | 3 | 0 | 0 | 3 |
| Current `--omit=dev` audit | 0 | 3 | 0 | 0 | 3 |

The identical full and production-only totals mean npm classifies the affected packages as part of the production install graph. It does **not** prove that every vulnerable operation is reachable in a deployed request path or receives attacker-controlled input. Reachability requires separate code-path and deployment analysis.

## 3. Exposure categories

This checkpoint uses the following conservative categories:

- **A — confirmed production-runtime reachable:** deployed code invokes the vulnerable operation and attacker-controlled input can reach it.
- **B — likely production-runtime reachable:** package is used at runtime and a plausible externally influenced path exists, but end-to-end exploitability is not demonstrated.
- **C — production-installed, conditional runtime:** package ships in production, but vulnerable behavior requires an optional feature or configuration not proven active.
- **D — build-time only:** package is used by compilation or asset processing, not by the deployed request runtime.
- **E — development/test only:** package is absent from the production install or used only by local/test tooling.
- **F — installed but no reachable vulnerable operation identified:** present in the graph, but current code and configuration do not expose the named operation.
- **G — superseded/not present in the current tree:** applicable to the preserved baseline but removed from the observed current dependency graph.

No finding is assigned category A without executed reachability evidence.

## 4. Preserved baseline critical/high package findings

The baseline audit reported 27 package-level critical/high findings. Most were inherited through the direct `next@9.3.3` dependency and its old webpack/Babel/PostCSS toolchain.

| Package | Severity | Direct? | Principal baseline parent/path | Operational classification | Current category/status |
| --- | --- | --- | --- | --- | --- |
| `loader-utils` | Critical | No | `next`; `styled-jsx`; `resolve-url-loader`; `adjust-sourcemap-loader` | Webpack loader/build processing; prototype pollution/ReDoS requires crafted loader input | **G** — absent after Next 16 transition |
| `next` | High | Yes | Root dependency | Production framework and build tool; several direct framework advisories were runtime relevant | **G for old 9.3.3 finding**; replaced by 16.2.12, which has separate current metavulnerability findings |
| `node-fetch` | High | No | Directly under `next@9.3.3`; nested patched copies through AMP toolbox/cross-fetch | Potential server-runtime HTTP client; secure-header forwarding requires attacker-influenced redirect/target and sensitive forwarded headers | **G** — old vulnerable `2.6.0` path absent from current tree |
| `path-to-regexp` | High | No | Directly under `next@9.3.3` | Routing regex; ReDoS requires a vulnerable generated pattern and attacker-controlled path | **G** — absent from current tree |
| `object-path` | High | No | `next` -> `resolve-url-loader` -> `adjust-sourcemap-loader` | Build/source-map transformation | **G** |
| `postcss` | High | No | Many nested PostCSS 7 copies in the old Next toolchain | Predominantly build-time CSS parsing; attacker-controlled CSS/source maps were not demonstrated | **G** for old copies; current Next has a distinct nested `postcss@8.4.31` finding |
| `@ampproject/toolbox-optimizer` | High | No | `next` | Build/HTML optimization | **G** |
| `adjust-sourcemap-loader` | High | No | `next` build chain | Build-time source-map processing | **G** |
| `ansi-html` | High | No | Old development/build middleware chain | Development/build output rendering | **G** |
| `braces` | High | No | `fork-ts-checker-webpack-plugin`; `watchpack-chokidar2`; webpack | Build/watch glob matching | **G** |
| `chokidar` | High | No | `watchpack-chokidar2` | Development/build file watcher | **G** |
| `devalue` | High | No | `next` | Serialization helper; vulnerable parse/unflatten reachability was not demonstrated in application code | **G** |
| `http-proxy` | High | No | `next` | Development proxy path; production deployment use not demonstrated | **G** |
| `json5` | High | No | Old Next/Babel tooling | Build/config parsing | **G** |
| `jsonwebtoken` | High | No | Old Next dependency graph | No application import or token-verification path was established | **G** |
| `launch-editor` | High | No | `next` development tooling | Development-only editor launch path | **G** |
| `micromatch` | High | No | Type-check/watch/webpack chain | Build/watch matching | **G** |
| `resolve-url-loader` | High | No | `next` | Build-time CSS URL/source-map processing | **G** |
| `serialize-javascript` | High | No | Webpack/terser chain | Build artifact serialization | **G** |
| `styled-jsx` | High | No | `next` | Framework CSS build/runtime helper | **G** for vulnerable old version |
| `terser` | High | No | `next`; AMP optimizer | Build-time minification | **G** |
| `terser-webpack-plugin` | High | No | webpack | Build-time minification | **G** |
| `watchpack` | High | No | webpack | Build/development file watching | **G** |
| `watchpack-chokidar2` | High | No | webpack/watchpack | Build/development file watching | **G** |
| `webpack` | High | No | `next` | Build compiler; runtime exposure not demonstrated | **G** |
| `webpack-dev-middleware` | High | No | `next` development server | Development server path traversal; production server use not demonstrated | **G** |
| `webpack-hot-middleware` | High | No | `next` development server | Development hot reload | **G** |

### Baseline `node-fetch` paths

Retained `npm explain` evidence established:

1. `pdfdadi -> next@9.3.3 -> node-fetch@2.6.0` — vulnerable to GHSA-r683-j2x4-v87g (`<2.6.7`).
2. Nested `node-fetch@2.6.7` paths through Next/AMP toolbox/cross-fetch — patched for that named high advisory and not the vulnerable node reported by npm.

Production install presence alone did not prove that an attacker could control a redirect target while sensitive headers were forwarded. The direct vulnerable path was nevertheless unacceptable framework debt because Next was a production runtime dependency.

### Baseline `path-to-regexp` path

Retained `npm explain` evidence established:

`pdfdadi -> next@9.3.3 -> path-to-regexp@6.1.0`

The advisory affects `>=4.0.0 <6.3.0`. Exploitation requires a vulnerable route pattern and attacker-controlled request path. No application-defined dynamic route pattern was shown to generate the advisory's pathological regex, so category A was not claimed; removal through the framework transition eliminates the old node.

## 5. Current findings on Next.js 16.2.12

Current parent paths:

```text
pdfdadi -> next@16.2.12
pdfdadi -> next@16.2.12 -> postcss@8.4.31
pdfdadi -> next@16.2.12 -> sharp@0.34.5 (optional)
```

The root development dependency `postcss@8.5.18` is patched for the listed PostCSS advisories. npm reports only Next's nested `postcss@8.4.31`.

| Finding | Advisory/range | Ships in production install? | Runtime reachability and input control | Category | Remediation status |
| --- | --- | --- | --- | --- | --- |
| `postcss@8.4.31` under Next | GHSA-6g55-p6wh-862q (`<=8.5.11`); GHSA-r28c-9q8g-f849 (`<=8.5.17`); moderate GHSA-qx2v-qp2m-jg93 (`<8.5.10`) | Yes, according to `--omit=dev` | Primarily a build/CSS processing dependency. Exploitation requires attacker-controlled CSS containing `sourceMappingURL` or unsafe stringification. No production endpoint that compiles user-supplied CSS was identified. | **D/F** | Requires an upstream Next release using patched nested PostCSS, or a documented supported dependency resolution. No blind override. |
| `sharp@0.34.5` | GHSA-f88m-g3jw-g9cj, `<0.35.0` | Optional production dependency is installed | No `next/image` imports, `images` configuration, remote patterns, or custom image-optimization route were found. The application does define four `next/og` `ImageResponse` route/files (`app/opengraph-image.tsx`, `app/icon.tsx`, `app/brand-logo/route.tsx`, and `app/blog/[slug]/opengraph-image.tsx`), so framework image generation is active and Sharp cannot be classified as unused solely from source inspection. The inspected generated inputs are JSX, fixed SVG/branding, and bounded application/admin text rather than arbitrary uploaded or remote image URLs. No exploitability test establishes attacker-controlled libvips input. | **C/F** | Await/validate a supported Next/Sharp combination with Sharp `>=0.35.0`; do not override native dependencies blindly. Retain route-level tests and deployment verification if exposure is accepted temporarily. |
| `next@16.2.12` metavulnerability | npm range `9.3.4-canary.0 - 16.3.0-preview.7`, caused by nested PostCSS and Sharp findings | Yes; direct production framework | Aggregate finding. It does not add a separate demonstrated vulnerable operation beyond the nested dependencies above. | **C/D** | npm proposes `next@9.3.3`, a major downgrade that reintroduces the preserved 92-finding tree and conflicts with React 19. Reject. |

## 6. npm remediation analysis

### Baseline dry run

`npm audit fix --dry-run --json` failed with `ERESOLVE` because npm attempted to select `next@9.5.5`, whose peer requirement is `react@^16.6.0`, while the project declares React `19.2.7`. No files or packages were changed.

### Current dry run

The retained post-Next-16 dry run still reports 3 high findings and proposes `next@9.3.3`. That recommendation is not a safe fix:

- it is a major framework downgrade;
- it reintroduces the old vulnerable dependency graph;
- it is incompatible with the current React 19 architecture;
- it contradicts the preserved baseline evidence;
- it treats a transitive advisory/metavulnerability calculation as permission to replace the framework.

Therefore:

- `npm audit fix --force` is prohibited;
- a Next.js downgrade is rejected;
- no blind `overrides` entry is authorized;
- no destructive lockfile rewrite is authorized;
- the remaining 3 highs require supported upstream remediation or evidence-backed exposure mitigation.

## 7. M7 blocking decision

The critical baseline finding and the old `node-fetch`/`path-to-regexp` paths are no longer present in the observed current tree. This is a material reduction from 92 findings to 3 highs.

Dependency security is still **OPEN** for M7.1 because:

1. the current 3 high findings remain in both full and production-only audits;
2. Next image generation is active through four `next/og` `ImageResponse` routes; no arbitrary remote/uploaded image input was identified, but Sharp/libvips reachability has not been excluded or exploit-tested;
3. no application runtime endpoint compiling attacker-controlled CSS or source maps was identified, supporting a build/input-boundary classification for nested PostCSS, but the finding still awaits supported upstream resolution;
4. no accepted dependency change may be certified until the required clean-install, Prisma, typecheck, lint, full-test, foreground-build, and re-audit sequence is retained;
5. repository history is unavailable, so the Next 9 -> 16 transition's attribution is not Git-verifiable.

This dependency gate does not authorize M7.2 or M8.

## 8. Required next evidence

1. Preserve the current manifest/lock hashes and post-Next-16 audit files.
2. Run `npm ci` in the controlled main workspace only after confirming the current lockfile is the intended candidate.
3. Run Prisma validate/generate, typecheck, lint, all tests, and a foreground production build.
4. Rerun full and production-only audits after the clean install/build.
5. Execute route/deployment verification for the four `next/og` image-generation surfaces and confirm whether the deployed implementation invokes Sharp/libvips; preserve the input-origin assessment.
6. Preserve the source review finding that no runtime endpoint accepts or compiles attacker-controlled CSS/source maps, and add a focused regression test if such a feature is introduced.
7. Track a supported upstream Next release that includes patched PostCSS and Sharp versions; test any candidate in a disposable copy first.
