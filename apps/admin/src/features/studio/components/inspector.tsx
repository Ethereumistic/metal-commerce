import { useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  Crosshair,
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  RotateCcw,
  Scaling,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Textarea } from "@workspace/ui/components/textarea";
import { Toggle } from "@workspace/ui/components/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { assetFor, layerBox, layerSize, type Resolved } from "../geometry";
import { useCutPreview, useFontState, useResolvedLayers } from "../hooks";
import {
  alignLayer,
  artboardRect,
  fitLayer,
  matchSize,
  scaleLayer,
  type Edge,
} from "../layout";
import { LIBRARY_SET_LABELS } from "../library";
import type { AssetLayer, Layer, LibrarySet, ShapeLayer, StudioDocument, TextLayer } from "../model";
import { SIGNS, SIGN_LABELS, type Sign } from "../signs";
import { useActiveDocument, useStudio } from "../store";
import {
  ColorField,
  Labelled,
  Num,
  Row,
  Section,
  Segmented,
  SelectField,
  SwitchField,
} from "./fields";
import { FontPicker, fontFor, useCatalog } from "./font-picker";

const SIGN_OPTIONS = SIGNS.map((sign) => ({ value: sign, label: SIGN_LABELS[sign] }));

function IconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="outline" size="icon-sm" onClick={onClick} aria-label={label} disabled={disabled} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Document & artboard

