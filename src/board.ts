// The card board itself. Plain DOM only, so it can be mounted both inside Obsidian
// and in a browser test harness with a mock vault.

import { buildPreview, isPlaceholderTitle, Preview } from "./preview";
import { COLORS, WALLPAPERS, contrastInk, resolveColor, wallpaperById, wallpaperImageLink } from "./palette";

export interface NoteRef {
	id: string; // vault path
	title: string; // basename
	mtime: number;
}

export interface NoteStyle {
	color?: string;
	wallpaper?: string;
}

export interface BoardHost {
	listNotes(): NoteRef[];
	read(id: string): Promise<string>;
	getStyle(id: string): NoteStyle;
	setStyle(id: string, patch: NoteStyle): Promise<void>;
	/** Resolve an image link found in a note (or a wallpaper link) to a URL the webview can load. */
	resolveImage(link: string, sourceId: string): string | null;
	open(id: string): void;
	create(): void;
	remove(id: string): Promise<void>;
	/** Optional: let the user pick a vault image; returns a wallpaper value like "[[pic.jpg]]". */
	pickImage?(): Promise<string | null>;
	isDark(): boolean;
	icon(el: HTMLElement, name: string): void;
	previewLines: number;
	layout: "grid" | "list";
	/** Hex colour for the + button; empty uses the theme accent. */
	fabColor: string;
	setLayout(layout: "grid" | "list"): void;
}

interface CachedPreview {
	mtime: number;
	preview: Preview;
}

const BATCH = 24;
const MIN_CARD = 150;
const GAP = 10;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	parent?: HTMLElement,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	if (parent) parent.appendChild(e);
	return e;
}

export class Board {
	private host: BoardHost;
	private root: HTMLElement;
	private scroller!: HTMLElement;
	private columnsEl!: HTMLElement;
	private columns: HTMLElement[] = [];
	private sentinel!: HTMLElement;
	private statusEl!: HTMLElement;
	private input!: HTMLInputElement;
	private clearBtn!: HTMLElement;
	private layoutBtn!: HTMLElement;
	private sheet: HTMLElement | null = null;
	private fab!: HTMLElement;

	private cache = new Map<string, CachedPreview>();
	private all: NoteRef[] = [];
	private shown: NoteRef[] = [];
	private rendered = 0;
	private query = "";
	private loading = false;
	private generation = 0;
	private observer: IntersectionObserver | null = null;
	private resizeObs: ResizeObserver | null = null;
	private colCount = 0;
	private searchTimer: number | undefined;
	private suppressClick = false;
	/** Styles just chosen in the sheet, shown until Obsidian's metadata cache catches up. */
	private pendingStyle = new Map<string, NoteStyle>();
	private sheetRepaint: (() => void) | null = null;

	constructor(root: HTMLElement, host: BoardHost) {
		this.root = root;
		this.host = host;
		this.build();
	}

	// ---------- public API ----------

	get scrollTop(): number {
		return this.scroller.scrollTop;
	}

	get searchQuery(): string {
		return this.query;
	}

	/** Restore scroll/query, e.g. after coming back from a note. */
	async restore(state: { scroll?: number; query?: string }): Promise<void> {
		if (typeof state.query === "string" && state.query !== this.query) {
			this.input.value = state.query;
			this.query = state.query;
			this.updateClear();
		}
		await this.refresh();
		if (typeof state.scroll === "number" && state.scroll > 0) {
			// Make sure enough cards exist to reach the old position.
			let guard = 0;
			while (this.scroller.scrollHeight - this.scroller.clientHeight < state.scroll && this.rendered < this.shown.length && guard++ < 50) {
				await this.renderMore();
			}
			this.scroller.scrollTop = state.scroll;
		}
	}

	/** Re-read the note list (after vault changes) while keeping the scroll position. */
	async refresh(): Promise<void> {
		const keepScroll = this.scroller.scrollTop;
		const keepCount = Math.max(this.rendered, BATCH);
		this.all = this.host.listNotes();
		await this.applyFilter(keepCount);
		this.scroller.scrollTop = keepScroll;
	}

	/** Call when a note's metadata changed on disk: drops the optimistic style and repaints. */
	styleChanged(id: string): void {
		this.pendingStyle.delete(id);
		this.restyle(id);
		this.sheetRepaint?.();
	}

	private styleOf(id: string): NoteStyle {
		const pending = this.pendingStyle.get(id);
		return pending ? { ...this.host.getStyle(id), ...pending } : this.host.getStyle(id);
	}

