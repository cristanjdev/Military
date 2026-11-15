"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, X } from "lucide-react";
import { cn } from "@/lib/utils";

const WIDTH = 352;  // 22rem
const MARGIN = 16;  // kept clear of the window edges

/**
 * A "?" in a circle that opens a small speech bubble with an explanation. Closes on a second
 * click, a click outside, or Escape. Place it next to a heading.
 *
 * The bubble is rendered on <body> with a fixed position, so cards below it (each one its own
 * layer because of the glass blur) can never cover it.
 */
export function HelpBubble({
  title,
  label = "How this works",
  children,
  className,
}: {
  title: string;
  /** Read by screen readers and shown on hover. */
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; arrow: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const id = useId();

  /** Under the "?", shifted left or right to stay inside the window; the pointer stays on the "?". */
  const place = useCallback(() => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    const centre = b.left + b.width / 2;
    const left = Math.min(Math.max(centre - 24, MARGIN), window.innerWidth - width - MARGIN);
    setPos({ top: b.bottom + 10, left, arrow: centre - left, width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !bubble.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-olive-500/60",
          open ? "text-olive-200" : "text-steel-400 hover:text-olive-200",
          className
        )}
      >
        <CircleHelp className="h-4 w-4" />
      </button>

      {open && pos && createPortal(
        <div
          ref={bubble}
          id={id}
          role="dialog"
          aria-label={title}
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          className="fixed z-[90] rounded-lg border border-olive-600/40 bg-[#131a20] p-4 text-left shadow-2xl shadow-black/60"
        >
          {/* The bubble's pointer, under the "?" */}
          <span
            style={{ left: pos.arrow }}
            className="absolute -top-[7px] h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-olive-600/40 bg-[#131a20]"
            aria-hidden
          />
          <div className="mb-2 flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-olive-50">{title}</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="-mr-1 -mt-0.5 rounded p-0.5 text-steel-400 hover:bg-steel-800 hover:text-steel-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="text-xs leading-relaxed text-steel-300">{children}</div>
        </div>,
        document.body
      )}
    </>
  );
}
