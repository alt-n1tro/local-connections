# Local Connections

A right-side panel for Obsidian that surfaces notes and paragraphs related to whatever you're reading. It runs entirely on a **local Ollama embedding model** (`bge-m3`). Built to replace **Smart Connections** after they paywalled Ollama support.

### How this was made.

Essentially all the code was written with AI - but not one-shot. It was used daily in a real vault and refined over roughly three months of hands-on human testing, with continual fixes and improvements.


### What it does

Open a note and the panel shows two ranked lists (by cosine similarity):

- **Similar notes** - other notes close to this one overall.
- **Similar blocks** - individual paragraphs, from anywhere in the vault, close to a paragraph in the note you're reading.

Notes you already link to are hidden. Every result has a **Copy link** button that puts a `[[wikilink]]` on your clipboard.

Also included:

- **Semantic search** - type a phrase and rank the whole vault against it.
- **Pause / resume** - stop re-embedding while you write; it catches up on resume.
- Embeddings are cached in `vectors.json`, so only changed notes are re-embedded.

### Install

1. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/local-connections/`.
2. In Obsidian: **Settings -> Community plugins -> enable Local Connections**.
3. Make sure Ollama is running with the model pulled - `ollama list` should show
   `bge-m3:latest`. If not, run `ollama run bge-m3:latest` to get the model.
4. First launch embeds the vault once (progress shows in a notice); it's cached after that.
5. Open the panel from the ribbon icon or the command palette.

### Settings

Everything adjustable lives in the plugin's settings tab (**Settings -> Local Connections**) -
which folders to include, how many results to show, similarity thresholds, the Ollama host
and model, and a **Re-embed entire vault** button.

### License

[GNU General Public License v3.0](LICENSE).
