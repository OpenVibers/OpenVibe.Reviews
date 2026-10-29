'use strict';
// What openvibe.reviews tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the bearer-token API, the public pages that explain
// what Reviews covers, llms.txt and the sitemap.
module.exports = {
    id: 'reviews',
    name: 'OpenVibe.Reviews',
    purpose: 'Reviews of products and services from many sources in one place: every review keeps its source, its date and what it claims, so a claim can be checked against the evidence behind it.',
    home: 'https://openvibe.reviews',
    site: 'openvibe.reviews',
    api: '/api/v1',
    docs: '/about',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
