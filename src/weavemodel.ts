// A weave is an arrangement of the notes a note links to. It lives inside that note, in a
// ```weave code block, so it travels and syncs with the note. This file is the plain-data
// side: reading and writing the block, and keeping it in step with the note's links.

export interface WItem {
	id: string;
	/** Link target as written in the note, e.g. "Folder/Note". */
	link: string;
}
export interface WBeat {
	item: WItem;
	/** Side notes tied to this beat, by lane id. */
	sides: Record<string, WItem[]>;
}
export interface WScene {
	id: string;
	name: string;
	loose: WItem[];
	beats: WBeat[];
}
export interface WLane {
	id: string;
	name: string;
	side: "L" | "R";
}
export interface WeaveModel {
	/** Name of the middle lane. */
	thread: string;
	lanes: WLane[];
	/** Linked notes that have not been placed in a scene yet. */
	basket: WItem[];
	scenes: WScene[];
}
export interface WeaveDefaults {
	left: string;
	thread: string;
	right: string;
}
export interface FoundLink {
	link: string;
	line: number;
}

let seq = 0;
const uid = (p: string) => p + (++seq).toString(36) + Date.now().toString(36);
export const newItem = (link: string): WItem => ({ id: uid("n"), link });
export const newScene = (name: string): WScene => ({ id: uid("s"), name, loose: [], beats: [] });
export const newLane = (name: string, side: "L" | "R"): WLane => ({ id: uid("l"), name, side });
const names = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function emptyWeave(d: WeaveDefaults): WeaveModel {
	return {
		thread: d.thread.trim() || "Thread",
		lanes: [...names(d.left).map((n) => newLane(n, "L")), ...names(d.right).map((n) => newLane(n, "R"))],
		basket: [],
		scenes: [],
	};
}

export function allItems(m: WeaveModel): WItem[] {
	const out = [...m.basket];
	for (const sc of m.scenes) {
		out.push(...sc.loose);
		for (const b of sc.beats) {
			out.push(b.item);
			for (const l of m.lanes) out.push(...(b.sides[l.id] ?? []));
		}
	}
	return out;
}

// ---------- the block inside the note ----------

const BLOCK = /^```weave[^\n]*\n([\s\S]*?)^```[ \t]*$/m;

export function findBlock(text: string): { start: number; end: number; body: string } | null {
	const m = BLOCK.exec(text);
	return m ? { start: m.index, end: m.index + m[0].length, body: m[1] } : null;
}

export function replaceBlock(text: string, body: string): string {
	const fenced = "```weave\n" + body + "```";
	const b = findBlock(text);
	if (b) return text.slice(0, b.start) + fenced + text.slice(b.end);
	return text.replace(/\s*$/, "") + (text.trim() ? "\n\n" : "") + fenced + "\n";
}

const LINK = /(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** Wikilinks in the note, in order, ignoring embeds, frontmatter and code blocks (the weave block included). */
export function extractLinks(text: string): FoundLink[] {
	const out: FoundLink[] = [];
	const lines = text.split(/\r?\n/);
	let fence = false;
	let i = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.indexOf("---", 1);
		if (end > 0) i = end + 1;
	}
	for (; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		LINK.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = LINK.exec(lines[i]))) if (!m[1] && m[2].trim()) out.push({ link: m[2].trim(), line: i });
	}
	return out;
}

const first = (s: string) => {
	LINK.lastIndex = 0;
	const m = LINK.exec(s);
	return m ? m[2].trim() : null;
};

export function parseWeave(body: string, d: WeaveDefaults): WeaveModel {
	const m: WeaveModel = { thread: "", lanes: [], basket: [], scenes: [] };
	let sawLanes = false;
	let scene: WScene | null = null;
	let beat: WBeat | null = null;
	for (const raw of body.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		const head = /^(left|right|thread):\s*(.*)$/i.exec(raw.trim());
		if (head && !scene && !m.basket.length) {
			const key = head[1].toLowerCase();
			if (key === "thread") m.thread = head[2].trim();
			else for (const n of names(head[2])) m.lanes.push(newLane(n, key === "left" ? "L" : "R"));
			sawLanes = true;
			continue;
		}
		const h = /^#{1,6}\s+(.*)$/.exec(raw);
		if (h) {
			scene = newScene(h[1].trim() || "Untitled scene");
			m.scenes.push(scene);
			beat = null;
			continue;
		}
		const link = first(raw);
		if (!link) continue;
		const item = newItem(link);
		const indented = /^\s+/.test(raw);
		const lane = /^\s*[-*+]\s+\(([^)]*)\)/.exec(raw);
		if (/^\s*(?:[-*+]\s+)?~/.test(raw) || !scene) (scene ? scene.loose : m.basket).push(item);
		else if (indented && beat && lane) {
			const name = lane[1].trim();
			let l = m.lanes.find((x) => x.name.toLowerCase() === name.toLowerCase());
			if (!l) m.lanes.push((l = newLane(name || "Lane", "R")));
			(beat.sides[l.id] = beat.sides[l.id] ?? []).push(item);
		} else if (indented && beat) scene.loose.push(item);
		else scene.beats.push((beat = { item, sides: {} }));
	}
	if (!sawLanes) m.lanes = emptyWeave(d).lanes;
	if (!m.thread) m.thread = d.thread.trim() || "Thread";
	return m;
}

