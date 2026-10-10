import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { DEFAULT_PRODUCT_SIZE, MACHINE_PRESETS, type Sheet } from "../model";
import { canCommonLine } from "../dxf";
import { DXF_TOLERANCE, exportSheet, type ExportFormat } from "../render";
import { nest, resizeProduct, sizeForColumns } from "../sheet";
import { useActiveDocument, useStudio } from "../store";
import { Labelled, Num, Row, Section, Segmented, SelectField, SwitchField, ToleranceField } from "./fields";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function SheetInspector() {
  const doc = useActiveDocument();
  const edit = useStudio((state) => state.edit);
  const [scaleArtwork, setScaleArtwork] = useState(true);
  const [columns, setColumns] = useState(3);
  const [artwork, setArtwork] = useState(true);
  const [pngWidth, setPngWidth] = useState(3000);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [tolerance, setTolerance] = useState(DXF_TOLERANCE);
  const [commonLine, setCommonLine] = useState(true);
  const [reference, setReference] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sheet, artboard } = doc;
  const layout = nest(sheet, artboard);
  const preset =
    MACHINE_PRESETS.find((item) => item.width === sheet.width && item.height === sheet.height)?.id ?? "custom";
  const square = artboard.width === artboard.height;
  const shape = artboard.shape === "ellipse" ? "circle" : "square";

  const setSheet = (patch: Partial<Sheet>, key: string) =>
    edit((draft) => void Object.assign(draft.sheet, patch), { coalesce: `sheet:${key}` });
  const setSize = (width: number, height: number, key: string) =>
    edit((draft) => resizeProduct(draft, width, height, scaleArtwork), { coalesce: `product:${key}` });

  async function download(format: ExportFormat) {
    setBusy(format);
    setError(null);
    try {
      await exportSheet(doc, format, { artwork, pngWidth, tolerance, commonLine, reference });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Section title="Machine sheet">
        <SelectField
          value={preset}
          options={[
            ...MACHINE_PRESETS.map((item) => ({ value: item.id as string, label: item.label })),
            { value: "custom", label: "Custom size" },
          ]}
          onChange={(id) => {
            const match = MACHINE_PRESETS.find((item) => item.id === id);
            if (match) setSheet({ width: match.width, height: match.height }, "preset");
          }}
          aria-label="Machine preset"
        />
        <Row>
          <Num label="W" unit="mm" value={sheet.width} min={1} max={20000} onChange={(width) => setSheet({ width }, "width")} />
          <Num label="H" unit="mm" value={sheet.height} min={1} max={20000} onChange={(height) => setSheet({ height }, "height")} />
        </Row>
        <Row>
          <Num label="Margin" unit="mm" value={sheet.margin} min={0} onChange={(margin) => setSheet({ margin }, "margin")} />
          <Num label="Gap" unit="mm" value={sheet.spacing} min={0} onChange={(spacing) => setSheet({ spacing }, "spacing")} />
        </Row>
        <p className="-mt-1 text-xs text-muted-foreground">
          Margin is the unusable safety border on every side. Gap is the space between pieces (0 = shared edges).
        </p>
        <Labelled label="Leftover space goes to">
          <Segmented
            value={sheet.anchor}
            options={[
              { value: "bottom-left", label: "Top" },
              { value: "top-left", label: "Bottom" },
              { value: "center", label: "Both sides" },
            ]}
            onChange={(anchor) => setSheet({ anchor }, "anchor")}
          />
        </Labelled>
      </Section>

      <Section title="Product">
        {doc.unit !== "mm" ? (
          <Alert>
            <AlertDescription className="flex flex-col gap-2">
              This design uses pixels. Nesting needs real sizes.
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() =>
                  edit((draft) => {
                    resizeProduct(draft, DEFAULT_PRODUCT_SIZE, DEFAULT_PRODUCT_SIZE * (draft.artboard.height / draft.artboard.width), true);
                    draft.unit = "mm";
                  })
                }
              >
                Convert to millimetres ({DEFAULT_PRODUCT_SIZE} mm, artwork scaled)
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Segmented
              value={shape}
              options={[
                { value: "square", label: "Square" },
                { value: "circle", label: "Circle" },
              ]}
              onChange={(next) =>
                edit((draft) => {
                  draft.artboard.shape = next === "circle" ? "ellipse" : "rect";
                  if (draft.artboard.width !== draft.artboard.height) {
                    const side = Math.min(draft.artboard.width, draft.artboard.height);
                    resizeProduct(draft, side, side, scaleArtwork);
                  }
                })
              }
            />
            {square ? (
              <Num
                label={shape === "circle" ? "Diameter" : "Side"}
                unit="mm"
                value={artboard.width}
                min={1}
                live={false}
                onChange={(size) => setSize(size, size, "size")}
              />
            ) : (
              <Row>
                <Num label="W" unit="mm" value={artboard.width} min={1} live={false} onChange={(w) => setSize(w, artboard.height, "w")} />
                <Num label="H" unit="mm" value={artboard.height} min={1} live={false} onChange={(h) => setSize(artboard.width, h, "h")} />
              </Row>
            )}
            <SwitchField
              label="Scale artwork with product"
              hint="Off keeps artwork at its current size and only changes the outline."
              checked={scaleArtwork}
              onChange={setScaleArtwork}
            />
            <div className="flex items-end gap-2">
              <div className="w-28">
                <Num label="Across" value={columns} min={1} max={50} digits={0} onChange={(value) => setColumns(Math.round(value))} />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 flex-1"
                onClick={() => {
                  const size = sizeForColumns(sheet, columns);
                  if (size > 0) setSize(size, size, "fit");
                }}
              >
                Largest size that fits
              </Button>
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">
              {columns} across → {sizeForColumns(sheet, columns)} mm pieces.
            </p>
          </>
        )}
      </Section>

      <Section title="Layout">
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/60 p-3">
          <Stat label="Pieces" value={`${layout.cols} × ${layout.rows} = ${layout.count}`} />
          <Stat label="Material used" value={`${(layout.utilisation * 100).toFixed(1)} %`} />
          <Stat label="Usable area" value={`${layout.usable.width} × ${layout.usable.height}`} />
          <Stat label="Leftover" value={`${layout.leftover.width} × ${layout.leftover.height}`} />
        </div>
        {layout.count === 0 && (
          <p className="text-xs text-destructive">The product does not fit inside the safety margin.</p>
        )}
        <Labelled label="Signs on the sheet">
          <Segmented
            value={sheet.fill}
            options={[
              { value: "same", label: "Design sign" },
              { value: "cycle", label: "Cycle all 12" },
            ]}
            onChange={(fill) => setSheet({ fill }, "fill")}
          />
        </Labelled>
      </Section>

      <Section title="Export sheet">
        <SwitchField
          label="Include artwork"
          hint="Off exports piece outlines only."
          checked={artwork}
          onChange={setArtwork}
        />
        <Num label="PNG width" unit="px" value={pngWidth} min={256} max={12000} step={100} digits={0} onChange={(value) => setPngWidth(Math.round(value))} />
        <Button onClick={() => download("dxf")} disabled={!!busy || !layout.count}>
          {busy === "dxf" ? <Loader2 className="animate-spin" /> : <Download />} DXF for the laser
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => download("svg")} disabled={!!busy || !layout.count}>
            {busy === "svg" ? <Loader2 className="animate-spin" /> : <Download />} SVG (mm)
          </Button>
          <Button variant="outline" onClick={() => download("png")} disabled={!!busy || !layout.count}>
            {busy === "png" ? <Loader2 className="animate-spin" /> : <Download />} PNG
          </Button>
        </div>
        <ToleranceField value={tolerance} onChange={setTolerance} />
        {canCommonLine(doc) && (
          <SwitchField
            label="Cut shared edges once"
            hint="With no gap, neighbouring squares share edges. Each grid line is written as one line, so it is cut once."
            checked={commonLine}
            onChange={setCommonLine}
          />
        )}
        <SwitchField
          label="Reference layers"
          hint="Adds the sheet edge (REF_SHEET) and safety margin (REF_MARGIN). Turn these layers off before cutting."
          checked={reference}
          onChange={setReference}
        />
        <p className="text-xs text-muted-foreground">
          DXF is real size in mm, origin at the sheet's bottom-left. Piece outlines are on CUT_OUTLINE; artwork
          openings, as merged closed contours, on CUT_INNER. SVG and PNG are for viewing. The SVG omits the margin guide.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Section>
    </>
  );
}