	/** Re-apply colours/wallpapers (theme change or frontmatter change). */
	restyle(id?: string): void {
		const cards = this.columnsEl.querySelectorAll<HTMLElement>(".jb-card");
		cards.forEach((c) => {
			if (!id || c.dataset.id === id) this.styleCard(c, c.dataset.id!);
		});
	}

	/** Re-read the + button colour from settings. */
	applyFabColor(): void {
		const c = (this.host.fabColor || "").trim();
		this.fab.style.backgroundColor = c;
		this.fab.style.color = c ? contrastInk(c) : "";
	}

	/** Forget cached previews (e.g. after the preview-length setting changes). */
	clearCache(): void {
		this.cache.clear();
	}

	focusSearch(): void {
		this.input.focus();
	}

	destroy(): void {
		this.observer?.disconnect();
		this.resizeObs?.disconnect();
		this.closeSheet();
		this.root.innerHTML = "";
		this.root.classList.remove("jb-root");
	}

	// ---------- construction ----------

	private build(): void {
		const r = this.root;
		r.classList.add("jb-root");

		const header = el("div", "jb-header", r);
		const bar = el("div", "jb-search", header);
		const sIcon = el("span", "jb-search-icon", bar);
		this.host.icon(sIcon, "search");
		this.input = el("input", "jb-search-input", bar);
		this.input.type = "search";
		this.input.placeholder = "Search your notes";
		this.input.setAttribute("enterkeyhint", "search");
		this.input.addEventListener("input", () => {
			this.updateClear();
			window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => {
				this.query = this.input.value;
				this.scroller.scrollTop = 0;
				void this.applyFilter(BATCH);
			}, 160);
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.input.blur();
		});
		this.clearBtn = el("button", "jb-icon-btn jb-search-clear", bar);
		this.clearBtn.setAttribute("aria-label", "Clear search");
		this.host.icon(this.clearBtn, "x");
		this.clearBtn.addEventListener("click", () => {
			this.input.value = "";
			this.query = "";
			this.updateClear();
			void this.applyFilter(BATCH);
		});
		this.layoutBtn = el("button", "jb-icon-btn jb-layout-btn", bar);
		this.layoutBtn.addEventListener("click", () => {
			this.host.setLayout(this.host.layout === "grid" ? "list" : "grid");
			this.updateLayoutBtn();
			this.relayout(true);
		});
		this.updateLayoutBtn();
		this.updateClear();

		this.scroller = el("div", "jb-scroller", r);
		this.statusEl = el("div", "jb-status", this.scroller);
		this.columnsEl = el("div", "jb-columns", this.scroller);
		this.sentinel = el("div", "jb-sentinel", this.scroller);

		const fab = (this.fab = el("button", "jb-fab", r));
		fab.setAttribute("aria-label", "New note");
		this.host.icon(fab, "plus");
		fab.addEventListener("click", () => this.host.create());
		this.applyFabColor();