export function serializeWeave(m: WeaveModel): string {
	const l = (it: WItem) => `[[${it.link}]]`;
	const list = (side: "L" | "R") => m.lanes.filter((x) => x.side === side).map((x) => x.name.replace(/,/g, " ")).join(", ");
	const out = [`left: ${list("L")}`, `thread: ${m.thread}`, `right: ${list("R")}`];
	for (const it of m.basket) out.push(`~ ${l(it)}`);
	for (const sc of m.scenes) {
		out.push("", `## ${sc.name}`);
		for (const b of sc.beats) {
			out.push(`- ${l(b.item)}`);
			for (const lane of m.lanes) for (const it of b.sides[lane.id] ?? []) out.push(`    - (${lane.name.replace(/[()]/g, "")}) ${l(it)}`);
		}
		for (const it of sc.loose) out.push(`~ ${l(it)}`);
	}
	return out.join("\n") + "\n";
}

// ---------- keeping the weave in step with the note ----------

/**
 * Make the weave hold exactly the notes the note links to: drop the ones no longer linked,
 * put newly linked ones in the basket. `keyOf` says when two links mean the same note.
 * Returns true if anything changed.
 */
export function reconcile(m: WeaveModel, links: FoundLink[], keyOf: (link: string) => string): boolean {
	const wanted = new Map<string, string>();
	for (const f of links) if (!wanted.has(keyOf(f.link))) wanted.set(keyOf(f.link), f.link);
	const seen = new Set<string>();
	let changed = false;
	const keep = (arr: WItem[]) =>
		arr.filter((it) => {
			const k = keyOf(it.link);
			const ok = wanted.has(k) && !seen.has(k);
			if (ok) seen.add(k);
			else changed = true;
			return ok;
		});
	m.basket = keep(m.basket);
	for (const sc of m.scenes) {
		const beats: WBeat[] = [];
		for (const b of sc.beats) {
			const [self] = keep([b.item]);
			if (self) {
				for (const k of Object.keys(b.sides)) b.sides[k] = keep(b.sides[k]);
				beats.push(b);
			} else sc.loose.push(...Object.values(b.sides).flat()); // its side notes stay, as loose notes of the scene
		}
		sc.beats = beats;
		sc.loose = keep(sc.loose);
	}
	for (const [k, link] of wanted) {
		if (seen.has(k)) continue;
		m.basket.push(newItem(link));
		changed = true;
	}
	return changed;
}

/**
 * First weave for a note: follow the shape the note already has. Links under a heading, or on
 * a line like "Scene 2: [[a]], [[b]]", become that scene's thread in order; the rest go to the basket.
 */
export function seedWeave(text: string, links: FoundLink[], keyOf: (link: string) => string, d: WeaveDefaults): WeaveModel {
	const m = emptyWeave(d);
	const lines = text.split(/\r?\n/);
	const sceneAt: Array<string | null> = [];
	let current: string | null = null;
	for (const line of lines) {
		const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
		const label = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\**([^[\]:*]{1,80}?)\**\s*:\**\s*(.*)$/.exec(line);
		if (h) current = h[1].length === 1 ? null : h[2].trim(); // an H1 is the note's title, not a scene
		else if (label && (label[2].trim() === "" || /^\s*\[\[/.test(label[2]))) current = label[1].trim();
		sceneAt.push(current);
	}
	const seen = new Set<string>();
	const scenes = new Map<string, WScene>();
	for (const f of links) {
		const k = keyOf(f.link);
		if (seen.has(k)) continue;
		seen.add(k);
		const name = sceneAt[f.line];
		if (!name) {
			m.basket.push(newItem(f.link));
			continue;
		}
		let sc = scenes.get(name);
		if (!sc) {
			sc = newScene(name);
			scenes.set(name, sc);
			m.scenes.push(sc);
		}
		sc.beats.push({ item: newItem(f.link), sides: {} });
	}
	return m;
}
