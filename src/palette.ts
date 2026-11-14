// Card colours and wallpapers. Everything is generated locally (no remote assets).

export interface CardColor {
	id: string;
	label: string;
	light: string;
	dark: string;
}

export const COLORS: CardColor[] = [
	{ id: "coral", label: "Coral", light: "#faafa8", dark: "#77172e" },
	{ id: "peach", label: "Peach", light: "#f39f76", dark: "#692b17" },
	{ id: "sand", label: "Sand", light: "#fff8b8", dark: "#7c4a03" },
	{ id: "mint", label: "Mint", light: "#e2f6d3", dark: "#264d3b" },
	{ id: "sage", label: "Sage", light: "#b4ddd3", dark: "#0c625d" },
	{ id: "fog", label: "Fog", light: "#d4e4ed", dark: "#256377" },
	{ id: "storm", label: "Storm", light: "#aeccdc", dark: "#284255" },
	{ id: "dusk", label: "Dusk", light: "#d3bfdb", dark: "#472e5b" },
	{ id: "blossom", label: "Blossom", light: "#f6e2dd", dark: "#6c394f" },
	{ id: "clay", label: "Clay", light: "#e9e3d4", dark: "#4b443a" },
	{ id: "chalk", label: "Chalk", light: "#efeff1", dark: "#232427" },
];

export function colorById(id: string | undefined): CardColor | undefined {
	if (!id) return undefined;
	const key = String(id).toLowerCase().trim();
	return COLORS.find((c) => c.id === key);
}

