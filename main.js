'use strict';

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, Modal, debounce } = require('obsidian');

/* ============================================================================
 *  TUNABLES  —  edit these freely, then reload the plugin (or restart Obsidian)
 * ----------------------------------------------------------------------------
 *  Everything you'd want to experiment with lives here at the top so you never
 *  have to dig through the code. All are safe to change; mistakes here won't
 *  corrupt your vault (worst case: re-embed via the settings button).
 * ==========================================================================*/
const TUNABLES = {
  // --- connection / model ---
  OLLAMA_HOST: 'http://localhost:11434',
  MODEL: 'bge-m3:latest',

  // --- how many results to show in each panel section ---
  NOTE_RESULT_LIMIT: 25,   // "Similar notes" (whole-note cosine)
  BLOCK_RESULT_LIMIT: 25,  // "Similar blocks" (flat, block-ranked)

  // --- power scaling ---
  // Sorting/threshold uses scaled = rawCosine ^ BETA.
  // BETA > 1 spreads out a bunched high-similarity distribution (bge-m3 tends
  // to cluster scores). Your prior Smart Connections tuning used ~3. Try 1
  // (off), 2, 3, 4. Larger BETA exaggerates differences among top results.
  BETA: 3,

  // What number to DISPLAY on each row: 'raw' shows the true cosine (0..1),
  // 'scaled' shows rawCosine^BETA. Sorting always uses the scaled value.
  DISPLAY_SCORE: 'raw',     // 'raw' | 'scaled'
  SCORE_DECIMALS: 3,        // decimal places shown

  // --- thresholds: hide weak matches entirely (compared against SCALED score) ---
  // Set to 0 to show everything up to the limit.
  NOTE_MIN_SCALED_SCORE: 0,
  BLOCK_MIN_SCALED_SCORE: 0,

  // --- block splitting ---
  MIN_BLOCK_CHARS: 40,      // blocks shorter than this are ignored
  MIN_NOTE_CHARS: 100,      // notes shorter than this aren't embedded at all

  // --- whole-note embedding cutoff ---
  // bge-m3 tops out at 8192 tokens (~4 chars/token). Above this the whole-note
  // vector would be silently truncated and become meaningless, so we skip it and
  // store noteVec as null. Block vectors are unaffected (each block is small).
  // ~28k chars keeps a safety margin under the 8192-token ceiling.
  NOTE_EMBED_MAX_CHARS: 28000,

  // --- embedding request batching ---
  // Ollama /api/embed accepts an array in `input`; we send inputs in chunks of
  // this size rather than one POST per block.
  BATCH_SIZE: 50,

  // Abort an Ollama request that hasn't responded in this many ms. A *hung*
  // (as opposed to failing) server would otherwise leave the embed loop waiting
  // forever with the "embedding" flag stuck on, freezing all further indexing.
  REQUEST_TIMEOUT_MS: 120000,

  // Expected embedding width. A vector of any other length can't be compared
  // (cosine returns -1), so those notes would silently never match anything.
  // Set to 0 to disable the check.
  EXPECTED_DIM: 1024,

  // --- block display ---
  BLOCK_PREVIEW_CHARS: 220, // how much of a matching block's text to show (collapsed)
  BLOCK_EXPANDED_MAX_CHARS: 800, // cap when you click a block to expand it (~150 words);
                                 // past this, open the note instead
  SHOW_CURRENT_BLOCK: true, // also show WHICH block of the current note matched

  // --- character caps (edit freely) ---
  // Max chars of a note's TITLE shown in the collapsed row (Similar notes tab).
  NOTE_TITLE_MAX_CHARS: 140,
  // Max chars of a note's BODY shown when you expand a row's dropdown.
  NOTE_EXPANDED_MAX_CHARS: 600,
  // Max chars of a note's TITLE shown on each result in the Similar blocks tab.
  BLOCK_TITLE_MAX_CHARS: 140,
  // Max chars of each block's text shown in the Drift window.
  DRIFT_BLOCK_PREVIEW_CHARS: 160,

  // --- behavior ---
  DEFAULT_TAB: 'notes',     // which tab opens first: 'notes' | 'blocks'
  EXCLUDE_LINKED_NOTES: true, // hide notes you directly link out to (both sections)

  // --- consensus gate (Similar blocks) ---
  // Blocks are ranked by their RAW similarity by default. The gate only kicks in
  // for SHORT paragraphs (at/below BLOCK_GATE_MAX_CHARS): a short block's score
  // becomes block cosine * the two notes' whole-note cosine, so a tiny generic
  // passage matching between topically unrelated notes (the classic false
  // positive) is demoted, while a long, substantive paragraph is trusted on its
  // own similarity. Notes with no whole-note vector (over-length docs) are never
  // gated — there's nothing to gate against.
  BLOCK_GATE_ENABLED: true,
  // Only block matches whose SUGGESTED paragraph is at/below this many characters
  // are gated; longer ones are ranked purely by raw similarity.
  BLOCK_GATE_MAX_CHARS: 85,
  // For gated (short) blocks only: skip one entirely when the two notes'
  // whole-note similarity is at/below this. 0 = never hide, only demote (the
  // default) — a low whole-note score is exactly the cross-domain case Strange
  // pairs is built to surface.
  BLOCK_GATE_FLOOR: 0,

  // --- strange pairs (third tab, shown only when non-empty) ---
  // Notes whose BODY agrees with the current note but whose TITLE doesn't —
  // same substance, different framing. The cross-domain connection seed.
  STRANGE_MIN_BODY: 0.6,    // bodies must agree at least this much
  STRANGE_MIN_DELTA: 0.15,  // ...and agree this much MORE than the titles do
  STRANGE_RESULT_LIMIT: 15,

  // --- gravity (top of Similar notes) ---
  // Which notes your RECENT thinking keeps circling: take the N most recently
  // touched notes, look at each one's top-K whole-note neighbours, and surface
  // the notes that recur across at least MIN_COUNT of those neighbourhoods. A
  // note already linked from the one you're reading is skipped — you've
  // already found it — and the next-best attractor takes its place instead.
  GRAVITY_ENABLED: true,
  GRAVITY_RECENT_N: 30,
  GRAVITY_TOP_K: 8,
  GRAVITY_MIN_SIM: 0.45,
  GRAVITY_MIN_COUNT: 2,
  GRAVITY_MAX_SHOW: 2,

  // ALLOWLIST: ONLY notes under these folder paths are embedded. Everything
  // else is skipped. Whether a note gets a whole-note vector is decided purely
  // by length (NOTE_EMBED_MAX_CHARS), not by folder — long docs (e.g. YouTube
  // transcripts) get block vectors only, with noteVec stored as null.
  INCLUDED_FOLDERS: [
    '5 - Permanent Notes',
  ],

  // --- performance ---
  SAVE_EVERY_N: 10,         // flush vectors.json to disk every N notes during a full embed
  SWITCH_DEBOUNCE_MS: 150,  // delay before recomputing on note-switch
  MODIFY_DEBOUNCE_MS: 800,  // delay before re-embedding an edited note
};
/* ==========================================================================*/

// A frozen snapshot of the literal defaults above, taken before any saved
// settings are overlaid onto TUNABLES at load. Used as the fallback for an
// invalid value and by the settings tab's "Reset to defaults".
const TUNABLE_DEFAULTS = JSON.parse(JSON.stringify(TUNABLES));

/* ============================================================================
 *  SETTINGS SCHEMA
 * ----------------------------------------------------------------------------
 *  Drives BOTH the settings tab UI and which TUNABLES keys are persisted. Every
 *  key here can be edited from Obsidian's plugin settings without touching
 *  main.js. `reembed: true` marks a setting that changes what/how notes are
 *  embedded — the value saves immediately but only takes effect after a
 *  re-embed (the tab shows a reminder and a Re-embed button).
 * ==========================================================================*/
const SETTINGS_SCHEMA = [
  {
    name: 'Connection',
    desc: 'Where the local embedding model lives.',
    items: [
      { key: 'OLLAMA_HOST', name: 'Ollama host', type: 'text',
        desc: 'URL of your local Ollama server.\nExample: http://localhost:11434' },
      { key: 'MODEL', name: 'Embedding model', type: 'text', reembed: true,
        desc: 'The Ollama model used for embeddings — it must be pulled first (ollama pull <model>). Changing this invalidates the whole cache.\nExample: bge-m3:latest' },
      { key: 'EXPECTED_DIM', name: 'Embedding dimension', type: 'int', min: 0, reembed: true,
        desc: 'The vector width the model outputs (bge-m3 = 1024). Vectors of any other length can’t be compared, so those notes silently never match — change this ONLY if you switch to a model with a different dimension. 0 turns the safety check off.\nDefault: 1024' },
    ],
  },
  {
    name: 'What gets embedded',
    desc: 'Which notes are indexed, and the length rules that decide what counts. Folder changes apply automatically; the length rules need a re-embed.',
    items: [
      { key: 'INCLUDED_FOLDERS', name: 'Included folders', type: 'folders',
        desc: 'One folder path per line. ONLY notes under these folders are indexed; everything else is ignored. Applies when you click away from the box.\nExample:\n5 - Permanent Notes\n10 - News Articles' },
      { key: 'MIN_NOTE_CHARS', name: 'Minimum note length', type: 'int', min: 0, reembed: true,
        desc: 'Notes shorter than this many characters (after cleaning) are skipped entirely.\nDefault: 100' },
      { key: 'MIN_BLOCK_CHARS', name: 'Minimum block length', type: 'int', min: 0, reembed: true,
        desc: 'Paragraphs shorter than this are dropped, so headers and one-word lines don’t become blocks.\nDefault: 40' },
      { key: 'NOTE_EMBED_MAX_CHARS', name: 'Whole-note size cap', type: 'int', min: 1000, reembed: true,
        desc: 'A note longer than this (~28k chars ≈ the model’s 8192-token limit) is embedded at the block level only — its whole-note vector is skipped rather than silently truncated. Long transcripts fall here.\nDefault: 28000' },
    ],
  },
  {
    name: 'Results & display',
    desc: 'How many results show, and how they look.',
    items: [
      { key: 'NOTE_RESULT_LIMIT', name: 'Max similar notes', type: 'int', min: 1,
        desc: 'How many rows the Notes tab shows.\nDefault: 25' },
      { key: 'BLOCK_RESULT_LIMIT', name: 'Max similar blocks', type: 'int', min: 1,
        desc: 'How many rows the Blocks tab shows.\nDefault: 25' },
      { key: 'DEFAULT_TAB', name: 'Default tab', type: 'select', options: { notes: 'Notes', blocks: 'Blocks' },
        desc: 'Which tab is active when the panel first opens.\nDefault: Notes' },
      { key: 'EXCLUDE_LINKED_NOTES', name: 'Hide already-linked notes', type: 'toggle',
        desc: 'When on, notes you already link to from the current note are hidden from the results — you’ve handled those.\nDefault: on' },
      { key: 'SHOW_CURRENT_BLOCK', name: 'Show which block matched', type: 'toggle',
        desc: 'In the Blocks tab, also show which paragraph of YOUR note the match was closest to.\nDefault: on' },
      { key: 'BLOCK_PREVIEW_CHARS', name: 'Block preview length', type: 'int', min: 40,
        desc: 'How much of a matching paragraph to show before you click to expand it.\nDefault: 220' },
      { key: 'BLOCK_EXPANDED_MAX_CHARS', name: 'Block expanded length', type: 'int', min: 100,
        desc: 'The cap when you click a block to expand it (~150 words). Past this, open the note instead.\nDefault: 800' },
      { key: 'DISPLAY_SCORE', name: 'Score shown', type: 'select', options: { raw: 'Raw cosine', scaled: 'Power-scaled' },
        desc: 'Whether each row shows the true cosine similarity or the power-scaled value. Sorting always uses the scaled value.\nDefault: Raw cosine' },
      { key: 'SCORE_DECIMALS', name: 'Score decimals', type: 'int', min: 0, max: 6,
        desc: 'Decimal places shown on scores.\nDefault: 3' },
    ],
  },
  {
    name: 'Ranking',
    desc: 'How matches are scored and filtered.',
    items: [
      { key: 'BETA', name: 'Power scaling (BETA)', type: 'slider', min: 1, max: 5, step: 0.5,
        desc: 'bge-m3 scores bunch up in a narrow high band; raising this spreads the top results apart so the best matches stand out. 1 = off (raw cosine). It doesn’t reorder — it reshapes the spread.\nDefault: 3' },
      { key: 'NOTE_MIN_SCALED_SCORE', name: 'Notes: hide weak matches below', type: 'slider', min: 0, max: 1, step: 0.02,
        desc: 'Hide similar-note results whose (scaled) score is below this. 0 = show everything up to the limit.\nDefault: 0' },
      { key: 'BLOCK_MIN_SCALED_SCORE', name: 'Blocks: hide weak matches below', type: 'slider', min: 0, max: 1, step: 0.02,
        desc: 'Same, for the Blocks tab. 0 = show everything.\nDefault: 0' },
    ],
  },
  {
    name: 'Similar-blocks gate',
    desc: 'Blocks are ranked by their raw similarity. Short paragraphs — the false-positive risk — are additionally weighted by how related the two notes are, so a tiny generic passage matching between unrelated notes gets demoted.',
    items: [
      { key: 'BLOCK_GATE_ENABLED', name: 'Consensus gate (short blocks)', type: 'toggle',
        desc: 'For SHORT block matches only (see the length below), rank by (block similarity × whole-note similarity) instead of raw similarity — pushing a short passage that matches between two unrelated notes down the list. Long paragraphs are always ranked raw.\nDefault: on' },
      { key: 'BLOCK_GATE_MAX_CHARS', name: 'Gate length threshold', type: 'int', min: 0,
        desc: 'Only block matches whose suggested paragraph is at/below this many characters get gated; longer ones are ranked purely by raw similarity.\nDefault: 85' },
      { key: 'BLOCK_GATE_FLOOR', name: 'Gate floor', type: 'slider', min: 0, max: 0.9, step: 0.05,
        desc: 'For gated (short) blocks only: hide one entirely when the two notes’ whole-note similarity is at/below this. 0 = never hide, only demote — recommended, so cross-domain matches stay visible.\nDefault: 0' },
    ],
  },
  {
    name: 'Strange pairs',
    desc: 'Notes that agree in substance but not in framing — the cross-domain connection seed. Its tab only appears when there’s at least one.',
    items: [
      { key: 'STRANGE_MIN_BODY', name: 'Min body agreement', type: 'slider', min: 0, max: 1, step: 0.02,
        desc: 'Two notes’ bodies must be at least this similar to count as a pair.\nDefault: 0.6' },
      { key: 'STRANGE_MIN_DELTA', name: 'Min framing gap', type: 'slider', min: 0, max: 0.5, step: 0.02,
        desc: '…and their bodies must agree this much MORE than their titles do. Higher = only “same idea, very different framing” pairs.\nDefault: 0.15' },
      { key: 'STRANGE_RESULT_LIMIT', name: 'Max pairs', type: 'int', min: 1,
        desc: 'How many pairs to show.\nDefault: 15' },
    ],
  },
  {
    name: 'Gravity',
    desc: 'Notes your recent thinking keeps circling, surfaced at the top of the Notes tab.',
    items: [
      { key: 'GRAVITY_ENABLED', name: 'Enable gravity', type: 'toggle',
        desc: 'Turn the Gravity section on or off.\nDefault: on' },
      { key: 'GRAVITY_RECENT_N', name: 'Recent notes considered', type: 'int', min: 3,
        desc: 'How many of your most recently edited notes count as “recent thinking”.\nDefault: 30' },
      { key: 'GRAVITY_TOP_K', name: 'Neighbours per note', type: 'int', min: 1,
        desc: 'How many nearest neighbours of each recent note to look at.\nDefault: 8' },
      { key: 'GRAVITY_MIN_SIM', name: 'Neighbour threshold', type: 'slider', min: 0, max: 1, step: 0.02,
        desc: 'A note only counts as a neighbour above this similarity.\nDefault: 0.45' },
      { key: 'GRAVITY_MIN_COUNT', name: 'Min recurrences', type: 'int', min: 1,
        desc: 'A note must appear in at least this many recent neighbourhoods to be an attractor.\nDefault: 2' },
      { key: 'GRAVITY_MAX_SHOW', name: 'Max shown', type: 'int', min: 1,
        desc: 'How many attractors to show at the top.\nDefault: 2' },
    ],
  },
  {
    name: 'Advanced',
    desc: 'Performance and internals — most people never need to touch these.',
    items: [
      { key: 'BATCH_SIZE', name: 'Embedding batch size', type: 'int', min: 1,
        desc: 'How many texts are sent to Ollama per request.\nDefault: 50' },
      { key: 'REQUEST_TIMEOUT_MS', name: 'Request timeout (ms)', type: 'int', min: 1000,
        desc: 'Abort an Ollama request that hasn’t responded in this long, so a hung server can’t freeze indexing.\nDefault: 120000' },
      { key: 'SAVE_EVERY_N', name: 'Save every N notes', type: 'int', min: 1,
        desc: 'Flush the vector cache to disk every N notes during a long embed, so a crash loses at most this many.\nDefault: 10' },
      { key: 'SWITCH_DEBOUNCE_MS', name: 'Note-switch debounce (ms)', type: 'int', min: 0,
        desc: 'Delay before recomputing results after you switch notes.\nDefault: 150' },
      { key: 'MODIFY_DEBOUNCE_MS', name: 'Edit debounce (ms)', type: 'int', min: 0,
        desc: 'Delay before re-embedding a note after you stop editing it.\nDefault: 800' },
      { key: 'NOTE_TITLE_MAX_CHARS', name: 'Note title cap', type: 'int', min: 20,
        desc: 'Max characters of a note title shown in a Notes-tab row.\nDefault: 140' },
      { key: 'BLOCK_TITLE_MAX_CHARS', name: 'Block title cap', type: 'int', min: 20,
        desc: 'Max characters of a note title shown on each Blocks-tab and Pairs-tab row.\nDefault: 140' },
      { key: 'NOTE_EXPANDED_MAX_CHARS', name: 'Note body preview cap', type: 'int', min: 50,
        desc: 'Max characters of body shown in an expanded note dropdown.\nDefault: 600' },
      { key: 'DRIFT_BLOCK_PREVIEW_CHARS', name: 'Drift block preview cap', type: 'int', min: 40,
        desc: 'Max characters of each block shown in the Drift window.\nDefault: 160' },
    ],
  },
];

