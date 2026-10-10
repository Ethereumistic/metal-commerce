import { useMemo, useRef, useState } from "react";
import { Circle, FileUp, Square, Type } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { libraryAsset, libraryName } from "../library";
import {
  createAssetLayer,
  createShapeLayer,
  createTextLayer,
  uid,
  type LibrarySet,
} from "../model";
import { SIGNS, SIGN_LABELS, type Sign } from "../signs";
import { parseSvg, attributesToString } from "../svg";
import { useActiveDocument, useStudio } from "../store";

const MAX_UPLOAD_BYTES = 1_000_000;

function Thumbnail({ set, sign }: { set: LibrarySet; sign: Sign }) {
  const markup = useMemo(() => {
    const asset = libraryAsset(set, sign);
    return {
      viewBox: asset.viewBox.join(" "),
      html: `<g${attributesToString(asset.attributes)}>${asset.markup}</g>`,
    };
  }, [set, sign]);
  return (
    <svg
      viewBox={markup.viewBox}
      className="size-full"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: markup.html }}
    />
  );
}

function LibraryGrid({ set }: { set: LibrarySet }) {
  const doc = useActiveDocument();
  const addLayer = useStudio((state) => state.addLayer);
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {SIGNS.map((sign) => (
        <Tooltip key={sign}>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex aspect-square items-center justify-center rounded-md border bg-neutral-900 p-2 text-white transition hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[current=true]:border-sky-400"
                data-current={sign === doc.sign}
                onClick={() =>
                  addLayer(
                    createAssetLayer(
                      doc.artboard,
                      {
                        type: "library",
                        set,
                        sign,
                        // The current design sign is linked so batch export swaps it per sign.
                        followDocument: sign === doc.sign,
                      },
                      libraryName(set, sign),
                    ),
                  )
                }
                aria-label={`Add ${libraryName(set, sign)}`}
              />
            }
          >
            <Thumbnail set={set} sign={sign} />
          </TooltipTrigger>
          <TooltipContent>{SIGN_LABELS[sign]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function Elements() {
  const doc = useActiveDocument();
  const { addLayer, edit } = useStudio.getState();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function importSvg(file: File) {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) return setError("SVG files must be under 1 MB.");
    const svg = await file.text();
    const id = uid();
    try {
      parseSvg(svg, "check-");
    } catch (reason) {
      return setError(reason instanceof Error ? reason.message : "Invalid SVG.");
    }
    const name = file.name.replace(/\.svg$/i, "");
    edit((draft) => void (draft.uploads[id] = { id, name, svg }));
    addLayer(createAssetLayer(doc.artboard, { type: "upload", uploadId: id }, name));
  }

  const items = [
    { label: "Text", icon: Type, add: () => addLayer(createTextLayer(doc.artboard)) },
    { label: "Circle", icon: Circle, add: () => addLayer(createShapeLayer(doc.artboard, "ellipse", true)) },
    { label: "Ring", icon: Circle, add: () => addLayer(createShapeLayer(doc.artboard, "ellipse", false)), outline: true },
    { label: "Rectangle", icon: Square, add: () => addLayer(createShapeLayer(doc.artboard, "rect", true)) },
    { label: "Frame", icon: Square, add: () => addLayer(createShapeLayer(doc.artboard, "rect", false)), outline: true },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <Button key={item.label} variant="outline" className="justify-start" onClick={item.add}>
            <item.icon className={item.outline ? "" : "fill-current"} />
            {item.label}
          </Button>
        ))}
        <Button variant="outline" className="justify-start" onClick={() => input.current?.click()}>
          <FileUp />
          Import SVG
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".svg,image/svg+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importSvg(file);
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Imported SVGs are cleaned (no scripts or external content) and recoloured to the layer colour.
        Text supports the <code>{"{sign}"}</code> and <code>{"{dates}"}</code> tokens.
      </p>
    </div>
  );
}

export function LibraryPanel() {
  return (
    <Tabs defaultValue="icon" className="gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="icon">Icons</TabsTrigger>
        <TabsTrigger value="constellation">Stars</TabsTrigger>
        <TabsTrigger value="elements">Elements</TabsTrigger>
      </TabsList>
      <TabsContent value="icon">
        <LibraryGrid set="icon" />
      </TabsContent>
      <TabsContent value="constellation">
        <LibraryGrid set="constellation" />
      </TabsContent>
      <TabsContent value="elements">
        <Elements />
      </TabsContent>
    </Tabs>
  );
}
