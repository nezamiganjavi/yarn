# Jotboard

A roomy, card-based home screen for Obsidian, built for phones:

- **Card grid.** Notes appear as cards in a two-column masonry layout (more columns on tablets), newest edited first. Cards load in batches as you scroll, so large vaults stay fast. A button in the search bar switches to a single-column list.
- **Search bar.** Searches note titles and text as you type. Separate words must all match.
- **Big + button.** Creates a note in Obsidian's *Default location for new notes* and opens it ready to type.
- **Colours and wallpapers.** Long-press a card (or right-click it on desktop) to open the sheet. It offers 11 colours, each with light and dark versions, 9 built-in wallpapers, and the option to use any image from your vault as a wallpaper.
- **Checklists and images in previews.** `- [ ]` tasks show as checkboxes, and the first image embedded in a note appears at the top of its card.
- **Replaces the landing page.** The board opens when Obsidian starts (you can turn this off in settings). Notes open in the same tab, so Back returns you to the board, and the board tries to restore your scroll position and search.

Everything is generated locally, and the plugin never loads anything from the internet (remote image links in notes are not shown on cards).

## Where colours are stored

Colours and wallpapers are saved as properties in the note's frontmatter, so they sync with the note:

```yaml
---
card-color: mint            # coral, peach, sand, mint, sage, fog, storm, dusk, blossom, clay, chalk, or a hex value like "#ffcc00"
card-wallpaper: hills       # waves, hills, peaks, night, dots, grid, leaves, confetti, aurora, or "[[some image.jpg]]"
---
```

Changing a colour keeps the note's "last modified" time, so the note doesn't jump to the top of the board.

## Install on Android (manual)

1. Download `jotboard.zip` (or the three files `main.js`, `manifest.json` and `styles.css` from this repo).
2. On your phone, open your vault folder with a file manager and go to `.obsidian/plugins/`. Hidden folders must be visible to see `.obsidian`. Create a folder called `jotboard` there.
3. Put `main.js`, `manifest.json` and `styles.css` inside `.obsidian/plugins/jotboard/`.
4. In Obsidian, go to **Settings → Community plugins**. Turn off Restricted mode if it's on, tap the refresh icon, and enable **Jotboard**.
5. Restart Obsidian, and the board will be your home screen.

If your vault syncs from a computer (Syncthing, Obsidian Sync with plugin syncing on, etc.), you can do steps 2–3 on the computer instead.

## Settings

- **Open on startup**: show the board instead of the usual landing page.
- **Folder**: only show notes in one folder. Leave empty to show the whole vault.
- **Excluded folders**: hide folders such as Templates.
- **Sort by**: last edited, created, or name.
- **Preview lines**: how much of each note appears on its card.
- **+ button colour**: nine presets plus the theme accent, or any colour from the picker. The + sign switches between white and dark automatically so it stays readable.

## Development

```bash
npm install
npm run build      # type-check + bundle main.js
npm run harness    # build the browser test harness, then open harness/index.html
```

`harness/index.html` mounts the real board against a mock vault. Use query parameters to change what it shows: `?theme=dark`, `?sheet=1`, `?q=milk`, `?layout=list`, `?count=0`.
