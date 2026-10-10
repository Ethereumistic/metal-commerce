# Zodiac product imagery — production brief

Requested 10 October 2026 · Status: all twelve square mockups generated and exported

## Confirmed design direction

- All twelve traditional zodiac signs.
- Product outline is square or circular, always with a 1:1 bounding box. Use the **square** outline for this first set of twelve images.
- Center the exact corresponding **`react-icons/tb` `TbZodiac[Sign]` glyph**; no animal drawings, replacement glyphs, or invented icon styles.
- Include the corresponding constellation from the owner's supplied SVG set. Preserve its star/line arrangement; place it within the square composition without obscuring the centered glyph. Final layout depends on inspecting those files.
- Matte-black painted sheet metal, hanging on a clean white wall, with realistic sheet edges and soft mounting shadows.
- Each final image is **1:1**, one product per image, consistent camera, lighting, scale, crop, wall, and finish across all twelve.
- No props, captions, logos, watermarks, or extra decorative star patterns.

The square choice is within the owner's stated square-or-circle preference. Physical size is not newly confirmed by this request; a **600 × 600 mm** plaque can be used as a provisional design reference, not a published product specification. Do not claim these mockups are photographs of manufactured zodiac products or approved DXFs.

This direction supersedes the earlier natural animal-shaped zodiac proposals in the inventory notes. A future circular version should use the same icon/constellation design system, not a different icon family.

## Exact inputs

[Source asset record](source/README.md): all twelve icons have been extracted from `react-icons/tb`, with source geometry preserved.

The twelve constellation SVGs are now available in `constellations/`, and the matching icons are in `icons/`. Deterministic reference compositions in `references/` preserve the source glyph geometry and constellation topology. Each icon is centered on the square plaque, with its constellation below. Final renders were produced with the built-in image-generation tool. See [the gallery](GALLERY.md), [release details](RELEASE.md), and [exact prompts](PROMPTS.md).

## Reusable image-generation prompt

```text
Use case: product-mockup
Asset type: square ecommerce product visualization
Primary request: photorealistic visualization of a square matte-black
laser-cut sheet-metal zodiac plaque hanging on a pristine white wall.
Input references: the approved composition for this sign, built from the
exact TbZodiac[Sign] SVG and the owner's corresponding constellation SVG.
Subject: one square plaque; the exact Tabler sign icon is centered, and
the supplied constellation is included clearly within the composition.
Composition: 1:1 image, straight-on product view, whole plaque visible,
centered in the image with generous consistent wall margin.
Lighting: soft neutral studio/daylight from upper left, believable shallow
wall shadow and subtle edge depth, no dramatic glare.
Materials: painted matte-black sheet metal; clean white wall.
Constraints: preserve the supplied symbol and constellation geometry;
no new stars, missing stars, altered glyphs, added animal illustrations,
captions, logos, watermarks, props, gradients on the metal, or split views.
Match the approved first image's camera, material, framing, and lighting.
```

One built-in image-generation call per sign was completed. Source composition and final render must be inspected for glyph/constellation fidelity. Review cutout connectivity, bridges, and mounting separately before treating a rendering as a fabrication design; raster generation is not CAD approval.

## Deliverable checklist

| Sign | Icon component | Constellation source | Final square render |
| --- | --- | --- | --- |
| Aries | TbZodiacAries | Available in `constellations/` | [PNG](renders/aries.png) / [WebP](web/aries.webp) |
| Taurus | TbZodiacTaurus | Available in `constellations/` | [PNG](renders/taurus.png) / [WebP](web/taurus.webp) |
| Gemini | TbZodiacGemini | Available in `constellations/` | [PNG](renders/gemini.png) / [WebP](web/gemini.webp) |
| Cancer | TbZodiacCancer | Available in `constellations/` | [PNG](renders/cancer.png) / [WebP](web/cancer.webp) |
| Leo | TbZodiacLeo | Available in `constellations/` | [PNG](renders/leo.png) / [WebP](web/leo.webp) |
| Virgo | TbZodiacVirgo | Available in `constellations/` | [PNG](renders/virgo.png) / [WebP](web/virgo.webp) |
| Libra | TbZodiacLibra | Available in `constellations/` | [PNG](renders/libra.png) / [WebP](web/libra.webp) |
| Scorpio | TbZodiacScorpio | Available in `constellations/` | [PNG](renders/scorpio.png) / [WebP](web/scorpio.webp) |
| Sagittarius | TbZodiacSagittarius | Available in `constellations/` | [PNG](renders/sagittarius.png) / [WebP](web/sagittarius.webp) |
| Capricorn | TbZodiacCapricorn | Available in `constellations/` | [PNG](renders/capricorn.png) / [WebP](web/capricorn.webp) |
| Aquarius | TbZodiacAquarius | Available in `constellations/` | [PNG](renders/aquarius.png) / [WebP](web/aquarius.webp) |
| Pisces | TbZodiacPisces | Available in `constellations/` | [PNG](renders/pisces.png) / [WebP](web/pisces.webp) |
