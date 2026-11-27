import {
	App,
	FuzzySuggestModal,
	ItemView,
	MarkdownView,
	Notice,
	Platform,
	addIcon,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	debounce,
	getAllTags,
	MarkdownPostProcessorContext,
	normalizePath,
	setIcon,
} from "obsidian";
import { Board, BoardHost, BoardState, NoteRef, NoteStyle } from "./board";
import { FAB_PRESETS } from "./palette";
import { buildPreview, isPlaceholderTitle } from "./preview";
import { WEAVE_SKINS, Weave, WeaveHost, WeaveUi } from "./weave";
import { WeaveModel, allItems, extractLinks, findBlock, parseWeave, reconcile, replaceBlock, seedWeave, serializeWeave } from "./weavemodel";

export const VIEW_TYPE = "yarn-view";
export const WEAVE_VIEW = "yarn-weave";
const WEAVE_ICON = "waypoints";
const COLOR_KEY = "card-color";
const WALLPAPER_KEY = "card-wallpaper";
const PINNED_KEY = "card-pinned";
const CHROME_CLASS = "yarn-chrome-hidden";
const ICON = "yarn-ball";
/** A little ball of yarn with a loose thread (drawn on Obsidian's 100×100 icon grid). */
const ICON_SVG =
	'<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
	'<circle cx="55" cy="45" r="34"/>' +
	// three long wraps sweeping across the ball
	'<path d="M33 19 Q 50 50 88 53"/><path d="M24 31 Q 42 60 84 63"/><path d="M21 44 Q 36 68 76 72"/>' +
	// shorter wraps crossing behind them
	'<path d="M57 11 Q 56 26 45 35"/><path d="M73 16 Q 70 33 55 43"/><path d="M84.5 28 Q 80 42 67 48.7"/>' +
	// the loose end, curling away
	'<path d="M27 65 C 15 65 9 74 12 81 C 15 88 24 88 36 88"/></g>';
