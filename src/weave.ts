// The weave board: scenes, each with a thread of beats, side lanes and a loose strip.
// Plain DOM only (like Board), so it mounts both inside Obsidian and in the browser harness.

import { WBeat, WItem, WScene, WeaveModel, newLane, newScene } from "./weavemodel";

export interface WeaveUi {
	skin: string;
	density: "titles" | "peek";
	loosePos: "top" | "bottom";
	looseDefaultMin: boolean;
	/** Defaults for new weaves: comma-separated lane names. */
	defLeft: string;
	defThread: string;
	defRight: string;
}

export interface WeaveHost {
	/** Name shown in the header (the note the weave lives in). */
	title: string;
	info(link: string): { title: string; missing: boolean };
	/** Plain-text preview of the linked note. */
	read(link: string): Promise<string>;
	open(link: string): void;
	openSource?(): void;
	/** Called after every change the user makes. */
	save(model: WeaveModel): void;
	ui: WeaveUi;
	/** Remembered per weave: which scenes are folded and which loose strips are minimized. */
	flags: Record<string, boolean>;
	saveUi(): void;
	isDark(): boolean;
}

export const WEAVE_SKINS: Array<{ id: string; name: string; sw: string[] }> = [
	{ id: "yarn", name: "Yarn", sw: ["#f3f2f6", "#fbf0d4", "#d9567f", "#d9f1ec", "#7c5bed"] },
	{ id: "indigo", name: "Indigo", sw: ["#e6eaf3", "#dfe7fa", "#2f47a8", "#f3eedf", "#1c2340"] },
	{ id: "margin", name: "Margin", sw: ["#fbfbfa", "#b3362b", "#1d1d1f", "#2c4f9e", "#cfcfcc"] },
	{ id: "snap", name: "Snap", sw: ["#ebe6f5", "#fbdfe8", "#fffefe", "#d9e8fb", "#d8f0e4"] },
	{ id: "quiet", name: "Quiet", sw: ["#f5f5f6", "#ffffff", "#74747e", "#dedee2", "#7c5bed"] },
];

type Target =
	| { type: "basket"; index: number }
	| { type: "loose"; scene: number; index: number }
	| { type: "chain"; scene: number; index: number }
	| { type: "side"; scene: number; beat: number; lane: string; index: number };

interface Press {
	id: string;
	pid?: number;
	x: number;
	y: number;
	touch: boolean;
	card: HTMLElement;
	timer: number;
}

interface Drag {
	id: string;
	ids: Set<string>;
	base: WeaveModel;
	key: string | null;
	t: Target | null;
	ghost: HTMLElement;
	ox: number;
	oy: number;
	x: number;
	y: number;
	sx: number;
	sy: number;
	armed: boolean;
	cool: number;
	moved: boolean;
}

/** Class names are written bare in this file and prefixed here, to stay clear of Obsidian's and themes' own. */
const K = (s: string) => s.split(/\s+/).filter(Boolean).map((n) => "yw-" + n).join(" ");
const Q = (sel: string) => sel.replace(/\.(?=[a-zA-Z])/g, ".yw-");
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

function el<T extends keyof HTMLElementTagNameMap>(tag: T, cls?: string, parent?: HTMLElement | null, text?: string): HTMLElementTagNameMap[T] {
	const e = document.createElement(tag);
	if (cls) e.className = K(cls);
	if (text !== undefined) e.textContent = text;
	if (parent) parent.appendChild(e);
	return e;
}

export class Weave {
	private host: WeaveHost;
	private root: HTMLElement;
	private board!: HTMLElement;
	private scroller!: HTMLElement;
	private panel!: HTMLElement;
	private laneList!: HTMLElement;
	private undoBtn!: HTMLButtonElement;
	private state: WeaveModel;
	private drag: Drag | null = null;
	private press: Press | null = null;
	private openSet = new Set<string>();
	private undo: WeaveModel[] = [];
	private texts = new Map<string, string>();
	private loading = new Set<string>();
	private ac = new AbortController();
	private raf = 0;
	private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

	constructor(parent: HTMLElement, host: WeaveHost, model: WeaveModel) {
		this.host = host;
		this.state = model;
		this.root = el("div", "root", parent);
		this.build();
		this.restyle();
	}

	/** True while a note is in the air; the host should not swap the model then. */
	get busy(): boolean {
		return !!this.drag;
	}

	get model(): WeaveModel {
		return this.state;
	}

	/** The note changed outside the board (links added or removed, or the block edited by hand). */
	setModel(model: WeaveModel): void {
		this.endDrag(true);
		this.state = model;
		this.undo = [];
		this.render(false);
		this.renderLanes();
	}