function BridgesSection({ doc }: { doc: StudioDocument }) {
  const edit = useStudio((state) => state.edit);
  const { islands } = useCutPreview(doc);
  const { bridges } = doc;
  const set = (patch: Partial<StudioDocument["bridges"]>, key: string) =>
    edit((draft) => void Object.assign(draft.bridges, patch), { coalesce: `bridges:${key}` });
  return (
    <Section title="Laser bridges">
      <SwitchField
        label="Bridge enclosed islands"
        hint="Keeps thin strips of metal so enclosed parts (the inside of A, O, Q, rings) do not fall out."
        checked={bridges.enabled}
        onChange={(enabled) => set({ enabled }, "enabled")}
      />
      <p className={islands && !bridges.enabled ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {islands === 0
          ? "No enclosed islands in this design."
          : bridges.enabled
            ? `${islands} island${islands === 1 ? "" : "s"} bridged.`
            : `${islands} island${islands === 1 ? "" : "s"} would fall out when cut.`}
      </p>
      {bridges.enabled && (
        <>
          <Row>
            <Num
              label="Width"
              unit={doc.unit}
              step={0.1}
              min={0.1}
              value={bridges.width}
              onChange={(width) => set({ width }, "width")}
            />
            <Segmented
              value={String(bridges.perIsland) as "1" | "2"}
              options={[
                { value: "1", label: "1 each" },
                { value: "2", label: "2 each" },
              ]}
              onChange={(value) => set({ perIsland: value === "2" ? 2 : 1 }, "count")}
            />
          </Row>
          <Segmented
            value={bridges.direction}
            options={[
              { value: "vertical", label: "Vertical" },
              { value: "horizontal", label: "Horizontal" },
              { value: "shortest", label: "Shortest" },
            ]}
            onChange={(direction) => set({ direction }, "direction")}
          />
          <p className="-mt-1 text-xs text-muted-foreground">
            Rule of thumb: about 1–1.5× the sheet thickness. Bridges appear on the canvas, in exports and in the
            DXF.
          </p>
        </>
      )}
    </Section>
  );
}

function DocumentInspector({ doc }: { doc: StudioDocument }) {
  const edit = useStudio((state) => state.edit);
  const { artboard } = doc;
  const unit = doc.unit;
  const setArtboard = (patch: Partial<StudioDocument["artboard"]>, key: string) =>
    edit((draft) => void Object.assign(draft.artboard, patch), { coalesce: `artboard:${key}` });

  return (
    <>
      <Section title="Design">
        <Labelled label="Name">
          <Input
            key={doc.id}
            defaultValue={doc.name}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== doc.name) edit((draft) => void (draft.name = name));
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        </Labelled>
        <Row>
          <Labelled label="Design sign">
            <SelectField
              value={doc.sign}
              options={SIGN_OPTIONS}
              onChange={(sign) => edit((draft) => void (draft.sign = sign))}
              aria-label="Design sign"
            />
          </Labelled>
          <Labelled label="Units">
            <SelectField
              value={unit}
              options={[
                { value: "px", label: "Pixels" },
                { value: "mm", label: "Millimetres" },
              ]}
              onChange={(next) => edit((draft) => void (draft.unit = next))}
              aria-label="Units"
            />
          </Labelled>
        </Row>
        <p className="text-xs text-muted-foreground">
          Layers linked to the design sign, and <code>{"{sign}"}</code> text, change with it. Export all 12
          signs at once from Export.
        </p>
      </Section>

      <Section title="Artboard">
        <Segmented
          value={artboard.shape}
          options={[
            { value: "rect", label: "Square / rectangle" },
            { value: "ellipse", label: "Circle / ellipse" },
          ]}
          onChange={(shape) => setArtboard({ shape }, "shape")}
        />
        <Row>
          <Num label="W" unit={unit} value={artboard.width} min={1} max={20000} onChange={(width) => setArtboard({ width }, "width")} />
          <Num label="H" unit={unit} value={artboard.height} min={1} max={20000} onChange={(height) => setArtboard({ height }, "height")} />
        </Row>
        <Row>
          {artboard.shape === "rect" ? (
            <Num label="Radius" unit={unit} value={artboard.cornerRadius} min={0} onChange={(cornerRadius) => setArtboard({ cornerRadius }, "radius")} />
          ) : (
            <span />
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              const side = Math.max(artboard.width, artboard.height);
              setArtboard({ width: side, height: side }, "square");
            }}
            disabled={artboard.width === artboard.height}
          >
            Make 1:1
          </Button>
        </Row>
        <Num
          label="Safe padding"
          unit={unit}
          value={artboard.padding}
          min={0}
          onChange={(padding) => setArtboard({ padding }, "padding")}
        />
        <Labelled label="Background">
          <ColorField label="Background colour" value={artboard.background} onChange={(background) => setArtboard({ background }, "background")} />
        </Labelled>
        <SwitchField
          label="Export background"
          hint="Off exports a transparent background."
          checked={artboard.backgroundVisible}
          onChange={(backgroundVisible) => setArtboard({ backgroundVisible }, "bg")}
        />
        <SwitchField
          label="Clip to shape"
          hint="Hide artwork outside the artboard outline."
          checked={artboard.clip}
          onChange={(clip) => setArtboard({ clip }, "clip")}
        />
      </Section>
      <BridgesSection doc={doc} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Layer

function ArrangeSection({
  layer,
  resolved,
  doc,
  resolvedMap,
}: {
  layer: Layer;
  resolved: Resolved;
  doc: StudioDocument;
  resolvedMap: Map<string, Resolved | null>;
}) {
  const updateLayer = useStudio((state) => state.updateLayer);
  const [targetId, setTargetId] = useState("artboard");
  const others = doc.layers.filter((item) => item.id !== layer.id && resolvedMap.get(item.id));
  const target = others.find((item) => item.id === targetId);
  const targetResolved = target ? resolvedMap.get(target.id)! : null;
  const [margin, setMargin] = useState<number | null>(null);
  const effectiveMargin = margin ?? (target ? 0 : doc.artboard.padding);
  const box = layerBox(layer, resolved);
  const { artboard } = doc;

  function align(edge: Edge) {
    const rect = target && targetResolved ? layerBox(target, targetResolved) : artboardRect(artboard);
    updateLayer(layer.id, (draft) => alignLayer(draft, resolved, rect, edge, effectiveMargin));
  }

  const margins = {
    left: box.x,
    right: artboard.width - box.x - box.width,
    top: box.y,
    bottom: artboard.height - box.y - box.height,
  };

  return (
    <Section title="Align">
      <SelectField
        value={target ? targetId : "artboard"}
        options={[
          { value: "artboard", label: "Relative to artboard" },
          ...others.map((item) => ({ value: item.id, label: `Relative to ${item.name}` })),
        ]}
        onChange={(value) => {
          setTargetId(value);
          setMargin(null);
        }}
        aria-label="Align relative to"
      />
      <div className="flex flex-wrap gap-1">
        <IconButton label="Align left edge" onClick={() => align("left")}><AlignStartVertical /></IconButton>
        <IconButton label="Centre horizontally" onClick={() => align("hcenter")}><AlignCenterVertical /></IconButton>
        <IconButton label="Align right edge" onClick={() => align("right")}><AlignEndVertical /></IconButton>
        <IconButton label="Align top edge" onClick={() => align("top")}><AlignStartHorizontal /></IconButton>
        <IconButton label="Centre vertically" onClick={() => align("vcenter")}><AlignCenterHorizontal /></IconButton>
        <IconButton label="Align bottom edge" onClick={() => align("bottom")}><AlignEndHorizontal /></IconButton>
        <IconButton
          label="Centre both"
          onClick={() => {
            align("hcenter");
            align("vcenter");
          }}
        >
          <Crosshair />
        </IconButton>
      </div>
      <Num
        label="Edge margin"
        unit={doc.unit}
        value={effectiveMargin}
        onChange={setMargin}
      />
      <div className="flex flex-wrap gap-1.5">
        {!target && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateLayer(layer.id, (draft) => fitLayer(draft, resolved, artboard, effectiveMargin))}
          >
            <Maximize2 /> Fit inside margin
          </Button>
        )}
        {target && targetResolved && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateLayer(layer.id, (draft) => matchSize(draft, resolved, targetResolved))}
          >
            <Scaling /> Match longest side
          </Button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-2 text-center text-xs tabular-nums">
        {(["left", "right", "top", "bottom"] as const).map((side) => (
          <div key={side} className="flex flex-col">
            <span className="text-muted-foreground capitalize">{side}</span>
            <span>{margins[side].toFixed(1)}</span>
          </div>
        ))}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        Distance from the visible artwork to each artboard edge.
      </p>
    </Section>
  );
}

