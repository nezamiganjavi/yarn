import {
	App,
	FuzzySuggestModal,
	ItemView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	setIcon,
} from "obsidian";
import { Board, BoardHost, NoteRef, NoteStyle } from "./board";
import { FAB_PRESETS } from "./palette";

export const VIEW_TYPE = "jotboard-view";
const COLOR_KEY = "card-color";
const WALLPAPER_KEY = "card-wallpaper";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

interface JotboardSettings {
	openOnStartup: boolean;
	folder: string;
	exclude: string;
	sort: "modified" | "created" | "name";
	previewLines: number;
	layout: "grid" | "list";
	fabColor: string;
}

const DEFAULTS: JotboardSettings = {
	openOnStartup: true,
	folder: "",
	exclude: "",
	sort: "modified",
	previewLines: 10,
	layout: "grid",
	fabColor: "",
};

interface BoardState {
	scroll?: number;
	query?: string;
}

export default class JotboardPlugin extends Plugin {
	settings!: JotboardSettings;
	/** Last board state, used as a fallback when the view is re-created. */
	lastState: BoardState = {};

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());

		this.registerView(VIEW_TYPE, (leaf) => new JotboardView(leaf, this));
		this.addRibbonIcon("layout-grid", "Open Jotboard", () => void this.activate(true));
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
		this.addSettingTab(new JotboardSettingTab(this.app, this));

		const refresh = debounce(() => this.forEachView((v) => void v.board?.refresh()), 400, true);
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", refresh));
			this.registerEvent(this.app.vault.on("delete", refresh));
			this.registerEvent(this.app.vault.on("rename", refresh));
			this.registerEvent(this.app.vault.on("modify", refresh));
			this.registerEvent(this.app.metadataCache.on("changed", (file) => this.forEachView((v) => v.board?.styleChanged(file.path))));
			this.registerEvent(this.app.workspace.on("css-change", () => this.forEachView((v) => v.board?.restyle())));
			if (this.settings.openOnStartup) void this.activate(false);
		});
	}

	forEachView(fn: (v: JotboardView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof JotboardView) fn(leaf.view);
		}
	}

	/** Show the board: reuse an existing one, else take over the current tab (Back returns to what was there). */
	async activate(focus: boolean): Promise<JotboardView | null> {
		const ws = this.app.workspace;
		let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = ws.getLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await ws.revealLeaf(leaf);
		if (focus) ws.setActiveLeaf(leaf, { focus: true });
		return leaf.view instanceof JotboardView ? leaf.view : null;
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
		return files.map((f) => ({ id: f.path, title: f.basename, mtime: f.stat.mtime }));
	}

	file(id: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(id);
		return f instanceof TFile ? f : null;
	}

	getStyle(id: string): NoteStyle {
		const f = this.file(id);
		const fm = f ? this.app.metadataCache.getFileCache(f)?.frontmatter : undefined;
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		return { color: str(fm?.[COLOR_KEY]), wallpaper: str(fm?.[WALLPAPER_KEY]) };
	}

	async setStyle(id: string, patch: NoteStyle): Promise<void> {
		const f = this.file(id);
		if (!f) return;
		const set = (fm: Record<string, unknown>, key: string, v: string | undefined) => {
			if (v) fm[key] = v;
			else delete fm[key];
		};
		// Keep the original modified time so colouring a note doesn't bump it to the top.
		await this.app.fileManager.processFrontMatter(
			f,
			(fm) => {
				if ("color" in patch) set(fm, COLOR_KEY, patch.color);
				if ("wallpaper" in patch) set(fm, WALLPAPER_KEY, patch.wallpaper);
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

class JotboardView extends ItemView {
	plugin: JotboardPlugin;
	board: Board | null = null;
	private pending: BoardState | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: JotboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Notes";
	}
	getIcon(): string {
		return "layout-grid";
	}

	getState(): Record<string, unknown> {
		const s: BoardState = this.board ? { scroll: this.board.scrollTop, query: this.board.searchQuery } : this.plugin.lastState;
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
			setStyle: (id, patch) => p.setStyle(id, patch),
			resolveImage: (link, src) => p.resolveImage(link, src),
			open: (id) => {
				const f = p.file(id);
				if (f) void this.leaf.openFile(f, { active: true });
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
			get layout() {
				return p.settings.layout;
			},
			get fabColor() {
				return p.settings.fabColor;
			},
			setLayout: (layout) => {
				p.settings.layout = layout;
				void p.saveSettings();
			},
		};
		this.contentEl.empty();
		this.board = new Board(this.contentEl, host);
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
			this.plugin.lastState = { scroll: this.board.scrollTop, query: this.board.searchQuery };
			this.board.destroy();
			this.board = null;
		}
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

class JotboardSettingTab extends PluginSettingTab {
	plugin: JotboardPlugin;
	constructor(app: App, plugin: JotboardPlugin) {
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
			.setName("Excluded folders")
			.setDesc("Comma-separated folders to hide, e.g. Templates, Archive.")
			.addTextArea((t) => t.setValue(s.exclude).onChange(async (v) => ((s.exclude = v), await save())));

		new Setting(containerEl).setName("Sort by").addDropdown((d) =>
			d
				.addOptions({ modified: "Last edited", created: "Created", name: "Name" })
				.setValue(s.sort)
				.onChange(async (v) => ((s.sort = v as JotboardSettings["sort"]), await save())),
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

		const fabSetting = new Setting(containerEl)
			.setName("+ button colour")
			.setDesc("Pick a preset, or choose any colour with the picker.");
		const swatches = fabSetting.controlEl.createDiv({ cls: "jb-fab-presets" });
		let picker: { setValue(v: string): unknown } | null = null;
		const setFab = async (color: string) => {
			s.fabColor = color;
			paintPresets();
			if (color) picker?.setValue(color);
			await this.plugin.saveSettings();
			this.plugin.forEachView((v) => v.board?.applyFabColor());
		};
		const paintPresets = () =>
			swatches.querySelectorAll<HTMLElement>(".jb-fab-preset").forEach((b) =>
				b.toggleClass("is-selected", (b.dataset.color || "").toLowerCase() === s.fabColor.toLowerCase()),
			);
		for (const preset of FAB_PRESETS) {
			const b = swatches.createEl("button", { cls: "jb-fab-preset", attr: { "aria-label": preset.label, "data-color": preset.color } });
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
		fabSetting.controlEl.addClass("jb-fab-setting");

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `Long-press a card to colour it or give it a wallpaper. These are stored in the note's properties as “${COLOR_KEY}” and “${WALLPAPER_KEY}”, so they sync with the note.`,
		});
	}
}
