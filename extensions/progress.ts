/**
 * Live progress window for `/claude` runs — a floating overlay showing the
 * activity feed, thinking indicator and text tail while the delegation runs.
 * ESC cancels (aborts the claude subprocess via the caller's AbortController).
 */

import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_INTERVAL_MS = 100;

export interface ProgressWindowOptions {
	/** Live content lines (tool feed, thinking, text tail). */
	getLines: () => string[];
	/** Called when the user presses ESC. */
	onCancel: () => void;
	/** Called when the user presses `m` (minimize — hide the window, keep the run going). */
	onMinimize: () => void;
}

/** Create the overlay component; disposes the spinner timer. */
export function progressWindow(tui: TUI, theme: Theme, opts: ProgressWindowOptions): Component & { dispose(): void } {
	let frame = 0;
	const timer = setInterval(() => {
		frame++;
		tui.requestRender();
	}, SPIN_INTERVAL_MS);

	return {
		render(width: number): string[] {
			const header = theme.fg("accent", `${SPINNER[frame % SPINNER.length]} claude delegate`);
			const lines = opts.getLines();
			const body = lines.slice(-12).map((l) => theme.fg("muted", truncateToWidth(l, width)));
			const hint = theme.fg("dim", "esc cancel · m minimize");
			return [header, ...body, "", hint];
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				opts.onCancel();
			} else if (data === "m") {
				opts.onMinimize();
			}
		},
		invalidate(): void {
			// stateless render — nothing to clear
		},
		dispose(): void {
			clearInterval(timer);
		},
	};
}
