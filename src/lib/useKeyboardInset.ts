import { useEffect, useState } from "react";

/**
 * Returns the height (in px) currently occupied at the bottom of the layout
 * viewport by the on-screen/virtual keyboard, using the visualViewport API.
 *
 * On mobile the layout viewport does not shrink when the keyboard opens; only
 * the visual viewport does. Callers can use this inset to lift bottom-anchored
 * UI (e.g. a command palette) above the keyboard.
 *
 * Pass `enabled` to only measure while relevant (e.g. while a dialog is open).
 * Returns `0` during SSR, when disabled, or when visualViewport is unavailable.
 */
export function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0);

	useEffect(() => {
		if (!enabled || typeof window === "undefined") return;
		const vv = window.visualViewport;
		if (!vv) return;

		const update = () =>
			setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));

		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, [enabled]);

	return enabled ? inset : 0;
}