/** Google Keep colour names (as written by the Keep importer) → Yarn palette. */
const KEEP_COLORS: Record<string, string> = {
	red: "coral",
	orange: "peach",
	yellow: "sand",
	green: "mint",
	teal: "sage",
	blue: "fog",
	darkblue: "storm",
	cerulean: "storm",
	purple: "dusk",
	pink: "blossom",
	brown: "clay",
	gray: "chalk",
	grey: "chalk",
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

interface YarnSettings {
	openOnStartup: boolean;
	folder: string;
	exclude: string;
	sort: "modified" | "created" | "name";
	previewLines: number;
	scrubber: boolean;
	overflow: "ellipsis" | "fade" | "none";
	chipOverflow: "fade" | "ellipsis";
	layout: "grid" | "list";
	fabColor: string;
	/** Lines of "tag = Display name". */
	tagNames: string;
	hideChrome: boolean;
	cardFont: "system" | "obsidian";
	weave: WeaveUi;
	/** Per note path: which scenes are folded and which loose strips are minimized. */
	weaveFlags: Record<string, Record<string, boolean>>;
}

const DEFAULTS: YarnSettings = {
	openOnStartup: true,
	folder: "",
	exclude: "",
	sort: "modified",
	previewLines: 10,
	scrubber: true,
	overflow: "ellipsis",
	chipOverflow: "fade",
	layout: "grid",
	fabColor: "",
	tagNames: "",
	hideChrome: false,
	cardFont: "system",
	weave: { skin: "yarn", density: "peek", loosePos: "bottom", looseDefaultMin: false, defLeft: "Keep in mind", defThread: "Thread", defRight: "Texture" },
	weaveFlags: {},
};


export default class YarnPlugin extends Plugin {
	settings!: YarnSettings;
	/** Last board state, used as a fallback when the view is re-created. */
	lastState: BoardState = {};

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.settings.weave = Object.assign({}, DEFAULTS.weave, this.settings.weave);
		this.settings.weaveFlags = this.settings.weaveFlags ?? {};

		this.registerView(VIEW_TYPE, (leaf) => new YarnView(leaf, this));
		addIcon(ICON, ICON_SVG);
		this.addRibbonIcon(ICON, "Open Yarn", () => void this.activate(true));
		this.addCommand({ id: "open", name: "Open board", callback: () => void this.activate(true) });
		this.addCommand({ id: "new-note", name: "New note", callback: () => void this.createNote() });
		this.addCommand({
			id: "search",
			name: "Search notes",
			callback: async () => {
				const view = await this.activate(true);
				view?.board?.focusSearch();
			},
		});
		this.addSettingTab(new YarnSettingTab(this.app, this));

		// Weaves: arrange the notes a note links to.
		this.registerView(WEAVE_VIEW, (leaf) => new WeaveView(leaf, this));
		this.addCommand({
			id: "weave-note",
			name: "Weave this note",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.openWeave(f);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, f) => {
				if (f instanceof TFile && f.extension === "md") menu.addItem((i) => i.setTitle("Open as weave").setIcon(WEAVE_ICON).onClick(() => void this.openWeave(f)));
			}),
		);
		this.registerMarkdownCodeBlockProcessor("weave", (src, elm, ctx) => this.renderWeaveEmbed(src, elm, ctx));
		this.addCommand({
			id: "copy-layout-report",
			name: "Copy layout report (for troubleshooting)",
			callback: async () => {
				await navigator.clipboard.writeText(this.layoutReport());
				new Notice("Yarn layout report copied");
			},
		});

		const refresh = debounce(() => this.forEachView((v) => void v.board?.refresh()), 400, true);
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", refresh));
			this.registerEvent(this.app.vault.on("delete", refresh));
			this.registerEvent(this.app.vault.on("rename", refresh));
			this.registerEvent(this.app.vault.on("modify", refresh));
			const weaveTexts = debounce(() => this.forEachWeave((v) => v.weave?.refreshTexts()), 1500, true);
			this.registerEvent(
				this.app.vault.on("modify", (f) => {
					let own = false;
					this.forEachWeave((v) => {
						if (v.file === f) {
							own = true;
							v.sourceChanged();
						}
					});
					if (!own) weaveTexts();
				}),
			);
			this.registerEvent(this.app.vault.on("delete", (f) => this.forEachWeave((v) => v.file === f && v.leaf.detach())));
			this.registerEvent(this.app.vault.on("rename", (f, old) => this.forEachWeave((v) => v.file === f && v.renamed(old))));
			this.registerEvent(this.app.workspace.on("css-change", () => this.forEachWeave((v) => v.weave?.restyle())));
			this.registerEvent(this.app.metadataCache.on("changed", (file) => this.forEachView((v) => v.board?.styleChanged(file.path))));
			this.registerEvent(this.app.workspace.on("css-change", () => this.forEachView((v) => v.board?.restyle())));
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateChrome()));
			this.registerEvent(this.app.workspace.on("layout-change", () => this.updateChrome()));
			if (this.settings.openOnStartup) void this.activate(false);
		});
	}

	onunload(): void {
		this.reclaimTopSpace(null);
		document.body.classList.remove(CHROME_CLASS, "yarn-system-font");
	}

	/** Hide Obsidian's header and bottom bar only while a Yarn board is the active tab. */
	updateChrome(): void {
		const active = this.app.workspace.getActiveViewOfType(YarnView);
		const hide = !!active && this.settings.hideChrome;
		document.body.classList.toggle(CHROME_CLASS, hide);
		document.body.classList.toggle("yarn-system-font", this.settings.cardFont === "system");
		this.reclaimTopSpace(hide ? active : null);
		this.forEachView((v) => v.board?.updateInsets());
	}

	private sidebarsWereOpen: { left: boolean; right: boolean } | null = null;

	/** Desktop "focus" mode: tuck both sidebars away, and bring back the ones that were open. */
	toggleSidebars(hide: boolean): void {
		const { leftSplit, rightSplit } = this.app.workspace;
		if (hide) {
			this.sidebarsWereOpen = { left: !leftSplit.collapsed, right: !rightSplit.collapsed };
			leftSplit.collapse();
			rightSplit.collapse();
		} else if (this.sidebarsWereOpen) {
			if (this.sidebarsWereOpen.left) leftSplit.expand();
			if (this.sidebarsWereOpen.right) rightSplit.expand();
			this.sidebarsWereOpen = null;
		}
	}

	private reclaimed: Array<{ el: HTMLElement; padding: string; margin: string }> = [];

	/**
	 * Obsidian's mobile layout reserves room above each tab for its floating header.
	 * With the header hidden, that room is empty, so zero the top padding/margin of
	 * the board's ancestors (restored as soon as the toolbars come back), then add
	 * back just the phone's status-bar inset ourselves.
	 */
	private reclaimTopSpace(view: YarnView | null): void {
		for (const r of this.reclaimed) {
			r.el.style.paddingTop = r.padding;
			r.el.style.marginTop = r.margin;
		}
		this.reclaimed = [];
		document.body.style.removeProperty("--yarn-safe-top");
		// Desktop has no reserved header space (and the window title bar must stay put).
		if (!view || !Platform.isMobile) return;
		let e: HTMLElement | null = view.contentEl;
		while (e && e !== document.body) {
			const cs = getComputedStyle(e);
			if (parseFloat(cs.paddingTop) > 0 || parseFloat(cs.marginTop) > 0) {
				this.reclaimed.push({ el: e, padding: e.style.paddingTop, margin: e.style.marginTop });
				e.style.setProperty("padding-top", "0px", "important");
				e.style.setProperty("margin-top", "0px", "important");
			}
			e = e.parentElement;
		}
		// Measure the status-bar inset (0 when the app doesn't draw under it).
		const probe = document.body.createDiv();
		probe.style.cssText = "position:fixed;visibility:hidden;top:0;padding-top:max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px));";
		const inset = probe.getBoundingClientRect().height;
		probe.remove();
		// Whatever still sits above the board (and isn't status bar) gets no extra padding.
		const top = view.contentEl.getBoundingClientRect().top;
		document.body.style.setProperty("--yarn-safe-top", Math.max(0, inset - top) + "px");
	}

	/** Snapshot of the layout around the board, for troubleshooting on a device. */
	layoutReport(): string {
		const view = this.app.workspace.getActiveViewOfType(YarnView) ?? this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
		const lines = [`Yarn ${this.manifest.version} · Obsidian ${(this.app as unknown as { appVersion?: string }).appVersion ?? "?"} · ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`];
		lines.push(`toolbars hidden: ${document.body.classList.contains(CHROME_CLASS)}`);
		let e: HTMLElement | null = view instanceof YarnView ? view.contentEl : null;
		while (e && e !== document.documentElement) {
			const cs = getComputedStyle(e);
			const r = e.getBoundingClientRect();
			lines.push(`${e.tagName.toLowerCase()}.${[...e.classList].join(".")} top=${Math.round(r.top)} h=${Math.round(r.height)} pad=${cs.paddingTop} mar=${cs.marginTop} pos=${cs.position}`);
			e = e.parentElement;
		}
		const header = document.querySelector(".workspace-leaf.mod-active .view-header");
		if (header) lines.push(`view-header display=${getComputedStyle(header).display} h=${Math.round(header.getBoundingClientRect().height)}`);
		return lines.join("\n");
	}

	/** Height of Obsidian's floating mobile bottom bar, if it is showing. */
	bottomInset(): number {
		const nav = document.querySelector<HTMLElement>(".mobile-navbar");
		if (!nav || document.body.classList.contains(CHROME_CLASS) || getComputedStyle(nav).display === "none") return 0;
		const r = nav.getBoundingClientRect();
		if (r.height === 0) return 0;
		// While Obsidian slides the bar away on scroll, fall back to its own height.
		return r.top < window.innerHeight ? window.innerHeight - r.top : r.height + 12;
	}

	forEachView(fn: (v: YarnView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof YarnView) fn(leaf.view);
		}
	}

	forEachWeave(fn: (v: WeaveView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(WEAVE_VIEW)) {
			if (leaf.view instanceof WeaveView) fn(leaf.view);
		}
	}

	/** Open the weave of a note: on a phone in place of the note (Back returns to it), on desktop in a new tab. */
	async openWeave(file: TFile): Promise<void> {
		const ws = this.app.workspace;
		let leaf: WorkspaceLeaf | null = null;
		this.forEachWeave((v) => {
			if (v.file === file) leaf = v.leaf;
		});
		if (!leaf) {
			leaf = Platform.isMobile ? ws.getLeaf(false) : ws.getLeaf("tab");
			await leaf.setViewState({ type: WEAVE_VIEW, active: true, state: { file: file.path } });
		}
		await ws.revealLeaf(leaf);
		ws.setActiveLeaf(leaf, { focus: true });
	}

	/** What a ```weave block shows inside its note: a card that opens the board. */
	private renderWeaveEmbed(src: string, elm: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const model = parseWeave(src, { left: "", thread: "", right: "" });
		const notes = allItems(model).length;
		const card = elm.createDiv({ cls: "yarn-weave-embed" });
		setIcon(card.createDiv({ cls: "yarn-weave-embed-icon" }), WEAVE_ICON);
		const text = card.createDiv();
		text.createDiv({ cls: "yarn-weave-embed-title", text: "Open weave" });
		text.createDiv({
			cls: "yarn-weave-embed-sub",
			text: src.trim() ? `${notes} note${notes === 1 ? "" : "s"} in ${model.scenes.length} scene${model.scenes.length === 1 ? "" : "s"}` : "Arranges the notes this note links to",
		});
		card.addEventListener("click", () => {
			const f = this.file(ctx.sourcePath);
			if (f) void this.openWeave(f);
		});
	}

	/** Show the board: reuse an existing one, else take over the current tab (Back returns to what was there). */
	async activate(focus: boolean): Promise<YarnView | null> {
		const ws = this.app.workspace;
		let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			// Phone: take over the current tab (Back returns to it). Desktop: never replace an
			// open note; reuse an empty tab or open a new one.
			const recent = ws.getMostRecentLeaf();
			leaf = Platform.isMobile ? ws.getLeaf(false) : recent && recent.view.getViewType() === "empty" ? recent : ws.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await ws.revealLeaf(leaf);
		if (focus) ws.setActiveLeaf(leaf, { focus: true });
		return leaf.view instanceof YarnView ? leaf.view : null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---------- notes ----------

	listNotes(): NoteRef[] {
		const folder = normalizePath(this.settings.folder.trim() || "/");
		const exclude = this.settings.exclude
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => normalizePath(s) + "/");
		const configDir = this.app.vault.configDir + "/";
		const files = this.app.vault.getMarkdownFiles().filter((f) => {
			if (folder !== "/" && !f.path.startsWith(folder + "/")) return false;
			if (f.path.startsWith(configDir)) return false;
			return !exclude.some((e) => f.path.startsWith(e));
		});
		const s = this.settings.sort;
		files.sort((a, b) =>
			s === "name" ? a.basename.localeCompare(b.basename) : s === "created" ? b.stat.ctime - a.stat.ctime : b.stat.mtime - a.stat.mtime,
		);
		return files.map((f) => ({ id: f.path, title: f.basename, mtime: f.stat.mtime, date: s === "created" ? f.stat.ctime : f.stat.mtime }));
	}

	file(id: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(id);
		return f instanceof TFile ? f : null;
	}

	/** All tags on a note exactly as Obsidian sees them, without "#". */
	private rawTags(id: string): string[] {
		const f = this.file(id);
		const cache = f ? this.app.metadataCache.getFileCache(f) : null;
		return ((cache && getAllTags(cache)) ?? []).map((t) => t.replace(/^#/, "")).filter(Boolean);
	}

	/**
	 * Tags to show on the card. The Google Keep importer writes labels as "Keep/Label/Traits"
	 * (shown as "Traits", sub-labels as "Traits/sub") and stores pins/colours as tags like
	 * "Keep/Pinned" and "Keep/Color/Green"; those become Yarn pins/colours instead of chips.
	 */
	private tagNameCache: { src: string; map: Array<[string, string]> } | null = null;

	/**
	 * Display name for a tag, from the "Label names" setting. The longest matching
	 * prefix wins, so "Stories/lalkaomilad/Dates" shows as "A Portrait of Lalka by Milād/Dates".
	 */
	tagLabel(tag: string): string {
		const src = this.settings.tagNames;
		if (!this.tagNameCache || this.tagNameCache.src !== src) {
			const map: Array<[string, string]> = [];
			for (const line of src.split(/\r?\n/)) {
				const i = line.indexOf("=");
				if (i < 0) continue;
				const key = line.slice(0, i).trim().replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
				const name = line.slice(i + 1).trim();
				if (key && name) map.push([key, name]);
			}
			map.sort((a, b) => b[0].length - a[0].length);
			this.tagNameCache = { src, map };
		}
		const lower = tag.toLowerCase();
		for (const [key, name] of this.tagNameCache.map) {
			if (lower === key) return name;
			if (lower.startsWith(key + "/")) return name + tag.slice(key.length);
		}
		return tag;
	}

	getTags(id: string): string[] {
		const seen = new Map<string, string>();
		for (const raw of this.rawTags(id)) {
			let tag = raw;
			const label = /^keep\/label\/(.+)$/i.exec(raw);
			if (label) tag = label[1];
			else if (/^keep(\/|$)/i.test(raw)) continue;
			if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
		}
		return [...seen.values()];
	}

	/** Pin/colour carried over from Google Keep import tags, if any. */
	private keepImport(id: string): { pinned: boolean; color?: string } {
		let pinned = false;
		let color: string | undefined;
		for (const raw of this.rawTags(id)) {
			if (/^keep\/pinned$/i.test(raw)) pinned = true;
			const c = /^keep\/colou?r\/(.+)$/i.exec(raw);
			if (c) color = KEEP_COLORS[c[1].toLowerCase().replace(/[^a-z]/g, "")];
		}
		return { pinned, color };
	}

	getStyle(id: string): NoteStyle {
		const f = this.file(id);
		const fm = f ? this.app.metadataCache.getFileCache(f)?.frontmatter : undefined;
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const keep = this.keepImport(id);
		// Yarn's own properties win; otherwise fall back to what Keep had.
		const pin = fm?.[PINNED_KEY];
		const pinned = pin === undefined || pin === null ? keep.pinned : pin === true || pin === "true";
		const ownColor = str(fm?.[COLOR_KEY]);
		const color = ownColor === "none" ? undefined : ownColor ?? keep.color;
		return { color, wallpaper: str(fm?.[WALLPAPER_KEY]), pinned };
	}

	async setStyle(id: string, patch: NoteStyle): Promise<void> {
		const f = this.file(id);
		if (!f) return;
		const set = (fm: Record<string, unknown>, key: string, v: string | undefined) => {
			if (v) fm[key] = v;
			else delete fm[key];
		};
		// Clearing a colour or pin that came from Keep needs an explicit "off" to override the tag.
		const keep = this.keepImport(id);
		// Keep the original modified time so colouring a note doesn't bump it to the top.
		await this.app.fileManager.processFrontMatter(
			f,
			(fm) => {
				if ("color" in patch) set(fm, COLOR_KEY, patch.color ?? (keep.color ? "none" : undefined));
				if ("wallpaper" in patch) set(fm, WALLPAPER_KEY, patch.wallpaper);
				if ("pinned" in patch) {
					if (patch.pinned) fm[PINNED_KEY] = true;
					else if (keep.pinned) fm[PINNED_KEY] = false;
					else delete fm[PINNED_KEY];
				}
			},
			{ mtime: f.stat.mtime },
		);
	}

	resolveImage(link: string, sourceId: string): string | null {
		// Only vault files: never fetch remote images.
		if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return null;
		let path = link;
		try {
			path = decodeURIComponent(link);
		} catch {
			/* not URL-encoded, e.g. "50% off.png" */
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(path, sourceId);
		return dest && IMAGE_EXT.has(dest.extension.toLowerCase()) ? this.app.vault.getResourcePath(dest) : null;
	}

	async createNote(leaf?: WorkspaceLeaf): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		const parent = this.app.fileManager.getNewFileParent(active?.path ?? "");
		const dir = parent.isRoot() ? "" : parent.path + "/";
		let path = normalizePath(`${dir}Untitled.md`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}Untitled ${i}.md`);
		const file = await this.app.vault.create(path, "");
		const target = leaf ?? this.app.workspace.getLeaf(false);
		await target.openFile(file, { active: true, state: { mode: "source" } });
		const view = target.view;
		if (view instanceof MarkdownView) view.editor.focus();
	}
}

class YarnView extends ItemView {
	plugin: YarnPlugin;
	board: Board | null = null;
	private pending: BoardState | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: YarnPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Yarn";
	}
	getIcon(): string {
		return ICON;
	}

	getState(): Record<string, unknown> {
		const s: BoardState = this.board ? this.board.state : this.plugin.lastState;
		return { ...super.getState(), ...s };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as BoardState;
		if (this.board) await this.board.restore(s);
		else this.pending = s;
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const p = this.plugin;
		const host: BoardHost = {
			listNotes: () => p.listNotes(),
			read: async (id) => {
				const f = p.file(id);
				return f ? this.app.vault.cachedRead(f) : "";
			},
			getStyle: (id) => p.getStyle(id),
			getTags: (id) => p.getTags(id),
			tagLabel: (tag) => p.tagLabel(tag),
			setStyle: (id, patch) => p.setStyle(id, patch),
			resolveImage: (link, src) => p.resolveImage(link, src),
			open: (id, newTab) => {
				const f = p.file(id);
				if (!f) return;
				const target = newTab ? this.app.workspace.getLeaf("tab") : this.leaf;
				void target.openFile(f, { active: true });
			},
			create: () => void p.createNote(this.leaf),
			remove: async (id) => {
				const f = p.file(id);
				if (!f) return;
				await this.app.fileManager.trashFile(f);
				new Notice(`Deleted “${f.basename}”`);
			},
			pickImage: () => new ImagePicker(this.app).pick(),
			isDark: () => document.body.classList.contains("theme-dark"),
			icon: (el, name) => setIcon(el, name),
			get previewLines() {
				return p.settings.previewLines;
			},
			get chipOverflow() {
				return p.settings.chipOverflow;
			},
			get overflow() {
				return p.settings.overflow;
			},
			get layout() {
				return p.settings.layout;
			},
			get sortKind() {
				return p.settings.sort === "name" ? ("name" as const) : ("date" as const);
			},
			get scrubber() {
				return p.settings.scrubber;
			},
			get fabColor() {
				return p.settings.fabColor;
			},
			get chromeHidden() {
				return p.settings.hideChrome;
			},
			setChromeHidden: (hidden) => {
				p.settings.hideChrome = hidden;
				if (!Platform.isMobile) p.toggleSidebars(hidden);
				void p.saveSettings();
				p.updateChrome();
			},
			bottomInset: () => p.bottomInset(),
			setLayout: (layout) => {
				p.settings.layout = layout;
				void p.saveSettings();
			},
		};
		this.contentEl.empty();
		this.board = new Board(this.contentEl, host);
		p.updateChrome();
		await this.board.restore(this.pending ?? p.lastState);
		this.pending = null;
		// Android back button closes the colour sheet first.
		this.scope?.register([], "Escape", () => {
			if (this.board?.sheetOpen) {
				this.board.closeSheet();
				return false;
			}
			return true;
		});
	}

	async onClose(): Promise<void> {
		if (this.board) {
			this.plugin.lastState = this.board.state;
			this.board.destroy();
			this.board = null;
		}
		this.plugin.updateChrome();
	}
}

/** The board for one note's weave. The arrangement is kept in a ```weave block inside that note. */
class WeaveView extends ItemView {
	plugin: YarnPlugin;
	weave: Weave | null = null;
	file: TFile | null = null;
	navigation = true;
	/** What we last wrote to (or read from) the block, to tell our own saves from outside edits. */
	private lastBody = "";
	private saveTimer = 0;
	private pendingModel: WeaveModel | null = null;
	private reloadTimer = 0;

	constructor(leaf: WorkspaceLeaf, plugin: YarnPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return WEAVE_VIEW;
	}
	getDisplayText(): string {
		return this.file ? "Weave: " + this.file.basename : "Weave";
	}
	getIcon(): string {
		return WEAVE_ICON;
	}
	getState(): Record<string, unknown> {
		return { ...super.getState(), file: this.file?.path };
	}
	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const path = (state as { file?: string } | null)?.file;
		const f = path ? this.plugin.file(path) : null;
		if (f && f !== this.file) {
			await this.flush();
			this.file = f;
			await this.loadWeave();
		}
		await super.setState(state, result);
	}
	async onClose(): Promise<void> {
		await this.flush();
		window.clearTimeout(this.reloadTimer);
		this.weave?.destroy();
		this.weave = null;
	}

	private get defaults() {
		const w = this.plugin.settings.weave;
		return { left: w.defLeft, thread: w.defThread, right: w.defRight };
	}
	private dest(link: string): TFile | null {
		return this.file ? this.app.metadataCache.getFirstLinkpathDest(link, this.file.path) : null;
	}
	/** Two links are the same note if they resolve to the same file. */
	private keyOf = (link: string): string => this.dest(link)?.path ?? "?" + link.toLowerCase();

	/** Read the note and bring its weave in step with its links. Returns the model and whether the block needs rewriting. */
	private read(text: string): { model: WeaveModel; dirty: boolean } {
		// only notes can be woven: links to images, PDFs and the like are left out
		const links = extractLinks(text).filter((l) => {
			const d = this.dest(l.link);
			return !d || d.extension === "md";
		});
		const block = findBlock(text);
		if (!block || !block.body.trim()) return { model: seedWeave(text, links, this.keyOf, this.defaults), dirty: true };
		const model = parseWeave(block.body, this.defaults);
		const dirty = reconcile(model, links, this.keyOf);
		this.lastBody = block.body;
		return { model, dirty };
	}

	private async loadWeave(): Promise<void> {
		const file = this.file;
		if (!file) return;
		const p = this.plugin;
		const { model, dirty } = this.read(await this.app.vault.read(file));
		const host: WeaveHost = {
			title: file.basename,
			info: (link) => {
				const d = this.dest(link);
				const name = d ? d.basename : link.split("/").pop() || link;
				return { title: d && isPlaceholderTitle(name) ? "" : name, missing: !d };
			},
			read: async (link) => {
				const d = this.dest(link);
				if (!d) return "";
				const pv = buildPreview(await this.app.vault.cachedRead(d), d.basename, 12);
				return pv.lines.map((l) => (l.kind === "bullet" ? "• " : l.kind === "task" ? (l.done ? "☑ " : "☐ ") : "") + l.text).join("\n") + (pv.truncated ? " …" : "");
			},
			open: (link) => void this.app.workspace.openLinkText(link, file.path, !Platform.isMobile),
			openSource: () => void this.app.workspace.getLeaf(Platform.isMobile ? false : "tab").openFile(file, { active: true }),
			save: (m) => this.queueSave(m),
			ui: p.settings.weave,
			flags: (p.settings.weaveFlags[file.path] = p.settings.weaveFlags[file.path] ?? {}),
			saveUi: () => void p.saveSettings(),
			isDark: () => document.body.classList.contains("theme-dark"),
		};
		this.weave?.destroy();
		this.contentEl.empty();
		this.weave = new Weave(this.contentEl, host, model);
		this.weave.setBottomInset(p.bottomInset());
		if (dirty) this.queueSave(model);
		// refresh the tab title
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private queueSave(model: WeaveModel): void {
		this.pendingModel = model;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flush(), 400);
	}
	private async flush(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		const model = this.pendingModel, file = this.file;
		this.pendingModel = null;
		if (!model || !file) return;
		const body = serializeWeave(model);
		if (body === this.lastBody) return;
		this.lastBody = body;
		await this.app.vault.process(file, (text) => replaceBlock(text, body));
	}

	/** The note was modified: by us (ignored), or by the user or a sync (links may have come or gone). */
	sourceChanged(): void {
		window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => void this.reload(), 500);
	}
	private async reload(): Promise<void> {
		const file = this.file, weave = this.weave;
		if (!file || !weave) return;
		if (weave.busy || this.pendingModel) return this.sourceChanged();
		const before = serializeWeave(weave.model);
		const { model, dirty } = this.read(await this.app.vault.read(file));
		if (serializeWeave(model) === before) return;
		weave.setModel(model);
		if (dirty) this.queueSave(model);
	}
	renamed(oldPath: string): void {
		const flags = this.plugin.settings.weaveFlags;
		if (this.file && flags[oldPath]) {
			flags[this.file.path] = flags[oldPath];
			delete flags[oldPath];
			void this.plugin.saveSettings();
		}
		void this.loadWeave();
	}
}

class ImagePicker extends FuzzySuggestModal<TFile> {
	private resolve: (v: string | null) => void = () => {};
	private chosen = false;

	constructor(app: App) {
		super(app);
		this.setPlaceholder("Pick an image from your vault");
	}
	pick(): Promise<string | null> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXT.has(f.extension.toLowerCase()));
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		this.chosen = true;
		this.resolve(`[[${item.path}]]`);
	}
	onClose(): void {
		super.onClose();
		// onChooseItem fires after close on some versions; wait a tick before reporting "cancelled".
		window.setTimeout(() => {
			if (!this.chosen) this.resolve(null);
		}, 50);
	}
}

