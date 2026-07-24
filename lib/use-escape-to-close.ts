import { useEffect } from "react";

// Closes an open overlay/modal when the user presses Escape. Passing an inactive
// state is a no-op, so it is safe to call unconditionally at the top of a component.
export function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);
}
