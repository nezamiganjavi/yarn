// Browser harness for the weave board: a mock note with links, run through the same
// seed / parse / reconcile / save path as in Obsidian. Not shipped in the plugin.
import { Weave, WeaveHost, WeaveUi } from "../src/weave";
import { extractLinks, findBlock, parseWeave, reconcile, replaceBlock, seedWeave, serializeWeave, WeaveModel } from "../src/weavemodel";

const BODIES: Record<string, string> = {
	"He arrives early": "Walks the block twice. Buys a newspaper he can't read.",
	"Lalka's Eyes": "They were the eyes of a cheetah, ferociously intelligent, untamed, and yet gentle beyond rational measure.",
	"She corrects his pronunciation": "Not unkindly. He asks her to do it again.",
	"The bill": "They both reach. Neither wins. They leave too much.",
	"Flashcards on the fridge": "хляб. вода. обичам. He covers the last one with a takeaway menu when his sister visits.",
	"He cooks for her week": "So that she has food for starting her week. Then realises it's Wednesday and her shift only starts next Monday.",
	"Her laugh on the phone": "Lower than in person, like she is keeping it for herself.",
	"Tram bell": "Use somewhere. The 28 rounding the corner right as he decides to speak.",
	"Rule - no interior monologue": "Everything Milād feels in this scene has to be visible in what he does with his hands.",
	"First time she leads": "Mark it. The balance tips here and never fully tips back.",
	"Light in the café": "Late, yellow, from the side. Dust in it.",
	"2026-11-09T07_08_55.452-05_00": "I woke up this morning and I felt at peace.",
};

let note = `# A Portrait of Lalka

Loose ideas: nothing here yet, but see [[Her laugh on the phone]] and [[Tram bell]] and [[Not written yet]].

The second date: [[He arrives early]], [[Lalka's Eyes]], [[She corrects his pronunciation]], [[The bill]], [[Rule - no interior monologue]], [[First time she leads]], [[Light in the café]]

## Learning Bulgarian
- [[Flashcards on the fridge]]
- [[He cooks for her week]]
- [[2026-11-09T07_08_55.452-05_00]]
`;

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.body.classList.add(dark ? "theme-dark" : "theme-light");
const log = (msg: string) => ((document.getElementById("log") as HTMLElement).textContent = msg);

const ui: WeaveUi = { skin: params.get("skin") ?? "yarn", density: "peek", loosePos: "bottom", looseDefaultMin: false, defLeft: "Keep in mind", defThread: "Thread", defRight: "Texture" };
const defaults = { left: ui.defLeft, thread: ui.defThread, right: ui.defRight };
const keyOf = (l: string) => l.toLowerCase();

function read(): { model: WeaveModel; dirty: boolean } {
	const links = extractLinks(note);
	const block = findBlock(note);
	if (!block || !block.body.trim()) return { model: seedWeave(note, links, keyOf, defaults), dirty: true };
	const model = parseWeave(block.body, defaults);
	return { model, dirty: reconcile(model, links, keyOf) };
}
const save = (m: WeaveModel) => {
	note = replaceBlock(note, serializeWeave(m));
	log("saved " + new Date().toLocaleTimeString());
};

const host: WeaveHost = {
	title: "A Portrait of Lalka by Milād",
	info: (link) => ({ title: /^\d{4}-/.test(link) ? "" : link, missing: !(link in BODIES) }),
	read: async (link) => BODIES[link] ?? "",
	open: (link) => log("open " + link),
	openSource: () => log("open source note"),
	save,
	ui,
	flags: {},
	saveUi: () => log("ui saved"),
	isDark: () => dark,
};

const first = read();
if (first.dirty) save(first.model);
const weave = new Weave(document.getElementById("app") as HTMLElement, host, first.model);
Object.assign(window, {
	weave,
	getNote: () => note,
	/** Simulate editing the note outside the board, e.g. `editNote(n => n.replace("[[Tram bell]]", ""))`. */
	editNote: (fn: (n: string) => string) => {
		note = fn(note);
		const r = read();
		weave.setModel(r.model);
		if (r.dirty) save(r.model);
	},
	setSkin: (s: string) => {
		ui.skin = s;
		weave.restyle();
	},
});
document.body.dataset.ready = "1";