function TransformSection({ layer, resolved, unit }: { layer: Layer; resolved: Resolved; unit: string }) {
  const updateLayer = useStudio((state) => state.updateLayer);
  const set = (key: string, recipe: (draft: Layer) => void) =>
    updateLayer(layer.id, recipe, { coalesce: `${layer.id}:${key}` });
  const size = layerSize(resolved);
  return (
    <Section title="Position">
      <Row>
        <Num label="X" unit={unit} value={layer.x} onChange={(x) => set("x", (d) => void (d.x = x))} />
        <Num label="Y" unit={unit} value={layer.y} onChange={(y) => set("y", (d) => void (d.y = y))} />
      </Row>
      <Row>
        <Num
          label="W"
          unit={unit}
          value={size.width}
          min={0.01}
          live={false}
          onChange={(width) => size.width > 0 && set("w", (d) => scaleLayer(d, width / size.width))}
        />
        <Num
          label="H"
          unit={unit}
          value={size.height}
          min={0.01}
          live={false}
          onChange={(height) => size.height > 0 && set("h", (d) => scaleLayer(d, height / size.height))}
        />
      </Row>
      <Row>
        <Num label="Rotate" unit="°" value={layer.rotation} min={-360} max={360} onChange={(rotation) => set("rotation", (d) => void (d.rotation = rotation))} />
        <Num
          label="Opacity"
          unit="%"
          value={layer.opacity * 100}
          min={0}
          max={100}
          digits={0}
          onChange={(opacity) => set("opacity", (d) => void (d.opacity = opacity / 100))}
        />
      </Row>
      <div className="flex items-center gap-1">
        <Toggle variant="outline" size="sm" pressed={layer.flipX} onPressedChange={(flipX) => set("flipX", (d) => void (d.flipX = flipX))} aria-label="Flip horizontally">
          <FlipHorizontal2 />
        </Toggle>
        <Toggle variant="outline" size="sm" pressed={layer.flipY} onPressedChange={(flipY) => set("flipY", (d) => void (d.flipY = flipY))} aria-label="Flip vertically">
          <FlipVertical2 />
        </Toggle>
        <span className="ml-auto text-xs text-muted-foreground">Position = centre of visible artwork</span>
      </div>
    </Section>
  );
}

