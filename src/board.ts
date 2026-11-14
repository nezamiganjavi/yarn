// The card board itself. Plain DOM only, so it can be mounted both inside Obsidian
// and in a browser test harness with a mock vault.

import { buildPreview, isPlaceholderTitle, Preview } from "./preview";
import { COLORS, WALLPAPERS, contrastInk, resolveColor, wallpaperById, wallpaperImageLink } from "./palette";

export interface NoteRef {
	id: string; // vault path
	title: string; // basename
	mtime: number;
	/** The date the list is sorted by (edited or created), for the scrubber. */
	date?: number;
}

export interface BoardState {
	scroll?: number;
	query?: string;
	/** The note at the top of the screen and how far it was scrolled, so deep positions survive. */
	anchor?: string;
	offset?: number;
}

export interface NoteStyle {
	color?: string;
	wallpaper?: string;
	pinned?: boolean;
}

export interface BoardHost {
	listNotes(): NoteRef[];
	read(id: string): Promise<string>;
	getStyle(id: string): NoteStyle;
	setStyle(id: string, patch: NoteStyle): Promise<void>;
	/** Resolve an image link found in a note (or a wallpaper link) to a URL the webview can load. */
	resolveImage(link: string, sourceId: string): string | null;
	open(id: string, newTab?: boolean): void;
	create(): void;
	remove(id: string): Promise<void>;
	/** Optional: the note's tags, without "#" (from properties and inline #tags). */
	getTags?(id: string): string[];
	/** Optional: how to display a tag (custom label names); defaults to the tag itself. */
	tagLabel?(tag: string): string;
	/** Optional: let the user pick a vault image; returns a wallpaper value like "[[pic.jpg]]". */
	pickImage?(): Promise<string | null>;
	isDark(): boolean;
	icon(el: HTMLElement, name: string): void;
	previewLines: number;
	/** "date" sorts (edited/created) scrub by month; "name" sort scrubs by letter. */
	sortKind?: "date" | "name";
	/** Show the drag-to-date scrubber on the right edge. */
	scrubber?: boolean;
	/** How a card shows that its note continues: "…", a fade, or nothing. */
	overflow: "ellipsis" | "fade" | "none";
	layout: "grid" | "list";
	/** Hex colour for the + button; empty uses the theme accent. */
	fabColor: string;
	setLayout(layout: "grid" | "list"): void;
	/** Optional: hide/show the surrounding app UI (Obsidian's header and bottom bar). */
	chromeHidden?: boolean;
	setChromeHidden?(hidden: boolean): void;
	/** Optional: pixels at the bottom of the screen covered by floating app UI. */
	bottomInset?(): number;
}

interface CachedPreview {
	mtime: number;
	preview: Preview;
}

