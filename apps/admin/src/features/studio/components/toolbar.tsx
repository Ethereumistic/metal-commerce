import { useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Download,
  FileJson,
  FilePlus2,
  FolderOpen,
  Grid2x2,
  Loader2,
  Magnet,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Kbd } from "@workspace/ui/components/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { Separator } from "@workspace/ui/components/separator";
import { Toggle } from "@workspace/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import type { Template } from "../model";
import {
  DXF_TOLERANCE,
  exportDocument,
  exportProject,
  usesSign,
  type ExportFormat,
} from "../render";
import { SIGNS, SIGN_LABELS } from "../signs";
import { useActiveDocument, useStudio } from "../store";
import { Labelled, Num, Segmented, SelectField, SwitchField, ToleranceField } from "./fields";

const TEMPLATES: { value: Template; label: string }[] = [
  { value: "blank", label: "Blank" },
  { value: "icon", label: "Zodiac icon" },
  { value: "icon-constellation", label: "Icon + constellation" },
  { value: "icon-name", label: "Icon + name" },
];

function ToolButton({
  label,
  shortcut,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            {...props}
          />
        }
      />
      <TooltipContent>
        {label} {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function DesignsMenu() {
  const studio = useStudio.getState();
  const doc = useActiveDocument();
  const activeId = useStudio((state) => state.activeId);
  // Names only, so dragging on the canvas does not re-render this menu.
  const designs = useStudio(
    useShallow((state) =>
      state.order.map((id) => `${id}\u0000${state.documents[id]?.name ?? ""}`),
    ),
  ).map((entry) => entry.split("\u0000") as [string, string]);
  const input = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="max-w-64 gap-1.5 px-2 font-medium"
            />
          }
        >
          <span className="truncate">{doc.name}</span>
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Designs in this browser</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activeId}
              onValueChange={(id) => studio.setActive(String(id))}
            >
              {designs.map(([id, name]) => (
                <DropdownMenuRadioItem key={id} value={id} closeOnClick>
                  <span className="truncate">{name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FilePlus2 /> New design
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {TEMPLATES.map((template) => (
                <DropdownMenuItem
                  key={template.value}
                  onClick={() => studio.createDocument(template.value)}
                >
                  {template.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => studio.duplicateDocument(doc.id)}>
            <Copy /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => input.current?.click()}>
            <FolderOpen /> Open design file…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => exportProject(doc)}>
            <FileJson /> Save design file (.json)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 /> Delete design
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            studio.importDocument(JSON.parse(await file.text()));
          } catch (error) {
            setImportError(
              error instanceof Error
                ? error.message
                : "Could not open the file.",
            );
          }
        }}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{doc.name}”?</DialogTitle>
            <DialogDescription>
              The design is removed from this browser. Save a design file first
              if you want a copy.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                studio.deleteDocument(doc.id);
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!importError} onOpenChange={() => setImportError(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Could not open design</DialogTitle>
            <DialogDescription>{importError}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ExportPopover() {
  const doc = useActiveDocument();
  const [formats, setFormats] = useState<ExportFormat[]>(["svg"]);
  const [tolerance, setTolerance] = useState(DXF_TOLERANCE);
  const [scope, setScope] = useState<"current" | "all">("current");
  const [pngWidth, setPngWidth] = useState(2048);
  const [background, setBackground] = useState(doc.artboard.backgroundVisible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileCount = formats.length * (scope === "all" ? SIGNS.length : 1);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await exportDocument(doc, {
        formats,
        pngWidth,
        background,
        signs: scope,
        tolerance,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setBackground(doc.artboard.backgroundVisible);
      }}
    >
      <PopoverTrigger render={<Button size="sm" />}>
        <Download /> Export
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <Labelled label="Formats">
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              spacing={0}
              value={formats}
              onValueChange={(values) => {
                if (values.length) setFormats(values as ExportFormat[]);
              }}
              className="w-full"
            >
              <ToggleGroupItem value="svg" className="flex-1">SVG</ToggleGroupItem>
              <ToggleGroupItem value="png" className="flex-1">PNG</ToggleGroupItem>
              <ToggleGroupItem value="dxf" className="flex-1">DXF (laser)</ToggleGroupItem>
            </ToggleGroup>
          </Labelled>
          {formats.includes("png") && (
            <Num
              label="PNG width"
              unit="px"
              value={pngWidth}
              min={64}
              max={8192}
              step={64}
              digits={0}
              onChange={(value) => setPngWidth(Math.round(value))}
            />
          )}
          {formats.includes("dxf") && (
            <>
              <ToleranceField value={tolerance} onChange={setTolerance} />
              <p className="-mt-1 text-xs text-muted-foreground">
                DXF holds closed cut contours: the product outline on layer CUT_OUTLINE and merged artwork openings
                on CUT_INNER, in {doc.unit === "mm" ? "millimetres" : "unitless design units"}.
              </p>
            </>
          )}
          <Labelled label="Signs">
            <Segmented
              value={scope}
              options={[
                { value: "current", label: SIGN_LABELS[doc.sign] },
                { value: "all", label: "All 12 signs" },
              ]}
              onChange={setScope}
            />
          </Labelled>
          {scope === "all" && !usesSign(doc) && (
            <p className="text-xs text-muted-foreground">
              No layer follows the design sign, so all 12 files will look the
              same.
            </p>
          )}
          <SwitchField
            label="Include background"
            checked={background}
            onChange={setBackground}
          />
          <p className="text-xs text-muted-foreground">
            {fileCount === 1
              ? "Downloads one file."
              : `Downloads a ZIP with ${fileCount} files and the design file.`}{" "}
            SVGs are vector-only: text is outlined, no fonts or external links.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button onClick={run} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Toolbar() {
  const doc = useActiveDocument();
  const canUndo = useStudio((state) => state.history.past.length > 0);
  const canRedo = useStudio((state) => state.history.future.length > 0);
  const view = useStudio((state) => state.view);
  const { undo, redo, setView, edit } = useStudio.getState();

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <Segmented
        className="w-auto"
        value={view.mode}
        options={[
          { value: "design", label: "Design" },
          { value: "sheet", label: "Sheet layout" },
        ]}
        onChange={(mode) => setView({ mode })}
      />
      <Separator
        orientation="vertical"
        className="mx-1 data-vertical:h-5 data-vertical:self-auto"
      />
      <DesignsMenu />
      <Separator
        orientation="vertical"
        className="mx-1 data-vertical:h-5 data-vertical:self-auto"
      />
      <div className="w-36">
        <SelectField
          value={doc.sign}
          options={SIGNS.map((sign) => ({
            value: sign,
            label: SIGN_LABELS[sign],
          }))}
          onChange={(sign) => edit((draft) => void (draft.sign = sign))}
          className="h-8"
          aria-label="Design sign"
        />
      </div>
      <Separator
        orientation="vertical"
        className="mx-1 data-vertical:h-5 data-vertical:self-auto"
      />
      <ToolButton
        label="Undo"
        shortcut="Ctrl Z"
        onClick={undo}
        disabled={!canUndo}
      >
        <Undo2 />
      </ToolButton>
      <ToolButton
        label="Redo"
        shortcut="Ctrl Shift Z"
        onClick={redo}
        disabled={!canRedo}
      >
        <Redo2 />
      </ToolButton>
      {view.mode === "design" && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  size="sm"
                  pressed={view.showGuides}
                  onPressedChange={(showGuides) => setView({ showGuides })}
                  aria-label="Show guides"
                />
              }
            >
              <Grid2x2 />
            </TooltipTrigger>
            <TooltipContent>Centre lines and safe padding</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  size="sm"
                  pressed={view.snapping}
                  onPressedChange={(snapping) => setView({ snapping })}
                  aria-label="Snapping"
                />
              }
            >
              <Magnet />
            </TooltipTrigger>
            <TooltipContent>
              Snapping (hold <Kbd>Alt</Kbd> to bypass)
            </TooltipContent>
          </Tooltip>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-xs text-muted-foreground lg:inline">
          Product {doc.artboard.width} × {doc.artboard.height} {doc.unit}
        </span>
        {view.mode === "design" && <ExportPopover />}
      </div>
    </div>
  );
}