// Flat list of every persisted setting, derived from the schema.
const SETTINGS_ITEMS = SETTINGS_SCHEMA.reduce((acc, cat) => acc.concat(cat.items), []);

// Validate/coerce a raw value (from disk or a UI control) for a setting item.
// Falls back to the item's default on anything unusable.
function coerceSetting(item, raw, fallback) {
  switch (item.type) {
    case 'toggle':
      return !!raw;
    case 'select':
      return (item.options && Object.prototype.hasOwnProperty.call(item.options, raw)) ? raw : fallback;
    case 'text':
      return typeof raw === 'string' ? raw : (raw == null ? fallback : String(raw));
    case 'folders': {
      // Strip surrounding slashes: isExcluded() matches on `folder + '/'`, so a
      // pasted "5 - Permanent Notes/" would otherwise never match anything and
      // silently index nothing.
      const clean = (list) => list
        .map((s) => String(s).trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean);
      if (Array.isArray(raw)) return clean(raw);
      if (typeof raw === 'string') return clean(raw.split('\n'));
      return Array.isArray(fallback) ? fallback.slice() : [];
    }
    case 'int':
    case 'number':
    case 'slider': {
      let n = typeof raw === 'number' ? raw : parseFloat(raw);
      if (!isFinite(n)) return fallback;
      if (item.type === 'int') n = Math.round(n);
      if (typeof item.min === 'number') n = Math.max(item.min, n);
      if (typeof item.max === 'number') n = Math.min(item.max, n);
      return n;
    }
    default:
      return raw;
  }
}

const VIEW_TYPE = 'local-connections-view';

// vectors.json schema version.
//   v3: noteVec = embed(title + body), may be null for over-length docs.
//   v4: adds bodyVec = embed(body) (for title-vs-body drift) and per-field
//       titleHash / bodyHash for precise, cheap reuse. v2/v3 migrate in place.
const STORE_FORMAT = 4;

// Version of the TEXT CLEANING rules in splitIntoBlocks().
//
// *** BUMP THIS whenever you change splitIntoBlocks() ***
//
// Why this exists: embedFile() skips a note entirely when its mtime is unchanged,
// without ever reading the file. So changing the cleaning rules would NOT
// re-process existing notes — the change silently applied only to notes you
// happened to edit afterwards. (That's how the code-fence strip failed to take:
// 111 already-cached blocks kept their fences.) Each entry records the cleaning
// version it was built with; a mismatch defeats the fast path, so exactly one
// re-read + re-split pass happens and only genuinely changed blocks re-embed.
//   1 = original rules
//   2 = + fenced code blocks stripped, + images/embeds stripped
const CLEAN_VERSION = 2;

// ---------- pure utilities ----------

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// scaled = raw^BETA. Cosine can be slightly negative for unrelated items;
// clamp negatives to 0 before exponentiating so scaling stays monotonic.
function powerScale(raw) {
  const clamped = raw < 0 ? 0 : raw;
  return Math.pow(clamped, TUNABLES.BETA);
}