	/** Forget cached note text, e.g. after notes were edited. */
	refreshTexts(): void {
		this.texts.clear();
		if (!this.drag) this.render(false);
	}

	/** Apply look and theme again after a setting changed. */
	restyle(): void {
		const ui = this.host.ui;
		this.root.dataset.mode = this.host.isDark() ? "dark" : "light";
		if (ui.skin && ui.skin !== "yarn") this.root.dataset.skin = ui.skin;
		else delete this.root.dataset.skin;
		this.syncControls();
		this.render(false);
	}

	setBottomInset(px: number): void {
		this.root.style.setProperty("--yw-inset", px + "px");
	}

	destroy(): void {
		this.ac.abort();
		cancelAnimationFrame(this.raf);
		if (this.press) clearTimeout(this.press.timer);
		this.root.remove();
	}

	// ---------- shell ----------

	private build(): void {
		const sig = { signal: this.ac.signal };
		const bar = el("header", "bar", this.root);
		const bt = el("div", "bar-title", bar);
		const eyebrow = el("div", "eyebrow", bt, "Weave");
		if (this.host.openSource) {
			eyebrow.textContent = "Weave · open note";
			eyebrow.addEventListener("click", () => this.host.openSource?.());
		}
		el("h1", "", bt, this.host.title);
		const tools = el("div", "tools", bar);
		const seg = el("div", "seg", tools);
		for (const d of ["titles", "peek"] as const) {
			const b = el("button", "", seg, d === "titles" ? "Titles" : "Peek");
			b.dataset.density = d;
			b.addEventListener("click", () => {
				this.host.ui.density = d;
				this.host.saveUi();
				this.syncControls();
				this.render(true);
			});
		}
		this.undoBtn = el("button", "btn", tools, "Undo");
		this.undoBtn.addEventListener("click", () => {
			const prev = this.undo.pop();
			if (!prev) return;
			this.state = prev;
			this.changed();
		});
		const optsBtn = el("button", "btn", tools, "Options");
		optsBtn.dataset.role = "opts";
		optsBtn.addEventListener("click", () => this.showPanel(this.panel.hasAttribute("hidden")));

		const wrap = el("div", "wrap", this.root);
		this.scroller = el("div", "scroller", wrap);
		this.board = el("div", "board", this.scroller);
		this.buildPanel(wrap);

		const b = this.board;
		b.addEventListener("pointerdown", (e) => this.onPointerDown(e), sig);
		window.addEventListener("pointermove", (e) => this.onPointerMove(e), sig);
		window.addEventListener("pointerup", (e) => this.onPointerUp(e), sig);
		window.addEventListener("pointercancel", (e) => { if (e.pointerType !== "touch") { this.clearPress(); this.endDrag(false); } }, sig);
		window.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.drag) this.endDrag(true); }, sig);
		b.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: true, signal: this.ac.signal });
		// Once a note is lifted, the finger moves the note, not the page.
		document.addEventListener("touchmove", (e) => { if (this.drag && e.cancelable) e.preventDefault(); }, { passive: false, signal: this.ac.signal });
		b.addEventListener("contextmenu", (e) => { if ((e.target as HTMLElement).closest(Q(".card"))) e.preventDefault(); }, sig);
		b.addEventListener("click", (e) => this.onClick(e), sig);
		b.addEventListener("change", (e) => this.onChange(e), sig);
	}

	private buildPanel(wrap: HTMLElement): void {
		const ui = this.host.ui;
		const p = (this.panel = el("aside", "panel", wrap));
		p.hidden = true;
		const head = el("div", "panel-head", p);
		el("h2", "", head, "Options");
		el("button", "btn small", head, "Close").addEventListener("click", () => this.showPanel(false));
		const o = el("div", "opts", p);

		el("h3", "", o, "Look");
		const skins = el("div", "skins", o);
		for (const s of WEAVE_SKINS) {
			const b = el("button", "skin", skins);
			b.dataset.skin = s.id;
			const sw = el("span", "swatches", b);
			for (const c of s.sw) el("i", "", sw).style.background = c;
			el("span", "", b, s.name);
			b.addEventListener("click", () => {
				ui.skin = s.id;
				this.host.saveUi();
				this.restyle();
			});
		}

		el("h3", "", o, "Lanes in this weave");
		this.laneList = el("div", "lane-list", o);
		const add = el("div", "opt-row", o);
		el("button", "btn small", add, "+ Lane on the left").addEventListener("click", () => this.commit(() => this.state.lanes.unshift(newLane("New lane", "L"))));
		el("button", "btn small", add, "+ Lane on the right").addEventListener("click", () => this.commit(() => this.state.lanes.push(newLane("New lane", "R"))));
		el("p", "", o, "Removing a lane moves its notes to each scene's loose strip. You can also rename a lane by tapping its name above a scene.");

		el("h3", "", o, "Loose strip");
		const pos = el("div", "seg", el("div", "opt-row", o));
		for (const v of ["top", "bottom"] as const) {
			const b = el("button", "", pos, v === "top" ? "Above the thread" : "Below the thread");
			b.dataset.loosePos = v;
			b.addEventListener("click", () => {
				ui.loosePos = v;
				this.host.saveUi();
				this.syncControls();
				this.render(true);
			});
		}
		const lab = el("label", "", el("div", "opt-row", o));
		const chk = el("input", "", lab);
		chk.type = "checkbox";
		chk.dataset.role = "loose-min";
		lab.append(" Start minimized");
		chk.addEventListener("change", () => {
			ui.looseDefaultMin = chk.checked;
			for (const k of Object.keys(this.host.flags)) if (k.startsWith("min:")) delete this.host.flags[k];
			this.host.saveUi();
			this.render(false);
		});
		el("p", "", o, "Each scene remembers whether you opened or minimized its strip.");

		el("h3", "", o, "Defaults for new weaves");
		const field = (label: string, key: "defLeft" | "defThread" | "defRight") => {
			const l = el("label", "stack", o, label);
			const i = el("input", "field", l);
			i.type = "text";
			i.value = ui[key];
			i.addEventListener("change", () => {
				ui[key] = i.value;
				this.host.saveUi();
			});
		};
		field("Lanes left of the thread, comma separated", "defLeft");
		field("Name of the middle lane", "defThread");
		field("Lanes right of the thread, comma separated", "defRight");
		this.renderLanes();
	}

	private showPanel(show: boolean): void {
		this.panel.hidden = !show;
		this.root.querySelector('[data-role="opts"]')?.setAttribute("aria-pressed", String(show));
	}

	private syncControls(): void {
		const ui = this.host.ui;
		const press = (sel: string, on: (e: HTMLElement) => boolean) => this.root.querySelectorAll<HTMLElement>(sel).forEach((b) => b.setAttribute("aria-pressed", String(on(b))));
		press("[data-density]", (b) => b.dataset.density === ui.density);
		press("[data-skin]:not(." + K("root") + ")", (b) => b.dataset.skin === (ui.skin || "yarn"));
		press("[data-loose-pos]", (b) => b.dataset.loosePos === ui.loosePos);
		const chk = this.root.querySelector<HTMLInputElement>('[data-role="loose-min"]');
		if (chk) chk.checked = ui.looseDefaultMin;
	}

	private renderLanes(): void {
		const list = this.laneList;
		list.replaceChildren();
		const row = (id: string, name: string, label: string) => {
			const r = el("div", "lane-row", list);
			el("span", "", r, label);
			const i = el("input", "field", r);
			i.type = "text";
			i.value = name;
			i.setAttribute("aria-label", label + " lane name");
			i.addEventListener("change", () => this.commit(() => this.renameLane(id, i.value)));
			const x = el("button", "icon-btn", r, "×");
			x.setAttribute("aria-label", "Remove lane " + name);
			x.disabled = id === "thread";
			x.addEventListener("click", () =>
				this.commit(() => {
					for (const sc of this.state.scenes)
						for (const b of sc.beats) {
							sc.loose.push(...(b.sides[id] ?? []));
							delete b.sides[id];
						}
					this.state.lanes = this.state.lanes.filter((l) => l.id !== id);
				}),
			);
		};
		this.state.lanes.filter((l) => l.side === "L").forEach((l) => row(l.id, l.name, "Left"));
		row("thread", this.state.thread, "Middle");
		this.state.lanes.filter((l) => l.side === "R").forEach((l) => row(l.id, l.name, "Right"));
	}

	private renameLane(id: string, value: string): void {
		const v = value.trim();
		if (id === "thread") this.state.thread = v || "Thread";
		else {
			const l = this.state.lanes.find((x) => x.id === id);
			if (l) l.name = v || "Lane";
		}
	}

	// ---------- model helpers ----------

	private sideItems(s: WeaveModel, b: WBeat): WItem[] {
		return s.lanes.flatMap((l) => b.sides[l.id] ?? []);
	}
	private flag(kind: "min" | "col", sc: WScene): boolean {
		const k = kind + ":" + sc.name;
		return k in this.host.flags ? this.host.flags[k] : kind === "min" ? this.host.ui.looseDefaultMin : false;
	}
	/** A change made through a control: remember the old state, apply, redraw, save. */
	private commit(fn: () => void): void {
		this.undo.push(clone(this.state));
		if (this.undo.length > 50) this.undo.shift();
		fn();
		this.changed();
	}
	private changed(): void {
		this.render(true);
		this.renderLanes();
		this.host.save(this.state);
	}

	// ---------- render ----------

	private text(it: WItem): string {
		const t = this.texts.get(it.link);
		if (t === undefined && !this.loading.has(it.link)) {
			this.loading.add(it.link);
			void this.host.read(it.link).then(
				(body) => {
					this.loading.delete(it.link);
					this.texts.set(it.link, body);
					// fill it in where the card already stands, without redrawing the board
					this.root.querySelectorAll<HTMLElement>(Q(".card")).forEach((c) => {
						if (c.dataset.link !== it.link) return;
						const b = c.querySelector<HTMLElement>(Q(".b"));
						if (b) b.textContent = body;
						c.classList.toggle(K("no-body"), !body);
					});
				},
				() => this.loading.delete(it.link),
			);
		}
		return t ?? "";
	}

	private card(it: WItem, num?: number): HTMLElement {
		const d = this.drag;
		const info = this.host.info(it.link);
		const c = el("div", "card");
		c.dataset.id = it.id;
		c.dataset.link = it.link;
		if (d && d.ids.has(it.id)) c.classList.add(K("is-carried"));
		if (d && d.id === it.id) c.classList.add(K("is-slot"));
		if (this.openSet.has(it.id)) c.classList.add(K("is-open"));
		if (info.missing) c.classList.add(K("is-missing"));
		const body = this.text(it);
		if (!body) c.classList.add(K("no-body"));
		el("div", "grip", c);
		if (num) el("span", "num", c, String(num));
		if (info.title) el("div", "t", c, info.title);
		el("div", "b", c, body);
		el("button", "open", c, info.missing ? "Create note" : "Open note").dataset.act = "open";
		return c;
	}

	private tray(parent: HTMLElement, items: WItem[], emptyText: string): HTMLElement {
		const t = el("div", "tray", parent);
		items.forEach((it) => t.appendChild(this.card(it)));
		if (!items.length) el("span", "tray-empty", t, emptyText);
		return t;
	}

	private looseStrip(parent: HTMLElement, sc: WScene, si: number): void {
		const min = this.flag("min", sc);
		const t = this.drag?.t;
		const targeted = !!t && t.type === "loose" && t.scene === si;
		const w = el("div", "loose" + (min ? " is-min" : "") + (targeted ? " is-target" : ""), parent);
		const h = el("button", "loose-head", w);
		h.dataset.act = "loose-toggle";
		h.setAttribute("aria-expanded", String(!min));
		el("span", "chev", h, "▼");
		el("span", "zone-label", h, "Loose · " + sc.loose.length);
		if (!min) this.tray(w, sc.loose, "Rules, reminders and tone for this scene.");
	}

	private render(animate: boolean): void {
		const { state, board, drag } = this;
		const ui = this.host.ui;
		const before = animate && !this.reduced ? this.rects() : null;
		const cols = [...state.lanes.filter((l) => l.side === "L"), { id: "thread", name: state.thread, side: "M" }, ...state.lanes.filter((l) => l.side === "R")];
		const mid = cols.findIndex((c) => c.side === "M");
		board.className = K("board " + ui.density);
		board.style.setProperty("--cols", cols.map((c) => (c.side === "M" ? "minmax(118px, 1.4fr)" : "minmax(84px, 1fr)")).join(" "));
		board.replaceChildren();

		const total = state.basket.length + state.scenes.reduce((n, sc) => n + sc.loose.length + sc.beats.length, 0);
		if (!total && !state.scenes.length) el("p", "empty", board, "This note doesn't link to any notes yet. Add [[links]] to it and they will show up here, ready to arrange.");

		const bk = el("section", "basket", board);
		bk.dataset.key = "basket";
		const bh = el("div", "zone-head", bk);
		el("span", "zone-label", bh, "Basket · not placed yet");
		el("span", "count", bh, String(state.basket.length));
		this.tray(bk, state.basket, state.scenes.length ? "Everything is placed." : "Add a scene below, then drag notes into it.");

		state.scenes.forEach((sc, si) => {
			const collapsed = this.flag("col", sc);
			const s = el("section", "scene" + (collapsed ? " is-collapsed" : ""), board);
			s.dataset.si = String(si);
			s.dataset.key = sc.id;
			const h = el("div", "zone-head", s);
			const chev = el("button", "chev", h, "▼");
			chev.dataset.act = "collapse";
			chev.setAttribute("aria-label", collapsed ? "Expand scene" : "Collapse scene");
			const name = el("input", "scene-name", h);
			name.type = "text";
			name.value = sc.name;
			name.setAttribute("aria-label", "Scene name");
			const notes = sc.beats.reduce((n, b) => n + 1 + this.sideItems(state, b).length, sc.loose.length);
			el("span", "count", h, sc.beats.length + " beats · " + notes + " notes");
			const zap = el("button", "zap", h, "×");
			zap.dataset.act = "remove-scene";
			zap.setAttribute("aria-label", "Remove scene " + sc.name);
			if (collapsed) return;
			if (ui.loosePos === "top") this.looseStrip(s, sc, si);
			const loom = el("div", "loom", s);
			const lanes = el("div", "lanes", loom);
			cols.forEach((c) => {
				const i = el("input", "lane-name", lanes);
				i.type = "text";
				i.value = c.name;
				i.dataset.lane = c.id;
				i.setAttribute("aria-label", "Lane name");
			});
			const rows = el("div", "rows", loom);
			if (!sc.beats.length) el("span", "rows-empty", rows, "Drop a note here to start the thread");
			sc.beats.forEach((b, bi) => {
				const r = el("div", "row" + (drag && drag.id === b.item.id ? " is-drag" : ""), rows);
				const has = cols.map((c) => c.side !== "M" && (b.sides[c.id] ?? []).length > 0);
				cols.forEach((c, ci) => {
					if (c.side === "M") {
						const m = el("div", "cell mid", r);
						m.dataset.lane = "thread";
						m.appendChild(this.card(b.item, bi + 1));
						return;
					}
					// an empty lane between a note and the thread carries the stitch across
					const outer = ci < mid ? has.slice(0, ci).some(Boolean) : has.slice(ci + 1).some(Boolean);
					const cell = el("div", "cell side " + c.side + (has[ci] ? " has" : outer ? " bridge" : ""), r);
					cell.dataset.lane = c.id;
					(b.sides[c.id] ?? []).forEach((it) => cell.appendChild(this.card(it)));
				});
			});
			if (ui.loosePos === "bottom") this.looseStrip(s, sc, si);
		});
		el("button", "add-scene", board, "+ Add scene").dataset.act = "add-scene";

		if (before) this.flip(before);
		this.undoBtn.disabled = !this.undo.length;
	}

	private keyed(): NodeListOf<HTMLElement> {
		return this.board.querySelectorAll<HTMLElement>(Q(".card[data-id], [data-key]"));
	}
	private rects(): Map<string, DOMRect> {
		const m = new Map<string, DOMRect>();
		this.keyed().forEach((e) => m.set(e.dataset.id || e.dataset.key || "", e.getBoundingClientRect()));
		return m;
	}
	private flip(before: Map<string, DOMRect>): void {
		const moved: HTMLElement[] = [];
		this.keyed().forEach((e) => {
			const a = before.get(e.dataset.id || e.dataset.key || "");
			if (!a) return;
			const b = e.getBoundingClientRect();
			const dx = a.left - b.left, dy = a.top - b.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
			e.style.transition = "none";
			e.style.transform = `translate(${dx}px,${dy}px)`;
			moved.push(e);
		});
		if (!moved.length) return;
		this.board.getBoundingClientRect(); // commit the start positions
		requestAnimationFrame(() =>
			moved.forEach((e) => {
				e.style.transition = "transform 190ms cubic-bezier(.2,.9,.25,1)";
				e.style.transform = "";
			}),
		);
	}

	// ---------- moves ----------

	private payloadIds(s: WeaveModel, id: string): string[] {
		for (const sc of s.scenes) for (const b of sc.beats) if (b.item.id === id) return [id, ...this.sideItems(s, b).map((i) => i.id)];
		return [id];
	}
	private take(s: WeaveModel, id: string): WBeat | null {
		const pull = (arr: WItem[]) => {
			const i = arr.findIndex((x) => x.id === id);
			return i < 0 ? null : arr.splice(i, 1)[0];
		};
		let it = pull(s.basket);
		if (it) return { item: it, sides: {} };
		for (const sc of s.scenes) {
			if ((it = pull(sc.loose))) return { item: it, sides: {} };
			for (let i = 0; i < sc.beats.length; i++) {
				const b = sc.beats[i];
				if (b.item.id === id) return sc.beats.splice(i, 1)[0];
				for (const k of Object.keys(b.sides)) if ((it = pull(b.sides[k]))) return { item: it, sides: {} };
			}
		}
		return null;
	}
	private applyMove(base: WeaveModel, id: string, t: Target): WeaveModel {
		const s = clone(base);
		const p = this.take(s, id);
		if (!p) return s;
		const flat = [p.item, ...this.sideItems(s, p)];
		if (t.type === "basket") s.basket.splice(t.index, 0, ...flat);
		else if (t.type === "loose") s.scenes[t.scene].loose.splice(t.index, 0, ...flat);
		else if (t.type === "chain") s.scenes[t.scene].beats.splice(t.index, 0, p);
		else {
			const sc = s.scenes[t.scene];
			const b = sc.beats[t.beat];
			if (b) (b.sides[t.lane] = b.sides[t.lane] ?? []).splice(t.index, 0, ...flat);
			else sc.beats.push(p);
		}
		return s;
	}

	// ---------- hit testing: where would this note snap? ----------

	private flowIndex(trayEl: Element, x: number, y: number): number {
		let i = 0;
		trayEl.querySelectorAll(Q(".card:not(.is-carried)")).forEach((c) => {
			const r = c.getBoundingClientRect();
			if (y > r.bottom || (y >= r.top && x > r.left + r.width / 2)) i++;
		});
		return i;
	}
	private hit(x: number, y: number): Target {
		const drag = this.drag as Drag;
		const FREE = Q(".card:not(.is-carried)");
		const bk = this.board.querySelector(Q(".basket")) as HTMLElement;
		if (y < bk.getBoundingClientRect().bottom + 4) return { type: "basket", index: this.flowIndex(bk.querySelector(Q(".tray")) as Element, x, y) };
		let best: HTMLElement | null = null, bd = Infinity;
		this.board.querySelectorAll<HTMLElement>(Q(".scene")).forEach((s) => {
			const r = s.getBoundingClientRect();
			const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
			if (d < bd) { bd = d; best = s; }
		});
		if (!best) return { type: "basket", index: 0 };
		const sceneEl = best as HTMLElement;
		const si = Number(sceneEl.dataset.si), base = drag.base.scenes[si];
		const rowsEl = sceneEl.querySelector(Q(".rows"));
		if (!rowsEl) return { type: "chain", scene: si, index: base.beats.filter((b) => b.item.id !== drag.id).length };
		const loose = sceneEl.querySelector(Q(".loose")) as HTMLElement;
		const lr = loose.getBoundingClientRect();
		if (y >= lr.top - 4 && y <= lr.bottom + 4) {
			const tr = loose.querySelector(Q(".tray"));
			return { type: "loose", scene: si, index: tr ? this.flowIndex(tr, x, y) : base.loose.filter((i) => !drag.ids.has(i.id)).length };
		}
		const rows = Array.from(rowsEl.querySelectorAll<HTMLElement>(Q(".row:not(.is-drag)")));
		if (!rows.length) return { type: "chain", scene: si, index: 0 };
		// which lane is the pointer over?
		let lane = "thread", ld = Infinity;
		for (const c of Array.from(rows[0].children) as HTMLElement[]) {
			const r = c.getBoundingClientRect();
			const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
			if (d < ld) { ld = d; lane = c.dataset.lane || "thread"; }
		}
		if (lane === "thread") {
			let i = 0;
			rows.forEach((r) => { const b = r.getBoundingClientRect(); if (y > b.top + b.height / 2) i++; });
			return { type: "chain", scene: si, index: i };
		}
		let bi = 0, d0 = Infinity;
		rows.forEach((r, i) => {
			const b = r.getBoundingClientRect();
			const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
			if (d < d0) { d0 = d; bi = i; }
		});
		let i = 0;
		rows[bi].querySelector(`[data-lane="${lane}"]`)?.querySelectorAll(FREE).forEach((c) => { const b = c.getBoundingClientRect(); if (y > b.top + b.height / 2) i++; });
		return { type: "side", scene: si, beat: bi, lane, index: i };
	}

	// ---------- dragging ----------
	// The picked-up card itself becomes the floating one and stays in the page for the whole drag,
	// so the finger that pressed it keeps sending its moves to us.

	private startDrag(p: Press): void {
		const g = p.card;
		if (!g.isConnected || this.drag) return;
		const r = g.getBoundingClientRect(), cs = getComputedStyle(g);
		const ids = this.payloadIds(this.state, p.id);
		for (const k of ["backgroundColor", "backgroundImage", "borderColor", "padding", "color"] as const) g.style[k] = cs[k];
		g.style.width = r.width + "px";
		g.classList.remove(K("is-pressing"), K("is-open"));
		g.classList.add(K("ghost"));
		if (ids.length > 1) el("span", "more", g, "+" + (ids.length - 1));
		this.root.appendChild(g);
		if (!p.touch && p.pid !== undefined) try { g.setPointerCapture(p.pid); } catch { /* pointer already gone */ }
		this.drag = { id: p.id, ids: new Set(ids), base: clone(this.state), key: null, t: null, ghost: g, ox: p.x - r.left, oy: p.y - r.top, x: p.x, y: p.y, sx: p.x, sy: p.y, armed: false, cool: 0, moved: false };
		this.root.classList.add(K("is-dragging"));
		if (p.touch && navigator.vibrate) navigator.vibrate(10);
		this.placeGhost();
		this.render(false);
		this.autoScroll();
	}
	/** The ghost is positioned inside the weave's own box: Obsidian's panes clip and offset "fixed" children. */
	private placeGhost(): void {
		const d = this.drag as Drag, o = this.root.getBoundingClientRect();
		d.ghost.style.transform = `translate(${d.x - d.ox - o.left}px,${d.y - d.oy - o.top}px) rotate(-1.5deg) scale(1.03)`;
	}
	private moveTo(x: number, y: number): void {
		const d = this.drag as Drag;
		d.x = x;
		d.y = y;
		this.placeGhost();
		this.retarget();
	}
	private retarget(): void {
		const d = this.drag;
		if (!d || performance.now() < d.cool) return;
		const t = this.hit(d.x, d.y);
		const key = JSON.stringify(t);
		if (key === d.key) return;
		d.key = key;
		d.t = t;
		d.moved = true;
		d.cool = performance.now() + 140;
		this.state = this.applyMove(d.base, d.id, t);
		this.render(true);
	}
	private autoScroll(): void {
		const d = this.drag;
		if (!d) return;
		this.raf = requestAnimationFrame(() => this.autoScroll());
		// a note picked up near the edge shouldn't start the page moving until it has travelled a bit
		if (!d.armed) return void (d.armed = Math.hypot(d.x - d.sx, d.y - d.sy) > 28);
		const r = this.scroller.getBoundingClientRect(), edge = 56;
		let v = 0;
		if (d.y < r.top + edge) v = -Math.min(1, (r.top + edge - d.y) / edge) * 14;
		else if (d.y > r.bottom - edge) v = Math.min(1, (d.y - (r.bottom - edge)) / edge) * 14;
		if (v) {
			this.scroller.scrollTop += v;
			this.retarget();
		}
	}
	private endDrag(cancel: boolean): void {
		const d = this.drag;
		if (!d) return;
		cancelAnimationFrame(this.raf);
		const did = !cancel && d.moved && JSON.stringify(this.state) !== JSON.stringify(d.base);
		if (cancel) this.state = d.base;
		else if (did) {
			this.undo.push(d.base);
			if (this.undo.length > 50) this.undo.shift();
		}
		this.drag = null;
		this.root.classList.remove(K("is-dragging"));
		this.render(cancel);
		if (did) this.host.save(this.state);
		const dest = this.board.querySelector<HTMLElement>(Q(".card") + `[data-id="${d.id}"]`);
		if (!dest || this.reduced) return void d.ghost.remove();
		const r = dest.getBoundingClientRect(), o = this.root.getBoundingClientRect();
		dest.style.visibility = "hidden";
		d.ghost.style.transition = "transform 170ms cubic-bezier(.2,.9,.25,1), width 170ms";
		d.ghost.style.width = r.width + "px";
		d.ghost.style.transform = `translate(${r.left - o.left}px,${r.top - o.top}px)`;
		window.setTimeout(() => {
			d.ghost.remove();
			dest.style.visibility = "";
		}, 180);
	}

	private clearPress(): void {
		if (!this.press) return;
		clearTimeout(this.press.timer);
		this.press.card.classList.remove(K("is-pressing"));
		this.press = null;
	}
	private toggleOpen(id: string): void {
		if (this.openSet.has(id)) this.openSet.delete(id);
		else this.openSet.add(id);
		this.render(true);
	}
	private pressable(e: Event): HTMLElement | null {
		const t = e.target as HTMLElement;
		const c = t.closest<HTMLElement>(Q(".card"));
		return c && !t.closest("button, input") ? c : null;
	}

	// Mouse and pen.
	private onPointerDown(e: PointerEvent): void {
		if (e.pointerType === "touch" || e.button !== 0 || this.drag) return;
		const c = this.pressable(e);
		if (c) this.press = { id: c.dataset.id || "", pid: e.pointerId, x: e.clientX, y: e.clientY, touch: false, card: c, timer: 0 };
	}
	private onPointerMove(e: PointerEvent): void {
		if (e.pointerType === "touch") return;
		if (this.drag) this.moveTo(e.clientX, e.clientY);
		else if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 5) {
			const p = this.press;
			this.clearPress();
			this.startDrag(p);
		}
	}
	private onPointerUp(e: PointerEvent): void {
		if (e.pointerType === "touch") return;
		if (this.drag) return this.endDrag(false);
		if (!this.press) return;
		const id = this.press.id;
		this.clearPress();
		this.toggleOpen(id);
	}

	// Fingers. The listeners sit on the pressed card itself: a touch keeps reporting to the element
	// it started on wherever that element goes, so the drag can't lose the finger mid-way.
	private onTouchStart(e: TouchEvent): void {
		if (this.drag || this.press || e.touches.length > 1) return;
		const c = this.pressable(e);
		if (!c) return;
		const t0 = e.changedTouches[0];
		const p: Press = { id: c.dataset.id || "", x: t0.clientX, y: t0.clientY, touch: true, card: c, timer: 0 };
		const mine = (ev: TouchEvent) => Array.from(ev.changedTouches).find((t) => t.identifier === t0.identifier);
		const move = (ev: TouchEvent) => {
			const t = mine(ev);
			if (!t) return;
			if (this.drag) {
				if (ev.cancelable) ev.preventDefault();
				this.moveTo(t.clientX, t.clientY);
			} else if (this.press === p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > 8) this.clearPress(); // it's a scroll
		};
		const end = (ev: TouchEvent) => {
			if (!mine(ev)) return;
			c.removeEventListener("touchmove", move);
			c.removeEventListener("touchend", end);
			c.removeEventListener("touchcancel", end);
			if (this.drag) {
				if (ev.cancelable) ev.preventDefault();
				this.endDrag(false);
			} else if (this.press === p) {
				this.clearPress();
				if (ev.type === "touchend") {
					if (ev.cancelable) ev.preventDefault();
					this.toggleOpen(p.id);
				}
			}
		};
		c.addEventListener("touchmove", move, { passive: false });
		c.addEventListener("touchend", end);
		c.addEventListener("touchcancel", end);
		if ((e.target as HTMLElement).closest(Q(".grip"))) return void this.startDrag(p);
		this.press = p;
		c.classList.add(K("is-pressing"));
		p.timer = window.setTimeout(() => {
			if (this.press !== p) return;
			this.clearPress();
			this.startDrag(p);
		}, 230);
	}

	// ---------- other controls ----------

	private toast(msg: string): void {
		this.root.querySelectorAll(Q(".toast")).forEach((t) => t.remove());
		const t = el("div", "toast", this.root, msg);
		window.setTimeout(() => t.remove(), 2200);
	}

	private onClick(e: MouseEvent): void {
		const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
		if (!b) return;
		const sceneEl = b.closest<HTMLElement>(Q(".scene"));
		const sc = sceneEl ? this.state.scenes[Number(sceneEl.dataset.si)] : null;
		const act = b.dataset.act;
		if (act === "add-scene") {
			let n = this.state.scenes.length + 1;
			while (this.state.scenes.some((s) => s.name === "Scene " + n)) n++;
			this.commit(() => this.state.scenes.push(newScene("Scene " + n)));
		} else if (act === "open") {
			const link = b.closest<HTMLElement>(Q(".card"))?.dataset.link;
			if (link) this.host.open(link);
		} else if (!sc) return;
		else if (act === "collapse" || act === "loose-toggle") {
			const kind = act === "collapse" ? "col" : "min";
			this.host.flags[kind + ":" + sc.name] = !this.flag(kind, sc);
			this.host.saveUi();
			this.render(false);
		} else if (act === "remove-scene") {
			this.commit(() => {
				for (const x of sc.beats) this.state.basket.push(x.item, ...this.sideItems(this.state, x));
				this.state.basket.push(...sc.loose);
				this.state.scenes = this.state.scenes.filter((x) => x !== sc);
			});
			this.toast("Scene removed. Its notes are in the basket");
		}
	}

	private onChange(e: Event): void {
		const t = e.target as HTMLInputElement;
		if (t.classList.contains(K("scene-name"))) {
			const sc = this.state.scenes[Number(t.closest<HTMLElement>(Q(".scene"))?.dataset.si)];
			if (!sc) return;
			let name = t.value.replace(/\s+/g, " ").trim() || "Untitled scene";
			// scene names are how the file tells scenes apart
			while (this.state.scenes.some((s) => s !== sc && s.name === name)) name += " 2";
			const flags = this.host.flags;
			for (const k of ["min:", "col:"]) {
				if (k + sc.name in flags) flags[k + name] = flags[k + sc.name];
				delete flags[k + sc.name];
			}
			this.commit(() => (sc.name = name));
		} else if (t.classList.contains(K("lane-name"))) this.commit(() => this.renameLane(t.dataset.lane || "", t.value));
	}
}
