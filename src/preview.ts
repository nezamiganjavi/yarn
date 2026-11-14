// Turns raw markdown into a lightweight card preview (plain text, no renderer).

export type PreviewLine =
	| { kind: "text"; text: string }
	| { kind: "heading"; text: string }
	| { kind: "bullet"; text: string }
	| { kind: "task"; text: string; done: boolean };

export interface Preview {
	lines: PreviewLine[];
	/** First embedded image link target, if any (wikilink path or markdown URL). */
	image?: string;
	/** Whole note as plain lowercase text, for searching. */
	searchText: string;
	truncated: boolean;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function stripFrontmatter(md: string): string {
	if (!md.startsWith("---")) return md;
	const end = md.indexOf("\n---", 3);
	if (end === -1) return md;
	const after = md.indexOf("\n", end + 4);
	return after === -1 ? "" : md.slice(after + 1);
}

export function inlinePlain(s: string): string {
	return s
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]#]+)(#[^\]]*)?\]\]/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/==(.+?)==/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+\^[\w-]+$/, "")
		.trim();
}

function findImage(md: string): string | undefined {
	const re = /!\[\[([^\]|#]+)[^\]]*\]\]|!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(md))) {
		const target = (m[1] || m[2] || "").trim();
		if (IMAGE_EXT.test(target.split("?")[0])) return target;
	}
	return undefined;
}

export function buildPreview(md: string, title: string, maxLines = 10): Preview {
	const body = stripFrontmatter(md).replace(/%%[\s\S]*?%%/g, "");
	const lines: PreviewLine[] = [];
	let inCode = false;
	let lastBlank = true;
	let truncated = false;
	const raw = body.split(/\r?\n/);
	for (let i = 0; i < raw.length; i++) {
		const line = raw[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inCode = !inCode;
			continue;
		}
		if (lines.length >= maxLines) {
			if (line.trim()) {
				truncated = true;
				break;
			}
			continue;
		}
		if (!line.trim()) {
			lastBlank = true;
			continue;
		}
		let item: PreviewLine | null = null;
		const task = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
		const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
		if (inCode) item = { kind: "text", text: line };
		else if (task) item = { kind: "task", done: task[1] !== " ", text: inlinePlain(task[2]) };
		else if (heading) {
			const t = inlinePlain(heading[1]);
			// Skip a leading H1 that just repeats the file name.
			if (lines.length === 0 && t.toLowerCase() === title.toLowerCase()) continue;
			item = { kind: "heading", text: t };
		} else if (bullet) item = { kind: "bullet", text: inlinePlain(bullet[1]) };
		else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) continue;
		// A line that is only #tags is shown as chips at the bottom of the card instead.
		else if (/^\s*(#[^\s#]+\s*)+$/.test(line) && !/^\s*#{1,6}\s/.test(line)) continue;
		else item = { kind: "text", text: inlinePlain(line.replace(/^\s*>\s?/, "")) };
		if (!item.text) continue;
		// Keep consecutive paragraph lines in one block, preserving their line breaks.
		const prev = lines[lines.length - 1];
		if (!lastBlank && prev && prev.kind === "text" && item.kind === "text") prev.text += "\n" + item.text;
		else lines.push(item);
		lastBlank = false;
	}
	return { lines, image: findImage(body), searchText: (title + "\n" + body).toLowerCase(), truncated };
}

/** Obsidian-style default names ("Untitled", "Untitled 3") are hidden on cards, like a blank title. */
export function isPlaceholderTitle(title: string): boolean {
	const t = title.trim();
	// "Untitled", "Untitled 3", or a bare timestamp name that importers give title-less notes,
	// e.g. "2026-11-09T07_08_55.452-05_00". Plain dates like "2026-11-13" still show.
	return /^untitled( \d+)?$/i.test(t) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}[_:.-]?\d{2}([_:.-]?\d{2}([.,]\d+)?)?(Z|[+-]\d{2}[_:]?\d{2})?( \d+)?$/i.test(t);
}
