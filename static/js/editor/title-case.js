// Title Case for the editor's labels, buttons, section names and menu
// options ("Appears on Step 2", "Count Down, Then Close"). Widget schemas
// are written in sentence case; the editor shows them in title case so
// every surface reads the same. Grey helper sentences stay as written.
//
// Small words stay lower case unless they open or close the label; a word
// that already carries its own capitals or digits (QR, 3D, AI, mp4) is left
// alone, and so is a one-letter unit ("3 s").

const SMALL = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
    'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'vs',
    'with', 'from', 'into', 'onto', 'over', 'than', 'if',
]);

const capWord = (w) => w.charAt(0).toUpperCase() + w.slice(1);

function fixWord(word, first, last) {
    // Leading punctuation ("(seconds)", "“quoted”") stays put.
    const m = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/.exec(word);
    const [, pre, core, post] = m;
    if (!core) return word;
    // Already shaped by its author: an acronym, a mixed-case name, a number.
    if (/[A-Z]/.test(core.slice(1)) || /\d/.test(core) || /^[A-Z]{2,}$/.test(core)) return word;
    if (core.length === 1 && core !== 'a' && core !== 'i') return word;
    const lower = core.toLowerCase();
    if (!first && !last && SMALL.has(lower)) return pre + lower + post;
    // Each part of a hyphenated word: "Open-Ended", "Auto-Rotate".
    return pre + core.split('-').map(capWord).join('-') + post;
}

/** "start collecting when the slide opens" → "Start Collecting When the Slide Opens" */
export function titleCase(text) {
    if (typeof text !== 'string' || !text.trim()) return text;
    const words = text.split(/(\s+)/);
    const real = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter(i => i >= 0);
    const firstIdx = real[0], lastIdx = real[real.length - 1];
    let afterBreak = true;   // after a colon, dash or opening: capitalise again
    return words.map((w, i) => {
        if (!/\S/.test(w)) return w;
        const out = fixWord(w, i === firstIdx || afterBreak, i === lastIdx);
        afterBreak = /[:—–]$/.test(w) || w === '—' || w === '–';
        return out;
    }).join('');
}
