const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'research_workbench.js'), 'utf8');
const sandbox = {
    console,
    document: {
        addEventListener() {},
        createElement() {
            let text = '';
            return {
                set textContent(value) { text = String(value || ''); },
                get innerHTML() {
                    return text
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;')
                        .replaceAll("'", '&#039;');
                },
            };
        },
    },
};

vm.runInNewContext(`${source}\nglobalThis.__ResearchWorkbench = ResearchWorkbench;`, sandbox);
const workbench = sandbox.__ResearchWorkbench;

const html = workbench.renderReferenceCard({
    type: 'case',
    title: '测试案例',
    content: '结构化详情',
    relevance_score: 90,
    case_library: 'mixed',
    authority_type: '典型案例',
    matched_by: ['semantic', 'ordinary', 'authoritative'],
    fields: { 案号: '（2024）某民终1号' },
}, 0);

assert.match(html, /library-mixed/);
assert.match(html, /普通 \+ 权威/);
assert.match(html, /语义检索/);
assert.match(html, /普通库/);
assert.match(html, /权威库/);
assert.match(html, /结构化详情/);

console.log('research card badge checks passed');