function AssetSection({ layer, doc }: { layer: AssetLayer; doc: StudioDocument }) {
  const updateLayer = useStudio((state) => state.updateLayer);
  const set = (key: string, recipe: (draft: AssetLayer) => void) =>
    updateLayer<AssetLayer>(layer.id, recipe, { coalesce: `${layer.id}:${key}` });
  const asset = (() => {
    try {
      return assetFor(layer, doc);
    } catch {
      return null;
    }
  })();
  const source = layer.source;
  return (
    <Section title="Artwork">
      {source.type === "library" ? (
        <>
          <Row>
            <SelectField
              value={source.set}
              options={(["icon", "constellation"] as LibrarySet[]).map((value) => ({
                value,
                label: LIBRARY_SET_LABELS[value],
              }))}
              onChange={(value) =>
                set("set", (d) => void (d.source.type === "library" && (d.source.set = value)))
              }
              aria-label="Artwork set"
            />
            <SelectField
              value={source.followDocument ? doc.sign : source.sign}
              options={SIGN_OPTIONS}
              onChange={(value: Sign) =>
                set("sign", (d) => {
                  if (d.source.type !== "library") return;
                  d.source.sign = value;
                  d.source.followDocument = false;
                })
              }
              aria-label="Sign"
            />
          </Row>
          <SwitchField
            label="Follow design sign"
            hint="Swaps automatically when the design sign changes and in batch export."
            checked={source.followDocument}
            onChange={(followDocument) =>
              set("follow", (d) => {
                if (d.source.type !== "library") return;
                d.source.followDocument = followDocument;
                if (!followDocument) d.source.sign = doc.sign;
              })
            }
          />
        </>
      ) : (
        <p className="text-sm">Imported SVG: {doc.uploads[source.uploadId]?.name ?? "missing"}</p>
      )}
      <Num
        label="Longest side"
        unit={doc.unit}
        value={layer.size}
        min={0.01}
        onChange={(size) => set("size", (d) => void (d.size = size))}
      />
      {asset?.stroked && (
        <div className="flex items-end gap-1.5">
          <div className="flex-1">
            <Num
              label="Stroke"
              unit="src"
              step={0.1}
              value={layer.strokeWidth ?? asset.strokeWidth ?? 1}
              min={0.05}
              onChange={(strokeWidth) => set("stroke", (d) => void (d.strokeWidth = strokeWidth))}
            />
          </div>
          <IconButton
            label="Reset to source stroke"
            disabled={layer.strokeWidth == null}
            onClick={() => set("strokeReset", (d) => void (d.strokeWidth = null))}
          >
            <RotateCcw />
          </IconButton>
        </div>
      )}
      <Labelled label="Colour">
        <ColorField label="Layer colour" value={layer.color} onChange={(color) => set("color", (d) => void (d.color = color))} />
      </Labelled>
    </Section>
  );
}

function TextSection({ layer, resolved }: { layer: TextLayer; resolved: Resolved | null }) {
  const updateLayer = useStudio((state) => state.updateLayer);
  const { catalog, error } = useCatalog();
  const status = useFontState(layer);
  const entry = catalog?.find((item) => item.id === layer.font.id);
  const set = (key: string, recipe: (draft: TextLayer) => void) =>
    updateLayer<TextLayer>(layer.id, recipe, { coalesce: `${layer.id}:${key}` });

  return (
    <Section title="Text">
      <Textarea
        value={layer.text}
        rows={2}
        onChange={(event) => set("text", (d) => void (d.text = event.target.value))}
        aria-label="Text"
        className="min-h-14 resize-y"
      />
      <p className="-mt-1 text-xs text-muted-foreground">
        Tokens: <code>{"{sign}"}</code>, <code>{"{dates}"}</code>. Text exports as vector outlines.
      </p>
      <Labelled label="Font (Google Fonts)">
        <FontPicker
          value={layer.font}
          catalog={catalog}
          onChange={(next) => set("font", (d) => void (d.font = fontFor(next, d.font)))}
        />
      </Labelled>
      {error && <p className="text-xs text-destructive">Could not load the font catalogue.</p>}
      <Row>
        <SelectField
          value={String(layer.font.weight)}
          options={(entry?.weights ?? [layer.font.weight]).map((weight) => ({
            value: String(weight),
            label: `Weight ${weight}`,
          }))}
          onChange={(weight) => set("weight", (d) => void (d.font = { ...d.font, weight: Number(weight) }))}
          aria-label="Font weight"
        />
        <SelectField
          value={layer.font.subset}
          options={(entry?.subsets ?? [layer.font.subset]).map((subset) => ({ value: subset, label: subset }))}
          onChange={(subset) => set("subset", (d) => void (d.font = { ...d.font, subset }))}
          aria-label="Character set"
        />
      </Row>
      {entry && entry.styles.length > 1 && (
        <Segmented
          value={layer.font.style}
          options={entry.styles.map((style) => ({ value: style, label: style === "normal" ? "Regular" : "Italic" }))}
          onChange={(style) => set("style", (d) => void (d.font = { ...d.font, style }))}
        />
      )}
      <Row>
        <Num label="Size" value={layer.fontSize} min={0.5} onChange={(fontSize) => set("size", (d) => void (d.fontSize = fontSize))} />
        <Num label="Spacing" unit="‰" step={10} digits={0} value={layer.letterSpacing} onChange={(letterSpacing) => set("spacing", (d) => void (d.letterSpacing = letterSpacing))} />
      </Row>
      <Segmented
        value={layer.transform}
        options={[
          { value: "none", label: "As typed" },
          { value: "uppercase", label: "UPPER" },
          { value: "lowercase", label: "lower" },
        ]}
        onChange={(transform) => set("case", (d) => void (d.transform = transform))}
      />
      <Num
        label="Arc radius"
        value={layer.arc}
        step={5}
        onChange={(arc) => set("arc", (d) => void (d.arc = arc))}
      />
      <p className="-mt-1 text-xs text-muted-foreground">
        0 = straight. Positive bends over the top of a circle, negative along the bottom.
      </p>
      <SwitchField label="Kerning" checked={layer.kerning} onChange={(kerning) => set("kerning", (d) => void (d.kerning = kerning))} />
      <Labelled label="Colour">
        <ColorField label="Text colour" value={layer.color} onChange={(color) => set("color", (d) => void (d.color = color))} />
      </Labelled>
      {status === "loading" && <p className="text-xs text-muted-foreground">Loading font…</p>}
      {status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>
            This font variant could not be loaded. Try another weight or character set.
          </AlertDescription>
        </Alert>
      )}
      {resolved?.warning && (
        <Alert>
          <AlertDescription>{resolved.warning}</AlertDescription>
        </Alert>
      )}
    </Section>
  );
}