class YarnSettingTab extends PluginSettingTab {
	plugin: YarnPlugin;
	constructor(app: App, plugin: YarnPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = async (refresh = true) => {
			await this.plugin.saveSettings();
			if (refresh)
				this.plugin.forEachView((v) => {
					v.board?.clearCache();
					void v.board?.refresh();
				});
		};

		new Setting(containerEl)
			.setName("Open on startup")
			.setDesc("Show the board when Obsidian starts, instead of the usual landing page.")
			.addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => ((s.openOnStartup = v), await save(false))));

		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Only show notes inside this folder. Leave empty for the whole vault. New notes still follow Obsidian's “Default location for new notes”.")
			.addText((t) => t.setPlaceholder("e.g. Notes").setValue(s.folder).onChange(async (v) => ((s.folder = v), await save())));

		new Setting(containerEl)
			.setName("Label names")
			.setDesc("Show a short tag under a longer name on cards and in the label list, one per line: Stories/lalkaomilad = A Portrait of Lalka by Milād. Searching still uses the tag itself, and sub-tags carry the name, e.g. Stories/lalkaomilad/Dates.")
			.addTextArea((t) => {
				t.setPlaceholder("Stories/lalkaomilad = A Portrait of Lalka by Milād")
					.setValue(s.tagNames)
					.onChange(async (v) => {
						s.tagNames = v;
						await save(false);
						this.plugin.forEachView((view) => view.board?.retag());
					});
				t.inputEl.rows = 4;
				t.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma-separated folders to hide, e.g. Templates, Archive.")
			.addTextArea((t) => t.setValue(s.exclude).onChange(async (v) => ((s.exclude = v), await save())));

		new Setting(containerEl)
			.setName("Hide Obsidian toolbars")
			.setDesc("While the board is open, hide Obsidian's top header and bottom bar. You can also toggle this from the button in the search bar.")
			.addToggle((t) =>
				t.setValue(s.hideChrome).onChange(async (v) => {
					s.hideChrome = v;
					await save(false);
					this.plugin.updateChrome();
				}),
			);

		new Setting(containerEl)
			.setName("Card font")
			.setDesc("Your phone's system font (airier, like most note apps) or Obsidian's interface font.")
			.addDropdown((d) =>
				d
					.addOptions({ system: "System font", obsidian: "Obsidian font" })
					.setValue(s.cardFont)
					.onChange(async (v) => {
						s.cardFont = v as YarnSettings["cardFont"];
						await save(false);
						this.plugin.updateChrome();
					}),
			);

		new Setting(containerEl).setName("Sort by").addDropdown((d) =>
			d
				.addOptions({ modified: "Last edited", created: "Created", name: "Name" })
				.setValue(s.sort)
				.onChange(async (v) => ((s.sort = v as YarnSettings["sort"]), await save())),
		);

		new Setting(containerEl)
			.setName("Preview lines")
			.setDesc("How many lines of each note to show on its card.")
			.addSlider((sl) =>
				sl
					.setLimits(2, 20, 1)
					.setValue(s.previewLines)
					.setDynamicTooltip()
					.onChange(async (v) => ((s.previewLines = v), await save())),
			);

		new Setting(containerEl)
			.setName("Date scrubber")
			.setDesc("A handle on the right edge appears while you scroll. Drag it to jump through your notes by month (or by letter when sorted by name).")
			.addToggle((t) =>
				t.setValue(s.scrubber).onChange(async (v) => {
					s.scrubber = v;
					await save(false);
					this.plugin.forEachView((view) => view.board?.updateScrubber());
				}),
			);

		new Setting(containerEl)
			.setName("Long label chips")
			.setDesc("How a label that is too long for its card ends.")
			.addDropdown((d) =>
				d
					.addOptions({ fade: "Fade out", ellipsis: "Three dots …" })
					.setValue(s.chipOverflow)
					.onChange(async (v) => {
						s.chipOverflow = v as YarnSettings["chipOverflow"];
						await save(false);
						this.plugin.forEachView((view) => view.board?.retag());
					}),
			);

		new Setting(containerEl)
			.setName("Long note indicator")
			.setDesc("How a card shows that its note continues past the preview.")
			.addDropdown((d) =>
				d
					.addOptions({ ellipsis: "Three dots …", fade: "Fade out", none: "None" })
					.setValue(s.overflow)
					.onChange(async (v) => ((s.overflow = v as YarnSettings["overflow"]), await save())),
			);

		const fabSetting = new Setting(containerEl)
			.setName("+ button colour")
			.setDesc("Pick a preset, or choose any colour with the picker.");
		const swatches = fabSetting.controlEl.createDiv({ cls: "yarn-fab-presets" });
		let picker: { setValue(v: string): unknown } | null = null;
		const setFab = async (color: string) => {
			s.fabColor = color;
			paintPresets();
			if (color) picker?.setValue(color);
			await this.plugin.saveSettings();
			this.plugin.forEachView((v) => v.board?.applyFabColor());
		};
		const paintPresets = () =>
			swatches.querySelectorAll<HTMLElement>(".yarn-fab-preset").forEach((b) =>
				b.toggleClass("is-selected", (b.dataset.color || "").toLowerCase() === s.fabColor.toLowerCase()),
			);
		for (const preset of FAB_PRESETS) {
			const b = swatches.createEl("button", { cls: "yarn-fab-preset", attr: { "aria-label": preset.label, "data-color": preset.color } });
			if (preset.color) b.style.backgroundColor = preset.color;
			else b.addClass("is-accent");
			b.addEventListener("click", () => void setFab(preset.color));
		}
		paintPresets();
		fabSetting.addColorPicker((cp) => {
			picker = cp;
			cp.setValue(s.fabColor || "#8e6cef").onChange((v) => {
				if (v.toLowerCase() !== s.fabColor.toLowerCase()) void setFab(v);
			});
		});
		fabSetting.controlEl.addClass("yarn-fab-setting");

		new Setting(containerEl).setName("Weaves").setHeading();
		const w = s.weave;
		const saveWeave = async () => {
			await this.plugin.saveSettings();
			this.plugin.forEachWeave((v) => v.weave?.restyle());
		};
		new Setting(containerEl)
			.setName("Look")
			.setDesc("How weaves are drawn. You can also switch this from Options inside a weave.")
			.addDropdown((d) =>
				d
					.addOptions(WEAVE_SKINS.reduce<Record<string, string>>((o, k) => ((o[k.id] = k.name), o), {}))
					.setValue(w.skin)
					.onChange(async (v) => ((w.skin = v), await saveWeave())),
			);
		new Setting(containerEl)
			.setName("Default lanes left of the thread")
			.setDesc("For new weaves. Comma separated; leave empty for none.")
			.addText((t) => t.setValue(w.defLeft).onChange(async (v) => ((w.defLeft = v), await saveWeave())));
		new Setting(containerEl)
			.setName("Default name of the middle lane")
			.addText((t) => t.setPlaceholder("Thread").setValue(w.defThread).onChange(async (v) => ((w.defThread = v), await saveWeave())));
		new Setting(containerEl)
			.setName("Default lanes right of the thread")
			.setDesc("For new weaves. Comma separated; leave empty for none.")
			.addText((t) => t.setValue(w.defRight).onChange(async (v) => ((w.defRight = v), await saveWeave())));
		new Setting(containerEl)
			.setName("Loose strip")
			.setDesc("Where each scene keeps its loose notes.")
			.addDropdown((d) =>
				d
					.addOptions({ bottom: "Below the thread", top: "Above the thread" })
					.setValue(w.loosePos)
					.onChange(async (v) => ((w.loosePos = v as WeaveUi["loosePos"]), await saveWeave())),
			);
		new Setting(containerEl)
			.setName("Loose strips start minimized")
			.setDesc("Each scene still remembers it once you open or minimize its strip.")
			.addToggle((t) => t.setValue(w.looseDefaultMin).onChange(async (v) => ((w.looseDefaultMin = v), await saveWeave())));

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `Long-press a card to colour it or give it a wallpaper. These, and pins, are stored in the note's properties as “${COLOR_KEY}”, “${WALLPAPER_KEY}” and “${PINNED_KEY}”, so they sync with the note.`,
		});
	}
}
