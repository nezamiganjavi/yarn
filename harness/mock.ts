// Browser harness: mounts the real Board with a mock vault so the UI can be
// screenshotted without Obsidian. Not shipped in the plugin.
import { Board, BoardHost, NoteRef, NoteStyle } from "../src/board";

const ICONS: Record<string, string> = {
	search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	plus: '<path d="M5 12h14M12 5v14"/>',
	"rows-3": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M21 9H3M21 15H3"/>',
	"layout-grid": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4"/>',
	"droplet-off": '<path d="M18.7 13.3a6.9 6.9 0 0 0-1.8-3.8L12 4.5 9.6 6.9M6.2 9.4A7 7 0 0 0 5 13a7 7 0 0 0 12.1 4.9M2 2l20 20"/>',
	"image-off": '<path d="M2 2l20 20M10.4 3H19a2 2 0 0 1 2 2v8.6M21 21H5a2 2 0 0 1-2-2V5"/>',
	"image-plus": '<path d="M16 5h6M19 2v6M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3-3-9 9"/><circle cx="9" cy="9" r="2"/>',
	"file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5M16 13H8M16 17H8"/>',
	"trash-2": '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

const NOTES: Array<{ title: string; body: string; style?: NoteStyle }> = [
	{ title: "Groceries", body: "- [ ] Oat milk\n- [ ] Bananas\n- [x] Coffee beans\n- [ ] Sourdough\n- [x] Eggs\n- [ ] Spinach", style: { color: "sand" } },
	{ title: "Trip ideas", body: "Lisbon in spring — tram 28, pastéis de nata at **Manteigaria**.\n\nPorto after: port cellars + the bookshop.", style: { color: "fog", wallpaper: "waves" } },
	{ title: "Untitled 2", body: "Call the dentist back about Thursday", style: undefined },
	{ title: "Book list", body: "## Reading\n- Piranesi\n- The Dispossessed\n## Next\n- Hyperion\n- Annihilation\n- A Psalm for the Wild-Built" },
	{ title: "Wifi at mum's", body: "Network: `Garden-5G`\nPassword is on the fridge", style: { color: "mint", wallpaper: "leaves" } },
	{ title: "Gift ideas", body: "Alex — fountain pen\nSam — climbing shoes?\nJo — that ceramics class", style: { color: "coral" } },
	{ title: "Weekend", body: "- [ ] Fix the bike tyre\n- [ ] Laundry\n- [ ] Plant the basil", style: { wallpaper: "night", color: "storm" } },
	{ title: "Quotes", body: "> The best way out is always through.\n\n> Simplicity is the ultimate sophistication.", style: { color: "dusk" } },
	{ title: "Meeting notes 11/12", body: "Roadmap review. Decided to ship v2 search first, then sync. [[Q1 planning]] needs updates by Friday. Owner: me.\n\nFollow-ups: ask design about the empty state, confirm budget." },
	{ title: "Recipe: dal", body: "1 cup red lentils\n3 cups water\nTurmeric, cumin, garlic, ginger\nTemper with ghee + mustard seeds", style: { color: "peach", wallpaper: "hills" } },
	{ title: "Run log", body: "Mon 5k 27:10\nWed 8k 44:02\nSat 12k 1:08:30", style: { wallpaper: "grid" } },
	{ title: "Passwords hint", body: "Not here. Use the manager.", style: { color: "chalk" } },
	{ title: "Plants", body: "Water the monstera on Sundays. Fiddle leaf likes the east window.", style: { color: "sage", wallpaper: "peaks" } },
	{ title: "Ideas", body: "App that turns voice memos into checklists\nBoard game about tide pools", style: { wallpaper: "confetti", color: "blossom" } },
	{ title: "Untitled", body: "" },
	{ title: "Movie night", body: "- [x] Arrival\n- [ ] Paterson\n- [ ] Columbus", style: { wallpaper: "aurora" } },
];

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.body.classList.add(dark ? "theme-dark" : "theme-light");

const notes: NoteRef[] = [];
const bodies = new Map<string, string>();
const styles = new Map<string, NoteStyle>();
const now = Date.now();
const count = Number(params.get("count") ?? 60);
for (let i = 0; i < count; i++) {
	const n = NOTES[i % NOTES.length];
	const title = i < NOTES.length ? n.title : `${n.title} (${Math.floor(i / NOTES.length) + 1})`;
	const id = `Notes/${title}.md`;
	notes.push({ id, title, mtime: now - i * 3600_000 });
	bodies.set(id, n.body);
	if (n.style) styles.set(id, { ...n.style });
}

let layout: "grid" | "list" = (params.get("layout") as "list") || "grid";
const log = (msg: string) => ((document.getElementById("log") as HTMLElement).textContent = msg);

const host: BoardHost = {
	listNotes: () => notes.slice(),
	read: async (id) => bodies.get(id) ?? "",
	getStyle: (id) => styles.get(id) ?? {},
	setStyle: async (id, patch) => void styles.set(id, { ...styles.get(id), ...patch }),
	resolveImage: () => null,
	open: (id) => log("open " + id),
	create: () => log("create"),
	remove: async (id) => void log("remove " + id),
	pickImage: async () => null,
	isDark: () => dark,
	icon: (el, name) => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon">${ICONS[name] ?? ""}</svg>`;
		el.insertAdjacentHTML("beforeend", svg);
	},
	previewLines: 10,
	get layout() {
		return layout;
	},
	setLayout: (l) => (layout = l),
};

const root = document.getElementById("app") as HTMLElement;
const board = new Board(root, host);
(window as any).board = board;
void board.restore({ query: params.get("q") ?? "" }).then(() => {
	if (params.get("sheet")) board.openSheet(notes[1].id);
	document.body.dataset.ready = "1";
});