const BATCH = 24;
/** Search words that mean "notes without any tags". */
const UNTAGGED = new Set(["#unlabelled", "#unlabeled", "#untagged", "#notags"]);
const MIN_CARD = 150;
/** Above this width (desktop, tablets) cards get a fixed, roomier width and the grid centres. */
const WIDE = 600;
const WIDE_CARD = 240;
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
	private pinnedColumns: HTMLElement[] = [];
	private pinnedCount = 0;
	private pinnedIds = new Set<string>();
	private chromeBtn: HTMLElement | null = null;
	private sentinel!: HTMLElement;
	private statusEl!: HTMLElement;
	private input!: HTMLInputElement;
	private clearBtn!: HTMLElement;
	private layoutBtn!: HTMLElement;
	private sheet: HTMLElement | null = null;
	private fab!: HTMLElement;
	private suggest!: HTMLElement;

	private cache = new Map<string, CachedPreview>();
	/** Built card elements, reused across re-layouts so nothing flashes or re-animates. */
	private cards = new Map<string, { mtime: number; el: HTMLElement }>();
	/** Signature of the list currently on screen; unchanged list = no rebuild. */
	private shownSig = "";
	private all: NoteRef[] = [];
	private shown: NoteRef[] = [];
	/** Others are rendered as a window [start, rendered) of `shown`; pinned are always all rendered. */
	private start = 0;
	private rendered = 0;
	/** One spacer at the top of each Others column, used to keep columns level when loading upward. */
	private spacers: HTMLElement[] = [];
	private topSentinel: HTMLElement | null = null;
	private scrub: HTMLElement | null = null;
	private thumb!: HTMLElement;
	private bubble!: HTMLElement;
	private marks!: HTMLElement;
	private dragging = false;
	private scrubHide: number | undefined;
	private scrubJump: number | undefined;
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

	/** Where the board is, for saving (Back navigation, restarts). */
	get state(): BoardState {
		const a = this.anchor();
		return { scroll: this.scroller.scrollTop, query: this.query, anchor: a?.id, offset: a?.offset };
	}

	/** Restore scroll/query, e.g. after coming back from a note. */
	async restore(state: BoardState): Promise<void> {
		if (typeof state.query === "string" && state.query !== this.query) {
			this.input.value = state.query;
			this.query = state.query;
			this.updateClear();
		}
		await this.refresh();
		const idx = state.anchor ? this.shown.findIndex((n) => n.id === state.anchor) : -1;
		if (idx >= this.pinnedCount) {
			await this.jumpTo(idx, state.offset ?? 0);
			return;
		}
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
		this.root.style.setProperty("--yarn-lines", String(this.host.previewLines));
		const keepScroll = this.scroller.scrollTop;
		const a = this.anchor();
		this.all = this.host.listNotes();
		const rebuilt = await this.applyFilter(BATCH, a);
		if (rebuilt && !a) this.scroller.scrollTop = keepScroll;
	}

	/** Call when a note's metadata changed on disk: drops the optimistic style and repaints. */
	styleChanged(id: string): void {
		this.pendingStyle.delete(id);
		if (!!this.styleOf(id).pinned !== this.pinnedIds.has(id)) void this.refresh();
		else this.restyle(id);
		this.columnsEl.querySelectorAll<HTMLElement>(".yarn-card").forEach((c) => {
			if (c.dataset.id === id) this.renderTags(c, id);
		});
		this.sheetRepaint?.();
	}

	private styleOf(id: string): NoteStyle {
		const pending = this.pendingStyle.get(id);
		return pending ? { ...this.host.getStyle(id), ...pending } : this.host.getStyle(id);
	}

	/** Re-apply colours/wallpapers (theme change or frontmatter change). */
	restyle(id?: string): void {
		const cards = this.columnsEl.querySelectorAll<HTMLElement>(".yarn-card");
		cards.forEach((c) => {
			if (!id || c.dataset.id === id) this.styleCard(c, c.dataset.id!);
		});
	}

	/** Lift the + button (and the end of the list) above floating app UI such as Obsidian's bottom bar. */
	updateInsets(): void {
		const lift = Math.max(0, Math.round(this.host.bottomInset?.() ?? 0));
		this.root.style.setProperty("--yarn-bottom-lift", lift + "px");
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
		this.cards.clear();
		this.shownSig = "";
	}

	focusSearch(): void {
		this.input.focus();
	}

	destroy(): void {
		this.observer?.disconnect();
		this.resizeObs?.disconnect();
		this.closeSheet();
		this.root.replaceChildren();
		this.root.classList.remove("yarn-root");
	}

	// ---------- construction ----------

	private build(): void {
		const r = this.root;
		r.classList.add("yarn-root");

		const header = el("div", "yarn-header", r);
		const bar = el("div", "yarn-search", header);
		const sIcon = el("span", "yarn-search-icon", bar);
		this.host.icon(sIcon, "search");
		this.input = el("input", "yarn-search-input", bar);
		this.input.type = "search";
		this.input.placeholder = "Search your notes";
		this.input.setAttribute("enterkeyhint", "search");
		this.input.addEventListener("focus", () => this.showSuggestions());
		this.input.addEventListener("blur", () => window.setTimeout(() => this.hideSuggestions(), 150));
		this.input.addEventListener("input", () => {
			if (this.input.value) this.hideSuggestions();
			else this.showSuggestions();
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
		this.suggest = el("div", "yarn-suggest", header);
		this.suggest.style.display = "none";
		this.clearBtn = el("button", "yarn-icon-btn yarn-search-clear", bar);
		this.clearBtn.setAttribute("aria-label", "Clear search");
		this.host.icon(this.clearBtn, "x");
		this.clearBtn.addEventListener("click", () => {
			this.input.value = "";
			this.query = "";
			this.updateClear();
			void this.applyFilter(BATCH);
		});
		this.layoutBtn = el("button", "yarn-icon-btn yarn-layout-btn", bar);
		this.layoutBtn.addEventListener("click", () => {
			this.host.setLayout(this.host.layout === "grid" ? "list" : "grid");
			this.updateLayoutBtn();
			this.relayout(true);
		});
		this.updateLayoutBtn();
		if (this.host.setChromeHidden) {
			const btn = (this.chromeBtn = el("button", "yarn-icon-btn yarn-chrome-btn", bar));
			btn.addEventListener("click", () => {
				this.host.setChromeHidden!(!this.host.chromeHidden);
				this.updateChromeBtn();
				window.setTimeout(() => this.updateInsets(), 60);
			});
			this.updateChromeBtn();
		}
		this.updateClear();
		this.root.style.setProperty("--yarn-lines", String(this.host.previewLines));

		this.scroller = el("div", "yarn-scroller", r);
		this.statusEl = el("div", "yarn-status", this.scroller);
		this.columnsEl = el("div", "yarn-columns", this.scroller);
		this.sentinel = el("div", "yarn-sentinel", this.scroller);

		const fab = (this.fab = el("button", "yarn-fab", r));
		fab.setAttribute("aria-label", "New note");
		this.host.icon(fab, "plus");
		fab.addEventListener("click", () => this.host.create());
		this.applyFabColor();
		this.updateInsets();

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					if (e.target === this.sentinel) void this.renderMore();
					else void this.renderAbove();
				}
			},
			{ root: this.scroller, rootMargin: "600px 0px" },
		);
		this.observer.observe(this.sentinel);

		this.buildScrubber();
		this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });

		this.resizeObs = new ResizeObserver(() => {
			this.relayout(false);
			this.updateInsets();
		});
		this.resizeObs.observe(this.scroller);
	}

	// ---------- date scrubber ----------

	private buildScrubber(): void {
		const s = (this.scrub = el("div", "yarn-scrub", this.root));
		this.marks = el("div", "yarn-scrub-marks", s);
		this.thumb = el("div", "yarn-scrub-thumb", s);
		this.thumb.setAttribute("role", "slider");
		this.thumb.setAttribute("aria-label", "Scroll by date");
		el("div", "yarn-scrub-grip", this.thumb);
		this.bubble = el("div", "yarn-scrub-bubble", s);

		let grabY = 0;
		const fractionAt = (clientY: number) => {
			const r = s.getBoundingClientRect();
			const h = this.thumb.offsetHeight;
			return Math.max(0, Math.min(1, (clientY - grabY - r.top) / Math.max(1, r.height - h)));
		};
		this.thumb.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.thumb.setPointerCapture(e.pointerId);
			grabY = e.clientY - this.thumb.getBoundingClientRect().top;
			this.dragging = true;
			this.root.classList.add("is-scrubbing");
			window.clearTimeout(this.scrubHide);
			s.classList.add("is-visible");
			this.drawTrackMarks();
			this.markMonths();
			this.dragTo(fractionAt(e.clientY));
		});
		this.thumb.addEventListener("pointermove", (e) => {
			if (this.dragging) this.dragTo(fractionAt(e.clientY));
		});
		const end = () => {
			if (!this.dragging) return;
			this.dragging = false;
			window.clearTimeout(this.scrubJump);
			void this.jumpTo(this.dragIndex).then(() => {
				this.root.classList.remove("is-scrubbing");
				this.updateScrubber();
				this.scheduleScrubHide();
			});
		};
		this.thumb.addEventListener("pointerup", end);
		this.thumb.addEventListener("pointercancel", end);
		this.thumb.addEventListener("lostpointercapture", end);
	}

	private dragIndex = 0;

	/** While dragging: move the thumb and bubble at once; jump the board after a short pause. */
	private dragTo(f: number): void {
		const span = this.shown.length - this.pinnedCount;
		if (span <= 0) return;
		this.dragIndex = this.pinnedCount + Math.round(f * (span - 1));
		this.placeThumb(f);
		this.bubble.textContent = this.labelFor(this.dragIndex);
		window.clearTimeout(this.scrubJump);
		this.scrubJump = window.setTimeout(() => {
			void this.jumpTo(this.dragIndex).then(() => {
				if (this.dragging) this.markMonths();
			});
		}, 140);
	}

	private placeThumb(f: number): void {
		if (!this.scrub) return;
		const travel = this.scrub.clientHeight - this.thumb.offsetHeight;
		const y = Math.round(f * Math.max(0, travel));
		this.thumb.style.transform = `translateY(${y}px)`;
		this.bubble.style.transform = `translateY(${y + this.thumb.offsetHeight / 2}px) translateY(-50%)`;
	}

	/** Month and year (date sorts) or first letter (name sort) of the note at `index`. */
	private labelFor(index: number): string {
		const n = this.shown[index];
		if (!n) return "";
		if (this.host.sortKind === "name") {
			const ch = n.title.trim().charAt(0).toUpperCase();
			return /[\p{L}\p{N}]/u.test(ch) ? ch : "#";
		}
		return new Date(n.date ?? n.mtime).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	}

	private shortLabel(index: number): string {
		const n = this.shown[index];
		if (!n) return "";
		if (this.host.sortKind === "name") return this.labelFor(index);
		return new Date(n.date ?? n.mtime).toLocaleDateString(undefined, { month: "short", year: "numeric" });
	}

	/** Years (or letters) along the track while you hold the thumb, like a ruler. */
	private drawTrackMarks(): void {
		this.marks.replaceChildren();
		const span = this.shown.length - this.pinnedCount;
		if (span <= 1 || !this.scrub) return;
		const h = this.scrub.clientHeight - this.thumb.offsetHeight;
		const seen = new Set<string>();
		let lastY = -Infinity;
		for (let i = this.pinnedCount; i < this.shown.length; i++) {
			const n = this.shown[i];
			const key = this.host.sortKind === "name" ? this.labelFor(i) : String(new Date(n.date ?? n.mtime).getFullYear());
			if (seen.has(key)) continue;
			seen.add(key);
			const y = ((i - this.pinnedCount) / (span - 1)) * h + this.thumb.offsetHeight / 2;
			if (y - lastY < 22) continue;
			lastY = y;
			const m = el("div", "yarn-scrub-mark", this.marks, key);
			m.style.top = y + "px";
		}
	}

	/** While scrubbing, label the first card of each month (an overlay; the grid doesn't move). */
	private markMonths(): void {
		const cards = Array.from(this.columnsEl.querySelectorAll<HTMLElement>(".yarn-column .yarn-card"));
		const first = new Map<string, HTMLElement>();
		for (const c of cards) {
			delete c.dataset.month;
			const idx = Number(c.dataset.idx);
			if (idx < this.pinnedCount) continue;
			const key = this.shortLabel(idx);
			const cur = first.get(key);
			if (!cur || Number(cur.dataset.idx) > idx) first.set(key, c);
		}
		for (const [key, c] of first) c.dataset.month = key;
	}

	private onScroll(): void {
		if (this.dragging || !this.scrub) return;
		this.updateScrubber();
		if (this.root.classList.contains("has-scrubber")) {
			this.scrub.classList.add("is-visible");
			this.scheduleScrubHide();
		}
	}

	private scheduleScrubHide(): void {
		window.clearTimeout(this.scrubHide);
		this.scrubHide = window.setTimeout(() => this.scrub?.classList.remove("is-visible"), 1600);
	}

	/** Put the thumb where the top of the screen is in the list. */
	updateScrubber(): void {
		if (!this.scrub || this.dragging) return;
		const span = this.shown.length - this.pinnedCount;
		const on = this.host.scrubber !== false && span > 30;
		this.root.classList.toggle("has-scrubber", on);
		if (!on) return;
		const a = this.anchor();
		let f = 0;
		if (a) f = span > 1 ? (a.idx - this.pinnedCount) / (span - 1) : 0;
		if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 2 && this.rendered >= this.shown.length) f = 1;
		this.placeThumb(f);
	}

	private updateClear(): void {
		this.clearBtn.style.display = this.input.value ? "" : "none";
	}

	private updateLayoutBtn(): void {
		this.layoutBtn.replaceChildren();
		const grid = this.host.layout === "grid";
		this.host.icon(this.layoutBtn, grid ? "rows-3" : "layout-grid");
		this.layoutBtn.setAttribute("aria-label", grid ? "List view" : "Grid view");
	}

	private updateChromeBtn(): void {
		if (!this.chromeBtn) return;
		const hidden = !!this.host.chromeHidden;
		this.chromeBtn.replaceChildren();
		this.host.icon(this.chromeBtn, hidden ? "minimize-2" : "maximize-2");
		this.chromeBtn.setAttribute("aria-label", hidden ? "Show Obsidian toolbars" : "Hide Obsidian toolbars");
	}

	private wantedColumns(): number {
		if (this.host.layout === "list") return 1;
		const w = this.scroller.clientWidth - 2 * 12;
		const card = w >= WIDE ? WIDE_CARD : MIN_CARD;
		return Math.max(2, Math.floor((w + GAP) / (card + GAP)));
	}

	private relayout(force: boolean): void {
		const n = this.wantedColumns();
		if (!force && n === this.colCount) return;
		const a = this.anchor();
		const keepScroll = this.scroller.scrollTop;
		this.shownSig = "";
		void (async () => {
			await this.resetColumns();
			await this.renderPinned();
			const idx = a ? this.shown.findIndex((x) => x.id === a.id) : -1;
			if (idx >= this.pinnedCount) await this.jumpTo(idx, a!.offset);
			else {
				await this.renderUpTo(BATCH);
				this.scroller.scrollTop = keepScroll;
			}
		})();
	}

	private async resetColumns(): Promise<void> {
		this.generation++;
		this.loading = false;
		this.start = this.rendered = this.pinnedCount;
		this.colCount = this.wantedColumns();
		this.columnsEl.replaceChildren();
		const list = this.host.layout === "list";
		const wide = this.scroller.clientWidth - 24 >= WIDE;
		this.root.classList.toggle("is-wide", wide);
		this.columnsEl.style.maxWidth = wide && !list ? this.colCount * WIDE_CARD + (this.colCount - 1) * GAP + "px" : "";
		const section = (label: string | null, others: boolean) => {
			const sec = el("div", "yarn-section", this.columnsEl);
			if (label) el("div", "yarn-section-label", sec, label);
			if (others) this.topSentinel = el("div", "yarn-top-sentinel", sec);
			const row = el("div", "yarn-columns-row" + (list ? " is-list" : ""), sec);
			const cols: HTMLElement[] = [];
			for (let i = 0; i < this.colCount; i++) cols.push(el("div", "yarn-column", row));
			return cols;
		};
		const hasPinned = this.pinnedCount > 0;
		this.pinnedColumns = hasPinned ? section("Pinned", false) : [];
		this.columns = section(hasPinned ? "Others" : null, true);
		this.spacers = this.columns.map((c) => el("div", "yarn-spacer", c));
		if (this.topSentinel) this.observer?.observe(this.topSentinel);
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

	/** Returns true if the board was rebuilt. With an anchor, it re-centres on that note. */
	private async applyFilter(renderCount: number, anchor: { id: string; offset: number } | null = null): Promise<boolean> {
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
					if (gen !== this.generation) return false; // a newer search started
				}
			}
			this.shown = this.all.filter((n) => {
				const text = this.cache.get(n.id)?.preview.searchText ?? n.title.toLowerCase();
				return terms.every((term) => {
					// "-word" / "-#tag" excludes notes that match.
					const negate = term.length > 1 && term.startsWith("-");
					const t = negate ? term.slice(1) : term;
					let hit: boolean;
					if (UNTAGGED.has(t) && this.host.getTags) {
						// "#unlabelled": notes with no tags (Keep's colour/pin tags don't count).
						hit = this.host.getTags(n.id).length === 0;
					} else if (t.startsWith("#") && t.length > 1 && this.host.getTags) {
						// "#tag" matches the note's tags (and nested ones like #tag/sub), not just text.
						const want = t.slice(1);
						hit = this.host.getTags(n.id).some((g) => {
							const tag = g.toLowerCase();
							return tag === want || tag.startsWith(want + "/");
						});
					} else hit = text.includes(t);
					return negate ? !hit : hit;
				});
			});
		}
		if (gen !== this.generation) return false;
		// Pinned notes first, in their usual order.
		const pinned = this.shown.filter((n) => this.styleOf(n.id).pinned);
		this.pinnedIds = new Set(pinned.map((n) => n.id));
		this.pinnedCount = pinned.length;
		if (pinned.length) this.shown = pinned.concat(this.shown.filter((n) => !this.pinnedIds.has(n.id)));
		// Nothing moved (e.g. only a colour or property changed): repaint in place instead of rebuilding.
		const sig = `${this.host.layout}|${this.wantedColumns()}|${pinned.length}|` + this.shown.map((n) => n.id + ":" + n.mtime).join("|");
		if (sig === this.shownSig && this.rendered > 0) {
			this.restyle();
			return false;
		}
		this.shownSig = sig;
		// Forget cards for notes that no longer exist.
		if (!q) {
			const ids = new Set(this.all.map((n) => n.id));
			for (const id of this.cards.keys()) if (!ids.has(id)) this.cards.delete(id);
		}
		await this.resetColumns();
		await this.renderPinned();
		const idx = anchor ? this.shown.findIndex((n) => n.id === anchor.id) : -1;
		if (idx >= this.pinnedCount) await this.jumpTo(idx, anchor!.offset);
		else await this.renderUpTo(renderCount);
		if (!this.shown.length) {
			this.setStatus(q ? "No matching notes" : "", !q);
		} else this.setStatus("");
		this.updateScrubber();
		return true;
	}

	private setStatus(text: string, emptyVault = false): void {
		this.statusEl.replaceChildren();
		this.statusEl.style.display = text || emptyVault ? "" : "none";
		if (emptyVault) {
			const ic = el("div", "yarn-empty-icon", this.statusEl);
			this.host.icon(ic, "lightbulb");
			el("div", "yarn-empty-text", this.statusEl, "Notes you add appear here");
		} else if (text) el("div", "yarn-status-text", this.statusEl, text);
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
			const start = this.rendered;
			const previews = await Promise.all(slice.map((n) => this.previewFor(n)));
			if (gen !== this.generation) return; // layout was reset meanwhile
			slice.forEach((note, i) => {
				let card: HTMLElement;
				try {
					card = this.renderCard(note, previews[i]);
				} catch (e) {
					console.error("Yarn: failed to render", note.id, e);
					return;
				}
				card.dataset.idx = String(start + i);
				this.shortestColumn(this.columns).appendChild(card);
				this.fitContent(card);
				card.dataset.h = String(card.getBoundingClientRect().height);
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

	/** Pinned notes are few, so they are always rendered in full. */
	private async renderPinned(): Promise<void> {
		if (!this.pinnedCount) return;
		const gen = this.generation;
		const slice = this.shown.slice(0, this.pinnedCount);
		const previews = await Promise.all(slice.map((n) => this.previewFor(n)));
		if (gen !== this.generation) return;
		slice.forEach((note, i) => {
			try {
				const card = this.renderCard(note, previews[i]);
				card.dataset.idx = String(i);
				this.shortestColumn(this.pinnedColumns).appendChild(card);
				this.fitContent(card);
				card.dataset.h = String(card.getBoundingClientRect().height);
			} catch (e) {
				console.error("Yarn: failed to render", note.id, e);
			}
		});
	}

	/**
	 * Load newer notes above the window (after a jump). New cards are measured first, shared
	 * out so every column grows by the same amount (spacers absorb the remainder), and the
	 * scroll position moves by exactly that amount, so nothing on screen shifts.
	 */
	async renderAbove(): Promise<void> {
		if (this.loading || this.start <= this.pinnedCount || !this.columns.length) return;
		this.loading = true;
		const gen = this.generation;
		try {
			const from = Math.max(this.pinnedCount, this.start - BATCH);
			const slice = this.shown.slice(from, this.start);
			const previews = await Promise.all(slice.map((n) => this.previewFor(n)));
			if (gen !== this.generation) return;
			const row = this.columns[0].parentElement!;
			const measure = el("div", "yarn-column yarn-measure", row);
			measure.style.width = this.columns[0].offsetWidth + "px";
			const built: HTMLElement[] = [];
			slice.forEach((note, i) => {
				try {
					const card = this.renderCard(note, previews[i]);
					card.dataset.idx = String(from + i);
					card.classList.add("is-settled");
					measure.appendChild(card);
					this.fitContent(card);
					built.push(card);
				} catch (e) {
					console.error("Yarn: failed to render", note.id, e);
				}
			});
			const heights = built.map((c) => c.getBoundingClientRect().height);
			measure.remove();
			const v = this.spacers.map((sp) => -(parseFloat(sp.style.height) || 0));
			// Nearest-to-window first, each inserted at the top, so columns read newest → oldest.
			for (let k = built.length - 1; k >= 0; k--) {
				let c = 0;
				for (let j = 1; j < v.length; j++) if (v[j] < v[c]) c = j;
				const sp = this.spacers[c];
				sp.parentElement!.insertBefore(built[k], sp.nextSibling);
				built[k].dataset.h = String(heights[k]);
				v[c] += heights[k] + GAP;
			}
			const shift = Math.max(...v);
			this.spacers.forEach((sp, i) => (sp.style.height = shift - v[i] + "px"));
			this.scroller.scrollTop += shift;
			this.start = from;
		} finally {
			if (gen === this.generation) this.loading = false;
		}
		requestAnimationFrame(() => {
			if (gen === this.generation && this.topNear()) void this.renderAbove();
		});
	}

	private topNear(): boolean {
		if (!this.topSentinel) return false;
		return this.topSentinel.getBoundingClientRect().bottom > this.scroller.getBoundingClientRect().top - 600;
	}

	/** A card grew after it was placed (an image loaded). If it's above the screen, keep the view still. */
	private cardGrew(card: HTMLElement): void {
		const before = Number(card.dataset.h || 0);
		const now = card.getBoundingClientRect().height;
		card.dataset.h = String(now);
		const delta = now - before;
		if (!delta || !before) return;
		const col = this.columns.indexOf(card.parentElement as HTMLElement);
		if (col < 0) return;
		if (card.getBoundingClientRect().top >= this.scroller.getBoundingClientRect().top) return;
		// Grow the other columns' spacers by the same amount so all columns move together.
		this.spacers.forEach((sp, i) => {
			if (i !== col) sp.style.height = (parseFloat(sp.style.height) || 0) + delta + "px";
		});
		this.scroller.scrollTop += delta;
	}

	/** The topmost visible Others card and its offset from the top of the screen. */
	anchor(): { id: string; offset: number; idx: number } | null {
		if (!this.columns.length) return null;
		const top = this.scroller.getBoundingClientRect().top;
		const row = this.columns[0].parentElement;
		if (!row || row.getBoundingClientRect().top >= top) return null; // still at the top of the board
		let best: HTMLElement | null = null;
		for (const col of this.columns) {
			for (const c of Array.from(col.children) as HTMLElement[]) {
				if (!c.classList.contains("yarn-card")) continue;
				if (c.getBoundingClientRect().bottom <= top) continue;
				if (!best || Number(c.dataset.idx) < Number(best.dataset.idx)) best = c;
				break;
			}
		}
		return best ? { id: best.dataset.id!, offset: best.getBoundingClientRect().top - top, idx: Number(best.dataset.idx) } : null;
	}

	private cardAt(index: number): HTMLElement | null {
		return this.columnsEl.querySelector<HTMLElement>(`.yarn-card[data-idx="${index}"]`);
	}

	/** Show the board from note `index` (in the current order/filter), `offset` px below the top. */
	async jumpTo(index: number, offset = 0): Promise<void> {
		if (this.shown.length <= this.pinnedCount) return;
		index = Math.max(this.pinnedCount, Math.min(this.shown.length - 1, index));
		if (!this.cardAt(index)) {
			if (this.start === this.pinnedCount && index < this.rendered + 2 * BATCH) {
				await this.renderUpTo(index + BATCH);
			} else {
				// Start a fresh window at the target; newer notes load above as you scroll up.
				this.generation++;
				this.loading = false;
				this.start = this.rendered = index;
				this.columns.forEach((c, i) => {
					this.spacers[i].style.height = "0px";
					c.replaceChildren(this.spacers[i]);
				});
				await this.renderUpTo(index + BATCH);
			}
		}
		// A jump lands instantly: skip the fade-in (its 4px slide would throw off the measurement).
		this.columnsEl.querySelectorAll(".yarn-card:not(.is-settled)").forEach((c) => c.classList.add("is-settled"));
		const card = this.cardAt(index);
		if (card) this.scroller.scrollTop += card.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - offset;
		requestAnimationFrame(() => {
			if (this.sentinelNear()) void this.renderMore();
			else if (this.topNear()) void this.renderAbove();
		});
	}

	private sentinelNear(): boolean {
		return this.sentinel.getBoundingClientRect().top < this.scroller.getBoundingClientRect().bottom + 600;
	}

	/**
	 * Cut the preview at a whole line (never mid-line), then mark the cut with
	 * an ellipsis, a fade, or nothing, per the user's setting. Runs after the card
	 * is in the page so lines can be measured.
	 */
	private fitContent(card: HTMLElement): void {
		const content = card.querySelector<HTMLElement>(".yarn-card-content");
		if (!content) return;
		const mode = this.host.overflow;
		const items = Array.from(content.children) as HTMLElement[];
		// Reset any previous fit (cards are reused across re-layouts).
		content.classList.remove("is-truncated", "mode-fade");
		content.querySelectorAll(".yarn-more").forEach((m) => m.remove());
		for (const it of items) {
			it.style.display = "";
			for (const t of [it, it.querySelector<HTMLElement>(".yarn-task-text")]) {
				if (!t) continue;
				t.classList.remove("is-clamped");
				t.style.removeProperty("-webkit-line-clamp");
				t.style.maxHeight = "";
			}
		}
		const lh = parseFloat(getComputedStyle(content).lineHeight) || 20;
		const limit = this.host.previewLines * lh;
		const top0 = content.getBoundingClientRect().top;
		let cut = content.dataset.more === "1";
		let last: HTMLElement | null = null;
		let clamped = false;
		for (const it of items) {
			if (clamped) {
				it.style.display = "none";
				continue;
			}
			const r = it.getBoundingClientRect();
			if (r.bottom - top0 <= limit + 1) {
				last = it;
				continue;
			}
			cut = true;
			clamped = true;
			const lines = Math.floor((limit - (r.top - top0)) / lh + 0.05);
			if (lines < 1) {
				it.style.display = "none";
				continue;
			}
			const target = it.querySelector<HTMLElement>(".yarn-task-text") ?? it;
			if (mode === "ellipsis") {
				target.classList.add("is-clamped");
				target.style.setProperty("-webkit-line-clamp", String(lines));
			} else {
				target.style.maxHeight = lines * lh + "px";
				target.style.overflow = "hidden";
				target.style.display = target === it ? "block" : "inline-block";
			}
			last = it;
		}
		if (!cut || !last) return;
		if (mode === "fade") {
			content.classList.add("is-truncated", "mode-fade");
			content.style.setProperty("--yarn-fade", Math.round(lh * 1.8) + "px");
		} else if (mode === "ellipsis" && !last.querySelector(".is-clamped") && !last.classList.contains("is-clamped")) {
			// Cut fell between paragraphs: end the last visible line with "…".
			const target = last.querySelector<HTMLElement>(".yarn-task-text") ?? last;
			const more = document.createElement("span");
			more.className = "yarn-more";
			more.textContent = " …";
			target.appendChild(more);
		}
	}

	private shortestColumn(cols: HTMLElement[]): HTMLElement {
		let best = cols[0];
		for (const c of cols) if (c.offsetHeight < best.offsetHeight) best = c;
		return best;
	}

	// ---------- cards ----------

	private renderCard(note: NoteRef, p: Preview): HTMLElement {
		const reuse = this.cards.get(note.id);
		if (reuse && reuse.mtime === note.mtime) {
			this.styleCard(reuse.el, note.id);
			return reuse.el;
		}
		const card = el("div", "yarn-card");
		card.addEventListener("animationend", () => card.classList.add("is-settled"), { once: true });
		this.cards.set(note.id, { mtime: note.mtime, el: card });
		card.dataset.id = note.id;
		card.tabIndex = 0;

		if (p.image) {
			const url = this.host.resolveImage(p.image, note.id);
			if (url) {
				const img = el("img", "yarn-card-image", card);
				img.loading = "lazy";
				img.decoding = "async";
				img.alt = "";
				img.src = url;
				img.addEventListener("error", () => img.remove());
				img.addEventListener("load", () => this.cardGrew(card));
			}
		}
		const body = el("div", "yarn-card-body", card);

		// Mouse/trackpad only (hidden by CSS on touch screens): colour + pin buttons. They float
		// in the top-right corner so the title (or first line) wraps around them, never under them.
		const tools = el("div", "yarn-card-tools", body);
		const palette = el("button", "yarn-card-tool yarn-card-palette", tools);
		palette.setAttribute("aria-label", "Colour and wallpaper");
		this.host.icon(palette, "palette");
		palette.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openSheet(note.id);
		});
		const pin = el("button", "yarn-card-tool yarn-card-pin", tools);
		pin.setAttribute("aria-label", "Pin / unpin");
		this.host.icon(pin, "pin");
		pin.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.togglePin(note.id);
		});
		for (const b of [pin, palette]) b.addEventListener("pointerdown", (e) => e.stopPropagation());

		const hideTitle = isPlaceholderTitle(note.title);
		if (!hideTitle) el("div", "yarn-card-title", body, note.title);
		if (p.lines.length) {
			const content = el("div", "yarn-card-content", body);
			for (const line of p.lines) {
				if (line.kind === "task") {
					const row = el("div", "yarn-line yarn-task" + (line.done ? " is-done" : ""), content);
					const box = el("span", "yarn-checkbox", row);
					if (line.done) this.host.icon(box, "check");
					el("span", "yarn-task-text", row, line.text);
				} else if (line.kind === "bullet") {
					el("div", "yarn-line yarn-bullet", content, line.text);
				} else if (line.kind === "heading") {
					el("div", "yarn-line yarn-heading", content, line.text);
				} else {
					el("div", "yarn-line yarn-text", content, line.text);
				}
			}
			if (p.truncated) content.dataset.more = "1";
		} else if (hideTitle && !p.image) {
			el("div", "yarn-card-empty", body, "Empty note");
		}

		this.renderTags(card, note.id);
		this.styleCard(card, note.id);
		this.bindCard(card, note.id);
		return card;
	}

	/** One line of tag chips at the bottom of the card; tapping one searches for it. */
	private renderTags(card: HTMLElement, id: string): void {
		card.querySelector(".yarn-card-tags")?.remove();
		const tags = this.host.getTags?.(id) ?? [];
		if (!tags.length) return;
		const body = card.querySelector<HTMLElement>(".yarn-card-body") ?? card;
		const row = el("div", "yarn-card-tags", body);
		for (const tag of tags) {
			const chip = el("button", "yarn-tag", row, this.host.tagLabel?.(tag) ?? tag);
			chip.title = "#" + tag;
			// Only long names give up space (and get "…"); short ones like "Stories" stay whole.
			if ((chip.textContent ?? "").length > 14) chip.classList.add("is-long");
			chip.addEventListener("pointerdown", (e) => e.stopPropagation());
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				this.search("#" + tag);
			});
		}
	}

	/** Under an empty, focused search bar: "Unlabelled" plus every tag, Keep-style. */
	private showSuggestions(): void {
		if (!this.host.getTags || this.input.value) return;
		const counts = new Map<string, { name: string; n: number }>();
		for (const note of this.all) {
			for (const t of this.host.getTags(note.id)) {
				const k = t.toLowerCase();
				const e = counts.get(k) ?? { name: t, n: 0 };
				e.n++;
				counts.set(k, e);
			}
		}
		this.suggest.replaceChildren();
		el("div", "yarn-suggest-label", this.suggest, "Labels");
		const row = el("div", "yarn-suggest-chips", this.suggest);
		const chip = (label: string, query: string, icon: string, n?: number) => {
			const b = el("button", "yarn-suggest-chip", row);
			this.host.icon(el("span", "yarn-suggest-icon", b), icon);
			el("span", "yarn-suggest-name", b, label);
			b.title = query;
			if (n !== undefined) el("span", "yarn-suggest-count", b, String(n));
			// Keep focus in the input until the click lands.
			b.addEventListener("pointerdown", (e) => e.preventDefault());
			b.addEventListener("click", () => {
				this.hideSuggestions();
				this.search(query);
				this.input.blur();
			});
		};
		const untagged = this.all.filter((n) => this.host.getTags!(n.id).length === 0).length;
		chip("Unlabelled", "#unlabelled", "tag", untagged);
		[...counts.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.forEach((t) => chip(this.host.tagLabel?.(t.name) ?? t.name, "#" + t.name, "tag", t.n));
		this.suggest.style.display = "";
	}

	private hideSuggestions(): void {
		this.suggest.style.display = "none";
	}

	/** Re-draw every card's tag chips (e.g. after label names change). */
	retag(): void {
		this.columnsEl.querySelectorAll<HTMLElement>(".yarn-card").forEach((c) => this.renderTags(c, c.dataset.id!));
	}

	/** Put text in the search bar and run it. */
	search(query: string): void {
		this.input.value = query;
		this.query = query;
		this.updateClear();
		this.scroller.scrollTop = 0;
		void this.applyFilter(BATCH);
	}

	private styleCard(card: HTMLElement, id: string): void {
		const style = this.styleOf(id);
		const dark = this.host.isDark();
		const color = resolveColor(style.color, dark);
		card.classList.toggle("has-color", !!color);
		card.classList.toggle("is-pinned", !!style.pinned);
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
			if (e.pointerType === "mouse") return; // mouse users right-click instead of long-pressing
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
			this.host.open(id, e.ctrlKey || e.metaKey);
		});
		// Middle-click opens in a new tab, like links.
		card.addEventListener("auxclick", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				this.host.open(id, true);
			}
		});
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.host.open(id);
		});
	}

	// ---------- colour / wallpaper sheet ----------

	openSheet(id: string): void {
		this.closeSheet();
		const note = this.all.find((n) => n.id === id);
		const overlay = el("div", "yarn-sheet-overlay", this.root);
		const panel = el("div", "yarn-sheet", overlay);
		el("div", "yarn-sheet-handle", panel);
		if (note) el("div", "yarn-sheet-title", panel, isPlaceholderTitle(note.title) ? "Untitled note" : note.title);

		const dark = this.host.isDark();
		const current = () => this.styleOf(id);

		el("div", "yarn-sheet-label", panel, "Colour");
		const colorRow = el("div", "yarn-swatch-row", panel);
		el("div", "yarn-sheet-label", panel, "Wallpaper");
		const wpRow = el("div", "yarn-swatch-row", panel);

		const paint = () => {
			const s = current();
			colorRow.querySelectorAll<HTMLElement>(".yarn-swatch").forEach((sw) => sw.classList.toggle("is-selected", (sw.dataset.value || "") === (s.color || "")));
			wpRow.querySelectorAll<HTMLElement>(".yarn-swatch").forEach((sw) => {
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

		const none = el("button", "yarn-swatch yarn-swatch-none", colorRow);
		none.dataset.value = "";
		none.setAttribute("aria-label", "Default");
		this.host.icon(none, "droplet-off");
		none.addEventListener("click", () => void apply({ color: undefined }));
		for (const c of COLORS) {
			const sw = el("button", "yarn-swatch", colorRow);
			sw.dataset.value = c.id;
			sw.setAttribute("aria-label", c.label);
			sw.style.backgroundColor = dark ? c.dark : c.light;
			el("span", "yarn-swatch-check", sw);
			sw.addEventListener("click", () => void apply({ color: c.id }));
		}

		const wpNone = el("button", "yarn-swatch yarn-swatch-wp yarn-swatch-none", wpRow);
		wpNone.dataset.value = "";
		wpNone.setAttribute("aria-label", "No wallpaper");
		this.host.icon(wpNone, "image-off");
		wpNone.addEventListener("click", () => void apply({ wallpaper: undefined }));
		const base = resolveColor(current().color, dark);
		for (const w of WALLPAPERS) {
			const sw = el("button", "yarn-swatch yarn-swatch-wp", wpRow);
			sw.dataset.value = w.id;
			sw.setAttribute("aria-label", w.label);
			const css = w.css(dark);
			sw.style.backgroundColor = base ?? "";
			sw.style.backgroundImage = css.image;
			sw.style.backgroundSize = css.repeat === "repeat" ? css.size : "cover";
			sw.style.backgroundPosition = css.repeat === "repeat" ? css.position : "bottom center";
			sw.style.backgroundRepeat = css.repeat;
			el("span", "yarn-swatch-check", sw);
			sw.addEventListener("click", () => void apply({ wallpaper: w.id }));
		}
		if (this.host.pickImage) {
			const pick = el("button", "yarn-swatch yarn-swatch-wp yarn-swatch-image", wpRow);
			pick.dataset.value = "__image";
			pick.setAttribute("aria-label", "Image from vault");
			this.host.icon(pick, "image-plus");
			el("span", "yarn-swatch-check", pick);
			pick.addEventListener("click", async () => {
				const v = await this.host.pickImage!();
				if (v) await apply({ wallpaper: v });
			});
		}

		const actions = el("div", "yarn-sheet-actions", panel);
		const pinned = !!current().pinned;
		const pinBtn = el("button", "yarn-sheet-action", actions);
		this.host.icon(el("span", "yarn-sheet-action-icon", pinBtn), pinned ? "pin-off" : "pin");
		el("span", "", pinBtn, pinned ? "Unpin" : "Pin");
		pinBtn.addEventListener("click", () => {
			this.closeSheet();
			void this.togglePin(id);
		});
		const del = el("button", "yarn-sheet-action mod-warning", actions);
		this.host.icon(el("span", "yarn-sheet-action-icon", del), "trash-2");
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
		overlay.tabIndex = -1;
		overlay.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				this.closeSheet();
			}
		});
		requestAnimationFrame(() => {
			overlay.classList.add("is-open");
			overlay.focus({ preventScroll: true });
		});
		this.sheet = overlay;
	}

	private async togglePin(id: string): Promise<void> {
		const pinned = !this.styleOf(id).pinned;
		this.pendingStyle.set(id, { ...this.pendingStyle.get(id), pinned });
		await this.refresh();
		await this.host.setStyle(id, { pinned });
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