function ShapeSection({ layer, unit }: { layer: ShapeLayer; unit: string }) {
  const updateLayer = useStudio((state) => state.updateLayer);
  const set = (key: string, recipe: (draft: ShapeLayer) => void) =>
    updateLayer<ShapeLayer>(layer.id, recipe, { coalesce: `${layer.id}:${key}` });
  return (
    <Section title="Shape">
      <Segmented
        value={layer.shape}
        options={[
          { value: "ellipse", label: "Ellipse" },
          { value: "rect", label: "Rectangle" },
        ]}
        onChange={(shape) => set("shape", (d) => void (d.shape = shape))}
      />
      <Segmented
        value={layer.fill ? "fill" : "outline"}
        options={[
          { value: "fill", label: "Filled" },
          { value: "outline", label: "Outline" },
        ]}
        onChange={(mode) =>
          set("mode", (d) => {
            d.fill = mode === "fill";
            if (!d.fill && d.strokeWidth <= 0) d.strokeWidth = Math.max(1, Math.round(d.width * 0.012));
          })
        }
      />
      <Row>
        <Num label="W" unit={unit} value={layer.width} min={0.01} onChange={(width) => set("w", (d) => void (d.width = width))} />
        <Num label="H" unit={unit} value={layer.height} min={0.01} onChange={(height) => set("h", (d) => void (d.height = height))} />
      </Row>
      <Row>
        {!layer.fill ? (
          <Num label="Stroke" unit={unit} value={layer.strokeWidth} min={0.01} onChange={(strokeWidth) => set("stroke", (d) => void (d.strokeWidth = strokeWidth))} />
        ) : (
          <span />
        )}
        {layer.shape === "rect" && (
          <Num label="Radius" unit={unit} value={layer.cornerRadius} min={0} onChange={(cornerRadius) => set("radius", (d) => void (d.cornerRadius = cornerRadius))} />
        )}
      </Row>
      <p className="-mt-1 text-xs text-muted-foreground">Size is the outer edge, outline included.</p>
      <Labelled label="Colour">
        <ColorField label="Shape colour" value={layer.color} onChange={(color) => set("color", (d) => void (d.color = color))} />
      </Labelled>
    </Section>
  );
}

function LayerInspector({ layer, doc }: { layer: Layer; doc: StudioDocument }) {
  const resolvedMap = useResolvedLayers(doc);
  const resolved = resolvedMap.get(layer.id) ?? null;
  const { duplicateLayer, removeLayer } = useStudio.getState();

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{layer.name}</span>
        <IconButton label="Duplicate (Ctrl+D)" onClick={() => duplicateLayer(layer.id)}>
          <Copy />
        </IconButton>
        <IconButton label="Delete (Del)" onClick={() => removeLayer(layer.id)}>
          <Trash2 />
        </IconButton>
      </div>
      {layer.locked && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          This layer is locked on the canvas. Fields stay editable.
        </p>
      )}
      {resolved && <TransformSection layer={layer} resolved={resolved} unit={doc.unit} />}
      {resolved && (
        <ArrangeSection key={layer.id} layer={layer} resolved={resolved} doc={doc} resolvedMap={resolvedMap} />
      )}
      {layer.kind === "asset" && <AssetSection layer={layer} doc={doc} />}
      {layer.kind === "text" && <TextSection layer={layer} resolved={resolved} />}
      {layer.kind === "shape" && <ShapeSection layer={layer} unit={doc.unit} />}
    </>
  );
}

export function Inspector() {
  const doc = useActiveDocument();
  const selectedId = useStudio((state) => state.selectedId);
  const layer = doc.layers.find((item) => item.id === selectedId);
  return layer ? <LayerInspector layer={layer} doc={doc} /> : <DocumentInspector doc={doc} />;
}
