"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { X } from "lucide-react";

export function useBulkSelection<T extends { id: string }>(items: T[]) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const visibleIds = useMemo(() => items.map((item) => item.id), [items]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(() => items.filter((item) => selectedSet.has(item.id)), [items, selectedSet]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => visibleIds.includes(id)));
  }, [visibleIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    lastSelectedIndexRef.current = null;
  }, []);

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedIds([]);
    lastSelectedIndexRef.current = null;
  }, []);

  const selectAllVisible = useCallback(() => {
    setIsSelectionMode(true);
    setSelectedIds(visibleIds);
  }, [visibleIds]);

  const toggleAllVisible = useCallback(() => {
    setSelectedIds((current) => (visibleIds.length && visibleIds.every((id) => current.includes(id)) ? [] : visibleIds));
  }, [visibleIds]);

  const toggleOne = useCallback(
    (id: string, options?: { shiftKey?: boolean }) => {
      const index = visibleIds.indexOf(id);
      setIsSelectionMode(true);
      setSelectedIds((current) => {
        if (options?.shiftKey && lastSelectedIndexRef.current !== null && index !== -1) {
          const start = Math.min(lastSelectedIndexRef.current, index);
          const end = Math.max(lastSelectedIndexRef.current, index);
          return Array.from(new Set([...current, ...visibleIds.slice(start, end + 1)]));
        }
        return current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id];
      });
      if (index !== -1) lastSelectedIndexRef.current = index;
    },
    [visibleIds],
  );

  return {
    isSelectionMode,
    selectedIds,
    selectedItems,
    selectedSet,
    selectedCount: selectedIds.length,
    hasSelection: selectedIds.length > 0,
    allVisibleSelected: visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id)),
    someVisibleSelected: visibleIds.some((id) => selectedSet.has(id)),
    clearSelection,
    enterSelectionMode,
    exitSelectionMode,
    selectAllVisible,
    toggleAllVisible,
    toggleOne,
    setSelectedIds,
  };
}

export function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="h-4 w-4 rounded border-slate-300 accent-royal-600"
    />
  );
}

export function BulkActionToolbar({
  count,
  entity,
  children,
  onClear,
}: {
  count: number;
  entity: string;
  children: ReactNode;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-royal-200 bg-royal-50 px-4 py-3 shadow-sm">
      <p className="text-sm font-black text-navy-950">
        {count} {entity}
        {count === 1 ? "" : "s"} selected
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <button
          type="button"
          onClick={onClear}
          className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-600"
        >
          <X className="h-4 w-4" />
          Cancel Selection
        </button>
      </div>
    </div>
  );
}

export function MobileBulkBar({
  count,
  children,
  onClear,
}: {
  count: number;
  children: ReactNode;
  onClear: () => void;
}) {
  if (!count) return null;
  return (
    <div className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-royal-200 bg-white p-3 shadow-xl lg:hidden" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-black text-navy-950">Selected: {count}</p>
        <button type="button" onClick={onClear} className="text-xs font-black text-slate-500">
          Exit Selection
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

export function checkboxShiftKey(event: ChangeEvent<HTMLInputElement>) {
  return Boolean((event.nativeEvent as MouseEvent | undefined)?.shiftKey);
}
