import { useCallback, useRef, type RefCallback } from "react";

type SwipeOptions = {
  enabled: boolean;
  /** Positive advances to the next photo; negative selects the previous one. */
  onSwipe: (direction: 1 | -1) => void;
};

type Gesture = {
  identifier: number;
  x: number;
  y: number;
  axis: "pending" | "horizontal" | "vertical";
};

/**
 * Attach to the photo surface, using touch-action: pan-y pinch-zoom while enabled.
 * Native non-passive touchmove is required: delegated React touch listeners can
 * be passive, which is too late to stop the page after a horizontal drag starts.
 * The callback ref also handles surfaces mounted later, such as the gallery.
 */
export function useHorizontalSwipe<T extends HTMLElement>({ enabled, onSwipe }: SwipeOptions): RefCallback<T> {
  const options = useRef({ enabled, onSwipe });
  options.current = { enabled, onSwipe };

  return useCallback((element: T | null) => {
    if (!element) return;
    let gesture: Gesture | null = null;
    let suppressClickUntil = 0;
    const maySwipe = () => options.current.enabled && (window.visualViewport?.scale ?? 1) <= 1;
    const suppressClick = () => { suppressClickUntil = Date.now() + 800; };

    const start = (event: TouchEvent) => {
      gesture = null;
      if (event.touches.length !== 1) {
        suppressClick();
        return;
      }
      // A fresh intentional tap must work even when the last drag emitted no click.
      suppressClickUntil = 0;
      if (!maySwipe()) return;
      const point = event.touches[0];
      gesture = { identifier: point.identifier, x: point.clientX, y: point.clientY, axis: "pending" };
    };

    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const point = event.touches[0];
      if (!maySwipe() || event.touches.length !== 1 || point.identifier !== gesture.identifier) {
        gesture = null;
        suppressClick();
        return;
      }
      if (gesture.axis === "pending") {
        const dx = Math.abs(point.clientX - gesture.x);
        const dy = Math.abs(point.clientY - gesture.y);
        if (Math.max(dx, dy) < 8) return;
        // Ambiguous diagonal gestures belong to vertical page scrolling.
        gesture.axis = dx > dy * 1.15 ? "horizontal" : "vertical";
      }
      if (gesture.axis === "horizontal") {
        if (event.cancelable) event.preventDefault();
        else {
          // The browser already owns this gesture; never also change the photo.
          gesture.axis = "vertical";
        }
      }
    };

    const end = (event: TouchEvent) => {
      const first = gesture;
      gesture = null;
      if (!first) return;
      let point: Touch | undefined;
      for (let index = 0; index < event.changedTouches.length; index++) {
        if (event.changedTouches[index].identifier === first.identifier) {
          point = event.changedTouches[index];
          break;
        }
      }
      if (!point) return;
      const dx = point.clientX - first.x;
      const dy = point.clientY - first.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 8) suppressClick();
      if (event.touches.length || !maySwipe() || first.axis !== "horizontal" || Math.abs(dx) < 42) return;
      options.current.onSwipe(dx < 0 ? 1 : -1);
    };

    const cancel = () => {
      if (gesture) suppressClick();
      gesture = null;
    };
    const click = (event: MouseEvent) => {
      // Keyboard and assistive-technology activation is never a synthetic tap.
      if (event.detail === 0 || Date.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") suppressClickUntil = 0;
    };

    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: true });
    element.addEventListener("touchcancel", cancel, { passive: true });
    element.addEventListener("click", click, true);
    element.addEventListener("pointerdown", pointerDown, { passive: true });
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
      element.removeEventListener("click", click, true);
      element.removeEventListener("pointerdown", pointerDown);
    };
  }, []);
}