/** Accept a palette id or any raw CSS hex colour (e.g. "#ffcc00"). */
export function resolveColor(value: string | undefined, dark: boolean): string | undefined {
	if (!value) return undefined;
	const c = colorById(value);
	if (c) return dark ? c.dark : c.light;
	if (/^#[0-9a-f]{3,8}$/i.test(String(value).trim())) return String(value).trim();
	return undefined;
}

export interface Wallpaper {
	id: string;
	label: string;
	/** Returns CSS for background-image / size / position for the given theme. */
	css(dark: boolean): { image: string; size: string; position: string; repeat: string };
}

const svgUrl = (svg: string) =>
	`url("data:image/svg+xml;utf8,${encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22")}")`;

/** Ink colour for illustrations: dark ink on light cards, light ink on dark cards. */
const ink = (dark: boolean, a: number) => (dark ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);

const bottomArt = (svg: string) => ({ image: svgUrl(svg), size: "100% auto", position: "bottom center", repeat: "no-repeat" });

export const WALLPAPERS: Wallpaper[] = [
	{
		id: "waves",
		label: "Waves",
		css: (d) =>
			bottomArt(
				`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 120'>` +
					`<path d='M0 60 Q50 30 100 60 T200 60 T300 60 T400 60 V120 H0Z' fill='${ink(d, 0.06)}'/>` +
					`<path d='M0 80 Q50 55 100 80 T200 80 T300 80 T400 80 V120 H0Z' fill='${ink(d, 0.08)}'/>` +
					`<path d='M0 100 Q50 80 100 100 T200 100 T300 100 T400 100 V120 H0Z' fill='${ink(d, 0.1)}'/></svg>`,
			),
	},
	{
		id: "hills",
		label: "Hills",
		css: (d) =>
			bottomArt(
				`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 140'>` +
					`<circle cx='320' cy='40' r='18' fill='${ink(d, 0.09)}'/>` +
					`<path d='M0 100 C80 50 160 60 240 95 S360 70 400 85 V140 H0Z' fill='${ink(d, 0.06)}'/>` +
					`<path d='M0 120 C100 80 200 110 280 100 S380 105 400 110 V140 H0Z' fill='${ink(d, 0.1)}'/></svg>`,
			),
	},
	{
		id: "peaks",
		label: "Peaks",
		css: (d) =>
			bottomArt(
				`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 130'>` +
					`<path d='M0 130 L70 50 L120 95 L190 20 L270 110 L320 60 L400 130Z' fill='${ink(d, 0.07)}'/>` +
					`<path d='M190 20 L172 41 L184 38 L192 46 L201 33 L208 40Z' fill='${ink(d, 0.1)}'/>` +
					`<path d='M0 130 L110 90 L200 120 L300 85 L400 120 V130Z' fill='${ink(d, 0.09)}'/></svg>`,
			),
	},
	{
		id: "night",
		label: "Night sky",
		css: (d) => {
			const s = (x: number, y: number, r: number) => `<circle cx='${x}' cy='${y}' r='${r}' fill='${ink(d, 0.16)}'/>`;
			return {
				image: svgUrl(
					`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>` +
						s(20, 30, 1.4) + s(70, 12, 1) + s(120, 48, 1.6) + s(170, 20, 1.1) + s(45, 90, 1) +
						s(150, 110, 1.3) + s(95, 140, 1) + s(25, 170, 1.5) + s(180, 175, 1) + s(110, 90, 0.8) +
						`<path d='M160 60 a14 14 0 1 1 -10 -18 a11 11 0 1 0 10 18z' fill='${ink(d, 0.07)}'/></svg>`,
				),
				size: "200px 200px",
				position: "top left",
				repeat: "repeat",
			};
		},
	},
	{
		id: "dots",
		label: "Dots",
		css: (d) => ({
			image: `radial-gradient(${ink(d, 0.12)} 1.2px, transparent 1.4px)`,
			size: "14px 14px",
			position: "0 0",
			repeat: "repeat",
		}),
	},
	{
		id: "grid",
		label: "Graph paper",
		css: (d) => ({
			image: `linear-gradient(${ink(d, 0.07)} 1px, transparent 1px), linear-gradient(90deg, ${ink(d, 0.07)} 1px, transparent 1px)`,
			size: "16px 16px",
			position: "-1px -1px",
			repeat: "repeat",
		}),
	},
	{
		id: "leaves",
		label: "Leaves",
		css: (d) => {
			const leaf = (x: number, y: number, rot: number, a: number) =>
				`<path transform='translate(${x} ${y}) rotate(${rot})' d='M0 0 C12 -18 34 -18 46 0 C34 18 12 18 0 0Z M0 0 L46 0' fill='${ink(d, a)}' stroke='${ink(d, a + 0.04)}' stroke-width='1'/>`;
			return bottomArt(
				`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 120'>` +
					leaf(330, 115, -60, 0.08) + leaf(345, 112, -100, 0.1) + leaf(360, 118, -35, 0.07) +
					leaf(20, 118, -120, 0.07) + leaf(40, 116, -80, 0.09) + `</svg>`,
			);
		},
	},
	{
		id: "confetti",
		label: "Confetti",
		css: (d) => {
			const a = 0.11;
			return {
				image: svgUrl(
					`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'>` +
						`<rect x='12' y='20' width='10' height='4' rx='2' transform='rotate(30 17 22)' fill='${ink(d, a)}'/>` +
						`<circle cx='70' cy='18' r='3' fill='${ink(d, a)}'/>` +
						`<path d='M120 30 l8 0 l-4 7z' fill='${ink(d, a)}'/>` +
						`<rect x='40' y='70' width='10' height='4' rx='2' transform='rotate(-25 45 72)' fill='${ink(d, a)}'/>` +
						`<circle cx='110' cy='85' r='2.5' fill='${ink(d, a)}'/>` +
						`<path d='M20 120 l8 0 l-4 7z' transform='rotate(40 24 123)' fill='${ink(d, a)}'/>` +
						`<rect x='130' y='130' width='10' height='4' rx='2' transform='rotate(60 135 132)' fill='${ink(d, a)}'/>` +
						`<circle cx='80' cy='140' r='3' fill='${ink(d, a)}'/></svg>`,
				),
				size: "160px 160px",
				position: "0 0",
				repeat: "repeat",
			};
		},
	},
	{
		id: "aurora",
		label: "Aurora",
		css: (d) => ({
			image: d
				? "radial-gradient(120% 80% at 0% 0%, rgba(120,200,255,0.18), transparent 60%), radial-gradient(100% 70% at 100% 100%, rgba(200,120,255,0.18), transparent 60%)"
				: "radial-gradient(120% 80% at 0% 0%, rgba(80,170,255,0.22), transparent 60%), radial-gradient(100% 70% at 100% 100%, rgba(255,120,190,0.22), transparent 60%)",
			size: "100% 100%",
			position: "0 0",
			repeat: "no-repeat",
		}),
	},
];

export function wallpaperById(id: string | undefined): Wallpaper | undefined {
	if (!id) return undefined;
	const key = String(id).toLowerCase().trim();
	return WALLPAPERS.find((w) => w.id === key);
}

/** Wallpapers can also be a vault image, written as a wikilink: "[[photo.jpg]]". */
export function wallpaperImageLink(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const m = /^\s*!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*$/.exec(String(value));
	return m ? m[1].trim() : undefined;
}
