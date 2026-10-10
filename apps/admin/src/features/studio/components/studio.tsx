import { useEffect } from "react";
import { Monitor } from "lucide-react";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import { useStudio } from "../store";
import { Canvas } from "./canvas";
import { Inspector } from "./inspector";
import { LayersPanel } from "./layers-panel";
import { LibraryPanel } from "./library-panel";
import { SheetInspector } from "./sheet-inspector";
import { SheetView } from "./sheet-view";
import { Toolbar } from "./toolbar";

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    !!target.closest('[role="dialog"],[role="menu"],[role="listbox"]')
  );
}

function useShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditable(event.target)) return;
      const studio = useStudio.getState();
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) studio.redo();
        else studio.undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        studio.redo();
        return;
      }
      const id = studio.selectedId;
      if (!id) return;
      if (event.key === "Escape") return studio.select(null);
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        return studio.removeLayer(id);
      }
      if (mod && key === "d") {
        event.preventDefault();
        return studio.duplicateLayer(id);
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const delta = arrows[event.key];
      if (delta) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
        studio.updateLayer(
          id,
          (layer) => {
            layer.x = Math.round((layer.x + delta[0] * step) * 1000) / 1000;
            layer.y = Math.round((layer.y + delta[1] * step) * 1000) / 1000;
          },
          { coalesce: `${id}:nudge` },
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function Studio() {
  useShortcuts();
  const mode = useStudio((state) => state.view.mode);
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center lg:hidden">
        <Monitor className="size-8 text-muted-foreground" />
        <p className="font-medium">The design studio needs a wider screen.</p>
        <p className="text-sm text-muted-foreground">Open it on a desktop or widen the window.</p>
      </div>
      <div className="hidden min-h-0 flex-1 flex-col lg:flex">
        <Toolbar />
        <div className="flex min-h-0 flex-1">
          {mode === "design" ? (
            <>
              <aside className="flex w-64 shrink-0 flex-col border-r">
                <ScrollArea className="min-h-0 basis-1/2 border-b">
                  <div className="p-3">
                    <LibraryPanel />
                  </div>
                </ScrollArea>
                <div className="flex min-h-0 flex-1 flex-col">
                  <h3 className="px-3 pt-3 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Layers
                  </h3>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="px-2 pb-3">
                      <LayersPanel />
                    </div>
                  </ScrollArea>
                </div>
              </aside>
              <Canvas />
            </>
          ) : (
            <SheetView />
          )}
          <aside className="w-76 shrink-0 border-l">
            <ScrollArea className="h-full">
              {mode === "design" ? <Inspector /> : <SheetInspector />}
            </ScrollArea>
          </aside>
        </div>
      </div>
    </>
  );
}
