/* Code listings on the audience's answer pages (survey_response,
   mcq_response), drawn the way the Audience Response widget draws them on the
   slide: line numbers in a gutter and colour for keywords, literals and
   comments. A port of decorateCode() in widgets/audience-response.html —
   keep the two in step. */
(function () {
  const KW_PY = 'def class lambda if elif else for while break continue return yield pass import from as with ' +
    'try except finally raise assert del global nonlocal in is not and or None True False async await';
  const KW_C  = 'function var let const class new delete return if else for while do switch case default break ' +
    'continue try catch finally throw typeof instanceof struct enum union typedef public private protected static ' +
    'void int long short float double char bool string true false null nullptr this super import export from ' +
    'extends implements interface package async await sizeof';
  const BI_PY = 'print len range str int float bool list dict set tuple sum min max abs sorted enumerate zip map ' +
    'filter type input open round isinstance append';
  const CLIKE = new Set(['js', 'javascript', 'ts', 'typescript', 'java', 'c', 'cpp', 'c++', 'cs', 'csharp',
                         'go', 'rust', 'php', 'swift', 'kotlin', 'scala', 'dart']);
  // The listing is coloured as a whole, not line by line, so a docstring or a
  // /* comment */ that runs over several lines stays coloured on every one
  // (an unclosed one runs to the end, as an editor would show it).
  const RE_COM = String.raw`#[^\n]*|//[^\n]*|/\*[\s\S]*?(?:\*/|$)`;
  const RE_STR = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
  const RE_NUM = String.raw`0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?`;

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function tokenRe(lang) {
    const kw = CLIKE.has(lang) ? KW_C
             : (lang === 'python' || lang === 'py' || !lang) ? KW_PY
             : KW_PY + ' ' + KW_C;
    const alt = list => list.trim().split(/\s+/).join('|');
    return new RegExp('(' + RE_COM + ')|(' + RE_STR + ')|\\b(' + alt(kw) + ')\\b' +
                      '|\\b(' + alt(BI_PY) + ')\\b|\\b(' + RE_NUM + ')\\b', 'g');
  }

  // A listing, coloured: one string of HTML per line. A token that spans
  // lines (a docstring) is closed at each line's end and reopened on the next,
  // so every line stands on its own (the gutter wraps each in a span).
  function highlightLines(src, re) {
    const toks = [];
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      if (m.index > last) toks.push(['', src.slice(last, m.index)]);
      toks.push([m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'kw' : m[4] ? 'bi' : 'num', m[0]]);
      last = re.lastIndex;
      if (m[0] === '') re.lastIndex++;
    }
    if (last < src.length) toks.push(['', src.slice(last)]);
    const lines = [''];
    for (const [c, t] of toks) {
      t.split('\n').forEach((piece, i) => {
        if (i) lines.push('');
        if (piece) lines[lines.length - 1] += c ? `<span class="pk-${c}">${esc(piece)}</span>` : esc(piece);
      });
    }
    return lines;
  }

  window.decorateCode = function (root) {
    root.querySelectorAll('pre > code').forEach(code => {
      const lang = (code.className.match(/language-([\w+#]+)/) || ['', ''])[1].toLowerCase();
      const re   = tokenRe(lang);
      const src  = code.textContent.replace(/\n+$/, '');
      code.innerHTML = highlightLines(src, re)
        .map((line, i) => `<span class="cl" data-n="${i + 1}">${line}</span>`)
        .join('');
    });
  };
})();