// Split note body into blocks. Strips metadata + "->" footer, splits on blank
// lines, keeps a list attached to the paragraph above it, drops short blocks.
function splitIntoBlocks(content) {
  // Drop fenced code blocks (```lang … ``` or ~~~ … ~~~) — diagrams and code
  // (tikz, etc.) carry no prose meaning, so they shouldn't skew the note/body
  // vectors or the title↔body drift. Mirrors stats.py's word-count rule.
  content = content.replace(/(```|~~~)[\s\S]*?\1/g, '\n');
  // Drop embeds and images. "![[file.jpeg|341]]" is a filename, not prose — but
  // it's long enough to clear MIN_BLOCK_CHARS, so it used to survive as a block
  // and then match OTHER image blocks (filename-to-filename similarity), which
  // is pure noise. Stripped everywhere (not just whole lines) so an image sitting
  // inside a paragraph doesn't pollute that paragraph's vector either; a block
  // left with nothing but an image falls below MIN_BLOCK_CHARS and is dropped.
  content = content
    .replace(/!\[\[[^\]]*\]\]/g, ' ')          // Obsidian embed: ![[img.png|300]]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // markdown image: ![alt](url)
    .replace(/<img\b[^>]*>/gi, ' ');           // raw HTML image
  const lines = content.split('\n');
  const cleaned = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^Date:\s/i.test(t)) continue;
    if (/^epistemic_status:/i.test(t)) continue;
    if (/^#\w+$/.test(t)) continue;      // lone tag line
    if (/^-{3,}$/.test(t)) continue;     // horizontal rule
    if (/^->/.test(t)) continue;         // trailing source-link footer
    // transcript diarization header, e.g. "[00:02:56 - 00:02:57] SPEAKER_00"
    // or "[00:02:56 - 00:02:57] UNKNOWN" — carries no meaning, drop it (and
    // don't let it count toward MIN_BLOCK_CHARS on the utterance below).
    if (/^\[\d{1,2}:\d{2}:\d{2}\s*-\s*\d{1,2}:\d{2}:\d{2}\]\s+(SPEAKER_\d+|UNKNOWN)\s*$/.test(t)) continue;
    cleaned.push(line);
  }
  const text = cleaned.join('\n');

  const rawChunks = text.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);

  const merged = [];
  for (const chunk of rawChunks) {
    const firstLine = chunk.split('\n')[0];
    const startsAsList = /^\s*([-*+]|\d+\.)\s/.test(firstLine);
    if (startsAsList && merged.length) {
      merged[merged.length - 1] += '\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }

  return merged.filter(
    (b) => b.replace(/\s+/g, ' ').length >= TUNABLES.MIN_BLOCK_CHARS
  );
}

// Whole-note text for note-level embedding: same cleaning, joined back.
function noteBodyForEmbedding(content) {
  return splitIntoBlocks(content).join('\n\n').trim();
}

function extractOutgoingLinks(content) {
  const targets = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let inner = m[1];
    const pipe = inner.indexOf('|');
    if (pipe !== -1) inner = inner.slice(0, pipe);
    inner = inner.split('#')[0].split('^')[0].trim();
    if (inner) targets.add(inner.toLowerCase());
  }
  return targets;
}

function truncate(str, n) {
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

// debounce() whose delay tracks TUNABLES[key] live. Obsidian's debounce bakes
// the delay in at creation, so building it once in onload() meant edits to the
// debounce settings did nothing until the plugin was reloaded.
function liveDebounce(fn, key, resetTimer) {
  let ms = null;
  let d = null;
  return (...args) => {
    if (TUNABLES[key] !== ms) {
      if (d && d.cancel) d.cancel();
      ms = TUNABLES[key];
      d = debounce(fn, ms, resetTimer);
    }
    return d(...args);
  };
}

// ---------- plugin ----------

module.exports = class LocalConnectionsPlugin extends Plugin {
  async onload() {
    await this.loadSettings(); // overlays saved settings onto TUNABLES + sets this.paused

    // store: path -> { hash, noteVec, blocks: [{ text, vec }] }
    this.store = {};
    this.embedding = false;
    this.embedError = null;
    // files edited (or created) while paused — embedded on resume, so we don't
    // rescan the whole vault. Set of file paths.
    this.dirtyWhilePaused = new Set();
    // paths edited since the last flush. Accumulated so a burst of edits (a
    // vault-wide find/replace) re-embeds every touched note, not just the last
    // one, and so edits arriving during a full run aren't dropped or raced.
    this.pending = new Set();

    await this.loadStore();

    this.registerView(VIEW_TYPE, (leaf) => new ConnectionsView(leaf, this));
    this.addRibbonIcon('waypoints', 'Local Connections', () => this.activateView());

    this.addCommand({
      id: 'open-local-connections',
      name: 'Open Local Connections panel',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'reembed-all',
      name: 'Re-embed entire vault',
      callback: () => this.embedVault(true),
    });
    this.addCommand({
      id: 'toggle-pause-embedding',
      name: 'Pause / resume embedding',
      callback: () => this.togglePause(),
    });

    this.addSettingTab(new LocalConnectionsSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', liveDebounce(() => {
        this.refreshView();
      }, 'SWITCH_DEBOUNCE_MS', true))
    );

    // Note edits. The debounced callback only ever fires with the LAST file of a
    // burst, so we must not embed straight from its argument — a vault-wide
    // find/replace touching 300 notes would re-embed exactly one and silently
    // leave the other 299 stale. Instead every modify event records its path
    // immediately (undebounced), and the debounce merely schedules a flush of
    // the whole accumulated set.
    const flushPending = liveDebounce(() => { this.flushPending(); },
      'MODIFY_DEBOUNCE_MS', true);
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.handleTouched(file, flushPending))
    );

    // Newly created notes. A note you create by hand is empty (below
    // MIN_NOTE_CHARS) and gets indexed when you type into it — but a note that
    // arrives with content already in it (sync, an external script, a file
    // moved in) fires only `create`, never `modify`, so without this it would
    // stay unindexed until the next restart.
    this.registerEvent(
      this.app.vault.on('create', (file) => this.handleTouched(file, flushPending))
    );

    // If a note is deleted, drop it from the store and every queue immediately
    // (cheap, keeps results correct even while paused).
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleDelete(file))
    );

    // On rename: move the vector to the new path, then re-embed just this one
    // file. A rename changes the title, so titleVec + noteVec are stale — but
    // bodyVec and every block vector are reused via the body hash, so this costs
    // ~2 embeds and is instant. It's event-driven (Obsidian hands us the exact
    // file), so there's no scanning or polling.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
    );

    this.app.workspace.onLayoutReady(() => {
      if (!this.paused) this.embedVault(false);
    });
  }

  // Rename handling, kept as a method so it can be exercised directly.
  async handleRename(file, oldPath) {
        // Folder rename: Obsidian may report only the folder, leaving every
        // child entry keyed under its old path. Those become orphans — dropped
        // by the next full-vault prune, which means the whole folder gets
        // re-embedded from scratch. Re-key them instead so the vectors survive.
        if (!(file instanceof TFile)) {
          this.remapFolder(oldPath, file.path);
          this.refreshView();
          return;
        }
        const moved = this.store[oldPath];
        if (moved) {
          this.store[file.path] = moved;
          delete this.store[oldPath];
        }
        if (this.dirtyWhilePaused.has(oldPath)) {
          this.dirtyWhilePaused.delete(oldPath);
          this.dirtyWhilePaused.add(file.path);
        }
        if (file.extension !== 'md') { this.refreshView(); return; }

        // Renamed out of the allowlist (moved into an excluded folder): the moved
        // entry would otherwise linger as a ghost, still showing up in results
        // even though the note is no longer meant to be indexed.
        if (this.isExcluded(file)) {
          delete this.store[file.path];
          this.dirtyWhilePaused.delete(file.path);
          this.pending.delete(file.path);
          this.refreshView();
          return;
        }
        if (this.paused) {
          // Catch it up on resume rather than embedding while paused.
          this.dirtyWhilePaused.add(file.path);
          this.refreshView();
          return;
        }
        // A rename doesn't change mtime, so clear it to bypass the fast-path and
        // let the title-dependent vectors refresh.
        if (moved) moved.mtime = null;
        // Route through the pending set so this can't race a full vault run.
        this.pending.add(file.path);
        await this.flushPending();
        this.refreshView();
  }

  // Obsidian unregisters our event listeners, but a debounce scheduled just
  // before unload can still fire. This flag stops that late callback from
  // embedding and writing the store on behalf of a plugin instance that is no
  // longer active (which could otherwise fight a freshly re-enabled instance).
  onunload() {
    this.unloaded = true;
  }

  async togglePause() {
    this.paused = !this.paused;
    await this.saveSettings();
    if (this.paused) {
      this.refreshView();
    } else {
      // Resume: clear the stale "Paused" banner right away, before we start
      // catching up, so the panel reflects that embedding is now running.
      this.refreshView();
      // Only embed what changed while paused — no full-vault rescan.
      const dirty = [...this.dirtyWhilePaused];
      this.dirtyWhilePaused.clear();
      if (dirty.length === 0) {
        this.refreshView();
      } else if (this.embedding) {
        // A run is already going (e.g. paused and resumed in quick succession).
        // embedPaths would bail out and the dirty list would be lost, so hand
        // the work to the pending set — the active run flushes it when it ends.
        for (const p of dirty) this.pending.add(p);
        this.refreshView();
      } else {
        await this.embedPaths(dirty);
        this.refreshView();
      }
    }
  }

  // A note was created or edited: queue it and schedule a flush. Paused edits go
  // to the catch-up set instead. Shared by the create and modify events.
  handleTouched(file, schedule) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    // Only queue notes we actually index. Without this, a vault-wide edit while
    // paused floods dirtyWhilePaused with every file in the vault, so resume
    // shows "catching up X/738" and wastes time on notes outside the allowlist
    // (embedFile skips them, but they still inflate the count and the work).
    if (this.isExcluded(file)) return;
    if (this.paused) { this.dirtyWhilePaused.add(file.path); return; }
    this.pending.add(file.path);
    if (schedule) schedule();
  }

  // A note or folder was deleted: forget it everywhere.
  handleDelete(file) {
    if (file instanceof TFile) {
      delete this.store[file.path];
      this.dirtyWhilePaused.delete(file.path);
      this.pending.delete(file.path);
      this.refreshView();
      return;
    }
    // Folder deleted: drop every entry beneath it, otherwise those vectors
    // linger until the next full-vault prune.
    if (file && file.path) this.purgeFolder(file.path);
    this.refreshView();
  }

  // Move every cached entry under `oldDir` to sit under `newDir` instead, so a
  // folder rename doesn't throw away vectors for all the notes inside it. Also
  // re-keys the dirty/pending sets so queued work still points somewhere real.
  remapFolder(oldDir, newDir) {
    if (!oldDir || !newDir || oldDir === newDir) return;
    const prefix = oldDir + '/';
    const rekey = (p) => (p.startsWith(prefix) ? newDir + '/' + p.slice(prefix.length) : null);
    for (const path of Object.keys(this.store)) {
      const next = rekey(path);
      if (!next) continue;
      this.store[next] = this.store[path];
      delete this.store[path];
    }
    for (const set of [this.dirtyWhilePaused, this.pending]) {
      for (const path of [...set]) {
        const next = rekey(path);
        if (!next) continue;
        set.delete(path);
        set.add(next);
      }
    }
  }

  // Drop every cached entry (and queued path) beneath a deleted folder.
  purgeFolder(dir) {
    const prefix = dir + '/';
    for (const path of Object.keys(this.store)) {
      if (path.startsWith(prefix)) delete this.store[path];
    }
    for (const set of [this.dirtyWhilePaused, this.pending]) {
      for (const path of [...set]) if (path.startsWith(prefix)) set.delete(path);
    }
  }

  // Embed everything recorded in the pending set.
  //
  // Deliberately a no-op while another run is in flight: embedVault (and
  // embedPaths) mutate this.store and prune it, so embedding concurrently could
  // drop a just-written entry. The paths stay in `pending` and the run calls
  // flushPending() when it finishes, so nothing is lost — it's deferred, not
  // dropped. Paused is handled the same way, via dirtyWhilePaused.
  async flushPending() {
    if (this.unloaded) return;
    if (this.pending.size === 0) return;
    if (this.embedding) return;   // a full run is going; it'll flush us afterwards
    // Model setting changed since the cache was built: embedding just these
    // notes would mix two models' vectors. Hold them (still queued) until a
    // re-embed or restart rebuilds the cache, or the setting is changed back.
    // Not auto-rebuilding here on purpose: the model field commits on every
    // keystroke, and a half-typed name must not wipe the cache.
    if (this.storeModel !== TUNABLES.MODEL) return;
    if (this.paused) {
      for (const p of this.pending) this.dirtyWhilePaused.add(p);
      this.pending.clear();
      return;
    }
    this.embedding = true;
    try {
      // Drain in a loop: edits that land *while* we're embedding go back into
      // `pending`, and would otherwise sit there unnoticed until the next event
      // or a restart. Keep going until the set is genuinely empty.
      //
      // Bounded so that a pathological feedback loop (something re-queuing a
      // path every time we embed it — e.g. a plugin rewriting files on save)
      // can't spin forever. Leftovers stay queued for the next flush.
      let rounds = 0;
      let done = 0;
      while (this.pending.size > 0 && !this.paused && !this.unloaded && rounds++ < 100) {
        const paths = [...this.pending];
        this.pending.clear();
        let failed = false;
        for (const path of paths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.extension !== 'md') continue;
          const progress = this.makeBlockProgress(
            `Local Connections: re-embedding ${file.basename}`);
          try {
            await this.embedFile(file, progress);
          } catch (e) {
            new Notice(`Local Connections: embed failed — ${this.embedError}`);
            failed = true;
            break;
          } finally {
            progress.finish(); // never leave a progress notice stuck on screen
          }
          // Flush periodically so a big drain (e.g. a bulk edit) is crash-safe.
          if (++done % TUNABLES.SAVE_EVERY_N === 0) await this.saveStore();
        }
        if (failed) break;
      }
      await this.saveStore();
    } finally {
      this.embedding = false;
      this.refreshView();
    }
  }

  // Embed a specific list of file paths (used on resume). Skips the full-vault
  // walk entirely, so cost scales with how much you edited, not vault size.
  async embedPaths(paths) {
    if (this.unloaded) return;
    if (this.embedding) {
      // Don't drop the work — hand it to the pending set, which the active run
      // flushes when it finishes.
      for (const p of paths) this.pending.add(p);
      return;
    }
    if (this.storeModel !== TUNABLES.MODEL) { // see flushPending
      for (const p of paths) this.pending.add(p);
      return;
    }
    this.embedding = true;
    this.embedError = null;
    let done = 0;
    const total = paths.length;
    const notice = new Notice(`Local Connections: catching up 0/${total}`, 0);
    let stoppedByPause = false;
    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        if (this.paused) {
          // User paused again mid-catchup: hand the rest back to the paused set
          // so the next resume picks them up instead of silently dropping them.
          for (const p of paths.slice(i)) this.dirtyWhilePaused.add(p);
          stoppedByPause = true;
          break;
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== 'md') continue;
        notice.setMessage(`Local Connections: catching up ${done}/${total}`);
        const progress = this.makeBlockProgress(
          `Local Connections: catching up ${done}/${total}`,
          (msg) => notice.setMessage(msg)
        );
        try {
          await this.embedFile(file, progress);
        } catch (e) {
          notice.setMessage(`Local Connections: embed failed \u2014 ${this.embedError}`);
          setTimeout(() => notice.hide(), 8000);
          break;
        } finally {
          progress.finish();
        }
        done++;
        // Flush to disk as we go, exactly like embedVault. Without this a long
        // catch-up wrote nothing until the very end, so closing Obsidian
        // part-way lost all of it and check_vector.py saw no progress.
        if (done % TUNABLES.SAVE_EVERY_N === 0) await this.saveStore();
      }
      await this.saveStore();
      if (stoppedByPause) {
        notice.setMessage(`Local Connections: paused at ${done}/${total}. Resume to continue.`);
        setTimeout(() => notice.hide(), 4000);
      } else if (!this.embedError) {
        notice.setMessage(`Local Connections: caught up (${done}/${total}).`);
        setTimeout(() => notice.hide(), 3000);
      }
    } finally {
      this.embedding = false;
      this.refreshView();
      this.flushPending(); // anything queued while we ran
    }
  }

  // Settings ARE overrides for TUNABLES keys (plus `paused`). Everything in the
  // code reads TUNABLES.X, so loading just overlays saved values onto TUNABLES;
  // no other code needs to know settings exist. Defaults are the literals in the
  // TUNABLES block (captured in TUNABLE_DEFAULTS before this overlay runs).
  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.applySettings(saved);
  }

  applySettings(saved) {
    for (const item of SETTINGS_ITEMS) {
      if (saved[item.key] !== undefined) {
        TUNABLES[item.key] = coerceSetting(item, saved[item.key], TUNABLE_DEFAULTS[item.key]);
      }
    }
    this.paused = !!saved.paused;
  }

  // The persisted shape: every schema key's current TUNABLES value, plus paused.
  collectSettings() {
    const out = { paused: this.paused };
    for (const item of SETTINGS_ITEMS) out[item.key] = TUNABLES[item.key];
    return out;
  }

  async saveSettings() {
    await this.saveData(this.collectSettings());
  }

  // Restore every setting to its literal default (used by the settings tab).
  async resetSettings() {
    for (const item of SETTINGS_ITEMS) {
      const def = TUNABLE_DEFAULTS[item.key];
      TUNABLES[item.key] = Array.isArray(def) ? def.slice() : def;
    }
    await this.saveSettings();
  }

  get storePath() {
    return `${this.app.vault.configDir}/plugins/local-connections/vectors.json`;
  }

  async loadStore() {
    // Try the real file; if it's missing or unreadable/corrupt, fall back to the
    // scratch file a previous save may have left behind (we can be killed in the
    // narrow window between removing the old file and renaming the new one in).
    // Losing one save is fine; silently re-embedding the whole vault is not.
    let parsed = await this._readStoreFile(this.storePath);
    if (!parsed) {
      parsed = await this._readStoreFile(this.tempStorePath);
      if (parsed) console.warn('[Local Connections] recovered vector store from the scratch file');
    }
    // Any leftover scratch file is stale by now — drop it so it can't be mistaken
    // for a newer store on a later launch.
    try { await this.app.vault.adapter.remove(this.tempStorePath); } catch (e) { /* none */ }

    // Whatever we end up holding was built with (or is empty for) this model.
    this.storeModel = TUNABLES.MODEL;
    if (!parsed || parsed.model !== TUNABLES.MODEL || !parsed.vectors) {
      this.store = {};
      return;
    }
    if (parsed.format === STORE_FORMAT) {
      this.store = parsed.vectors;
    } else if (parsed.format === 2 || parsed.format === 3) {
      this.migrateStore(parsed.vectors, parsed.format);
      this.store = parsed.vectors;
    } else {
      this.store = {};
    }
  }

  // Read + parse one candidate store file. Returns null if absent or unparseable.
  async _readStoreFile(path) {
    try {
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch (e) {
      return null;
    }
  }

  // Migrate an older cache in place to the current format. The point is to avoid
  // a full rebuild: we keep every vector we can and let the next embed pass fill
  // in only what's genuinely new.
  //
  //   v2 -> v4: noteVec was body-only back then, so drop it (it'll be recomputed
  //             as title+body). titleVec and blocks are kept.
  //   v3 -> v4: everything is kept; we only need the new bodyVec, which the next
  //             pass computes (free for single-block notes, one embed otherwise).
  //
  // We seed titleHash/bodyHash from data already in the cache (body is exactly
  // the stored block texts joined), so the next pass sees title+body as
  // unchanged and reuses titleVec/noteVec/blocks — it embeds ONLY the missing
  // bodyVec. Clearing mtime is what forces that one pass to run.
  migrateStore(vectors, fromFormat) {
    for (const [path, entry] of Object.entries(vectors)) {
      if (!entry) continue;
      const basename = (path.split('/').pop() || '').replace(/\.md$/i, '');
      const body = Array.isArray(entry.blocks) ? entry.blocks.map((b) => b.text).join('\n\n') : '';
      entry.titleHash = hashString(basename);
      entry.bodyHash = hashString(body);
      delete entry.hash;   // old combined hash, no longer used
      delete entry.mtime;  // force one pass to fill in bodyVec
      if (fromFormat < 3) delete entry.noteVec; // v2 noteVec was body-only
      // bodyVec intentionally left absent -> computed on the next pass
    }
  }

  get tempStorePath() {
    return this.storePath + '.tmp';
  }

  // Persist the vector store.
  //
  // Two protections, both learned the hard way:
  //
  // 1. ATOMIC WRITE. vectors.json can be tens of MB, so a plain overwrite has a
  //    real window where the process can die mid-write, leaving a truncated file
  //    that won't parse — which makes the next launch silently discard the whole
  //    cache and re-embed the entire vault. Instead we write a .tmp file and
  //    rename it over the real one. A rename is atomic: if we're killed, the
  //    worst case is a stale-but-valid vectors.json plus a junk .tmp.
  //
  // 2. ONE WRITER AT A TIME. Several paths save (the vault run every N notes, the
  //    modify handler, rename, resume). Overlapping writes would interleave into
  //    the same .tmp and corrupt it, defeating protection 1. Saves are therefore
  //    serialized: a save requested while one is in flight is coalesced into a
  //    single follow-up run (the store is a snapshot of current state anyway, so
  //    collapsing several pending saves into one loses nothing).
  async saveStore() {
    // Mark that the current store state needs writing, then either join the
    // in-flight save or start one. The runner loops while more saves have been
    // requested, so awaiting saveStore() always resolves AFTER a write that
    // included your changes — callers can rely on "it's on disk now".
    this._saveQueued = true;
    if (this._saving) return this._saving;
    this._saving = (async () => {
      while (this._saveQueued) {
        this._saveQueued = false;
        await this._doSaveStore();
      }
    })();
    try {
      await this._saving;
    } finally {
      this._saving = null;
    }
  }

  async _doSaveStore() {
    const payload = JSON.stringify({
      model: this.storeModel || TUNABLES.MODEL,
      format: STORE_FORMAT,
      updated_at: Date.now(),
      vectors: this.store,
    });
    const adapter = this.app.vault.adapter;
    try {
      // Write to a scratch file first, then swap it in.
      await adapter.write(this.tempStorePath, payload);
      if (adapter.rename) {
        try {
          // Preferred: a single atomic swap, no window where the real file is missing.
          await adapter.rename(this.tempStorePath, this.storePath);
        } catch (e) {
          // Some adapters refuse to rename onto an existing file. Only then do we
          // clear the target first. This leaves a brief window where vectors.json
          // is absent — loadStore() can recover from the .tmp if we die here.
          await adapter.remove(this.storePath);
          await adapter.rename(this.tempStorePath, this.storePath);
        }
      } else {
        // No rename support: fall back to a direct write (pre-existing behavior).
        await adapter.write(this.storePath, payload);
        try { await adapter.remove(this.tempStorePath); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.error('[Local Connections] failed to save vector store', e);
      // Never leave a half-written scratch file lying around.
      try { await adapter.remove(this.tempStorePath); } catch (e2) { /* ignore */ }
    }
  }

  isExcluded(file) {
    // Allowlist: embed ONLY notes whose path sits under one of these folders.
    return !TUNABLES.INCLUDED_FOLDERS.some((f) => file.path.startsWith(f + '/'));
  }

  // Build an onBatch(done, total) callback that surfaces per-block progress for
  // a single large re-embed (e.g. a long transcript) via a Notice. Small notes
  // (< BATCH_SIZE inputs, i.e. a single request) show nothing — no flashing on
  // ordinary edits. `update` lets a caller prefix its own file-level counter.
  makeBlockProgress(prefix, update) {
    let notice = null;
    const cb = (done, total) => {
      if (total <= TUNABLES.BATCH_SIZE) return; // fits in one request — stay quiet
      const msg = `${prefix} (blocks ${done}/${total})`;
      if (update) { update(msg); return; }
      if (!notice) notice = new Notice(msg, 0);
      else notice.setMessage(msg);
      if (done >= total) { const n = notice; notice = null; setTimeout(() => n.hide(), 1500); }
    };
    // Callers MUST call finish() in a finally. The notice is created with a
    // duration of 0 (never auto-dismisses), so if an embed throws part-way
    // through a big note the progress notice would otherwise stay on screen
    // forever with no way to clear it.
    cb.finish = () => {
      if (notice) { notice.hide(); notice = null; }
    };
    return cb;
  }

  // POST to Ollama with a timeout, so a hung server surfaces as an error instead
  // of blocking the embed loop forever.
  async _postEmbed(url, input) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && TUNABLES.REQUEST_TIMEOUT_MS > 0
      ? setTimeout(() => controller.abort(), TUNABLES.REQUEST_TIMEOUT_MS)
      : null;
    try {
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TUNABLES.MODEL, input }),
      };
      if (controller) opts.signal = controller.signal;
      return await fetch(url, opts);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`Ollama did not respond within ${TUNABLES.REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Reject a vector whose width isn't what the rest of the store uses. Mixing
  // dimensions is silent poison: cosine() returns -1 for mismatched lengths, so
  // affected notes simply stop matching anything, with no error anywhere.
  _checkDim(vec) {
    const want = TUNABLES.EXPECTED_DIM;
    if (!want) return vec;
    if (!Array.isArray(vec)) throw new Error('Ollama returned a non-array embedding');
    if (vec.length !== want) {
      throw new Error(
        `Ollama returned a ${vec.length}-dim embedding, expected ${want}. ` +
        `Wrong model, or "${TUNABLES.MODEL}" changed — re-embed the vault after fixing it.`
      );
    }
    return vec;
  }

  async embedText(text) {
    const url = `${TUNABLES.OLLAMA_HOST.replace(/\/$/, '')}/api/embed`;
    const resp = await this._postEmbed(url, text);
    if (!resp.ok) throw new Error(`Ollama responded ${resp.status}`);
    const data = await resp.json();
    if (Array.isArray(data.embeddings) && data.embeddings.length) return this._checkDim(data.embeddings[0]);
    if (Array.isArray(data.embedding)) return this._checkDim(data.embedding);
    throw new Error('Unexpected embedding response shape');
  }

  // Embed many inputs, sent to Ollama in chunks of BATCH_SIZE (its /api/embed
  // accepts an array in "input" and returns embeddings in order). Results are
  // concatenated in input order. onProgress(done, total) fires after each chunk.
  // If a chunk fails, the error propagates and NO partial result is returned —
  // the caller leaves the note's previous cache entry untouched.
  async embedBatch(texts, onProgress) {
    if (texts.length === 0) return [];
    const url = `${TUNABLES.OLLAMA_HOST.replace(/\/$/, '')}/api/embed`;
    const out = [];
    for (let i = 0; i < texts.length; i += TUNABLES.BATCH_SIZE) {
      const chunk = texts.slice(i, i + TUNABLES.BATCH_SIZE);
      const resp = await this._postEmbed(url, chunk);
      if (!resp.ok) throw new Error(`Ollama responded ${resp.status}`);
      const data = await resp.json();
      if (Array.isArray(data.embeddings) && data.embeddings.length === chunk.length) {
        for (const v of data.embeddings) out.push(this._checkDim(v));
      } else {
        // shape mismatch — fall back to one request per item for this chunk
        for (const t of chunk) out.push(await this.embedText(t));
      }
      if (onProgress) onProgress(out.length, texts.length);
    }
    return out;
  }

  // Embed one file. onBatch(done, total) (optional) reports progress in terms of
  // inputs actually sent to Ollama this run — so a one-word edit to a 570-block
  // note reports "1/1", not "1/570", because unchanged blocks are reused.
  async embedFile(file, onBatch) {
    if (this.isExcluded(file)) return;

    // Fast path: if the file's modification time matches what we stored AND we
    // already have a title vector AND the entry was built with the current
    // cleaning rules, nothing can have changed — skip the read + clean + hash
    // entirely. The CLEAN_VERSION check is what makes a change to
    // splitIntoBlocks() actually propagate to already-cached notes.
    const mtime = file.stat ? file.stat.mtime : null;
    const existingEntry = this.store[file.path];
    if (
      existingEntry && existingEntry.titleVec &&
      existingEntry.clean === CLEAN_VERSION &&
      mtime != null && existingEntry.mtime === mtime
    ) {
      return;
    }

    let content;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (e) {
      return;
    }

    const noteBody = noteBodyForEmbedding(content);
    if (noteBody.length < TUNABLES.MIN_NOTE_CHARS) {
      delete this.store[file.path];
      return;
    }

    const title = file.basename;
    const blocks = splitIntoBlocks(content);

    // Per-field content hashes (cheap string hashes, no network). A single
    // bodyHash covers the body AND every block's content/order, so change
    // detection is two comparisons regardless of paragraph count.
    const titleHash = hashString(title);
    const bodyHash = hashString(noteBody);

    const existing = this.store[file.path];
    const titleUnchanged = !!(existing && existing.titleHash === titleHash);
    const bodyUnchanged = !!(existing && existing.bodyHash === bodyHash);

    // Size gates: skip a vector the model would silently truncate. noteVec
    // embeds title+body (for whole-note similarity + search); bodyVec embeds the
    // body alone (for title-vs-body drift). Both null for over-length docs.
    const wholeNoteInput = title + '\n\n' + noteBody;
    const wantNoteVec = wholeNoteInput.length <= TUNABLES.NOTE_EMBED_MAX_CHARS;
    const wantBodyVec = noteBody.length <= TUNABLES.NOTE_EMBED_MAX_CHARS;

    // Reuse cached block vectors by text: only new/changed blocks get embedded.
    const reuse = new Map();
    if (existing && Array.isArray(existing.blocks)) {
      for (const b of existing.blocks) {
        if (b && typeof b.text === 'string') reuse.set(b.text, b.vec);
      }
    }

    // Build the embed queue, reusing every vector whose input is unchanged.
    const queue = [];

    // titleVec depends only on the title.
    let titleVec = (titleUnchanged && existing.titleVec) ? existing.titleVec : null;
    let titleQ = -1;
    if (!titleVec) { titleQ = queue.length; queue.push(title); }

    // noteVec depends on title AND body.
    let noteVec;
    let noteQ = -1;
    if (titleUnchanged && bodyUnchanged && 'noteVec' in existing) {
      noteVec = existing.noteVec;                 // vector or null, unchanged
    } else if (wantNoteVec) {
      noteQ = queue.length; queue.push(wholeNoteInput);
    } else {
      noteVec = null;
    }

    // Blocks: reuse unchanged ones by their text.
    const blockPlan = blocks.map((text) => {
      if (reuse.has(text)) return { text, vec: reuse.get(text) };
      const q = queue.length;
      queue.push(text);
      return { text, q };
    });

    // bodyVec depends only on the body. For a single-block note the body IS that
    // block, so we reuse the block's vector rather than embedding it again.
    let bodyVec;
    let bodyQ = -1;
    let bodyFromSingleBlock = false;
    if (bodyUnchanged && existing && 'bodyVec' in existing) {
      bodyVec = existing.bodyVec;                 // vector or null, unchanged
    } else if (!wantBodyVec) {
      bodyVec = null;
    } else if (blocks.length === 1) {
      bodyFromSingleBlock = true;                 // resolved after blocks embed
    } else {
      bodyQ = queue.length; queue.push(noteBody);
    }

    try {
      const vecs = await this.embedBatch(queue, onBatch);
      if (titleQ >= 0) titleVec = vecs[titleQ];
      if (noteQ >= 0) noteVec = vecs[noteQ];
      const blockEntries = blockPlan.map((b) => ({
        text: b.text,
        vec: b.q != null ? vecs[b.q] : b.vec,
      }));
      if (bodyFromSingleBlock) bodyVec = blockEntries[0].vec;
      else if (bodyQ >= 0) bodyVec = vecs[bodyQ];
      this.store[file.path] = {
        mtime, clean: CLEAN_VERSION,
        titleHash, bodyHash, titleVec, noteVec, bodyVec, blocks: blockEntries,
      };
      this.embedError = null;
    } catch (e) {
      this.embedError = e.message || String(e);
      console.error('[Local Connections] embed failed for', file.path, e);
      throw e;
    }
  }

  async embedVault(force) {
    if (this.unloaded) return;
    if (this.embedding) return;
    this.embedding = true;
    this.embedError = null;
    // A model change makes every cached vector incomparable with new ones (and
    // same-width models wouldn't even trip the dimension check), so treat it as
    // a forced rebuild rather than quietly mixing the two.
    if (force || this.storeModel !== TUNABLES.MODEL) {
      this.store = {};
      this.storeModel = TUNABLES.MODEL;
    }

    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f));
    const total = files.length;
    let done = 0, changed = 0;
    const notice = new Notice(`Local Connections: embedding 0/${total}`, 0);

    try {
      for (const file of files) {
        if (this.paused) {
          notice.setMessage(`Local Connections: paused at ${done}/${total}. Resume to continue.`);
          await this.saveStore();
          setTimeout(() => notice.hide(), 4000);
          this.embedding = false;
          this.refreshView();
          return;
        }
        const before = this.store[file.path];
        const progress = this.makeBlockProgress(
          `Local Connections: embedding ${done}/${total}`,
          (msg) => notice.setMessage(msg)
        );
        try {
          await this.embedFile(file, progress);
        } catch (e) {
          notice.setMessage(
            `Local Connections: embedding failed \u2014 ${this.embedError}. Is Ollama running with "${TUNABLES.MODEL}"?`
          );
          this.embedding = false;
          this.refreshView();
          setTimeout(() => notice.hide(), 8000);
          return;
        }
        progress.finish();
        if (this.store[file.path] !== before) changed++;
        done++;
        if (done % 5 === 0 || done === total) {
          notice.setMessage(`Local Connections: embedding ${done}/${total}`);
        }
        // Periodically flush to disk so a crash/close mid-run doesn't lose all
        // progress. On next launch, cached notes are skipped instantly.
        if (done % TUNABLES.SAVE_EVERY_N === 0) {
          await this.saveStore();
        }
      }
      const live = new Set(files.map((f) => f.path));
      for (const p of Object.keys(this.store)) if (!live.has(p)) delete this.store[p];
      await this.saveStore();
      notice.setMessage(`Local Connections: ready (${total} notes, ${changed} updated).`);
      setTimeout(() => notice.hide(), 3000);
    } finally {
      this.embedding = false;
      this.refreshView();
      // Edits that arrived while this run was going were deferred, not dropped.
      this.flushPending();
    }
  }

  linkedTargetsFor(content) {
    return extractOutgoingLinks(content);
  }

  isLinked(otherFile, linkedSet) {
    if (!TUNABLES.EXCLUDE_LINKED_NOTES) return false;
    const basenameKey = otherFile.basename.toLowerCase();
    const pathKey = otherFile.path.replace(/\.md$/i, '').toLowerCase();
    return linkedSet.has(basenameKey) || linkedSet.has(pathKey);
  }

  // Whole-note similar notes.
  computeSimilarNotes(file, linkedSet) {
    const self = this.store[file.path];
    if (!self || !self.noteVec) return null;
    const out = [];
    for (const [path, entry] of Object.entries(this.store)) {
      if (path === file.path || !entry.noteVec) continue;
      const other = this.app.vault.getAbstractFileByPath(path);
      if (!(other instanceof TFile)) continue;
      if (this.isExcluded(other)) continue; // stale entry for a note moved out of the allowlist
      if (this.isLinked(other, linkedSet)) continue;
      const raw = cosine(self.noteVec, entry.noteVec);
      if (raw <= -1) continue;
      const scaled = powerScale(raw);
      if (scaled < TUNABLES.NOTE_MIN_SCALED_SCORE) continue;
      out.push({ file: other, raw, scaled });
    }
    out.sort((a, b) => b.scaled - a.scaled);
    return out.slice(0, TUNABLES.NOTE_RESULT_LIMIT);
  }

  // Flat block-ranked list: every block of every other (non-linked) note, each
  // paired with its best-matching block in the current note. Multiple blocks
  // from the same note are allowed. Sorted by scaled score across everything.
  computeSimilarBlocks(file, linkedSet) {
    const self = this.store[file.path];
    if (!self || !self.blocks || self.blocks.length === 0) return null;

    const out = [];
    for (const [path, entry] of Object.entries(this.store)) {
      if (path === file.path || !entry.blocks) continue;
      const other = this.app.vault.getAbstractFileByPath(path);
      if (!(other instanceof TFile)) continue;
      if (this.isExcluded(other)) continue; // stale entry for a note moved out of the allowlist
      if (this.isLinked(other, linkedSet)) continue;

      // Whole-note similarity of the two notes — the gate value, computed once.
      // Only used for SHORT blocks below (long blocks are ranked raw). A note
      // with no noteVec (over-length doc) can't be gated.
      let gateRaw = null;
      if (TUNABLES.BLOCK_GATE_ENABLED && self.noteVec && entry.noteVec) {
        gateRaw = cosine(self.noteVec, entry.noteVec);
        if (gateRaw <= -1) gateRaw = null;
      }
      const gate = gateRaw == null ? 1 : Math.max(gateRaw, 0);

      for (const ob of entry.blocks) {
        let bestRaw = -1;
        let bestCurrent = null;
        for (const cb of self.blocks) {
          const raw = cosine(cb.vec, ob.vec);
          if (raw > bestRaw) {
            bestRaw = raw;
            bestCurrent = cb;
          }
        }
        if (bestRaw <= -1) continue;

        // The gate only applies to SHORT suggested paragraphs — the false-
        // positive risk. A long, substantive block is trusted on its raw
        // similarity. Length is measured the same way as MIN_BLOCK_CHARS.
        const short = ob.text.replace(/\s+/g, ' ').length <= TUNABLES.BLOCK_GATE_MAX_CHARS;
        const gated = short && gateRaw != null;
        if (gated && TUNABLES.BLOCK_GATE_FLOOR > 0 && gate <= TUNABLES.BLOCK_GATE_FLOOR) continue;

        const clamped = Math.max(bestRaw, 0);
        const combined = gated ? clamped * gate : clamped;
        const scaled = powerScale(combined);
        if (scaled < TUNABLES.BLOCK_MIN_SCALED_SCORE) continue;
        out.push({
          file: other,
          raw: bestRaw,       // pure block cosine
          combined,           // what's ranked AND shown: raw for long blocks, block × note for short ones
          scaled,             // powerScale(combined); the actual sort key
          gate: gated ? gateRaw : null, // null = not gated (long block, or no noteVec)
          otherBlock: ob.text,
          currentBlock: bestCurrent ? bestCurrent.text : null,
        });
      }
    }
    out.sort((a, b) => b.scaled - a.scaled);
    return out.slice(0, TUNABLES.BLOCK_RESULT_LIMIT);
  }

  // Notes whose BODY agrees with the current note but whose TITLE doesn't —
  // same substance, different framing. The cross-domain connection seed:
  // ranked by how much MORE the bodies agree than the titles do.
  computeStrangePairs(file, linkedSet) {
    const self = this.store[file.path];
    if (!self || !self.bodyVec || !self.titleVec) return null;
    const out = [];
    for (const [path, entry] of Object.entries(this.store)) {
      if (path === file.path || !entry.bodyVec || !entry.titleVec) continue;
      const other = this.app.vault.getAbstractFileByPath(path);
      if (!(other instanceof TFile)) continue;
      if (this.isExcluded(other)) continue; // stale entry for a note moved out of the allowlist
      if (this.isLinked(other, linkedSet)) continue;
      const bodyRaw = cosine(self.bodyVec, entry.bodyVec);
      if (bodyRaw < TUNABLES.STRANGE_MIN_BODY) continue;
      const titleRaw = cosine(self.titleVec, entry.titleVec);
      const delta = bodyRaw - titleRaw;
      if (delta < TUNABLES.STRANGE_MIN_DELTA) continue;
      out.push({ file: other, raw: bodyRaw, titleRaw, delta, scaled: powerScale(bodyRaw) });
    }
    out.sort((a, b) => b.delta - a.delta);
    return out.slice(0, TUNABLES.STRANGE_RESULT_LIMIT);
  }

  // Which notes your RECENT thinking keeps circling: take the most recently
  // touched notes, look at each one's top-K whole-note neighbours, and surface
  // the notes that recur across at least GRAVITY_MIN_COUNT of those
  // neighbourhoods. This candidate ranking is vault-wide (independent of which
  // note is open) — only the final filtering below is relative to `file`: the
  // current note can't be its own attractor, and a note already linked from
  // `file` is skipped (you've already found it), so the next-best attractor
  // takes its place instead of the section just showing fewer results.
  //
  // Cost note: O(GRAVITY_RECENT_N * embedded-notes) cosine comparisons, run
  // fresh on every call (no caching). Fine at a few hundred–thousand notes;
  // GRAVITY_ENABLED is there to turn it off if a much larger vault makes this
  // noticeable on note-switch.
  computeGravity(file, linkedSet) {
    if (!TUNABLES.GRAVITY_ENABLED) return null;
    const self = this.store[file.path];
    if (!self || !self.noteVec) return null; // no meaningful score to show

    const entries = [];
    for (const [path, entry] of Object.entries(this.store)) {
      if (entry.noteVec && typeof entry.mtime === 'number') entries.push([path, entry]);
    }
    if (entries.length < 5) return null;

    entries.sort((a, b) => b[1].mtime - a[1].mtime);
    const recent = entries.slice(0, TUNABLES.GRAVITY_RECENT_N);
    if (recent.length < 3) return null;

    const counts = new Map();
    for (const [rp, re] of recent) {
      const sims = [];
      for (const [path, entry] of entries) {
        if (path === rp) continue;
        const s = cosine(re.noteVec, entry.noteVec);
        if (s >= TUNABLES.GRAVITY_MIN_SIM) sims.push([path, s]);
      }
      sims.sort((a, b) => b[1] - a[1]);
      for (const [path] of sims.slice(0, TUNABLES.GRAVITY_TOP_K)) {
        counts.set(path, (counts.get(path) || 0) + 1);
      }
    }

    const ranked = [...counts.entries()]
      .filter(([, count]) => count >= TUNABLES.GRAVITY_MIN_COUNT)
      .sort((a, b) => b[1] - a[1]);

    const out = [];
    for (const [path, count] of ranked) {
      if (out.length >= TUNABLES.GRAVITY_MAX_SHOW) break;
      if (path === file.path) continue; // can't be an attractor of itself
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      if (this.isExcluded(f)) continue;
      if (this.isLinked(f, linkedSet)) continue; // already found — the next one takes this slot
      const entry = this.store[path];
      if (!entry || !entry.noteVec) continue;
      const raw = cosine(self.noteVec, entry.noteVec);
      if (raw <= -1) continue;
      out.push({ file: f, count, raw, scaled: powerScale(raw) });
    }
    return out.length ? out : null;
  }

  async computeAll(file) {
    const self = this.store[file.path];
    if (!self) return { ready: false };
    const content = await this.app.vault.cachedRead(file);
    const linkedSet = this.linkedTargetsFor(content);
    return {
      ready: true,
      notes: this.computeSimilarNotes(file, linkedSet) || [],
      blocks: this.computeSimilarBlocks(file, linkedSet) || [],
      strange: this.computeStrangePairs(file, linkedSet) || [],
      gravity: this.computeGravity(file, linkedSet) || [],
    };
  }

  // Semantic search: embed the query once, then rank every note vector and
  // every block vector against it. No self/linked exclusion — a free-text query
  // has no "current note". Same cosine + power-scaling as the panels, so scores
  // are comparable. Returns { notes, blocks } shaped exactly like computeAll so
  // the existing renderers can display them unchanged.
  async searchByText(query) {
    const q = (query || '').trim();
    if (!q) return { notes: [], blocks: [] };
    const qvec = await this.embedText(q);

    const notes = [];
    const blocks = [];
    for (const [path, entry] of Object.entries(this.store)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (this.isExcluded(file)) continue; // stale entry for a note moved out of the allowlist

      if (entry.noteVec) {
        const raw = cosine(qvec, entry.noteVec);
        if (raw > -1) {
          const scaled = powerScale(raw);
          if (scaled >= TUNABLES.NOTE_MIN_SCALED_SCORE) notes.push({ file, raw, scaled });
        }
      }
      if (entry.blocks) {
        for (const b of entry.blocks) {
          const raw = cosine(qvec, b.vec);
          if (raw <= -1) continue;
          const scaled = powerScale(raw);
          if (scaled < TUNABLES.BLOCK_MIN_SCALED_SCORE) continue;
          blocks.push({ file, raw, scaled, otherBlock: b.text, currentBlock: null });
        }
      }
    }
    notes.sort((a, b) => b.scaled - a.scaled);
    blocks.sort((a, b) => b.scaled - a.scaled);
    return {
      notes: notes.slice(0, TUNABLES.NOTE_RESULT_LIMIT),
      blocks: blocks.slice(0, TUNABLES.BLOCK_RESULT_LIMIT),
    };
  }

  // Title-vs-content drift for the current note. Uses the stored title vector,
  // body vector, and block vectors — no new embedding needed. Returns raw
  // cosine values (relative comparison; not pass/fail). Blocks stay in
  // document order so you can spot where the note wandered.
  computeDrift(file) {
    const self = this.store[file.path];
    if (!self) return { ready: false, reason: 'This note isn\u2019t embedded yet.' };
    if (!self.titleVec) {
      return { ready: false, reason: 'No title vector yet \u2014 re-embed this note (edit it, or run Re-embed entire vault) to populate it.' };
    }
    // Drift is title vs BODY, so compare against bodyVec (body only). Using
    // noteVec here would be wrong — it embeds the title too, inflating the score.
    const titleBody = self.bodyVec ? cosine(self.titleVec, self.bodyVec) : null;
    const blocks = (self.blocks || []).map((b, i) => ({
      index: i,
      text: b.text,
      score: cosine(self.titleVec, b.vec),
    }));
    return {
      ready: true,
      title: file.basename,
      titleBody,
      blocks, // already in document order
    };
  }

  openDriftModal() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('Open a note to see its title drift.');
      return;
    }
    new DriftModal(this.app, this, file).open();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    this.refreshView();
  }

  refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      // Don't clobber an active search (and its focused input) when the active
      // note changes or embedding progresses — the user is reading while searching.
      if (leaf.view instanceof ConnectionsView && !leaf.view.searchMode) leaf.view.render();
    }
  }

  formatScore(raw, scaled) {
    const val = TUNABLES.DISPLAY_SCORE === 'scaled' ? scaled : raw;
    return val.toFixed(TUNABLES.SCORE_DECIMALS);
  }
};

