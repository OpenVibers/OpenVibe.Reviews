'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, all shown, each with its own heading; on a phone the chips are a
 *                row of links that jump to them (the owner, 2026-10-31: never hide content to shorten).
 *   pickList()   a list of things of the same kind under one heading, every item shown.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS lives in this site's own stylesheet.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone the
 * heading gives way to the chip that names it.
 *
 *   pickBlock({ key, label, head, panes })   panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes }) {
    // A pane with nothing to show is left out, so the chips and the rules that show them match the page.
    panes = (panes || []).filter((p) => p.html);
    if (!panes.length) return '';
    const chips = panes.map((p) => '<a class="pick-chip" href="#' + esc(p.id) + '">' + esc(p.label) + '</a>').join('');
    const body = panes.map((p) => '<div class="pick-pane" id="' + esc(p.id) + '">' + p.html + '</div>').join('');
    return '<div class="pick" id="pick-' + esc(key) + '"><div class="pick-bar"><div class="pick-head"><h2>' + esc(head || label) + '</h2></div><nav class="pick-row" aria-label="' + esc(label) + '">' + chips + '</nav></div><div class="pick-body">' + body + '</div></div>';
}



/**
 * A pick list: a list of things of the same kind under one heading, every item shown (2026-10-31). The list keeps
 * its own markup; `labels` is kept for callers and no longer drawn.
 *
 *   pickList({ key, label, head, labels, html })   labels: the chip labels, in the order of the items
 */
function pickList({ key, label, head = '', labels, html }) {
    labels = labels || [];
    if (!labels.length) return '';
    return '<div class="pick" id="pick-' + esc(key) + '"><div class="pick-bar"><div class="pick-head"><h2>' + esc(head || label) + '</h2></div></div>' + html + '</div>';
}



/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return '<details class="rv-fold rv-fold-block" id="' + esc(id) + '" open><summary>' + head + '<span class="rv-fold-hint">tap to open</span></summary>' + html + '</details>' + foldScript(id);
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return "<script>(function(){var d=document.getElementById(" + JSON.stringify(id) + ");if(!d)return;var k='ov_fold_'+" + JSON.stringify(id) + ";var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>";
}


/**
 * A part of a page's own markup, found by the heading it carries: the site can then show it in a pick block or a
 * fold. { start, end, html } — the section that holds the needle.
 */
function part(html, needle) {
    const at = html.indexOf(needle);
    if (at < 0) return null;
    const start = html.lastIndexOf('<section', at);
    const close = html.indexOf('</section>', at);
    if (start < 0 || close < 0) return null;
    const end = close + '</section>'.length;
    return { start, end, html: html.slice(start, end) };
}

/** The same part, but replaced by something else. */
function swap(html, needle, withHtml) {
    const p = part(html, needle);
    if (!p) return html;
    return html.slice(0, p.start) + withHtml + html.slice(p.end);
}

/** The part that carries this heading, as a fold: closed on a phone, the section it was where there is room. */
function foldAround(html, needle, id, head) {
    const p = part(html, needle);
    if (!p) return html;
    return html.slice(0, p.start) + foldBlock({ id, head, html: p.html }) + html.slice(p.end);
}

module.exports = { pickBlock, pickList, foldBlock, foldScript, part, swap, foldAround };
