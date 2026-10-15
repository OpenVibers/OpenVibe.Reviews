'use strict';

/**
 * Every review site, one search (/everywhere): the owner's April ask for Reviews was aggregation across Glassdoor, Yelp,
 * BBB, Reddit and the rest "subject to legal and technical feasibility". Their terms forbid copying their reviews, so
 * Reviews does what they allow: one name (and, for a local business, a place) opens each site's own search for it, in
 * a new tab. Reviews stores nothing and fetches nothing from them.
 *
 * The URL forms were opened in a real headless Chromium on 2026-10-15: Google Maps, BBB, Glassdoor, Indeed, Blind,
 * LowEndTalk, YouTube, RTINGS, Amazon, Product Hunt and Reddit answered with results; Yelp, Trustpilot, Tripadvisor, G2
 * and Capterra stop headless browsers at a bot check, and these are their own search addresses for people. Left out:
 * WebHostingTalk (its search is a POST), ApartmentRatings and Rate My Landlord (no search address that works).
 *
 *   KINDS        what a person is looking up
 *   SITES        id, name, kinds, best (what the site is good for), url(q, near) → URL
 *   linksFor(q, { kind, near }) → [{ id, name, url, best }]
 */

const enc = encodeURIComponent;
const plus = (s) => enc(s).replace(/%20/g, '+');
const withNear = (q, near) => (near ? `${q} ${near}` : q);

const KINDS = ['business', 'employer', 'landlord', 'company', 'hosting', 'product', 'software'];
const KIND_TEXT = {
    business: 'A local business', employer: 'An employer', landlord: 'A landlord or building', company: 'A company or online shop',
    hosting: 'A hosting provider', product: 'A product', software: 'Software or an app',
};

const SITES = [
    { id: 'google', name: 'Google Maps', kinds: ['business', 'landlord'], best: 'Star ratings and reviews on the map, for nearly every place.',
        url: (q, near) => `https://www.google.com/maps/search/${plus(withNear(q, near))}` },
    { id: 'yelp', name: 'Yelp', kinds: ['business', 'landlord'], best: 'Restaurants, shops and local services, with photos.',
        url: (q, near) => `https://www.yelp.com/search?find_desc=${enc(q)}${near ? `&find_loc=${enc(near)}` : ''}` },
    { id: 'tripadvisor', name: 'Tripadvisor', kinds: ['business'], best: 'Restaurants, hotels and things to do, from travellers.',
        url: (q, near) => `https://www.tripadvisor.com/Search?q=${enc(withNear(q, near))}` },
    { id: 'bbb', name: 'Better Business Bureau', kinds: ['business', 'landlord', 'company'], best: 'Complaints, how the business answered them, and its BBB rating.',
        url: (q, near) => `https://www.bbb.org/search?find_text=${enc(q)}${near ? `&find_loc=${enc(near)}` : ''}` },
    { id: 'trustpilot', name: 'Trustpilot', kinds: ['company', 'hosting'], best: 'Customer reviews of companies and online shops.',
        url: (q) => `https://www.trustpilot.com/search?query=${enc(q)}` },
    { id: 'glassdoor', name: 'Glassdoor', kinds: ['employer'], best: 'What employees say: ratings, pay and interviews.',
        url: (q) => `https://www.glassdoor.com/Search/results.htm?keyword=${enc(q)}` },
    { id: 'indeed', name: 'Indeed', kinds: ['employer'], best: 'Company reviews and ratings from people who worked there.',
        url: (q) => `https://www.indeed.com/companies/search?q=${enc(q)}` },
    { id: 'blind', name: 'Blind', kinds: ['employer'], best: 'Anonymous talk from verified employees, mostly tech.',
        url: (q) => `https://www.teamblind.com/search/${enc(q)}` },
    { id: 'lowendtalk', name: 'LowEndTalk', kinds: ['hosting'], best: 'Hosting customers on uptime, support and offers.',
        url: (q) => `https://lowendtalk.com/search?Search=${enc(q)}` },
    { id: 'rtings', name: 'RTINGS', kinds: ['product'], best: 'Lab-measured reviews of TVs, headphones, monitors and more.',
        url: (q) => `https://www.rtings.com/search?q=${enc(q)}` },
    { id: 'youtube', name: 'YouTube reviews', kinds: ['product', 'software'], best: 'Video reviews and hands-on tests.',
        url: (q) => `https://www.youtube.com/results?search_query=${plus(`${q} review`)}` },
    { id: 'amazon', name: 'Amazon', kinds: ['product'], best: 'Buyer ratings and reviews of products sold there.',
        url: (q) => `https://www.amazon.com/s?k=${plus(q)}` },
    { id: 'g2', name: 'G2', kinds: ['software'], best: 'Business software reviews by its users.',
        url: (q) => `https://www.g2.com/search?query=${enc(q)}` },
    { id: 'capterra', name: 'Capterra', kinds: ['software'], best: 'Software reviews with ratings for features and support.',
        url: (q) => `https://www.capterra.com/search/?query=${enc(q)}` },
    { id: 'producthunt', name: 'Product Hunt', kinds: ['software'], best: 'New apps and tools, with comments from early users.',
        url: (q) => `https://www.producthunt.com/search?q=${enc(q)}` },
    { id: 'reddit', name: 'Reddit', kinds: KINDS, best: 'Unfiltered threads from people who used it.',
        url: (q) => `https://www.reddit.com/search/?q=${enc(`${q} review`)}` },
];

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function linksFor(q, { kind = 'business', near = '' } = {}) {
    const query = clean(q, 120);
    if (!query) return [];
    const k = KINDS.includes(kind) ? kind : 'business';
    const place = clean(near, 80);
    return SITES.filter((s) => s.kinds.includes(k)).map((s) => ({ id: s.id, name: s.name, url: s.url(query, place), best: s.best }));
}

module.exports = { KINDS, KIND_TEXT, SITES, linksFor, clean };
