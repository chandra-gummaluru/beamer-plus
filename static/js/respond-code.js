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
  const RE_COM = String.raw`#[^\n]*|//[^\n]*|/\*.*?\*/`;
  const RE_STR = String.raw`"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?`;
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

  function highlightLine(line, re) {
    const sp = (c, t) => `<span class="pk-${c}">${esc(t)}</span>`;
    let out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      out += esc(line.slice(last, m.index));
      out += m[1] ? sp('com', m[1]) : m[2] ? sp('str', m[2]) : m[3] ? sp('kw', m[3])
           : m[4] ? sp('bi', m[4]) : sp('num', m[5]);
      last = re.lastIndex;
      if (m[0] === '') re.lastIndex++;
    }
    return out + esc(line.slice(last));
  }

  window.decorateCode = function (root) {
    root.querySelectorAll('pre > code').forEach(code => {
      const lang = (code.className.match(/language-([\w+#]+)/) || ['', ''])[1].toLowerCase();
      const re   = tokenRe(lang);
      const src  = code.textContent.replace(/\n+$/, '');
      code.innerHTML = src.split('\n')
        .map((line, i) => `<span class="cl" data-n="${i + 1}">${highlightLine(line, re)}</span>`)
        .join('');
    });
  };
})();
