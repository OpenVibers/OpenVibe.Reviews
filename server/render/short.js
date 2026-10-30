'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio
 *                inputs and :has(), no script: every block stays in the page for crawlers, and a wider screen (or a
 *                browser without :has()) shows them all and no chips.
 *   pickList()   a list of things of the same kind, one at a time on a phone, picked with a row of chips.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in this site's own stylesheet; the rule that shows the picked block is written for the
 * page, because there is one per block.
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
    const chips = panes.map((p, i) => '<input type="radio" name="pick-' + esc(key) + '" id="pk-' + esc(key) + '-' + esc(p.id) + '" value="' + esc(p.id) + '"' + (i === 0 ? ' checked' : '') + '><label for="pk-' + esc(key) + '-' + esc(p.id) + '">' + esc(p.label) + '</label>').join('');
    const body = panes.map((p) => '<div class="pick-pane" id="' + esc(p.id) + '">' + p.html + '</div>').join('');
    return '<div class="pick" id="pick-' + esc(key) + '"><div class="pick-bar"><div class="pick-head"><h2>' + esc(head || label) + '</h2></div><div class="pick-row" role="radiogroup" aria-label="' + esc(label) + '">' + chips + '</div></div><div class="pick-body">' + body + '</div></div>';
}

/** The rule that shows the picked block of a pick block: one per block, so the CSS is written for the page. */
function pickRule(key, id) {
    return '.pick:has(#pk-' + key + '-' + id + ':checked) #' + id + '{display:block}';
}

/** The rules for every block of a pick block, in the order they appear. */
function pickRules(key, ids) {
    return ids.map((id) => pickRule(key, id)).join('');
}

/**
 * A pick list: a list of things of the same kind, one at a time on a phone, picked with a row of chips. The list
 * keeps its own markup and every item stays in the page; the caller marks each item with the index its chip picks.
 *
 *   pickList({ key, label, head, labels, html })   labels: the chip labels, in the order of the items
 */
function pickList({ key, label, head = '', labels, html }) {
    labels = labels || [];
    if (!labels.length) return '';
    const chips = labels.map((l, i) => '<input type="radio" name="pick-' + esc(key) + '" id="pk-' + esc(key) + '-' + i + '" value="' + i + '"' + (i === 0 ? ' checked' : '') + '><label for="pk-' + esc(key) + '-' + i + '">' + esc(l) + '</label>').join('');
    return '<div class="pick" id="pick-' + esc(key) + '"><div class="pick-bar"><div class="pick-head"><h2>' + esc(head || label) + '</h2></div><div class="pick-row" role="radiogroup" aria-label="' + esc(label) + '">' + chips + '</div></div>' + html + '</div>';
}

/** The rule that shows the picked item of a pick list: one per item, so the CSS is written for the page. */
function pickListRule(key, i) {
    return '.pick#pick-' + key + ':has(#pk-' + key + '-' + i + ':checked) .pick-list>li[data-i="' + i + '"]{display:block}';
}

/** The rules for every item of a pick list. */
function pickListRules(key, n) {
    return Array.from({ length: n }, (_, i) => pickListRule(key, i)).join('');
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

module.exports = { pickBlock, pickRule, pickRules, pickList, pickListRule, pickListRules, foldBlock, foldScript, part, swap, foldAround };
