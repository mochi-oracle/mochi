<p align="center">
  <a href="docs/assets/mochi-banner-poster.png"><img src="docs/assets/mochi-banner.gif" alt="Mochi: follow a claim through research to evidence and limitations. Open the static poster." width="100%"></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Code: PolyForm Noncommercial 1.0.0" src="https://img.shields.io/badge/code-PolyForm%20Noncommercial%201.0.0-e13b82"></a>
  <a href="LICENSE-docs.md"><img alt="Docs: CC BY-NC 4.0" src="https://img.shields.io/badge/docs-CC%20BY--NC%204.0-f08b52"></a>
  <img alt="Status: research preview" src="https://img.shields.io/badge/status-research%20preview-6e5b72">
</p>

<h3 align="center">Check the claim before you share it.</h3>

Mochi helps people inspect claims in crypto and AI posts, articles, and announcements. Give it one exact claim and, if you have them, links to sources. It gathers bounded public evidence, asks three independently configured models to read that same evidence, and lays out their findings, cited passages, limitations, and disagreements. The point is to make the reasoning easier to examine—not to ask you to trust a single confident-sounding answer.

**[Preview the claim research interface](https://web-production-fb1a0.up.railway.app/check/)** · Live model reviews are currently disabled while provider configuration is pending.

## How it works

1. **Choose a claim.** Submit a short, exact statement and optionally up to five HTTPS source URLs. Mochi asks for consent before external research.
2. **Gather evidence.** It retrieves a limited amount of public HTML or plain text, checks supplied sources, and can use web search when that provider is configured. It shows when external discovery is unavailable.
3. **Compare readings.** Three separately configured models receive the same evidence. Mochi checks that cited passages match the retrieved text and displays each reading, along with uncertainty and disagreement. A split or lack of useful evidence stays unresolved; it is not turned into a majority-backed verdict.
4. **Decide what to do.** Review the evidence and limitations yourself. Sharing a result is a separate, explicit choice.

This first pilot is for researching one claim at a time. It does not extract every claim from a full article, retrieve PDFs or authenticated posts, bypass paywalls, or establish that a source is authentic or that a matching quote proves a claim. Providers receive the claim and evidence as described by the consent in the interface. Do not submit confidential material.

## Current status

The interface is built, tested, and deployed as a research preview. **Real model reviews are not enabled yet.** Synthetic browser fixtures and a successful public-source retrieval exercise check parts of the implementation; they do not establish model accuracy. The pilot does not take payments. The discussed five-cent target is not a price charged by the current service.

Confidential document review is a separate protocol and is not activated here. This pilot does not run in a trusted execution environment (TEE), publish a chain receipt, or settle anything on-chain. See the [claim research implementation notes](services/claims/README.md) for configuration, data handling, limits, and the checks completed so far.

## Run locally

Requirements: [Bun](https://bun.sh/) and the dependencies declared by this repository. From the repository root:

```sh
bun install --ignore-scripts
bun run typecheck
cd web/site
bun install --frozen-lockfile --ignore-scripts
bun run build
cd ../..
bun web/server.ts
```

Then open `http://localhost:4321/check/` (or the local URL printed by the server). The interface remains in its disabled state unless server-side pilot settings and providers are configured. Keep provider credentials out of the browser and repository; use the hosting environment as described in the [configuration guide](services/claims/README.md). Local browser fixtures use synthetic findings and are not a quality benchmark.

## Project notes

This public export includes the broader Mochi contracts and packages as well as the claim research pilot. The research preview is the active user-facing interface; repository components do not imply that every protocol feature is running or available to users. The [public history](docs/HISTORY.md) explains how this retrospective 250-commit export was assembled and its limits.

## License and notices

Mochi source code is licensed under [PolyForm Noncommercial 1.0.0](LICENSE). Documentation and media are licensed under [CC BY-NC 4.0](LICENSE-docs.md). **The project is source-available under noncommercial terms; it is not open source under the OSI definition.** Commercial use requires a separate license. Third-party components retain their own terms; see [NOTICE.md](NOTICE.md). For vulnerability reports, see [SECURITY.md](SECURITY.md).
