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
	/** Show an "unrestricted permissions" warning banner. */
	dangerous?: boolean;
	/** Called when the user presses ESC. */
	onCancel: () => void;
	/** Called when the user presses `m` (minimize — hide the window, keep the run going). */
	onMinimize: () => void;
}

/** Create the overlay component; disposes the spinner timer. */
export function progressWindow(tui: TUI, theme: Theme, opts: ProgressWindowOptions): Component & { dispose(): void } {
	let frame = 0;
	let armed = false;
	let armTimer: ReturnType<typeof setTimeout> | null = null;
	const timer = setInterval(() => {
		frame++;
		tui.requestRender();
	}, SPIN_INTERVAL_MS);

	const disarm = () => {
		armed = false;
		if (armTimer) {
			clearTimeout(armTimer);
			armTimer = null;
		}
	};

	return {
		render(width: number): string[] {
			const header = theme.fg("accent", `${SPINNER[frame % SPINNER.length]} claude delegate`);
			const lines = opts.getLines();
			const body = lines.slice(-12).map((l) => theme.fg("muted", truncateToWidth(l, width)));
			const out: string[] = [header];
			if (opts.dangerous) {
				out.push(theme.fg("error", "⚠ bypassPermissions — unrestricted access"));
			}
			out.push(...body);
			// double-ESC guard: first press arms cancel, second confirms
			const hint = armed
				? theme.fg("warning", "press esc again to cancel") + theme.fg("dim", " · m minimize")
				: theme.fg("dim", "esc cancel · m minimize");
			out.push("", hint);
			return out;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				if (armed) {
					disarm();
					opts.onCancel();
				} else {
					armed = true;
					armTimer = setTimeout(() => {
						armed = false;
						armTimer = null;
						tui.requestRender();
					}, 1500);
					tui.requestRender();
				}
			} else if (data === "m") {
				disarm();
				opts.onMinimize();
			}
		},
		invalidate(): void {
			// stateless render — nothing to clear
		},
		dispose(): void {
			clearInterval(timer);
			disarm();
		},
	};
}