// ---------- view ----------

class ConnectionsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = TUNABLES.DEFAULT_TAB === 'blocks' ? 'blocks' : 'notes';
    // remember which rows the user has expanded, keyed by file path, so a
    // re-render (e.g. debounced refresh) doesn't collapse them.
    this.expanded = new Set();
    // rows whose (long) title the user clicked to see in full, same keying.
    this.titleExpanded = new Set();
    // block rows (Similar blocks) the user clicked to expand, keyed by
    // "path index" within the current result list.
    this.blockExpanded = new Set();
    // path of the note the note-relative view last rendered for; used to reset
    // the expansion sets when you switch to a different note.
    this.notePath = null;
    // Gravity section folded away by clicking its label. Deliberately NOT part
    // of resetExpansions(): this reads as a standing preference ("I don't want
    // to see that right now"), so it persists as you move between notes.
    this.gravityCollapsed = false;
    // --- semantic search state ---
    // When searchMode is on, the panel shows a query box + query-ranked results
    // instead of note-relative results, and note-switch refreshes are ignored so
    // you can read around without losing your search.
    this.searchMode = false;
    this.searchQuery = '';
    this.searchResults = null; // { notes, blocks } once a search has run
    this.searching = false;
    // links out of the note that was active when the search ran, so results
    // already linked from it can be marked. Lower-cased basename/path keys.
    this.searchLinked = new Set();
    // How the Strange pairs tab is ordered: by the strangeness 'delta' (default),
    // or by raw 'body' / 'title' agreement.
    this.strangeSort = 'delta';
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Local Connections'; }
  getIcon() { return 'waypoints'; }
  async onOpen() { this.render(); }
  async onClose() {}

  makeCopyButton(row, targetFile, sourceFile) {
    const btn = row.createEl('button', { cls: 'lc-copy', text: 'Copy link' });
    btn.addEventListener('click', async (evt) => {
      evt.stopPropagation();
      const linktext = this.plugin.app.metadataCache.fileToLinktext(targetFile, sourceFile.path);
      await navigator.clipboard.writeText(`[[${linktext}]]`);
      btn.setText('Copied \u2713');
      setTimeout(() => btn.setText('Copy link'), 1200);
    });
    return btn;
  }

  // Public entry point. render() is async (it awaits computeAll), so two calls
  // in quick succession — which happens on resume, where several refreshView()s
  // fire — used to interleave: each empties the container and then, after its
  // await, appends into the shared `_header`, producing a duplicated tab bar.
  // Serialize instead: never run two _render()s at once; if a render is asked
  // for while one is in flight, do exactly one more pass afterwards with the
  // latest state.
  async render() {
    if (this._rendering) { this._renderPending = true; return; }
    this._rendering = true;
    try {
      // Bounded, so a refreshView() storm can't loop forever.
      let passes = 0;
      do {
        this._renderPending = false;
        await this._render();
      } while (this._renderPending && ++passes < 20);
    } finally {
      this._rendering = false;
    }
  }

  async _render() {
    const container = this.containerEl.children[1];
    // Expanding a row re-renders the whole panel, which recreates the scroll
    // region and would jump you back to the top — losing the row you just
    // clicked. Remember where the list was scrolled and restore it after the
    // rebuild (see restoreScroll() at the end of the note-relative path). We
    // deliberately DON'T restore across a note switch: a new note should start
    // at the top.
    const prevScroll = container.querySelector ? container.querySelector('.lc-scroll') : null;
    const savedScrollTop = prevScroll ? prevScroll.scrollTop : 0;
    container.empty();
    container.addClass('local-connections-panel');

    // Persistent toolbar (always shown, even on error/empty states)
    // Toolbar, search bar and tabs all live in one sticky header. Keeping them
    // in a single sticky element means the tabs stay correctly positioned even
    // when the toolbar wraps onto two rows in a narrow sidebar (a fixed sticky
    // offset would leave them hidden behind the taller toolbar).
    const header = container.createDiv({ cls: 'lc-header' });
    this._header = header;
    const toolbar = header.createDiv({ cls: 'lc-toolbar' });
    const pauseBtn = toolbar.createEl('button', {
      cls: 'lc-pause' + (this.plugin.paused ? ' lc-paused' : ''),
    });
    pauseBtn.createSpan({ cls: 'lc-pause-label', text: this.plugin.paused ? 'Paused' : 'Live' });
    pauseBtn.setAttr(
      'title',
      this.plugin.paused
        ? 'Embedding is paused. Edits won\u2019t re-embed. Click to resume and catch up.'
        : 'Pause live re-embedding while you write. The panel keeps working off existing vectors.'
    );
    pauseBtn.addEventListener('click', () => {
      this.plugin.togglePause();
      // togglePause flips paused synchronously, but its refreshView() skips
      // search-mode views (so a search isn't clobbered). Re-render this view
      // directly so the Live/Paused label updates even while search is open.
      this.render();
    });

    // Drift button shows the live title-drift (title vs body) cosine. High = the
    // title matches the note's content; low = the note may have drifted. Click
    // opens the per-block breakdown.
    const activeFile = this.plugin.app.workspace.getActiveFile();
    let driftLabel = 'Drift \u2014';
    if (activeFile && activeFile.extension === 'md') {
      const d = this.plugin.computeDrift(activeFile);
      if (d.ready && d.titleBody != null) {
        driftLabel = `Drift ${d.titleBody.toFixed(TUNABLES.SCORE_DECIMALS)}`;
      }
    }
    const driftBtn = toolbar.createEl('button', { cls: 'lc-drift-btn', text: driftLabel });
    driftBtn.setAttr('title', 'Title\u2194body drift (higher = title matches content). Click for the per-block breakdown.');
    driftBtn.addEventListener('click', () => this.plugin.openDriftModal());

    // Semantic search toggle. Highlighted while active. Puts a query box + the
    // same two-tab results into the panel without touching the open note.
    const searchBtn = toolbar.createEl('button', {
      cls: 'lc-search-btn' + (this.searchMode ? ' lc-search-active' : ''),
      text: 'Semantic Search',
    });
    searchBtn.setAttr('title', 'Search notes and blocks by meaning. Type a sentence and press Enter.');
    searchBtn.addEventListener('click', () => this.toggleSearch());

    // Everything below the header scrolls inside its own box, so results can
    // never paint over the fixed toolbar/tabs. Banners stay in the header.
    const scroll = container.createDiv({ cls: 'lc-scroll' });

    if (this.plugin.embedError) {
      scroll.createDiv({
        cls: 'lc-empty',
        text: `Embedding error: ${this.plugin.embedError}. Check that Ollama is running and "${TUNABLES.MODEL}" is pulled.`,
      });
      return;
    }

    // Restore the scroll position after the list is (re)built. Only when we've
    // stayed on the same view context — a note switch or entering search should
    // start at the top. Best-effort: no-op in the test DOM shim (no scrollTop).
    //
    // We restore TWICE: once synchronously, and once on the next animation frame.
    // The second pass matters for expandable rows whose dropdown body loads
    // asynchronously (Notes / Pairs) — at the synchronous restore the body is
    // still "Loading…", so the height isn't final yet; the cachedRead microtask
    // fills it in before the next frame, and the rAF pass corrects for it. (For
    // Blocks the height is final immediately, so the first pass already suffices.)
    const restoreScroll = (sameContext) => {
      if (!sameContext || !savedScrollTop || typeof scroll.scrollTop !== 'number') return;
      scroll.scrollTop = savedScrollTop;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { scroll.scrollTop = savedScrollTop; });
      }
    };

    // Search mode replaces the note-relative results but keeps the toolbar.
    if (this.searchMode) {
      this.renderSearch(scroll);
      restoreScroll(true); // staying in search — keep the scroll position
      return;
    }

    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      scroll.createDiv({ cls: 'lc-empty', text: 'Open a note to see related notes and blocks.' });
      return;
    }

    // Switching to a different note clears any rows you had expanded, so they
    // don't carry over and clog the new note's results.
    const changedNote = this.noteContextChanged(file.path);
    if (changedNote) this.resetExpansions();

    const result = await this.plugin.computeAll(file);

    // Banners live in the header too, so they keep their place between the
    // toolbar and the tabs (and stay visible while you scroll results).
    if (this.plugin.paused) {
      header.createDiv({ cls: 'lc-banner lc-paused-banner', text: 'Paused \u2014 edits won\u2019t re-embed until you resume.' });
    } else if (this.plugin.embedding) {
      header.createDiv({ cls: 'lc-banner', text: 'Embedding vault\u2026 results will fill in.' });
    }

    if (!result.ready) {
      if (!this.plugin.embedding) {
        scroll.createDiv({
          cls: 'lc-empty',
          text: 'This note isn\u2019t embedded yet (too short, excluded, or still processing).',
        });
      }
      return;
    }

    this.renderResultTabs(scroll, result, file, null, result.gravity);
    restoreScroll(!changedNote); // keep position on an in-place re-render (expand/collapse)
  }

  // Shared two-tab (notes / blocks) results area, used by both the note-relative
  // panel and semantic search. `sourceFile` is only used to make copied links
  // relative; in search mode it may be the active file or a { path: '' } stub.
  // Forget every row-expansion the user opened (note rows, full titles, blocks).
  resetExpansions() {
    this.expanded.clear();
    this.titleExpanded.clear();
    this.blockExpanded.clear();
  }

  // In the note-relative view, detect a switch to a different note. Returns true
  // (and updates the remembered path) the first time it sees a new path, so the
  // caller can clear stale expansions — but stays false across the many re-renders
  // of the SAME note (debounced refresh, tab switch, expanding a row), so those
  // don't collapse what you just opened.
  noteContextChanged(path) {
    if (path === this.notePath) return false;
    this.notePath = path;
    return true;
  }

  // Is this file already linked from the note the search ran against?
  // Mirrors the panel's link matching (bare + path-qualified, case-insensitive).
  isResultLinked(file, linkedSet) {
    if (!linkedSet || linkedSet.size === 0) return false;
    const byName = file.basename.toLowerCase();
    const byPath = file.path.replace(/\.md$/i, '').toLowerCase();
    return linkedSet.has(byName) || linkedSet.has(byPath);
  }

  // Return a copy of the strange pairs ordered by the current sort choice:
  // 'delta' (strangeness), 'body' (body agreement) or 'title' (title agreement).
  sortedStrange(strange) {
    const key = this.strangeSort === 'body' ? 'raw'
      : this.strangeSort === 'title' ? 'titleRaw'
        : 'delta';
    return [...strange].sort((a, b) => b[key] - a[key]);
  }

  // `gravity` is a separate arg, not part of `result`: it's only meaningful in
  // the note-relative view (search has no "current note" to be gravity-relative
  // to), and only the Similar-notes body render needs it.
  renderResultTabs(container, result, sourceFile, linkedSet, gravity) {
    // Same short labels in both modes — the panel is narrow, and "Similar" adds
    // no information the tab position doesn't already carry.
    const tabsDef = [
      { id: 'notes', label: 'Notes', count: result.notes.length },
      { id: 'blocks', label: 'Blocks', count: result.blocks.length },
    ];
    // "Pairs" only appears when there's at least one — an empty tab would just
    // be a dead click, so the tab bar quietly reverts to two tabs.
    if (!this.searchMode && result.strange && result.strange.length > 0) {
      tabsDef.push({ id: 'strange', label: 'Pairs', count: result.strange.length });
    }

    const tabs = (this._header || container).createDiv({ cls: 'lc-tabs' });
    for (const def of tabsDef) {
      const tab = tabs.createEl('button', {
        cls: 'lc-tab' + (this.activeTab === def.id ? ' lc-tab-active' : ''),
        text: def.label,
      });
      tab.createSpan({ cls: 'lc-tab-count', text: String(def.count) });
      tab.addEventListener('click', () => {
        if (this.activeTab !== def.id) { this.activeTab = def.id; this.render(); }
      });
    }

    const body = container.createDiv({ cls: 'lc-tab-body' });
    if (this.activeTab === 'blocks') {
      this.renderBlocksTab(body, result.blocks, sourceFile, linkedSet);
    } else if (this.activeTab === 'strange' && result.strange && result.strange.length > 0) {
      this.renderStrangeTab(body, result.strange, sourceFile, linkedSet);
    } else {
      // Covers 'notes', and 'strange' falling back once its tab has vanished
      // (e.g. the note's outgoing links changed and the last pair got excluded).
      if (this.activeTab === 'strange') this.activeTab = 'notes';
      this.renderNotesTab(body, result.notes, sourceFile, linkedSet, gravity || null);
    }
  }

  toggleSearch() {
    this.searchMode = !this.searchMode;
    // Search results never have a Strange pairs tab; land on Notes instead of
    // a tab bar with nothing highlighted.
    if (this.searchMode && this.activeTab === 'strange') {
      this.activeTab = 'notes';
    }
    // Leaving search mode clears the query, results, and any rows expanded while
    // searching, so reopening search starts clean and the note-relative view
    // isn't left holding search-time expansions.
    if (!this.searchMode) {
      this.searchQuery = '';
      this.searchResults = null;
      this.resetExpansions();
      this.notePath = null; // force a fresh context on the next note render
    }
    this.render();
  }

  async runSearch(query) {
    this.searchQuery = query;
    const q = (query || '').trim();
    if (!q) { this.searchResults = null; this.render(); return; }
    // Capture the current note's outgoing links so matching results can be
    // marked as "already linked from the note you're reading".
    const active = this.plugin.app.workspace.getActiveFile();
    let linked = new Set();
    if (active && active.extension === 'md') {
      try {
        linked = this.plugin.linkedTargetsFor(await this.plugin.app.vault.cachedRead(active));
      } catch (e) { /* no-op: just means no highlighting */ }
    }
    this.searchLinked = linked;
    this.searching = true;
    this.render();
    try {
      this.searchResults = await this.plugin.searchByText(q);
    } catch (e) {
      this.searchResults = null;
      new Notice(`Local Connections: search failed — ${e.message || e}`);
    } finally {
      this.searching = false;
      this.render();
    }
  }

  // ----- Semantic search view (in-panel, keeps the current note untouched) -----
  renderSearch(container) {
    const bar = (this._header || container).createDiv({ cls: 'lc-search-bar' });

    const input = bar.createEl('input', {
      cls: 'lc-search-input',
      attr: { type: 'text', placeholder: 'Search by meaning… (press Enter)' },
    });
    input.value = this.searchQuery;
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') { evt.preventDefault(); this.runSearch(input.value); }
    });
    // Focus without stealing the cursor mid-typing on unrelated re-renders: only
    // (re)focus when this is a fresh entry into search mode or right after a run.
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);

    if (this.searching) {
      container.createDiv({ cls: 'lc-banner', text: 'Searching…' });
      return;
    }
    if (!this.searchResults) {
      container.createDiv({
        cls: 'lc-empty',
        text: 'Type a sentence or phrase and press Enter to find the closest notes and blocks by meaning.',
      });
      return;
    }

    const sourceFile = this.plugin.app.workspace.getActiveFile() || { path: '' };
    this.renderResultTabs(container, this.searchResults, sourceFile, this.searchLinked, null);
  }

  // ----- Similar notes tab: rows with an expandable dropdown -----
  renderNotesTab(body, notes, currentFile, linkedSet, gravity) {
    const hasGravity = !this.searchMode && gravity && gravity.length > 0;
    if (notes.length === 0 && !hasGravity) {
      body.createDiv({ cls: 'lc-empty', text: 'No similar notes (or all are already linked).' });
      return;
    }
    const list = body.createDiv({ cls: 'lc-list' });

    // Gravity: which notes your recent thinking keeps circling, surfaced above
    // the regular ranking as normal expandable rows. Skipped in search mode
    // (no "current note" context) and whenever there's nothing to show —
    // computeGravity() already excludes the current note and anything already
    // linked from it, so every hit here is genuinely new.
    //
    // All hits share ONE labelled box rather than repeating a label per row:
    // the grouping is what carries the meaning, and the per-row counts live in
    // each row's tooltip so the section stays visually quiet.
    if (hasGravity) {
      const collapsed = this.gravityCollapsed;
      const cage = list.createDiv({ cls: 'lc-gravity-cage' });
      // The label doubles as the fold control. When collapsed the cage stays
      // put (same width, just the label's height) so the section never
      // disappears entirely — it's still there to click open again.
      const label = cage.createDiv({ cls: 'lc-gravity-label' });
      label.createSpan({ cls: 'lc-gravity-caret', text: collapsed ? '\u25B7' : '\u25BD' });
      label.createSpan({ cls: 'lc-gravity-label-text', text: 'Gravity' });
      if (collapsed) {
        label.createSpan({ cls: 'lc-gravity-hidden-count', text: String(gravity.length) });
      }
      label.setAttr(
        'title',
        collapsed
          ? 'Notes your recent thinking keeps circling. Click to show them.'
          : 'Notes your recent thinking keeps circling: they recur among the nearest neighbours of your most recently edited notes. Click to hide.'
      );
      label.addEventListener('click', () => {
        this.gravityCollapsed = !this.gravityCollapsed;
        this.render();
      });
      if (!collapsed) {
        for (const hit of gravity) {
          const nb = hit.count === 1 ? 'neighbourhood' : 'neighbourhoods';
          const row = this._renderNoteRow(cage, hit, currentFile, linkedSet, 'lc-gravity-row');
          if (row) row.setAttr('title', `In ${hit.count} recent ${nb}`);
        }
      }
    }

    for (const r of notes) {
      this._renderNoteRow(list, r, currentFile, linkedSet, null);
    }
  }

  // Render one expandable note row (score, title, copy button, expand caret +
  // dropdown). Shared by the normal Notes list, the Gravity rows above it, and
  // the Pairs tab, so all three look and behave identically. `extraWrapClass`
  // adds a marker class to the row's wrapper. `opts` lets a caller override the
  // score text/tooltip and add an always-visible sub-line under the row (Pairs
  // uses this to show its delta and the body/title breakdown). Returns the row
  // element so callers can annotate it (Gravity puts its count in a tooltip).
  _renderNoteRow(list, r, currentFile, linkedSet, extraWrapClass, opts) {
    opts = opts || {};
    const linked = this.isResultLinked(r.file, linkedSet);
    const item = list.createDiv({ cls: 'lc-item-wrap' + (extraWrapClass ? ' ' + extraWrapClass : '') });
    const row = item.createDiv({ cls: 'lc-item' + (linked ? ' lc-linked' : '') });

    // expand/collapse caret
    const isOpen = this.expanded.has(r.file.path);
    const caret = row.createSpan({ cls: 'lc-caret', text: isOpen ? '\u25BD' : '\u25B7' });
    caret.setAttr('title', isOpen ? 'Collapse' : 'Expand title & body');

    const scoreEl = row.createSpan({
      cls: 'lc-score',
      text: opts.scoreText != null ? opts.scoreText : this.plugin.formatScore(r.raw, r.scaled),
    });
    if (opts.scoreTitle) scoreEl.setAttr('title', opts.scoreTitle);

    const name = row.createSpan({
      cls: 'lc-name',
      text: truncate(r.file.basename, TUNABLES.NOTE_TITLE_MAX_CHARS),
    });
    name.setAttr('title', r.file.path);
    if (linked) {
      const dot = name.createSpan({ cls: 'lc-linked-dot' });
      dot.setAttr('title', 'Already linked from the note you searched from');
    }
    name.addEventListener('click', (evt) => {
      this.plugin.app.workspace.openLinkText(r.file.path, '', evt.ctrlKey || evt.metaKey);
    });

    this.makeCopyButton(row, r.file, currentFile);

    // Optional always-visible sub-line (e.g. the Pairs "body X \u00B7 title Y" line),
    // sitting between the row and its dropdown.
    if (opts.subText) {
      item.createDiv({ cls: 'lc-strange-sub', text: opts.subText });
    }

    // clicking the caret toggles the dropdown
    const toggle = async () => {
      if (this.expanded.has(r.file.path)) {
        this.expanded.delete(r.file.path);
        this.titleExpanded.delete(r.file.path); // collapse resets the title too
      } else {
        this.expanded.add(r.file.path);
      }
      this.render();
    };
    caret.addEventListener('click', (evt) => { evt.stopPropagation(); toggle(); });

    if (isOpen) {
      const drop = item.createDiv({ cls: 'lc-dropdown' });
      // Title, capped at NOTE_TITLE_MAX_CHARS. If it doesn't fit, clicking it
      // toggles the full title — long note names are common here and the
      // truncated form often hides the part that says what the note is about.
      const fullTitle = r.file.basename.replace(/\s+/g, ' ').trim();
      const shortTitle = truncate(r.file.basename, TUNABLES.NOTE_TITLE_MAX_CHARS);
      const clipped = shortTitle !== fullTitle;
      const titleOpen = this.titleExpanded.has(r.file.path);
      const titleEl = drop.createDiv({
        cls: 'lc-drop-title' + (clipped ? ' lc-drop-title-clipped' : ''),
        text: titleOpen ? fullTitle : shortTitle,
      });
      if (clipped) {
        titleEl.setAttr('title', titleOpen ? 'Click to shorten' : 'Click to show the full title');
        titleEl.addEventListener('click', (evt) => {
          evt.stopPropagation();
          if (titleOpen) this.titleExpanded.delete(r.file.path);
          else this.titleExpanded.add(r.file.path);
          this.render();
        });
      }
      // body preview (loaded async)
      const bodyEl = drop.createDiv({ cls: 'lc-drop-body', text: 'Loading\u2026' });
      this.plugin.app.vault.cachedRead(r.file).then((content) => {
        const clean = noteBodyForEmbedding(content);
        bodyEl.setText(truncate(clean, TUNABLES.NOTE_EXPANDED_MAX_CHARS));
      }).catch(() => bodyEl.setText('(could not read note)'));
    }
    return row;
  }

  // ----- Strange pairs tab: same substance, different framing -----
  // Same expandable row as the Notes tab (title/body dropdown on the caret) \u2014
  // the only difference is the score shown (the strangeness delta) and an
  // always-visible sub-line with the body/title breakdown.
  renderStrangeTab(body, strange, currentFile, linkedSet) {
    if (!strange || strange.length === 0) {
      body.createDiv({
        cls: 'lc-empty',
        text: 'No strange pairs right now: nothing agrees in substance while disagreeing in framing.',
      });
      return;
    }
    this.buildStrangeSort(body);

    const list = body.createDiv({ cls: 'lc-list' });
    const dec = TUNABLES.SCORE_DECIMALS;
    // The sort button only reorders the rows \u2014 the displayed numbers stay put:
    // the difference (strangeness) sits top-left, body/title on the sub-line.
    for (const r of this.sortedStrange(strange)) {
      this._renderNoteRow(list, r, currentFile, linkedSet, 'lc-strange-row', {
        scoreText: r.delta.toFixed(dec),
        scoreTitle: 'Strangeness: how much more the bodies agree than the titles',
        subText: `diff ${r.delta.toFixed(dec)} \u00b7 body ${r.raw.toFixed(dec)} \u00b7 title ${r.titleRaw.toFixed(dec)}`,
      });
    }
  }

  // Small "Sort: [Difference ▾]" dropdown at the top of the Pairs tab. The
  // selected option is what the rows are ordered by.
  buildStrangeSort(body) {
    const row = body.createDiv({ cls: 'lc-strange-sortbar' });
    row.createSpan({ cls: 'lc-strange-sortlabel', text: 'Sort' });
    const select = row.createEl('select', { cls: 'lc-strange-sortselect' });
    const opts = [['delta', 'Difference'], ['body', 'Body'], ['title', 'Title']];
    for (const [id, label] of opts) {
      const opt = select.createEl('option', { text: label, attr: { value: id } });
      if (this.strangeSort === id) opt.setAttr('selected', 'selected');
    }
    select.value = this.strangeSort;
    select.addEventListener('change', (evt) => {
      const val = evt && evt.target ? evt.target.value : select.value;
      if (this.strangeSort !== val) { this.strangeSort = val; this.render(); }
    });
  }

  // ----- Similar blocks tab: flat ranked blocks -----
  renderBlocksTab(body, blocks, currentFile, linkedSet) {
    if (blocks.length === 0) {
      body.createDiv({ cls: 'lc-empty', text: 'No similar blocks (or all are in already-linked notes).' });
      return;
    }
    const list = body.createDiv({ cls: 'lc-list lc-block-list' });
    blocks.forEach((r, i) => {
      const linked = this.isResultLinked(r.file, linkedSet);
      const row = list.createDiv({ cls: 'lc-block-item' + (linked ? ' lc-linked' : '') });

      const top = row.createDiv({ cls: 'lc-block-top' });
      // Show the score the list is actually ranked by (the gate-adjusted
      // block × note score), so the numbers descend top-to-bottom. Falls back to
      // the pure block cosine when `combined` isn't present (older data / tests).
      const shownScore = r.combined != null ? r.combined : r.raw;
      top.createSpan({ cls: 'lc-score', text: this.plugin.formatScore(shownScore, r.scaled) });
      const name = top.createSpan({
        cls: 'lc-name',
        text: truncate(r.file.basename, TUNABLES.BLOCK_TITLE_MAX_CHARS),
      });
      name.setAttr('title', r.file.path);
      if (linked) {
        const dot = name.createSpan({ cls: 'lc-linked-dot' });
        dot.setAttr('title', 'Already linked from the note you searched from');
      }
      name.addEventListener('click', (evt) => {
        this.plugin.app.workspace.openLinkText(r.file.path, '', evt.ctrlKey || evt.metaKey);
      });
      this.makeCopyButton(top, r.file, currentFile);

      // Each paragraph expands INDEPENDENTLY: clicking the suggested block grows
      // only it; clicking your matched block grows only that. Capped at
      // BLOCK_EXPANDED_MAX_CHARS so a giant transcript paragraph can't flood the
      // panel. Only clickable when there's more text than the preview shows.
      const HUGE = Number.MAX_SAFE_INTEGER;
      const hasMore = (text) =>
        truncate(text, TUNABLES.BLOCK_PREVIEW_CHARS) !== truncate(text, HUGE);
      // `suffix` ('o' = other/suggested, 'c' = current/yours) keeps the two
      // halves of one row on separate expansion keys.
      const renderExpandable = (el, text, suffix) => {
        const key = r.file.path + '\u0000' + i + '\u0000' + suffix;
        const open = this.blockExpanded.has(key);
        const cap = open ? TUNABLES.BLOCK_EXPANDED_MAX_CHARS : TUNABLES.BLOCK_PREVIEW_CHARS;
        el.setText(truncate(text, cap));
        if (hasMore(text)) {
          el.addClass('lc-block-expandable');
          el.setAttr('title', open ? 'Click to collapse' : 'Click to expand this paragraph');
          el.addEventListener('click', () => {
            if (this.blockExpanded.has(key)) this.blockExpanded.delete(key);
            else this.blockExpanded.add(key);
            this.render();
          });
        }
      };

      const textEl = row.createDiv({ cls: 'lc-block-text' });
      renderExpandable(textEl, r.otherBlock, 'o');

      if (TUNABLES.SHOW_CURRENT_BLOCK && r.currentBlock) {
        const cur = row.createDiv({ cls: 'lc-current-block' });
        cur.createSpan({ cls: 'lc-current-label', text: 'matched your: ' });
        const curText = cur.createSpan({ cls: 'lc-current-text' });
        renderExpandable(curText, r.currentBlock, 'c');
      }
    });
  }
}

