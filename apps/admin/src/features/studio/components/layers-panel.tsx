import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Eye,
  EyeOff,
  GripVertical,
  Link2,
  Lock,
  LockOpen,
  Shapes,
  Sparkles,
  Type,
} from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import type { Layer } from "../model";
import { useActiveDocument, useStudio } from "../store";

function KindIcon({ layer }: { layer: Layer }) {
  if (layer.kind === "text") return <Type className="size-3.5" />;
  if (layer.kind === "shape") return <Shapes className="size-3.5" />;
  return <Sparkles className="size-3.5" />;
}

function LayerRow({ layer, selected }: { layer: Layer; selected: boolean }) {
  const { select, updateLayer } = useStudio.getState();
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: layer.id });
  const follows = layer.kind === "asset" && layer.source.type === "library" && layer.source.followDocument;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex h-8 items-center gap-1 rounded-md pr-1 text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        isDragging && "relative z-10 bg-background shadow-md",
        !layer.visible && "text-muted-foreground",
      )}
      onClick={() => select(layer.id)}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex h-full w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        aria-label={`Reorder ${layer.name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <KindIcon layer={layer} />
      {editing ? (
        <input
          autoFocus
          defaultValue={layer.name}
          className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none"
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name && name !== layer.name) updateLayer(layer.id, (l) => void (l.name = name));
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate pl-1"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {layer.name}
        </span>
      )}
      {follows && (
        <Link2 className="size-3.5 shrink-0 text-sky-500" aria-label="Follows design sign" />
      )}
      <button
        type="button"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground",
          layer.locked ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          updateLayer(layer.id, (l) => void (l.locked = !l.locked));
        }}
        aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
      >
        {layer.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
      </button>
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          updateLayer(layer.id, (l) => void (l.visible = !l.visible));
        }}
        aria-label={layer.visible ? "Hide layer" : "Show layer"}
      >
        {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </li>
  );
}

export function LayersPanel() {
  const doc = useActiveDocument();
  const selectedId = useStudio((state) => state.selectedId);
  const moveLayer = useStudio((state) => state.moveLayer);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Displayed top-most first; stored bottom-to-top.
  const items = [...doc.layers].reverse();

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const target = doc.layers.findIndex((layer) => layer.id === over.id);
    if (target >= 0) moveLayer(String(active.id), target);
  }

  if (!items.length)
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        No layers yet. Add an icon, constellation or text.
      </p>
    );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((layer) => layer.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-0.5">
          {items.map((layer) => (
            <LayerRow key={layer.id} layer={layer} selected={layer.id === selectedId} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