		this.observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) void this.renderMore();
			},
			{ root: this.scroller, rootMargin: "600px 0px" },
		);
		this.observer.observe(this.sentinel);

		this.resizeObs = new ResizeObserver(() => this.relayout(false));
		this.resizeObs.observe(this.scroller);
	}

	private updateClear(): void {
		this.clearBtn.style.display = this.input.value ? "" : "none";
	}

	private updateLayoutBtn(): void {
		this.layoutBtn.innerHTML = "";
		const grid = this.host.layout === "grid";
		this.host.icon(this.layoutBtn, grid ? "rows-3" : "layout-grid");
		this.layoutBtn.setAttribute("aria-label", grid ? "List view" : "Grid view");
	}

	private wantedColumns(): number {
		if (this.host.layout === "list") return 1;
		const w = this.scroller.clientWidth - 2 * 12;
		return Math.max(2, Math.floor((w + GAP) / (MIN_CARD + GAP)));
	}

	private relayout(force: boolean): void {
		const n = this.wantedColumns();
		if (!force && n === this.colCount) return;
		const keep = this.rendered;
		void this.resetColumns().then(() => this.renderUpTo(Math.max(keep, BATCH)));
	}

	private async resetColumns(): Promise<void> {
		this.generation++;
		this.loading = false;
		this.rendered = 0;
		this.colCount = this.wantedColumns();
		this.columnsEl.innerHTML = "";
		this.columnsEl.classList.toggle("is-list", this.host.layout === "list");
		this.columns = [];
		for (let i = 0; i < this.colCount; i++) this.columns.push(el("div", "jb-column", this.columnsEl));
	}

	// ---------- data ----------

	private async previewFor(note: NoteRef): Promise<Preview> {
		const hit = this.cache.get(note.id);
		if (hit && hit.mtime === note.mtime) return hit.preview;
		let md = "";
		try {
			md = await this.host.read(note.id);
		} catch {
			md = "";
		}
		const preview = buildPreview(md, note.title, this.host.previewLines);
		this.cache.set(note.id, { mtime: note.mtime, preview });
		return preview;
	}

	private async applyFilter(renderCount: number): Promise<void> {
		const gen = ++this.generation;
		const q = this.query.trim().toLowerCase();
		if (!q) {
			this.shown = this.all;
		} else {
			const terms = q.split(/\s+/).filter(Boolean);
			// Make sure every note has been read once (cached by mtime afterwards).
			const missing = this.all.filter((n) => this.cache.get(n.id)?.mtime !== n.mtime);
			if (missing.length) {
				this.setStatus(`Searching ${this.all.length} notes…`);
				for (let i = 0; i < missing.length; i += 40) {
					await Promise.all(missing.slice(i, i + 40).map((n) => this.previewFor(n)));
					if (gen !== this.generation) return; // a newer search started
				}
			}
			this.shown = this.all.filter((n) => {
				const text = this.cache.get(n.id)?.preview.searchText ?? n.title.toLowerCase();
				return terms.every((t) => text.includes(t));
			});
		}
		if (gen !== this.generation) return;
		await this.resetColumns();
		await this.renderUpTo(renderCount);
		if (!this.shown.length) {
			this.setStatus(q ? "No matching notes" : "", !q);
		} else this.setStatus("");
	}

	private setStatus(text: string, emptyVault = false): void {
		this.statusEl.innerHTML = "";
		this.statusEl.style.display = text || emptyVault ? "" : "none";
		if (emptyVault) {
			const ic = el("div", "jb-empty-icon", this.statusEl);
			this.host.icon(ic, "lightbulb");
			el("div", "jb-empty-text", this.statusEl, "Notes you add appear here");
		} else if (text) el("div", "jb-status-text", this.statusEl, text);
	}

	private async renderUpTo(count: number): Promise<void> {
		let guard = 0;
		while (this.rendered < Math.min(count, this.shown.length) && guard++ < 100) {
			const before = this.rendered;
			await this.renderMore(count - this.rendered);
			if (this.rendered === before) break;
		}
	}

	private async renderMore(max = BATCH): Promise<void> {
		if (this.loading || this.rendered >= this.shown.length) return;
		this.loading = true;
		const gen = this.generation;
		try {
			const slice = this.shown.slice(this.rendered, this.rendered + Math.min(max, BATCH));
			const previews = await Promise.all(slice.map((n) => this.previewFor(n)));
			if (gen !== this.generation) return; // layout was reset meanwhile
			slice.forEach((note, i) => {
				let card: HTMLElement;
				try {
					card = this.renderCard(note, previews[i]);
				} catch (e) {
					console.error("Jotboard: failed to render", note.id, e);
					return;
				}
				this.shortestColumn().appendChild(card);
			});
			this.rendered += slice.length;
		} finally {
			if (gen === this.generation) this.loading = false;
		}
		// If the new cards didn't push the sentinel off-screen, the observer won't fire again: keep going.
		requestAnimationFrame(() => {
			if (gen === this.generation && this.sentinelNear()) void this.renderMore();
		});
	}

	private sentinelNear(): boolean {
		return this.sentinel.getBoundingClientRect().top < this.scroller.getBoundingClientRect().bottom + 600;
	}

	private shortestColumn(): HTMLElement {
		let best = this.columns[0];
		for (const c of this.columns) if (c.offsetHeight < best.offsetHeight) best = c;
		return best;
	}

	// ---------- cards ----------

	private renderCard(note: NoteRef, p: Preview): HTMLElement {
		const card = el("div", "jb-card");
		card.dataset.id = note.id;
		card.tabIndex = 0;

		if (p.image) {
			const url = this.host.resolveImage(p.image, note.id);
			if (url) {
				const img = el("img", "jb-card-image", card);
				img.loading = "lazy";
				img.decoding = "async";
				img.alt = "";
				img.src = url;
				img.addEventListener("error", () => img.remove());
			}
		}
		const body = el("div", "jb-card-body", card);
		const hideTitle = isPlaceholderTitle(note.title);
		if (!hideTitle) el("div", "jb-card-title", body, note.title);
		if (p.lines.length) {
			const content = el("div", "jb-card-content", body);
			for (const line of p.lines) {
				if (line.kind === "task") {
					const row = el("div", "jb-line jb-task" + (line.done ? " is-done" : ""), content);
					const box = el("span", "jb-checkbox", row);
					if (line.done) this.host.icon(box, "check");
					el("span", "jb-task-text", row, line.text);
				} else if (line.kind === "bullet") {
					el("div", "jb-line jb-bullet", content, line.text);
				} else if (line.kind === "heading") {
					el("div", "jb-line jb-heading", content, line.text);
				} else {
					el("div", "jb-line jb-text", content, line.text);
				}
			}
			if (p.truncated) content.classList.add("is-truncated");
		} else if (hideTitle && !p.image) {
			el("div", "jb-card-empty", body, "Empty note");
		}

		this.styleCard(card, note.id);
		this.bindCard(card, note.id);
		return card;
	}

	private styleCard(card: HTMLElement, id: string): void {
		const style = this.styleOf(id);
		const dark = this.host.isDark();
		const color = resolveColor(style.color, dark);
		card.classList.toggle("has-color", !!color);
		card.style.backgroundColor = color ?? "";

		const wp = wallpaperById(style.wallpaper);
		const link = wallpaperImageLink(style.wallpaper);
		card.classList.remove("has-wallpaper", "has-photo");
		card.style.backgroundImage = "";
		card.style.backgroundSize = "";
		card.style.backgroundPosition = "";
		card.style.backgroundRepeat = "";
		if (wp) {
			const css = wp.css(dark);
			card.classList.add("has-wallpaper");
			card.style.backgroundImage = css.image;
			card.style.backgroundSize = css.size;
			card.style.backgroundPosition = css.position;
			card.style.backgroundRepeat = css.repeat;
		} else if (link) {
			const url = this.host.resolveImage(link, id);
			if (url) {
				card.classList.add("has-wallpaper", "has-photo");
				const shade = dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.6)";
				card.style.backgroundImage = `linear-gradient(${shade}, ${shade}), url("${url.replace(/"/g, '\\"')}")`;
				card.style.backgroundSize = "cover";
				card.style.backgroundPosition = "center";
				card.style.backgroundRepeat = "no-repeat";
			}
		}
	}

	private bindCard(card: HTMLElement, id: string): void {
		let timer: number | undefined;
		let startX = 0;
		let startY = 0;
		const cancel = () => {
			window.clearTimeout(timer);
			timer = undefined;
			card.classList.remove("is-pressing");
		};
		card.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			this.suppressClick = false; // a new gesture starts fresh
			startX = e.clientX;
			startY = e.clientY;
			card.classList.add("is-pressing");
			timer = window.setTimeout(() => {
				timer = undefined;
				card.classList.remove("is-pressing");
				this.suppressClick = true;
				if (navigator.vibrate) navigator.vibrate(12);
				this.openSheet(id);
			}, 450);
		});
		card.addEventListener("pointermove", (e) => {
			if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
		});
		card.addEventListener("pointerup", cancel);
		card.addEventListener("pointercancel", cancel);
		card.addEventListener("pointerleave", cancel);
		// Android webviews fire contextmenu on long-press; desktop on right-click.
		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			if (this.sheet) return;
			cancel();
			this.suppressClick = true;
			this.openSheet(id);
		});
		card.addEventListener("click", (e) => {
			if (this.suppressClick) {
				this.suppressClick = false;
				e.preventDefault();
				return;
			}
			this.host.open(id);
		});
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.host.open(id);
		});
	}

	// ---------- colour / wallpaper sheet ----------

	openSheet(id: string): void {
		this.closeSheet();
		const note = this.all.find((n) => n.id === id);
		const overlay = el("div", "jb-sheet-overlay", this.root);
		const panel = el("div", "jb-sheet", overlay);
		el("div", "jb-sheet-handle", panel);
		if (note) el("div", "jb-sheet-title", panel, isPlaceholderTitle(note.title) ? "Untitled note" : note.title);

		const dark = this.host.isDark();
		const current = () => this.styleOf(id);

		el("div", "jb-sheet-label", panel, "Colour");
		const colorRow = el("div", "jb-swatch-row", panel);
		el("div", "jb-sheet-label", panel, "Wallpaper");
		const wpRow = el("div", "jb-swatch-row", panel);

		const paint = () => {
			const s = current();
			colorRow.querySelectorAll<HTMLElement>(".jb-swatch").forEach((sw) => sw.classList.toggle("is-selected", (sw.dataset.value || "") === (s.color || "")));
			wpRow.querySelectorAll<HTMLElement>(".jb-swatch").forEach((sw) => {
				const v = sw.dataset.value || "";
				const sel = v === "__image" ? !!wallpaperImageLink(s.wallpaper) : v === (s.wallpaper || "");
				sw.classList.toggle("is-selected", sel);
			});
		};
		const apply = async (patch: NoteStyle) => {
			this.pendingStyle.set(id, { ...this.pendingStyle.get(id), ...patch });
			this.restyle(id);
			paint();
			await this.host.setStyle(id, patch);
		};
		this.sheetRepaint = paint;

		const none = el("button", "jb-swatch jb-swatch-none", colorRow);
		none.dataset.value = "";
		none.setAttribute("aria-label", "Default");
		this.host.icon(none, "droplet-off");
		none.addEventListener("click", () => void apply({ color: undefined }));
		for (const c of COLORS) {
			const sw = el("button", "jb-swatch", colorRow);
			sw.dataset.value = c.id;
			sw.setAttribute("aria-label", c.label);
			sw.style.backgroundColor = dark ? c.dark : c.light;
			el("span", "jb-swatch-check", sw);
			sw.addEventListener("click", () => void apply({ color: c.id }));
		}

		const wpNone = el("button", "jb-swatch jb-swatch-wp jb-swatch-none", wpRow);
		wpNone.dataset.value = "";
		wpNone.setAttribute("aria-label", "No wallpaper");
		this.host.icon(wpNone, "image-off");
		wpNone.addEventListener("click", () => void apply({ wallpaper: undefined }));
		const base = resolveColor(current().color, dark);
		for (const w of WALLPAPERS) {
			const sw = el("button", "jb-swatch jb-swatch-wp", wpRow);
			sw.dataset.value = w.id;
			sw.setAttribute("aria-label", w.label);
			const css = w.css(dark);
			sw.style.backgroundColor = base ?? "";
			sw.style.backgroundImage = css.image;
			sw.style.backgroundSize = css.repeat === "repeat" ? css.size : "cover";
			sw.style.backgroundPosition = css.repeat === "repeat" ? css.position : "bottom center";
			sw.style.backgroundRepeat = css.repeat;
			el("span", "jb-swatch-check", sw);
			sw.addEventListener("click", () => void apply({ wallpaper: w.id }));
		}
		if (this.host.pickImage) {
			const pick = el("button", "jb-swatch jb-swatch-wp jb-swatch-image", wpRow);
			pick.dataset.value = "__image";
			pick.setAttribute("aria-label", "Image from vault");
			this.host.icon(pick, "image-plus");
			el("span", "jb-swatch-check", pick);
			pick.addEventListener("click", async () => {
				const v = await this.host.pickImage!();
				if (v) await apply({ wallpaper: v });
			});
		}

		const actions = el("div", "jb-sheet-actions", panel);
		const openBtn = el("button", "jb-sheet-action", actions);
		this.host.icon(el("span", "jb-sheet-action-icon", openBtn), "file-text");
		el("span", "", openBtn, "Open");
		openBtn.addEventListener("click", () => {
			this.closeSheet();
			this.host.open(id);
		});
		const del = el("button", "jb-sheet-action mod-warning", actions);
		this.host.icon(el("span", "jb-sheet-action-icon", del), "trash-2");
		const delLabel = el("span", "", del, "Delete");
		let armed = false;
		del.addEventListener("click", async () => {
			if (!armed) {
				armed = true;
				delLabel.textContent = "Tap again to delete";
				return;
			}
			this.closeSheet();
			await this.host.remove(id);
		});

		paint();
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) this.closeSheet();
		});
		requestAnimationFrame(() => overlay.classList.add("is-open"));
		this.sheet = overlay;
	}

	closeSheet(): void {
		if (!this.sheet) return;
		const s = this.sheet;
		this.sheet = null;
		this.sheetRepaint = null;
		s.classList.remove("is-open");
		window.setTimeout(() => s.remove(), 180);
	}

	get sheetOpen(): boolean {
		return !!this.sheet;
	}
}