// ---------- drift modal ----------

class DriftModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('lc-drift-modal');

    const d = this.plugin.computeDrift(this.file);

    contentEl.createEl('h3', { cls: 'lc-drift-title', text: 'Title drift' });
    contentEl.createEl('div', { cls: 'lc-drift-note', text: this.file.basename });

    if (!d.ready) {
      contentEl.createEl('div', { cls: 'lc-drift-empty', text: d.reason });
      return;
    }

    const dec = TUNABLES.SCORE_DECIMALS;

    // Headline: title vs body
    const headline = contentEl.createDiv({ cls: 'lc-drift-headline' });
    headline.createSpan({ cls: 'lc-drift-label', text: 'Title \u2194 body' });
    headline.createSpan({
      cls: 'lc-drift-score-big',
      text: d.titleBody == null ? '\u2014' : d.titleBody.toFixed(dec),
    });

    contentEl.createEl('div', {
      cls: 'lc-drift-hint',
      text: 'Higher = title matches content. Compare blocks below relative to each other; a low outlier is a paragraph that wandered from the title.',
    });

    // Per-block, document order
    const list = contentEl.createDiv({ cls: 'lc-drift-list' });
    if (d.blocks.length === 0) {
      list.createDiv({ cls: 'lc-drift-empty', text: 'No blocks in this note.' });
    }
    for (const b of d.blocks) {
      const row = list.createDiv({ cls: 'lc-drift-row' });
      const head = row.createDiv({ cls: 'lc-drift-row-head' });
      head.createSpan({ cls: 'lc-drift-idx', text: `#${b.index + 1}` });
      head.createSpan({ cls: 'lc-drift-score', text: b.score.toFixed(dec) });
      row.createDiv({
        cls: 'lc-drift-block-text',
        text: truncate(b.text, TUNABLES.DRIFT_BLOCK_PREVIEW_CHARS),
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- settings ----------

class LocalConnectionsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Coalesce rapid changes (a dragged slider, a typed number) into one save +
    // one panel refresh, rather than firing on every tick.
    this.applyDebounced = debounce(() => {
      this.plugin.saveSettings();
      this.plugin.refreshView();
    }, 350, false);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('lc-settings');

    this.buildAbout(containerEl);

    for (const cat of SETTINGS_SCHEMA) {
      new Setting(containerEl).setName(cat.name).setHeading();
      if (cat.desc) {
        containerEl.createEl('div', { cls: 'setting-item-description lc-cat-desc', text: cat.desc });
      }
      for (const item of cat.items) this.buildSetting(containerEl, item);
      if (cat.name === 'What gets embedded') this.buildReembed(containerEl);
    }

    // ---- reset ----
    new Setting(containerEl)
      .setName('Reset all settings to defaults')
      .setDesc('Restore every setting above to the values it shipped with. Does not delete your embeddings.')
      .addButton((b) => b.setButtonText('Reset').setWarning().onClick(async () => {
        await this.plugin.resetSettings();
        this.plugin.refreshView();
        this.display(); // re-render the tab so the controls show the defaults
        new Notice('Local Connections: settings reset to defaults.');
      }));
  }

  // Build a description that renders multi-line text (examples on their own
  // lines) and appends the ⟳ re-embed reminder for embedding-shape settings.
  // A short "what is this / working dictionary" panel at the very top, for
  // someone who has never seen the plugin. Kept compact on purpose.
  buildAbout(containerEl) {
    new Setting(containerEl).setName('About Local Connections').setHeading();
    const box = containerEl.createEl('div', { cls: 'setting-item-description lc-about' });

    box.createEl('p', {
      text: 'This plugin surfaces the notes and paragraphs most related to whatever you’re '
        + 'reading — entirely on your own machine, using a local Ollama embedding model '
        + '(no cloud, no subscription). It answers two questions at once: what else is in the '
        + 'same territory as this idea (whole-note matches), and which specific paragraph '
        + 'anywhere in your vault is precisely on-point (block matches). The goal is to help '
        + 'you find and make the connections between your notes that you’d otherwise miss.',
    });

    box.createEl('div', { cls: 'lc-about-subhead', text: 'Working dictionary' });
    const dl = box.createEl('dl', { cls: 'lc-about-dl' });
    const terms = [
      ['Embedding', 'Turns a note or paragraph into a vector of numbers that captures its meaning. Similar meaning → vectors that point the same way. Everything here is built on this.'],
      ['Cosine similarity', 'The score for “how alike” two things are: 1.00 = same direction, ~0 = unrelated. Every number you see in the panel is one of these.'],
      ['Block', 'One paragraph, embedded on its own. Powers the Blocks tab — the sharp, atomic signal that catches a single on-point passage buried in an otherwise-unrelated note.'],
      ['Whole-note vector', 'Title + body embedded together. Powers the Notes tab: “what else is about this?” Broader than a block match.'],
      ['Body / title vectors', 'The body alone and the title alone, embedded separately. Used to measure Drift.'],
      ['Drift', 'How well a note’s title matches its body. A low score means the note wandered away from what its title claims.'],
      ['Consensus gate', 'Demotes a paragraph that matches between two notes which aren’t really about the same thing — the classic false positive — without hiding it.'],
      ['Strange pairs', 'Notes whose bodies agree but whose titles don’t: same substance, different framing. A seed for cross-domain connections.'],
      ['Gravity', 'The notes your recent thinking keeps circling, surfaced at the top of the Notes tab.'],
      ['Cleaning', 'Before embedding, metadata lines, images, and code blocks are stripped, so only your actual prose shapes the meaning.'],
      ['Length rules', 'Very short notes are skipped; very long ones (e.g. transcripts) are indexed by block only — the model has a token limit, so a whole-note vector would be meaningless.'],
    ];
    for (const [term, def] of terms) {
      dl.createEl('dt', { cls: 'lc-about-term', text: term });
      dl.createEl('dd', { cls: 'lc-about-def', text: def });
    }
  }

  descFor(item) {
    const frag = document.createDocumentFragment();
    item.desc.split('\n').forEach((line, i) => {
      if (i) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(line));
    });
    if (item.reembed) {
      frag.appendChild(document.createElement('br'));
      const note = document.createElement('span');
      note.className = 'lc-reembed-note';
      note.textContent = '⟳ Needs a re-embed to apply.';
      frag.appendChild(note);
    }
    return frag;
  }

  // Persist a changed value: coerce it, write it into TUNABLES, and apply the
  // right effect. Folders re-index on blur; re-embed settings just save (the
  // reminder tells the user to re-embed); everything else saves + refreshes.
  commit(item, raw, immediate) {
    TUNABLES[item.key] = coerceSetting(item, raw, TUNABLE_DEFAULTS[item.key]);
    if (immediate) {
      this.plugin.saveSettings();
      this.plugin.refreshView();
    } else {
      this.applyDebounced();
    }
  }

  buildSetting(containerEl, item) {
    const s = new Setting(containerEl).setName(item.name).setDesc(this.descFor(item));
    const val = TUNABLES[item.key];

    switch (item.type) {
      case 'text':
        s.addText((t) => t.setValue(val == null ? '' : String(val))
          .onChange((v) => this.commit(item, v)));
        break;
      case 'toggle':
        s.addToggle((t) => t.setValue(!!val)
          .onChange((v) => this.commit(item, v, true)));
        break;
      case 'select':
        s.addDropdown((d) => {
          for (const [k, label] of Object.entries(item.options)) d.addOption(k, label);
          d.setValue(String(val)).onChange((v) => this.commit(item, v, true));
        });
        break;
      case 'slider':
        s.addSlider((sl) => sl.setLimits(item.min, item.max, item.step)
          .setValue(coerceSetting(item, val, item.min)).setDynamicTooltip()
          .onChange((v) => this.commit(item, v)));
        break;
      case 'int':
      case 'number':
        s.addText((t) => {
          if (t.inputEl) t.inputEl.type = 'number';
          t.setValue(String(val)).onChange((v) => this.commit(item, v));
        });
        break;
      case 'folders':
        s.addTextArea((t) => {
          t.setValue((Array.isArray(val) ? val : []).join('\n'));
          // What the index was last built for, so merely clicking into the box
          // and away again doesn't trigger a vault walk + notice.
          let indexedFor = JSON.stringify(TUNABLES[item.key]);
          if (t.inputEl) {
            t.inputEl.rows = 6;
            t.inputEl.addClass('lc-folders-input');
            // Save on each edit, but only re-index once the user clicks away —
            // re-indexing on every keystroke would be miserable.
            t.inputEl.addEventListener('blur', () => {
              TUNABLES[item.key] = coerceSetting(item, t.getValue(), TUNABLE_DEFAULTS[item.key]);
              this.plugin.saveSettings();
              const now = JSON.stringify(TUNABLES[item.key]);
              if (now === indexedFor) return;
              indexedFor = now;
              new Notice('Local Connections: updating included folders.');
              this.plugin.embedVault(false); // embed newly-included, prune removed
            });
          }
          t.onChange((v) => { TUNABLES[item.key] = coerceSetting(item, v, TUNABLE_DEFAULTS[item.key]); this.applyDebounced(); });
        });
        s.settingEl && s.settingEl.addClass('lc-setting-folders');
        break;
      default:
        break;
    }
  }

  buildReembed(containerEl) {
    new Setting(containerEl)
      .setName('Re-embed entire vault')
      .setDesc('Rebuild all note + block vectors from scratch. Run this after changing the model or any of the length rules above (the ⟳ settings).')
      .addButton((b) => b.setButtonText('Re-embed').setCta().onClick(() => {
        this.plugin.embedVault(true);
        new Notice('Local Connections: re-embedding the vault.');
      }));
  }
}
