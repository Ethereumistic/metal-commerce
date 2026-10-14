# BoldKit primitives and blocks

Ported from [BoldKit](https://boldkit.dev) (MIT, © 2025 BoldKit,
https://github.com/ANIBIT14/boldkit). The store uses Base UI rather than
Radix, so components that relied on Radix `Slot` export their class
variants instead and are applied to TanStack `Link`s directly. Tokens
(`--primary`, `--shadow-color`, `--shadow-offset`, …) follow BoldKit's
theme contract and live in `src/styles.css` as the "Metal Craft" preset.
